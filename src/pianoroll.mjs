import { noteToMidi } from '@strudel/core';

const GUTTER = 5; // "C4 |"

// How long a note stays lit after its onset, in cycles. Long enough to read as
// a flash at the playhead, short enough that it is clearly the onset being
// marked rather than the note's duration.
const FLASH_CYCLES = 0.04;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Played notes drop to a flat neutral grey rather than a dimmed voice colour:
// once it has fired, which voice it was matters less than that it is done.
const PLAYED = 240;

// One hue per sound, assigned on first sight, so every layer of a stack reads
// as its own voice. A hash would be stateless but collides, and two layers
// sharing a colour is exactly the thing this is meant to fix.
const VOICE_COLORS = [45, 214, 46, 199, 51, 226, 203, 141, 118, 208, 87, 171];
const voiceColors = new Map();

export function colorForSound(name) {
  const key = name ?? '(none)';
  if (!voiceColors.has(key)) {
    voiceColors.set(key, VOICE_COLORS[voiceColors.size % VOICE_COLORS.length]);
  }
  return voiceColors.get(key);
}

export function resetVoiceColors() {
  voiceColors.clear();
}

export function soundOf(value) {
  if (value && typeof value === 'object') return value.s ?? value.sound ?? null;
  return null;
}

const RESET = '\x1b[0m';
const fg = (n) => `\x1b[38;5;${n}m`;
const bg = (n) => `\x1b[48;5;${n}m`;
const dim = (n) => `\x1b[2;38;5;${n}m`;
const bold = (n) => `\x1b[1;38;5;${n}m`;

function safeNoteToMidi(name) {
  try {
    const m = noteToMidi(name);
    return Number.isFinite(m) ? m : null;
  } catch {
    return null;
  }
}

// Null for unpitched events, drum samples and the like, which get their own lane.
export function hapPitch(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return safeNoteToMidi(value);
  if (typeof value !== 'object') return null;

  if (value.note !== undefined) {
    return typeof value.note === 'number' ? value.note : safeNoteToMidi(value.note);
  }
  if (typeof value.freq === 'number' && value.freq > 0) {
    return 69 + 12 * Math.log2(value.freq / 440);
  }
  return null;
}

export function hapLabel(value) {
  if (value && typeof value === 'object') return value.s ?? value.sound ?? value.bank ?? '?';
  return String(value ?? '?');
}

function noteName(midi) {
  const pc = ((midi % 12) + 12) % 12;
  return `${NOTE_NAMES[pc]}${Math.floor(midi / 12) - 1}`;
}

// The grid is reused between frames rather than rebuilt. Worth knowing what
// this bought and what it costs: garbage went from 41.6KB to 37.1KB per frame,
// about a tenth, because most of the allocation is the strings rather than the
// cells. The renderer is no longer reentrant as a result, so it must not be
// called twice before the first result is read.
let gridCache = { width: 0, height: 0, rows: null };

function scratchGrid(width, height) {
  if (!gridCache.rows || gridCache.width !== width || gridCache.height !== height) {
    gridCache = {
      width,
      height,
      rows: Array.from({ length: height }, () =>
        Array.from({ length: width }, () => ({ ch: ' ', color: null })),
      ),
    };
    return gridCache.rows;
  }
  for (const row of gridCache.rows) {
    for (const cell of row) {
      cell.ch = ' ';
      cell.color = null;
    }
  }
  return gridCache.rows;
}

function serialize(cells) {
  let out = '';
  let active = null;
  for (const cell of cells) {
    if (cell.color !== active) {
      out += cell.color ?? RESET;
      active = cell.color;
    }
    out += cell.ch;
  }
  return out + (active ? RESET : '');
}

/**
 * Render the piano roll as an array of `height` ANSI strings, each `width`
 * printable columns wide. Time runs left to right; the playhead sits at a fixed
 * column and the notes scroll through it.
 */
