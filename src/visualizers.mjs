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
import { renderWaveform } from './waveform.mjs';
import { analyserData } from './audio.mjs';

export const KINDS = ['roll', 'steps', 'wave'];

/** Rows a kind occupies, known without rendering so the pane can size itself. */
export const heightOf = (kind) => (kind === 'steps' ? 1 : kind === 'wave' ? 4 : 5);
const DEFAULT_KIND = 'roll';

// Ids for the wave kind, handed out in evaluation order and matched to the
// source scan, which numbers them in source order. A stack evaluates its
// arguments left to right, so the two agree; anything that defers evaluation
// out of source order would not, and would draw the wrong pattern's audio.
let waveCount = 0;
export const waveId = (n) => `viz${n}`;
export function resetWaveIds() {
  waveCount = 0;
}

// A prototype method rather than core.register, which patternifies its argument
// and so rebuilds the query: the events and their times came back identical but
// in a different order.
//
// roll and steps are inert, and everything they draw comes from the source.
// wave cannot be: the audio has to reach an analyser for there to be anything
// to show, so that one attaches .analyze(), which taps the signal rather than
// changing it. In an offline render superdough ignores analyze entirely, so a
// bounce is unaffected either way.
// The transpiler rewrites a string argument into mini notation, so what arrives
// here is a Pattern, not "wave". Reading the string back out of it is the
// difference between this working and silently doing nothing.
function kindOf(arg) {
  if (typeof arg === 'string') return arg;
  try {
    const value = arg?.queryArc?.(0, 1)?.[0]?.value;
    return typeof value === 'string' ? value : DEFAULT_KIND;
  } catch {
    return DEFAULT_KIND;
  }
}

export function installVisualizer(core) {
  core.Pattern.prototype.visualizer = function visualizer(kind) {
    if (kindOf(kind) !== 'wave') return this;
    return this.analyze(waveId(waveCount++));
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
  let waves = 0;
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
        const raw = typeof arg?.value === 'string' ? arg.value : DEFAULT_KIND;
        const kind = KINDS.includes(raw) ? raw : DEFAULT_KIND;
        found.push({
          // acorn lines are 1-indexed, the editor's are not
          line: node.loc.end.line - 1,
          kind,
          id: kind === 'wave' ? waveId(waves++) : null,
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
export function renderVisualizer({ kind, id, haps, currentCycle, width, height, cyclesVisible = 2 }) {
  const indent = 6;
  const inner = width - indent;
  if (inner < 12 || height < 1) return [];
  const pad = ' '.repeat(indent);

  if (kind === 'steps') {
    return [pad + renderSteps({ haps, currentCycle, width: inner, cyclesVisible })];
  }

  if (kind === 'wave') {
    const data = analyserData(id);
    // nothing has played through this analyser yet, or we are offline
    if (!data) return [];
    return renderWaveform({ data, width: inner, height: Math.min(height, 4) }).map((r) => pad + r);
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
