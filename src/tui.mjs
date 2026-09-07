import { renderPianoRoll } from './pianoroll.mjs';
import { renderWaveform } from './waveform.mjs';
import { sampleRate, workletWarning, waveform, isSilent } from './audio.mjs';
import { recentLog } from './logcapture.mjs';
import { describe, rangeOf, controlReference } from './complete.mjs';
import { tokenize, sliceSegments } from './highlight.mjs';
import * as sliders from './sliders.mjs';
import * as tracks from './tracks.mjs';
import { renderTimeline } from './timeline.mjs';

const MAX_PANEL_ROWS = 8;

// Key reminders per mode, ordered by how much each is worth knowing: the tail
// is what gets dropped when the line is short.
const HELP = {
  insert: 'tab complete   ctrl-e notes   ctrl-z undo   esc command   shift+arrows select   ctrl-w del word',
  notes: '←→ slot   ↑↓ move   opt+←→ seq   opt+↑↓ scale   esc back',
  command: '↑↓ pick  m mute  s solo  e notes  [ ] loop  , . seek  x bounce  p roll  w scope  t timeline  q quit',
};

// Which slice of the panel to draw so the selected row is always on screen.
// Exported so the windowing can be tested without a terminal.
export function panelWindow(total, height, selected) {
  if (total <= height) return { offset: 0, size: total, hidden: 0 };
  // the last line becomes a "more" marker, so one fewer row of content
  const size = Math.max(1, height - 1);
  const offset = Math.max(0, Math.min(selected - Math.floor(size / 2), total - size));
  return { offset, size, hidden: total - size };
}

// Tempo, then the sends and bus effects, then a row per stack layer, then the
// sliders the code declares. All rendered alike so one set of keys drives them.
export function panelRows(engine) {
  const bpm = sliders.bpmFromCps(engine.cps);
  const rows = [
    {
      label: 'tempo',
      value: bpm,
      min: sliders.TEMPO_MIN_BPM,
      max: sliders.TEMPO_MAX_BPM,
      display: `${Math.round(bpm)} bpm`,
      tempo: true,
    },
  ];
  // Session-wide controls sit directly under tempo, ahead of the tracks. There
  // is a fixed handful of them and any number of tracks, so ordering it the
  // other way pushed the sends and the bus effects off the visible window on
  // any file with a few layers: on a six track file they were behind "7 more,
  // arrows to reach them", which is no way to find an effect.
  for (const row of sliders.GLOBAL_ROWS) {
    // an effect's own controls only appear once it is doing something
    if (row.showWith && !sliders.globals[row.showWith]) continue;
    const value = sliders.globals[row.key];
    rows.push({
      label: row.label,
      value,
      min: row.min,
      max: row.max,
      // a parameter always has a value, so it reads as a number rather than
      // "off", which would be a lie about a rate or a depth
      display: row.param
        ? sliders.format(value, row.min, row.max)
        : value ? sliders.format(value, row.min, row.max) : 'off',
      global: row.key,
    });
  }
  for (const layer of engine.layers ?? []) {
    const flags = tracks.stateOf(layer.index);
    rows.push({
      label: layer.label,
      track: layer.index,
      muted: flags.muted,
      soloed: flags.soloed,
      audible: flags.audible,
      volume: flags.volume,
      display: flags.volume.toFixed(2),
    });
  }
  // two sliders on the same control would otherwise show as identical rows
  const seen = new Map();
  for (const slot of sliders.list()) {
    const count = (seen.get(slot.label) ?? 0) + 1;
    seen.set(slot.label, count);
    const label = count > 1 ? `${slot.label} ${count}` : slot.label;
    rows.push({
      label,
      value: slot.value,
      min: slot.min,
      max: slot.max,
      display: sliders.format(slot.value, slot.min, slot.max),
      ordinal: slot.ordinal,
    });
  }
  return rows;
}

const SYNTAX = {
  comment: '\x1b[2;38;5;240m',
  string: '\x1b[38;5;114m',
  mini: '\x1b[38;5;215m', // the musical syntax, deliberately the loudest
  number: '\x1b[38;5;180m',
  method: '\x1b[38;5;81m',
  call: '\x1b[38;5;147m',
  punct: '\x1b[38;5;244m',
  text: '\x1b[38;5;250m',
};

