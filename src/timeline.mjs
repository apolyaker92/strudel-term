// A zoomed-out strip of the arrangement: one glance at many cycles, with event
// density, the playhead and the loop.
//
// Querying dozens of cycles costs milliseconds, far too much to redo every
// frame, so the counts are computed once per pattern version and only the
// markers move in between.

const GUTTER = 5;
const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

const RESET = '\x1b[0m';
const fg = (n) => `\x1b[38;5;${n}m`;
const dim = (n) => `\x1b[2;38;5;${n}m`;
const bg = (n) => `\x1b[48;5;${n}m`;

export const PAGE_CYCLES = 64;

// Which page of the arrangement a cycle falls on, so the strip advances in
// steady jumps rather than scrolling under the eye.
export function pageFor(cycle, span = PAGE_CYCLES) {
  return Math.max(0, Math.floor(cycle / span));
}

/**
 * Event counts per cycle for one page. Returned as a plain array so it can be
 * cached and reused across frames.
 */
export function densityFor(pattern, page, span = PAGE_CYCLES) {
  const from = page * span;
  const counts = new Array(span).fill(0);
  if (!pattern) return counts;
  let haps;
  try {
    haps = pattern.queryArc(from, from + span);
  } catch {
    return counts;
  }
  for (const hap of haps) {
    if (!hap.whole) continue;
    const index = Math.floor(hap.whole.begin.valueOf()) - from;
    if (index >= 0 && index < span) counts[index] += 1;
  }
  return counts;
}

export function renderTimeline({ counts, page, span = PAGE_CYCLES, currentCycle, loop, width }) {
  const inner = Math.max(1, width - GUTTER);
  const from = page * span;
  const peak = Math.max(1, ...counts);

  const cells = [];
  for (let column = 0; column < inner; column++) {
    // each column covers a slice of the page, aggregated when zoomed out
    const startCycle = Math.floor((column * span) / inner);
    const endCycle = Math.max(startCycle + 1, Math.floor(((column + 1) * span) / inner));
    let total = 0;
    for (let c = startCycle; c < endCycle && c < span; c++) total += counts[c];

    const level = total === 0 ? 0 : Math.max(1, Math.round((total / peak) * (BLOCKS.length - 1)));
    const absolute = from + startCycle;
    const inLoop = loop && absolute >= loop.start && absolute < loop.end;
    cells.push({ ch: BLOCKS[level], inLoop, absolute, endCycle: from + endCycle });
  }

  const headColumn = Math.floor(((currentCycle - from) / span) * inner);

  let out = `${dim(245)}time │${RESET}`;
  let active = null;
  for (const [column, cell] of cells.entries()) {
    const isHead = column === headColumn;
    const style = isHead
      ? `${bg(24)}${fg(231)}`
      : cell.inLoop
        ? fg(45)
        : cell.ch === ' '
          ? dim(238)
          : fg(66);
    if (style !== active) {
      out += RESET + style;
      active = style;
    }
    out += isHead && cell.ch === ' ' ? '│' : cell.ch;
  }
  return out + RESET;
}