export function renderPianoRoll({
  haps,
  currentCycle,
  width,
  height,
  cyclesVisible = 2,
  playheadFrac = 0.3,
  selectedStart = null,
  loop = null,
}) {
  // A hap belongs to the selected note when it was produced by the same source
  // characters. Comparing offsets works across separate queries, where object
  // identity does not.
  const isSelected = (hap) =>
    selectedStart != null &&
    (hap.context?.locations ?? []).some((location) => location.start === selectedStart);
  if (height < 3 || width < GUTTER + 8) return Array.from({ length: Math.max(0, height) }, () => '');

  const windowStart = currentCycle - playheadFrac * cyclesVisible;
  const windowEnd = windowStart + cyclesVisible;
  const rollWidth = width - GUTTER;
  const colOf = (cycle) => Math.round(((cycle - windowStart) / cyclesVisible) * rollWidth);

  const inWindow = haps.filter(
    (h) => h.whole.end.valueOf() > windowStart && h.whole.begin.valueOf() < windowEnd,
  );

  const pitched = [];
  const unpitched = [];
  for (const hap of inWindow) {
    const pitch = hapPitch(hap.value);
    if (pitch == null) unpitched.push(hap);
    else pitched.push({ hap, pitch: Math.round(pitch) });
  }

  const percLane = unpitched.length > 0 ? 1 : 0;
  const rollRows = height - 1 - percLane; // last line is the cycle ruler

  // Pitch range: one row per semitone when it fits, centred; compressed only
  // when the pattern spans more rows than the pane has.
  let lo = 60;
  let hi = 72;
  if (pitched.length) {
    lo = Math.min(...pitched.map((p) => p.pitch));
    hi = Math.max(...pitched.map((p) => p.pitch));
  }
  let span = hi - lo + 1;
  if (span < rollRows) {
    const pad = Math.floor((rollRows - span) / 2);
    lo -= pad;
    hi = lo + rollRows - 1;
    span = rollRows;
  }

  const rowOf = (midi) => {
    const frac = span <= 1 ? 0 : (midi - lo) / (span - 1);
    return rollRows - 1 - Math.round(frac * (rollRows - 1));
  };

  const grid = scratchGrid(width, rollRows + percLane + 1);

  // cycle gridlines
  for (let c = Math.ceil(windowStart); c < windowEnd; c++) {
    const col = colOf(c) + GUTTER;
    if (col < GUTTER || col >= width) continue;
    for (let r = 0; r < rollRows + percLane; r++) {
      grid[r][col].ch = '·';
      grid[r][col].color = dim(238);
    }
  }

  // notes
  for (const { hap, pitch } of pitched) {
    const row = rowOf(pitch);
    if (row < 0 || row >= rollRows) continue;

    const begin = hap.whole.begin.valueOf();
    const end = hap.whole.end.valueOf();
    const startCol = Math.max(0, colOf(begin));
    let endCol = Math.min(rollWidth, Math.max(colOf(end), startCol + 1));
    // a one-column gap keeps consecutive same-pitch notes from merging
    if (endCol - startCol > 2) endCol -= 1;

    const color = colorForSound(soundOf(hap.value));
    // Grey from the onset, not from the end: once the playhead has passed a
    // note it has been played, and a long note staying lit for its whole
    // duration reads as "still to come".
    const age = currentCycle - begin;
    const style = isSelected(hap)
      ? `${bg(24)}${fg(231)}`
      : age < 0
        ? fg(color)
        : age < FLASH_CYCLES
          ? bold(231)
          : dim(PLAYED);

    for (let col = startCol; col < endCol; col++) {
      const x = col + GUTTER;
      if (x < GUTTER || x >= width) continue;
      grid[row][x].ch = '█';
      grid[row][x].color = style;
    }
  }

  // unpitched events share a lane under the roll
  if (percLane) {
    const row = rollRows;
    // Drum steps are as long as their slot, so filling the span turns a 16th
    // hat pattern into one solid bar. Mark the onset only.
    for (const hap of unpitched) {
      const begin = hap.whole.begin.valueOf();
      const col = colOf(begin);
      const x = col + GUTTER;
      if (x < GUTTER || x >= width) continue;
      const age = currentCycle - begin;
      const color = colorForSound(soundOf(hap.value));
      const lit = age >= 0 && age < FLASH_CYCLES;
      const style = age < 0 ? fg(color) : lit ? bold(231) : dim(PLAYED);
      grid[row][x].ch = lit ? '▇' : '▄';
      grid[row][x].color = style;
    }
  }

  // playhead
  const playCol = colOf(currentCycle) + GUTTER;
  if (playCol >= GUTTER && playCol < width) {
    for (let r = 0; r < rollRows + percLane; r++) {
      if (grid[r][playCol].ch === ' ' || grid[r][playCol].ch === '·') {
        grid[r][playCol].ch = '│';
        grid[r][playCol].color = fg(241);
      }
    }
  }

  // gutter: name every C, plus the top and bottom rows
  for (let r = 0; r < rollRows; r++) {
    const midi = lo + Math.round(((rollRows - 1 - r) / Math.max(1, rollRows - 1)) * (span - 1));
    const isC = ((midi % 12) + 12) % 12 === 0;
    const label = isC ? noteName(midi).padEnd(4).slice(0, 4) : '    ';
    const color = isC ? dim(245) : null;
    for (let i = 0; i < 4; i++) {
      grid[r][i].ch = label[i];
      grid[r][i].color = color;
    }
    grid[r][4].ch = '│';
    grid[r][4].color = dim(238);
  }
  if (percLane) {
    const label = 'perc';
    for (let i = 0; i < 4; i++) {
      grid[rollRows][i].ch = label[i];
      grid[rollRows][i].color = dim(245);
    }
    grid[rollRows][4].ch = '│';
    grid[rollRows][4].color = dim(238);
  }

  // loop bounds, marked on the ruler so the region is visible at a glance
  const ruler = grid[rollRows + percLane];
  if (loop) {
    for (const [cycle, mark] of [[loop.start, '['], [loop.end, ']']]) {
      const col = colOf(cycle) + GUTTER;
      if (col < GUTTER || col >= width) continue;
      ruler[col].ch = mark;
      ruler[col].color = fg(45);
    }
  }

  for (let c = Math.ceil(windowStart); c < windowEnd; c++) {
    const col = colOf(c) + GUTTER;
    if (loop && (c === loop.start || c === loop.end)) continue;
    const text = String(c);
    for (let i = 0; i < text.length; i++) {
      const x = col + i;
      if (x < GUTTER || x >= width) continue;
      ruler[x].ch = text[i];
      ruler[x].color = dim(240);
    }
  }

  return grid.map(serialize);
}