// Verified against this build before being written down: every line below was
// queried and produced the events it claims. See scripts/mininote checks.
const CHEATSHEET = [
  'MINI-NOTATION',
  '',
  '  "c3 e3 g3"    sequence, one cycle split evenly',
  '  "c3 ~ e3"     ~ is a rest',
  '  "c3*2"        repeat, twice as fast',
  '  "c3/2"        stretch over two cycles',
  '  "c3 [e3 g3]"  subdivide one step',
  '  "<c3 e3>"     alternate, one per cycle',
  '  "c3,e3,g3"    stack together, a chord',
  '  "c3!3"        repeat three times',
  '  "c3@3"        this step takes three units of time',
  '  "c3?"         randomly drop it',
  '  "c3(3,8)"     euclidean, 3 hits spread over 8 steps',
  '  "c3(3,8,2)"   euclidean, rotated by 2',
  '  "white:2"     sample index 2',
  '  "0 .. 3"      range, same as 0 1 2 3',
  '',
  '  ctrl-g again for control ranges',
];

function buildControlsPage() {
  const rows = ['CONTROL RANGES', '', '  typical working values, not hard limits', ''];
  const width = Math.max(
    ...controlReference().flatMap((g) => g.entries.map((e) => e.name.length)),
  );
  for (const group of controlReference()) {
    rows.push(`  ${group.heading}`);
    for (const entry of group.entries) {
      rows.push(`    ${entry.name.padEnd(width)}  ${entry.range}`);
    }
  }
  rows.push('', '  ctrl-g closes this');
  return rows;
}

const PAGES = {
  notation: CHEATSHEET,
  controls: buildControlsPage(),
};

export const CHEATSHEET_ORDER = [null, 'notation', 'controls'];

const RESET = '\x1b[0m';
const fg = (n) => `\x1b[38;5;${n}m`;
const bg = (n) => `\x1b[48;5;${n}m`;
const dim = (n) => `\x1b[2;38;5;${n}m`;

const BRACKETED_PASTE_ON = '\x1b[?2004h';
const BRACKETED_PASTE_OFF = '\x1b[?2004l';
const ALT_SCREEN_ON = '\x1b[?1049h';
const ALT_SCREEN_OFF = '\x1b[?1049l';
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const HOME = '\x1b[H';
const CLEAR_LINE = '\x1b[K';

const FPS = 30;

const PERF_LOG = process.env.STRUDEL_TERM_PERF;
let perfStream = null;
if (PERF_LOG) {
  const { createWriteStream } = await import('node:fs');
  perfStream = createWriteStream(PERF_LOG, { flags: 'a' });
}
export function perf(line) {
  perfStream?.write(`${line}\n`);
}

