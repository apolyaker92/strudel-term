// Time-domain scope drawn in braille. Each cell is a 2x4 grid of dots, so a
// pane w cells wide by h tall gives 2w by 4h effective resolution.
//
//   dot layout      bit
//   1 4             0x01 0x08
//   2 5             0x02 0x10
//   3 6             0x04 0x20
//   7 8             0x40 0x80
const BRAILLE_BASE = 0x2800;
const DOT_BITS = [
  [0x01, 0x02, 0x04, 0x40], // left column, top to bottom
  [0x08, 0x10, 0x20, 0x80], // right column
];

const GUTTER = 5;
const RESET = '\x1b[0m';
const fg = (n) => `\x1b[38;5;${n}m`;
const dim = (n) => `\x1b[2;38;5;${n}m`;

// quiet to loud
const LEVEL_COLORS = [45, 51, 49, 46, 118, 190, 226, 214, 208, 203];

// Auto-range, the way a scope's auto setting works. A mix sitting at 0.3 would
// otherwise use a third of the pane and read as a flat line. Fast attack so a
// transient never clips, slow release so the trace doesn't pump.
const FILL_TARGET = 0.85;
const RELEASE = 0.94;
const MIN_GAIN = 0.2;
const MAX_GAIN = 40;
let smoothedPeak = 0.05;

export function resetAutoGain() {
  smoothedPeak = 0.05;
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
 * Render a time-domain buffer as `height` ANSI rows of `width` columns.
 * Draws the min/max envelope per column, the way a hardware scope does, so
 * fast waveforms stay visible instead of aliasing into dots.
 */
// Reused between frames for the same reason the roll's grid is: this runs at
// 30fps and the collection pauses it would otherwise cause are audible.
let scratch = { width: 0, height: 0, rows: null, bits: null };

function scratchRows(width, height, bitsLength) {
  if (!scratch.rows || scratch.width !== width || scratch.height !== height) {
    scratch = {
      width,
      height,
      rows: Array.from({ length: height }, () =>
        Array.from({ length: width }, () => ({ ch: ' ', color: null })),
      ),
      bits: new Uint8Array(bitsLength),
    };
    return scratch;
  }
  for (const row of scratch.rows) {
    for (const cell of row) {
      cell.ch = ' ';
      cell.color = null;
    }
  }
  if (scratch.bits.length !== bitsLength) scratch.bits = new Uint8Array(bitsLength);
  else scratch.bits.fill(0);
  return scratch;
}

export function renderWaveform({ data, width, height, gain }) {
  const scopeWidthForBits = Math.max(0, width - GUTTER);
  const reused = scratchRows(width, height, scopeWidthForBits * height);
  const rows = reused.rows;

  const scopeWidth = width - GUTTER;
  if (height < 1 || scopeWidth < 4) return rows.map(serialize);

  const subW = scopeWidth * 2;
  const subH = height * 4;
  const bits = reused.bits;

  const n = data?.length ?? 0;

  // pass one: true peak, which drives auto-range and the readout
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
  }

  smoothedPeak = Math.max(peak, smoothedPeak * RELEASE);
  const scale =
    gain ?? Math.max(MIN_GAIN, Math.min(MAX_GAIN, FILL_TARGET / Math.max(smoothedPeak, 0.001)));

  // amplitude -1..1 maps top to bottom
  const toSubRow = (v) => {
    const clamped = Math.max(-1, Math.min(1, v));
    return Math.max(0, Math.min(subH - 1, Math.round(((1 - clamped) / 2) * (subH - 1))));
  };

  if (n > 0) {
    for (let x = 0; x < subW; x++) {
      const from = Math.floor((x * n) / subW);
      const to = Math.max(from + 1, Math.floor(((x + 1) * n) / subW));

      let lo = Infinity;
      let hi = -Infinity;
      for (let i = from; i < to && i < n; i++) {
        const v = data[i] * scale;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (lo === Infinity) continue;

      const yTop = toSubRow(hi);
      const yBottom = toSubRow(lo);

      const cellX = x >> 1;
      const dotCol = x & 1;
      for (let y = yTop; y <= yBottom; y++) {
        const cellY = y >> 2;
        const dotRow = y & 3;
        bits[cellY * scopeWidth + cellX] |= DOT_BITS[dotCol][dotRow];
      }
    }
  }

  const level = Math.min(LEVEL_COLORS.length - 1, Math.floor(peak * LEVEL_COLORS.length));
  const color = fg(LEVEL_COLORS[level]);

  // The axis marks zero, so it has to come from the same mapping the trace
  // does. Deriving it separately as the middle row put it one row above where a
  // silent signal actually draws, on any pane with an even height.
  const axisRow = toSubRow(0) >> 2;

  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < scopeWidth; cx++) {
      const mask = bits[cy * scopeWidth + cx];
      const x = cx + GUTTER;
      if (mask) {
        rows[cy][x].ch = String.fromCharCode(BRAILLE_BASE + mask);
        rows[cy][x].color = color;
      } else if (cy === axisRow) {
        // dim zero axis where the trace isn't
        rows[cy][x].ch = '─';
        rows[cy][x].color = dim(236);
      }
    }
  }

  // gutter: label on top row, peak on the next
  const label = 'wave';
  for (let i = 0; i < 4; i++) {
    rows[0][i].ch = label[i];
    rows[0][i].color = dim(245);
  }
  if (height > 1) {
    const text = peak.toFixed(2).slice(0, 4).padEnd(4);
    for (let i = 0; i < 4; i++) {
      rows[1][i].ch = text[i];
      rows[1][i].color = dim(240);
    }
  }
  for (let cy = 0; cy < height; cy++) {
    rows[cy][4].ch = '│';
    rows[cy][4].color = dim(238);
  }

  return rows.map(serialize);
}
