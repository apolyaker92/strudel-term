// Browser entry point. Not cli.mjs: that owns the file, the watcher and a
// child-process bounce, none of which exist here. Everything under the
// interface is the same code the terminal build runs.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import { Editor, parseKeys } from '../src/editor.mjs';
import { Engine } from '../src/engine.mjs';
import { Tui, panelRows } from '../src/tui.mjs';
import * as sliders from '../src/sliders.mjs';
import * as tracks from '../src/tracks.mjs';
import { initVocabulary, completionsFor } from '../src/complete.mjs';
import { setBusEffect, setBusParam } from './audio-browser.mjs';
import { initAudio, loadSampleBank } from './audio-browser.mjs';

// Read at build time so the demo cannot drift from the shipped example.
import STARTER from '../examples/first.str?raw';


// The layout wants about 90 columns before it stops looking like itself, so
// the type is sized to the box rather than fixed: a phone gets small text and
// enough columns instead of large text and half a header.
function fontFor(width) {
  const CELL_RATIO = 0.6; // a monospace cell is roughly 0.6em wide
  return Math.max(8, Math.min(14, Math.floor(width / (90 * CELL_RATIO))));
}

const term = new Terminal({
  fontFamily: '"Cascadia Mono", "JetBrains Mono", Menlo, monospace',
  fontSize: fontFor(window.innerWidth),
  theme: { background: '#11131a', foreground: '#d8dee9' },
  cursorBlink: true,
  convertEol: false,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term'));
fit.fit();
globalThis.__term = term;

const editor = new Editor(STARTER);
const engine = new Engine();
const state = {
  file: 'demo.str',
  mode: 'insert',
  error: null,
  status: 'click start to hear it',
  auto: true,
  parseOk: true,
  hint: null,
  cheatsheet: null,
  slider: 0,
  note: 0,
  selectedStart: null,
};
const tui = new Tui({ engine, state, editor });

// Completion, the same flow cli.mjs runs: tab completes and cycles, and the
// dropdown the Tui draws comes from state.hint.
let completion = null;

function handleTab() {
  const cycling =
    completion && completion.line === editor.line && editor.col === completion.endCol;

  if (cycling) {
    completion.index = (completion.index + 1) % completion.matches.length;
  } else {
    const found = completionsFor(editor.lines[editor.line] ?? '', editor.col);
    if (!found.matches.length) {
      completion = null;
      editor.tab();
      return;
    }
    completion = {
      line: editor.line,
      start: found.start,
      matches: found.matches,
      index: 0,
      endCol: editor.col,
    };
  }

  editor.replaceInLine(completion.start, completion.endCol, completion.matches[completion.index]);
  completion.endCol = editor.col;
}

function refreshHint() {
  if (state.mode !== 'insert') {
    state.hint = null;
    return;
  }
  if (completion) {
    state.hint = { matches: completion.matches, index: completion.index, start: completion.start };
    return;
  }
  const found = completionsFor(editor.lines[editor.line] ?? '', editor.col);
  state.hint = found.matches.length
    ? { matches: found.matches, index: 0, start: found.start }
    : null;
}

let evalTimer = null;
function scheduleEvaluate() {
  clearTimeout(evalTimer);
  evalTimer = setTimeout(async () => {
    const error = await engine.setCode(editor.text, { quiet: true });
    state.parseOk = !error;
    state.error = error ? String(error).split('\n')[0] : null;
    if (!error) state.status = `evaluated ${new Date().toLocaleTimeString()}`;
  }, 400);
}

// Enough of the key handling to prove the loop. The full command and note
// modes live in cli.mjs and are the next thing to port.
// The mixer row under the cursor.
function adjustRow(direction) {
  const rows = panelRows(engine);
  if (!rows.length) return;
  const row = rows[Math.min(state.slider ?? 0, rows.length - 1)];

  if (row.track !== undefined) {
    const level = tracks.adjustVolume(row.track, direction);
    state.status = `${row.label} ${level.toFixed(2)}`;
    return;
  }
  if (row.tempo) {
    const step = (sliders.TEMPO_MAX_BPM - sliders.TEMPO_MIN_BPM) / 40;
    const bpm = Math.min(
      sliders.TEMPO_MAX_BPM,
      Math.max(sliders.TEMPO_MIN_BPM, row.value + direction * step),
    );
    engine.setCps(sliders.cpsFromBpm(bpm));
    state.status = `tempo ${Math.round(bpm)} bpm`;
    return;
  }
  if (row.global) {
    const value = sliders.adjustGlobal(row.global, direction);
    if (row.param) setBusParam(row.param.effect, row.param.key, value);
    else if (row.bus) setBusEffect(row.key, value);
    state.status = `${row.label} ${value ? sliders.format(value, row.min, row.max) : 'off'}`;
    return;
  }
  const value = sliders.adjust(row.ordinal, direction);
  if (value != null) state.status = `${row.label} ${sliders.format(value, row.min, row.max)}`;
}

function handleCommandKey(ch) {
  const rows = panelRows(engine);
  switch (ch) {
    case ' ':
      engine.toggle();
      return;
    case 'i':
    case '\r':
      state.mode = 'insert';
      return;
    case 'p':
      tui.toggleRoll();
      return;
    case 'w':
      tui.toggleWaveform();
      return;
    case 't':
      tui.toggleTimeline();
      return;
    case 'm':
    case 's': {
      const row = rows[state.slider ?? 0];
      if (!row || row.track === undefined) {
        state.status = 'pick a track row first';
        return;
      }
      if (ch === 'm') tracks.toggleMute(row.track);
      else tracks.toggleSolo(row.track);
      const now = tracks.stateOf(row.track);
      state.status = `${row.label} ${now.soloed ? 'solo' : now.muted ? 'muted' : 'on'}`;
      return;
    }
    case '+':
    case '=':
      adjustRow(1);
      return;
    case '-':
    case '_':
      adjustRow(-1);
      return;
    default:
      return;
  }
}

function handleKey(key) {
  if (key.type === 'esc') {
    state.mode = 'command';
    editor.clearSelection();
    return;
  }

  if (key.type === 'csi') {
    if (state.mode === 'command') {
      const rows = panelRows(engine);
      if (key.final === 'A') state.slider = Math.max(0, (state.slider ?? 0) - 1);
      else if (key.final === 'B') state.slider = Math.min(rows.length - 1, (state.slider ?? 0) + 1);
      else if (key.final === 'C') adjustRow(1);
      else if (key.final === 'D') adjustRow(-1);
      return;
    }
    // Editor has one move(dLine, dCol), not four named methods
    if (key.final === 'A') editor.move(-1, 0);
    else if (key.final === 'B') editor.move(1, 0);
    else if (key.final === 'C') editor.move(0, 1);
    else if (key.final === 'D') editor.move(0, -1);
    else if (key.final === 'H') editor.home();
    else if (key.final === 'F') editor.end();
    return;
  }

  if (key.type !== 'char' && key.type !== 'paste') return;

  if (state.mode === 'command') {
    if (key.type === 'char') handleCommandKey(key.ch);
    return;
  }

  if (key.type === 'paste') {
    editor.insertText(key.text);
    return scheduleEvaluate();
  }

  const ch = key.ch;
  if (ch === '\x1b') {
    state.mode = 'command';
    return;
  }
  if (ch === '\r') editor.insert('\n');
  else if (ch === '\x7f' || ch === '\b') editor.backspace();
  else if (ch === '\t') handleTab();
  else if (ch >= ' ') editor.insert(ch);
  else return;
  scheduleEvaluate();
}

term.onData((data) => {
  for (const key of parseKeys(data)) {
    // Anything but tab ends the run being cycled through. Without this the
    // dropdown stays up after the word is finished, because refreshHint keeps
    // drawing it for as long as a completion is active.
    const isTab = key.type === 'char' && key.ch === '\t';
    try {
      handleKey(key);
    } catch (err) {
      // otherwise a bad handler kills the keystroke in silence
      state.error = `key handler: ${err.message}`;
    }
    if (!isTab) completion = null;
  }
  refreshHint();
});
window.addEventListener('resize', () => {
  const size = fontFor(window.innerWidth);
  if (size !== term.options.fontSize) term.options.fontSize = size;
  fit.fit();
});

// Names come from the loaded modules, so completion tracks whatever is bundled.
//
// The first evaluation has to happen before the vocabulary is read: the methods
// this project adds, .visualizer() among them, are installed while evaluating,
// so enumerating the prototype first misses them. It also means the roll and
// the strips are drawn before you press start.
(async () => {
  try {
    await engine.setCode(editor.text, { quiet: true });
    const core = await import('@strudel/core');
    const tonal = await import('@strudel/tonal');
    const dough = await import('superdough');
    await initVocabulary({ pattern: engine.pattern ?? core.silence, modules: [core, tonal], dough });
  } catch (err) {
    state.error = `completion unavailable: ${err.message}`;
  }
})();

setInterval(() => tui.draw(), 33);
tui.draw();

document.getElementById('go').addEventListener('click', async () => {
  const overlay = document.getElementById('start');
  overlay.remove();
  term.focus();
  state.status = 'starting audio';
  await initAudio();
  state.status = 'loading samples';
  try {
    await loadSampleBank('github:tidalcycles/dirt-samples');
  } catch {
    state.status = 'samples unavailable, synths only';
  }
  await engine.setCode(editor.text, { quiet: true });
  engine.start();
});