function visibleWidth(s) {
  // strings we build carry only SGR sequences
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function fit(s, width) {
  const visible = visibleWidth(s);
  if (visible <= width) return s + ' '.repeat(width - visible);
  // truncating styled text safely is not worth it here; callers pass plain text
  return s.slice(0, width);
}

// Drop whole reminders rather than cutting one in half. A slice mid-binding
// says nothing: "ctrl+\u2191" is not a key anyone can press, and it costs the same
// width as the item that would have fitted.
function fitHelp(help, room) {
  if (room <= 12) return '';
  if (help.length <= room) return help;

  const separator = help.includes('   ') ? '   ' : '  ';
  let shown = '';
  for (const item of help.split(separator)) {
    const next = shown ? `${shown}${separator}${item}` : item;
    if (next.length > room) break;
    shown = next;
  }
  return shown;
}

export class Tui {
  constructor({ engine, state, editor }) {
    this.engine = engine;
    this.state = state; // { file, mode, error, status }
    this.editor = editor;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.cursorRow = 0;
    this.cursorCol = 0;
    // last frame's rows, so only what changed gets written
    this.previous = [];
    this.timer = null;
    this.stopped = false;
    this.showWaveform = true;
    this.showRoll = true;
    this.showTimeline = true;
    this.waveHeight = 6;
  }

  toggleWaveform() {
    this.showWaveform = !this.showWaveform;
  }

  toggleRoll() {
    this.showRoll = !this.showRoll;
  }

  toggleTimeline() {
    this.showTimeline = !this.showTimeline;
  }

  start() {
    process.stdout.write(ALT_SCREEN_ON + BRACKETED_PASTE_ON + CURSOR_HIDE);
    this.timer = setInterval(() => this.draw(), Math.round(1000 / FPS));
    process.stdout.on('resize', () => {
      this.invalidate();
      this.draw();
    });
    this.draw();
  }

  invalidate() {
    this.previous = [];
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    process.stdout.write(BRACKETED_PASTE_OFF + ALT_SCREEN_OFF + CURSOR_SHOW);
  }

  // Completion dropdown under the cursor. Replaces whole rows rather than
  // compositing into them, which would mean tracking SGR state mid-line. Each
  // row ends with a reset so clear-to-end-of-line does not smear the
  // background.
  overlayCompletion(lines, width) {
    const hint = this.state.hint;
    if (!hint || !hint.matches.length || this.cursorRow <= 0) return;
    if (this.state.mode !== 'insert' || this.state.cheatsheet) return;

    const MAX_ITEMS = 8;
    const MAX_DESC = 48;

    // scroll the window so the selection stays visible while tab cycles
    const total = hint.matches.length;
    const offset =
      total <= MAX_ITEMS
        ? 0
        : Math.max(0, Math.min(hint.index - Math.floor(MAX_ITEMS / 2), total - MAX_ITEMS));
    const shown = hint.matches.slice(offset, offset + MAX_ITEMS);
    const selectedRow = hint.index - offset;
    const remaining = total - (offset + shown.length);
    const rows = shown.length + (remaining > 0 ? 1 : 0);

    const descs = shown.map((name) => {
      const text = describe(name) ?? '';
      return text.length > MAX_DESC ? `${text.slice(0, MAX_DESC - 1)}…` : text;
    });
    const ranges = shown.map((name) => rangeOf(name) ?? '');
    const nameWidth = Math.max(...shown.map((n) => n.length));
    const descWidth = Math.max(0, ...descs.map((d) => d.length));
    let rangeWidth = Math.max(0, ...ranges.map((r) => r.length));

    // the range column is the first thing to go when the terminal is narrow
    const fixed = nameWidth + (descWidth ? descWidth + 2 : 0) + 2;
    if (rangeWidth && fixed + rangeWidth + 2 > width - 1) rangeWidth = 0;
    const boxWidth = Math.min(width - 1, fixed + (rangeWidth ? rangeWidth + 2 : 0));

    let left = Math.max(0, 4 + (hint.start - this.scrollLeft) - 1);
    if (left + boxWidth > width) left = Math.max(0, width - boxWidth);

    // below the cursor line, flipped above when there is no room
    const cursorIdx = this.cursorRow - 1;
    const lastUsable = lines.length - 2; // keep the footer
    let top = cursorIdx + 1;
    if (top + rows - 1 > lastUsable) {
      const above = cursorIdx - rows;
      top = above >= 1 ? above : Math.max(1, lastUsable - rows + 1);
    }

    for (let i = 0; i < rows; i++) {
      const y = top + i;
      if (y < 1 || y > lastUsable) continue;

      let body;
      let style;
      if (i < shown.length) {
        const name = shown[i].padEnd(nameWidth);
        const desc = descWidth ? `  ${descs[i].padEnd(descWidth)}` : '';
        const range = rangeWidth ? `  ${ranges[i].padEnd(rangeWidth)}` : '';
        body = ` ${name}${desc}${range} `.slice(0, boxWidth).padEnd(boxWidth);
        style = i === selectedRow ? `${bg(24)}${fg(231)}` : `${bg(236)}${fg(250)}`;
      } else {
        body = ` … ${remaining} more `.slice(0, boxWidth).padEnd(boxWidth);
        style = `${bg(236)}${fg(243)}`;
      }
      lines[y] = ' '.repeat(left) + style + body + RESET;
    }
  }

  overlayCheatsheet(lines, width, height) {
    const page = PAGES[this.state.cheatsheet];
    if (!page) return;

    const lastUsable = lines.length - 2;
    // clip rather than overflow: a short terminal shows what fits and says so
    const room = Math.max(3, lastUsable - 1);
    const clipped = page.length > room;
    const shown = clipped
      ? [...page.slice(0, room - 1), '  …more in tab-completion']
      : page;

    const boxWidth = Math.min(width - 4, Math.max(...shown.map((l) => l.length)) + 4);
    const left = Math.max(0, Math.floor((width - boxWidth) / 2));
    const top = Math.max(1, Math.floor((height - shown.length) / 2));

    for (let i = 0; i < shown.length; i++) {
      const y = top + i;
      if (y < 1 || y > lastUsable) continue;
      const raw = shown[i];
      const body = ` ${raw} `.padEnd(boxWidth).slice(0, boxWidth);

      let styled;
      if (i === 0) {
        styled = `${bg(24)}${fg(231)}${body}${RESET}`;
      } else {
        // colour the example the same way the editor would, so the notation
        // in here matches the notation on screen
        const segments = sliceSegments(tokenize(body), 0, boxWidth);
        styled = `${bg(236)}`;
        for (const seg of segments) {
          styled += `${SYNTAX[seg.kind] ?? SYNTAX.text}${bg(236)}${seg.text}`;
        }
        styled += RESET;
      }
      lines[y] = ' '.repeat(left) + styled;
    }
  }

  // One row per track, send or slider, windowed so a long list scrolls rather
  // than pushing the code pane off the screen.
  pushPanel(lines, rows, sliderRows, width) {
    const { state } = this;

    const selected = Math.min(state.slider ?? 0, rows.length - 1);
    const window = panelWindow(rows.length, sliderRows, selected);
    const labelWidth = Math.min(14, Math.max(...rows.map((r) => r.label.length)));
    // Bars fill the row. They were capped at 40 columns, which left most of a
    // wide terminal empty to the right of the mixer and made small fader
    // moves invisible.
    const barWidth = Math.max(8, width - labelWidth - 16);

    for (let i = 0; i < window.size; i++) {
      const row = rows[window.offset + i];
      const isSelected = window.offset + i === selected && state.mode === 'command';

      if (row.track !== undefined) {
        const marker = isSelected ? `${fg(214)}▸ ` : '  ';
        const name = `${isSelected ? fg(231) : row.audible ? fg(252) : dim(240)}${row.label.slice(0, labelWidth).padEnd(labelWidth)}`;
        const badge = row.soloed
          ? `${fg(46)}SOLO`
          : row.muted
            ? `${fg(203)}MUTE`
            : `${dim(240)}  on`;
        const faderWidth = Math.max(6, barWidth - 5);
        const filledFader = Math.round(Math.min(1, row.volume / 1.5) * faderWidth);
        const fader = row.audible
          ? `${isSelected ? fg(214) : fg(66)}${'▓'.repeat(filledFader)}${dim(238)}${'░'.repeat(faderWidth - filledFader)}`
          : `${dim(237)}${'░'.repeat(faderWidth)}`;
        const level = `${isSelected ? fg(231) : dim(245)} ${row.volume.toFixed(2)}`;
        lines.push(fit(`${marker}${name}${RESET} ${badge}${RESET} ${fader}${RESET}${level}${RESET}`, width));
        continue;
      }

      const span = row.max - row.min || 1;
      const fraction = Math.max(0, Math.min(1, (row.value - row.min) / span));
      const filled = Math.round(fraction * barWidth);

      const marker = isSelected ? `${fg(214)}▸ ` : '  ';
      const label = `${isSelected ? fg(231) : dim(245)}${row.label.slice(0, labelWidth).padEnd(labelWidth)}`;
      const bar =
        `${isSelected ? fg(214) : row.tempo || row.global ? fg(72) : fg(66)}${'▓'.repeat(filled)}` +
        `${dim(238)}${'░'.repeat(barWidth - filled)}`;
      const value = `${isSelected ? fg(231) : dim(245)} ${row.display}`;
      lines.push(fit(`${marker}${label}${RESET} ${bar}${RESET}${value}${RESET}`, width));
    }

    if (window.hidden > 0) {
      lines.push(fit(`  ${dim(244)}… ${window.hidden} more, ↑↓ to reach them${RESET}`, width));
    }
  }

  // Compact on purpose: at 80 columns the old header ran past the edge and the
  // loop indicator, being last, was silently cut off.
  headerLine() {
    const { engine, state } = this;
    const playing = isSilent()
      ? `${dim(245)}▪ silent`
      : engine.playing
        ? `${fg(46)}▶ playing`
        : `${fg(214)}⏸ paused`;
    const mode =
      state.mode === 'insert'
        ? `${fg(46)}INSERT`
        : state.mode === 'notes'
          ? `${fg(45)}NOTES`
          : `${fg(214)}COMMAND`;
    const auto = state.auto
      ? state.parseOk
        ? `${dim(245)}auto`
        : `${fg(208)}auto·unparsed`
      : `${dim(245)}manual`;
    const bpm = Math.round(engine.cps * 60 * 4);

    return (
      `${fg(45)}strudel${RESET} ${mode}${RESET} ${auto}${RESET} ` +
      `${dim(245)}${state.file}${this.editor.dirty ? '*' : ''}${RESET} ` +
      `${playing}${RESET} ${dim(245)}${bpm}bpm cyc ${engine.currentCycle.toFixed(1)}${RESET}` +
      (engine.loop ? ` ${fg(45)}loop ${engine.loop.start}-${engine.loop.end}${RESET}` : '')
    );
  }

  // A problem outranks everything; otherwise the status carries the information
  // and the reminders take what is left. With the help first, at 80 columns it
  // filled the line and pushed every "evaluated" and error message off the end.
  footerLine(width) {
    const { state, engine } = this;
    const problem = state.error || engine.error || workletWarning();
    if (problem) return `${fg(203)}${String(problem).slice(0, width)}${RESET}`;
    if (engine.warning) return `${fg(214)}${engine.warning.slice(0, width)}${RESET}`;

    const recent = recentLog();
    if (recent && recent.level !== 'log') return `${fg(214)}${recent.text.slice(0, width)}${RESET}`;

    const status = state.status ?? '';
    const room = width - (status ? status.length + 3 : 0);
    const shown = fitHelp(HELP[state.mode] ?? HELP.command, room);
    return (status ? `${fg(252)}${status}${RESET}   ` : '') + `${dim(244)}${shown}${RESET}`;
  }

  draw() {
    if (this.stopped) return;
    const started = perfStream ? performance.now() : 0;
    const width = process.stdout.columns || 80;
    const height = process.stdout.rows || 24;
    if (width < 20 || height < 8) return;

    const lines = [];
    const { engine, state } = this;

    lines.push(fit(this.headerLine(), width));

    // editable code pane
    const timelineRows = this.showTimeline ? 1 : 0;
    const available = height - 3 - timelineRows;
    const editor = this.editor;
    const codeLines = editor.lines;
    // size to the file, capped at half the pane, so a short file leaves the
    // roll room to breathe instead of showing empty gutter
    // with the roll hidden there is nothing else competing for the height, so
    // the code pane takes it rather than leaving a band of empty screen
    const panelWanted = Math.min(panelRows(engine).length, MAX_PANEL_ROWS);
    const sharedCap = Math.floor(available * 0.5);
    // Hiding the roll must never leave less room for code than showing it. On a
    // short terminal the subtraction below can come out under the shared cap
    // once the panel has enough rows, and then turning the roll off shrank the
    // code pane. The panel scrolls, so it is the one that gives way.
    const codeCap = this.showRoll
      ? sharedCap
      : Math.max(
          sharedCap,
          Math.max(3, available - panelWanted - (this.showWaveform ? this.waveHeight : 0)),
        );
    const codeHeight = Math.max(3, Math.min(codeLines.length, codeCap));
    // a one column track on the right shows where you are in a long file
    const showScrollbar = codeLines.length > codeHeight;
    const bodyWidth = Math.max(1, width - 4 - (showScrollbar ? 1 : 0));

    // keep the cursor on screen
    if (editor.line < this.scrollTop) this.scrollTop = editor.line;
    if (editor.line >= this.scrollTop + codeHeight) this.scrollTop = editor.line - codeHeight + 1;
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, codeLines.length - codeHeight)));

    if (editor.col < this.scrollLeft) this.scrollLeft = editor.col;
    if (editor.col >= this.scrollLeft + bodyWidth) this.scrollLeft = editor.col - bodyWidth + 1;
    this.scrollLeft = Math.max(0, this.scrollLeft);

    const selection = editor.selectionRange?.() ?? null;

    this.cursorRow = 0;
    for (let row = 0; row < codeHeight; row++) {
      const idx = this.scrollTop + row;
      if (idx >= codeLines.length) {
        lines.push('');
        continue;
      }
      const onCursor = idx === editor.line;
      const errorLine = engine.errorLoc?.line === idx + 1;
      const n = String(idx + 1).padStart(3);
      const raw = codeLines[idx].replace(/\t/g, '  ');
      const segments = sliceSegments(tokenize(raw), this.scrollLeft, this.scrollLeft + bodyWidth);

      // which columns of this line are selected, if any
      let selFrom = -1;
      let selTo = -1;
      if (selection) {
        const { start, end } = selection;
        if (idx >= start.line && idx <= end.line) {
          selFrom = idx === start.line ? start.col : 0;
          selTo = idx === end.line ? end.col : raw.length + 1;
        }
      }

      let body = '';
      let column = this.scrollLeft;
      for (const seg of segments) {
        const colour = SYNTAX[seg.kind] ?? SYNTAX.text;
        if (selFrom < 0) {
          body += `${colour}${seg.text}`;
          column += seg.text.length;
          continue;
        }
        // split the token where the selection starts and ends
        for (const char of seg.text) {
          const selected = column >= selFrom && column < selTo;
          body += selected ? `${bg(60)}${fg(231)}${char}${RESET}` : `${colour}${char}`;
          column += 1;
        }
      }
      const gutter = errorLine ? `${bg(52)}${fg(210)}${n}${RESET}${fg(210)}▸` : `${onCursor ? fg(246) : dim(238)}${n} `;

      let rendered = `${gutter}${RESET}${body}`;

      // A faint wash on the line the cursor is on. Applied around the whole row
      // so the padding is highlighted too, which is what makes it read as a
      // line rather than as a coloured word.
      if (onCursor && !errorLine) {
        const used = visibleWidth(rendered);
        const pad = Math.max(0, width - used - (showScrollbar ? 1 : 0));
        rendered = `${bg(235)}${rendered}${' '.repeat(pad)}${RESET}`;
      }

      if (showScrollbar) {
        const span = Math.max(1, codeLines.length - codeHeight);
        const thumbSize = Math.max(1, Math.round((codeHeight * codeHeight) / codeLines.length));
        const thumbTop = Math.round((this.scrollTop / span) * (codeHeight - thumbSize));
        const onThumb = row >= thumbTop && row < thumbTop + thumbSize;
        const track = onThumb ? `${fg(245)}█` : `${dim(237)}│`;
        rendered = fit(rendered, width - 1) + track + RESET;
      }

      lines.push(fit(rendered, width));
      if (onCursor) {
        // 1-indexed screen position: header occupies row 1
        this.cursorRow = 2 + row;
        this.cursorCol = 5 + (editor.col - this.scrollLeft);
      }
    }

    // separator
    lines.push(`${dim(238)}${'─'.repeat(width)}${RESET}`);

    if (timelineRows) {
      const { page, counts } = engine.densityPage();
      lines.push(
        renderTimeline({
          counts,
          page,
          currentCycle: engine.currentCycle,
          loop: engine.loop,
          width,
        }),
      );
    }

    // piano roll, with the scope and the control panel taking slices off the bottom
    const rows = panelRows(engine);
    // never let the panel squeeze the roll out entirely on a short terminal
    const panelBudget = Math.max(2, Math.min(MAX_PANEL_ROWS, available - codeHeight - (this.showRoll ? 4 : 0)));
    const sliderRows = Math.min(rows.length, panelBudget);
    const waveHeight = this.showWaveform
      ? Math.min(this.waveHeight, Math.max(0, available - codeHeight - sliderRows - (this.showRoll ? 6 : 0)))
      : 0;
    const rollHeight = this.showRoll
      ? Math.max(0, available - codeHeight - waveHeight - sliderRows)
      : 0;
    const cyclesVisible = 2;
    const playheadFrac = 0.3;
    const current = engine.currentCycle;
    const rollLines = rollHeight > 0 ? renderPianoRoll({
      haps: engine.visibleHaps(current - cyclesVisible, current + cyclesVisible),
      currentCycle: current,
      width,
      height: rollHeight,
      cyclesVisible,
      playheadFrac,
      selectedStart: state.mode === 'notes' ? state.selectedStart ?? null : null,
      loop: engine.loop,
    }) : [];
    for (const line of rollLines) lines.push(line);

    if (sliderRows > 0) this.pushPanel(lines, rows, sliderRows, width);

    if (waveHeight > 0) {
      const wave = renderWaveform({ data: waveform(), width, height: waveHeight });
      for (const line of wave) lines.push(line);
    }

    while (lines.length < height - 1) lines.push('');

    lines.push(fit(this.footerLine(width), width));

    this.overlayCompletion(lines, width);
    this.overlayCheatsheet(lines, width, height);

    // Only about a quarter of the rows change between frames: the roll, the
    // scope and the clock. Writing the whole screen at 30fps was 96 KB/s of
    // mostly identical bytes.
    let frame = '';
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === this.previous[i]) continue;
      frame += `\x1b[${i + 1};1H${lines[i]}${CLEAR_LINE}`;
    }
    this.previous = lines;

    if (state.mode === 'insert' && this.cursorRow > 0) {
      frame += `\x1b[${this.cursorRow};${this.cursorCol}H${CURSOR_SHOW}`;
    } else if (frame) {
      frame += CURSOR_HIDE;
    }
    if (frame) process.stdout.write(frame);
    if (perfStream) {
      const took = performance.now() - started;
      if (took > 8) perf(`frame ${took.toFixed(1)}ms`);
    }
  }
}
