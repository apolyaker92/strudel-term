// Layers of a top-level stack(), treated as mixer tracks. Nothing is rewritten:
// acorn gives each argument's source range and every event carries the
// locations that produced it, so an event belongs to whichever range contains
// them, and muting means declining to schedule it. Rewriting instead would
// shift every offset after an inserted .gain() and break note editing.

import { parse } from 'acorn';

const muted = new Set();
const soloed = new Set();
const volumes = new Map();

// A readable name for a layer: whatever instrument or note call opens it.
function labelFor(text) {
  const sound = /\b(?:sound|s)\(\s*"([^"]+)"/.exec(text);
  if (sound) return sound[1].split(/[\s*<>[\]]/)[0] || sound[1];
  const note = /\bnote\(\s*"([^"]+)"/.exec(text);
  if (note) return note[1].split(/[\s*<>[\]]/)[0] || 'note';
  const n = /\bn\(\s*"([^"]+)"/.exec(text);
  if (n) return `n ${n[1].split(/\s/)[0]}`;
  const call = /\b([a-z][A-Za-z0-9_]*)\(/.exec(text);
  return call ? call[1] : 'layer';
}

// Find the outermost stack() call and report its arguments.
export function analyse(code) {
  let ast;
  try {
    ast = parse(code, { ecmaVersion: 'latest' });
  } catch {
    return [];
  }

  let found = null;
  const visit = (node) => {
    if (!node || typeof node !== 'object' || found) return;
    if (node.type === 'CallExpression' && node.callee?.name === 'stack') {
      found = node;
      return;
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child.type === 'string') visit(child);
    }
  };
  visit(ast);
  if (!found) return [];

  return found.arguments.map((arg, index) => ({
    index,
    start: arg.start,
    end: arg.end,
    label: labelFor(code.slice(arg.start, arg.end)),
  }));
}

// Which layer produced this event, by source position. -1 when unattributable.
export function trackOf(hap, layers) {
  if (!layers.length) return -1;
  for (const location of hap.context?.locations ?? []) {
    for (const layer of layers) {
      if (location.start >= layer.start && location.end <= layer.end) return layer.index;
    }
  }
  return -1;
}

export function isAudible(index) {
  if (index < 0) return true; // unattributable events always play
  if (soloed.size > 0) return soloed.has(index) && !muted.has(index);
  return !muted.has(index);
}

export function toggleMute(index) {
  if (muted.has(index)) muted.delete(index);
  else muted.add(index);
}

export function toggleSolo(index) {
  if (soloed.has(index)) soloed.delete(index);
  else soloed.add(index);
}

export function volumeOf(index) {
  return volumes.get(index) ?? 1;
}

export function adjustVolume(index, direction, steps = 20) {
  const next = Math.max(0, Math.min(1.5, volumeOf(index) + direction / steps));
  volumes.set(index, next);
  return next;
}

export function setVolume(index, value) {
  volumes.set(index, Math.max(0, Math.min(1.5, value)));
}

export function stateOf(index) {
  return {
    muted: muted.has(index),
    soloed: soloed.has(index),
    audible: isAudible(index),
    volume: volumeOf(index),
  };
}

export function anySoloed() {
  return soloed.size > 0;
}

export function reset() {
  muted.clear();
  soloed.clear();
  volumes.clear();
}

export function snapshot() {
  return {
    muted: [...muted],
    soloed: [...soloed],
    volumes: Object.fromEntries(volumes),
  };
}

export function restore(state) {
  if (!state || typeof state !== 'object') return;
  reset();
  for (const index of state.muted ?? []) muted.add(Number(index));
  for (const index of state.soloed ?? []) soloed.add(Number(index));
  for (const [index, value] of Object.entries(state.volumes ?? {})) {
    const volume = Number(value);
    if (Number.isFinite(volume)) volumes.set(Number(index), volume);
  }
}

// Drop tracks that no longer exist after an edit.
export function prune(count) {
  for (const set of [muted, soloed]) {
    for (const index of [...set]) if (index >= count) set.delete(index);
  }
  for (const index of [...volumes.keys()]) if (index >= count) volumes.delete(index);
}
