// Inline visualizers: `.visualizer("roll")` draws a small strip under the line
// it sits on.
//
// The method itself does nothing at runtime, it returns the pattern it was
// given. Everything visible is worked out from the source: acorn finds each
// call and the expression it is chained onto, and events are attributed to it
// by asking whether their source locations fall inside that expression, which
// is how tracks.mjs attributes events to mixer layers. So a visualizer cannot
// change what you hear.

import { parse } from 'acorn';
import { renderPianoRoll } from './pianoroll.mjs';

export const KINDS = ['roll', 'steps'];

/** Rows a kind occupies, known without rendering so the pane can size itself. */
export const heightOf = (kind) => (kind === 'steps' ? 1 : 5);
const DEFAULT_KIND = 'roll';

// A prototype method rather than core.register, which patternifies its argument
// and so rebuilds the query: the events and their times came back identical but
// in a different order, and this is supposed to touch nothing at all.
export function installVisualizer(core) {
  core.Pattern.prototype.visualizer = function visualizer() {
    return this;
  };
}

const RESET = '\x1b[0m';
const dim = (n) => `\x1b[2;38;5;${n}m`;
const fg = (n) => `\x1b[38;5;${n}m`;

// Reparsing at 30fps would be wasteful, and the source only changes on an edit.
let cache = { code: null, found: [] };

/**
 * Every .visualizer() call in the source, with the line it sits on and the
 * range of the expression it is chained onto. Returns [] for code that does not
 * parse, which is most keystrokes.
 */
export function findVisualizers(code) {
  if (cache.code === code) return cache.found;

  const found = [];
  try {
    const ast = parse(code, { ecmaVersion: 'latest', locations: true });
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (
        node.type === 'CallExpression' &&
        node.callee?.type === 'MemberExpression' &&
        node.callee.property?.name === 'visualizer'
      ) {
        const arg = node.arguments[0];
        const kind = typeof arg?.value === 'string' ? arg.value : DEFAULT_KIND;
        found.push({
          // acorn lines are 1-indexed, the editor's are not
          line: node.loc.end.line - 1,
          kind: KINDS.includes(kind) ? kind : DEFAULT_KIND,
          start: node.callee.object.start,
          end: node.callee.object.end,
        });
      }
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value.type === 'string') walk(value);
      }
    };
    walk(ast);
  } catch {
    // mid-edit source does not parse; keep the last good answer rather than
    // flickering the strips out on every keystroke
    return cache.found;
  }

  cache = { code, found };
  return found;
}

export function hapsFor(haps, target) {
  return haps.filter((hap) =>
    (hap.context?.locations ?? []).some(
      (location) => location.start >= target.start && location.end <= target.end,
    ),
  );
}

// One row: where this pattern's onsets fall across the visible cycle.
function renderSteps({ haps, currentCycle, width, cyclesVisible }) {
  const from = currentCycle - cyclesVisible / 2;
  const cells = new Array(width).fill(null);

  for (const hap of haps) {
    const begin = hap.whole.begin.valueOf();
    const col = Math.round(((begin - from) / cyclesVisible) * (width - 1));
    if (col < 0 || col >= width) continue;
    cells[col] = currentCycle >= begin ? 'played' : 'coming';
  }

  let out = '';
  let active = null;
  for (let i = 0; i < width; i++) {
    const style = cells[i] === 'coming' ? fg(45) : cells[i] === 'played' ? dim(240) : dim(236);
    if (style !== active) {
      out += style;
      active = style;
    }
    out += cells[i] ? '▍' : '·';
  }
  return out + RESET;
}

/**
 * Rows to draw under a line. Indented to sit under the code rather than the
 * gutter, and never taller than the space it is given.
 */
export function renderVisualizer({ kind, haps, currentCycle, width, height, cyclesVisible = 2 }) {
  const indent = 6;
  const inner = width - indent;
  if (inner < 12 || height < 1) return [];
  const pad = ' '.repeat(indent);

  if (kind === 'steps') {
    return [pad + renderSteps({ haps, currentCycle, width: inner, cyclesVisible })];
  }

  // renderPianoRoll needs three rows before it will draw anything
  const rollHeight = Math.min(height, 5);
  if (rollHeight < 3) return [];
  return renderPianoRoll({
    haps,
    currentCycle,
    width: inner,
    height: rollHeight,
    cyclesVisible,
    playheadFrac: 0.5,
  }).map((row) => pad + row);
}

export function resetCache() {
  cache = { code: null, found: [] };
}
