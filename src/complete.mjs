// Completion for the code pane.
//
// The runtime exposes ~943 pattern methods and ~830 core functions, but most
// are internals (withValue, appWhole, splitQueries) and dumping them teaches
// nothing. So: a curated tier with descriptions, ranked first, then everything
// the runtime actually has as a second tier, so nothing is unreachable.

import { tokenize } from './highlight.mjs';

const CURATED = {
  // structure
  arp: 'spread a chord out in time',
  ctranspose: 'transpose by semitones, an alias of transpose here',
  mtranspose: 'transpose by scale steps, an alias of scaleTranspose here',
  arpWith: 'arpeggiate with your own function over the chord notes',
  pick: 'choose from a list of patterns by index, as in "<0 1>".pick([a, b])',
  invert: 'flip a boolean pattern, for use with struct and mask',
  stack: 'play patterns at the same time',
  cat: 'one pattern per cycle, in turn',
  slowcat: 'one pattern per cycle (same as cat)',
  fastcat: 'squeeze all patterns into one cycle',
  seq: 'play in sequence within one cycle',
  overlay: 'layer a second pattern on top',
  superimpose: 'layer a modified copy over the original',
  layer: 'stack several modified copies',
  silence: 'the empty pattern',
  arrange: 'sections of n cycles each',
  polymeter: 'patterns sharing a step rate',

  // sources
  note: 'pitch, as names (c3 eb4) or numbers',
  n: 'sample index, or note number for synths',
  sound: 'which instrument or sample bank',
  s: 'shorthand for sound',
  freq: 'pitch in Hz, instead of note',

  // time
  slow: 'stretch over more cycles',
  fast: 'squeeze into fewer cycles',
  hurry: 'fast, and speed the samples up too',
  rev: 'reverse each cycle',
  palindrome: 'alternate forwards and backwards',
  iter: 'shift the start point one step each cycle',
  early: 'nudge earlier by a fraction of a cycle',
  late: 'nudge later by a fraction of a cycle',
  off: 'layer a copy shifted in time',
  ply: 'repeat each event n times',
  segment: 'sample a continuous pattern n times a cycle',
  struct: 'take rhythm from here, values from the pattern',
  mask: 'silence events where the mask is false',
  euclid: 'spread n pulses over k steps',
  euclidRot: 'euclid with a rotation',
  euclidLegato: 'euclid, notes held until the next',
  every: 'apply a function every n cycles',
  when: 'apply a function while a test holds',
  whenmod: 'apply on some cycles of a repeating count',
  sometimes: 'apply to about half the events',
  sometimesBy: 'apply with a given probability',
  often: 'apply to about 75% of events',
  rarely: 'apply to about 25% of events',
  almostNever: 'apply to about 10% of events',
  almostAlways: 'apply to about 90% of events',
  always: 'apply to every event',
  never: 'apply to none',
  chunk: 'apply to a different nth of the cycle each time',
  linger: 'repeat the first fraction of the cycle',
  repeatCycles: 'hold each cycle for n repeats',
  compress: 'squeeze the pattern into a time span',
  zoom: 'play only part of the cycle, filling it',
  degrade: 'randomly drop about half the events',
  degradeBy: 'randomly drop events with a probability',
  undegradeBy: 'the complement of degradeBy',
  swingBy: 'delay every other subdivision',
  swing: 'swing with a default amount',

  // pitch
  add: 'add to the current value',
  sub: 'subtract from the current value',
  mul: 'multiply the current value',
  div: 'divide the current value',
  scale: 'map numbers onto a musical scale',
  transpose: 'shift by semitones',
  octave: 'shift by whole octaves',

  // synthesis and mix
  gain: 'output level',
  velocity: 'note velocity',
  pan: 'stereo position',
  cutoff: 'low-pass filter cutoff in Hz',
  lpf: 'low-pass filter cutoff (same as cutoff)',
  resonance: 'low-pass filter resonance',
  hpf: 'high-pass filter cutoff in Hz',
  bpf: 'band-pass filter centre in Hz',
  attack: 'envelope attack',
  decay: 'envelope decay',
  sustain: 'envelope sustain level',
  release: 'envelope release',
  adsr: 'all four envelope stages at once',
  shape: 'waveshaping distortion',
  crush: 'bit crush, lower is harsher',
  coarse: 'sample rate reduction',
  vowel: 'formant filter',
  delay: 'delay send level',
  delaytime: 'delay time',
  delayfeedback: 'how much delay feeds back',
  room: 'reverb send level',
  size: 'reverb size',
  orbit: 'which effects bus to use',
  speed: 'sample playback rate',
  begin: 'start point within the sample',
  end: 'end point within the sample',
  clip: 'scale note length; samples and drum synths only',
  legato: 'note length relative to the step; samples and drum synths only',
  detune: 'detune amount',
  fm: 'FM modulation index',
  fmh: 'FM harmonic ratio',
  bank: 'which sample bank to draw from',
  postgain: 'level after the effects',
  duration: 'fixed event length in seconds',

  jux: 'play a modified copy in the other stereo channel',
  juxBy: 'jux with a stereo width',
  press: 'shift each event into the second half of its step',
  pressBy: 'press by a given amount',
  shuffle: 'split into n parts and reorder them, no repeats',
  scramble: 'split into n parts and pick at random, repeats allowed',
  stut: 'echo n times; arguments are count, feedback, time',
  echo: 'echo n times; arguments are count, time, feedback',
  firstOf: 'apply a function on the first of every n cycles',
  lastOf: 'apply a function on the last of every n cycles',
  someCycles: 'apply a function on about half the cycles',
  fastGap: 'speed up but leave the rest of the cycle silent',
  inside: 'slow down, apply a function, speed back up',
  outside: 'speed up, apply a function, slow back down',
  ribbon: 'loop a slice of the pattern, from a cycle for a length',
  iterBack: 'shift the start point one step backwards each cycle',
  brak: 'on alternate cycles, shift and squeeze the pattern',
  plyWith: 'repeat each event n times, applying a function each repeat',
  squeeze: 'squeeze a chosen pattern into each event',
  chop: 'cut each sample into n consecutive pieces',
  striate: 'interlace n pieces of the sample across all events',
  slice: 'split the sample into n parts and play chosen indices',
  splice: 'slice, stretched to fit the step',
  loopAt: 'stretch a sample over n cycles',
  cut: 'cut group: a new event stops the previous one on the same number',
  fit: 'set playback to fit the event length',
  nudge: 'shift in seconds, for micro timing',
  phaser: 'sweeping phaser',
  tremolo: 'amplitude wobble',
  leslie: 'rotating speaker',
  comb: 'comb filter',
  ring: 'ring modulation',
  krush: 'harsh saturation',
  squiz: 'harmonic squash',
  waveloss: 'drop part of the waveform, lo-fi',
  triode: 'valve style saturation',
  drive: 'input level into the distortion',
  compressor: 'dynamics compression, threshold:ratio:knee:attack:release',
  roomsize: 'reverb room size',
  roomfade: 'reverb fade time',
  unison: 'stack n detuned copies of the oscillator',
  hcutoff: 'high-pass cutoff, same as hpf',
  hresonance: 'high-pass resonance',
  lpenv: 'how far the filter envelope sweeps the cutoff',
  lpattack: 'filter envelope attack',
  bandf: 'band-pass centre, same as bpf',
  delayfb: 'delay feedback, same as delayfeedback',
  delayt: 'delay time, same as delaytime',
  scaleTranspose: 'transpose by scale steps, needs scale()',
  mode: 'voicing mode for chords, such as root:e',
  range: 'scale a signal into a range, as in sine.range(200, 2000)',
  vib: 'vibrato rate',
  pw: 'pulse width, for the pulse oscillator',
  seed: 'fix the random seed so randomness repeats',
  flanger: 'flange this pattern alone, 0 to 1; not a superdough control, see the guide',
  visualizer: 'draw a strip under this line: "roll", "steps" or "wave"',
  label: 'tag events; browser only, no effect here',
  color: 'colour for visuals; browser only, no effect here',
};

// Tidal and SuperCollider controls that strudel accepts and superdough 1.3.0
// does not implement: they evaluate, change the event, and alter the sound not
// at all, which is miserable to chase by ear. Verified by rendering with and
// without each through an OfflineAudioContext, identical to the bit. A
// superdough upgrade is what would make this wrong, so re-check it.
const UNSUPPORTED = {
  chorus: 'no effect here; the mixer has a chorus that works, this control does not',
  overgain: 'no effect here; superdough never reads it, use gain or postgain',
  leslie: 'rotating speaker; no effect here, superdough has none',
  ring: 'ring modulation; no effect here, superdough has none',
  ringf: 'ring modulator frequency; no effect here',
  krush: 'harsh saturation; no effect here, superdough has none',
  squiz: 'harmonic squash; no effect here, superdough has none',
  waveloss: 'drop part of the waveform; no effect here',
  triode: 'valve saturation; no effect here, superdough has none',
};

// Typical working ranges. These are not hard limits: most controls accept
// anything and simply sound wrong outside these. Where superdough reports a
// default it is quoted here, and those five are the only values in this table
// taken from the code rather than written by hand.
const RANGES = {
  gain: '0 to 1, default 0.8',
  postgain: '0 to 2, default 1',
  pan: '0 left to 1 right',
  velocity: '0 to 1',

  cutoff: '20 to 20000 Hz, useful 200 to 8000',
  lpf: '20 to 20000 Hz, useful 200 to 8000',
  resonance: '0 to 30, gets whistly past 20',
  hpf: '20 to 20000 Hz',
  bpf: '20 to 20000 Hz',
  vowel: 'a e i o u, not a number',

  attack: '0 to 2 seconds',
  decay: '0 to 2 seconds',
  sustain: '0 to 1',
  release: '0 to 2 seconds, default 0.01',

  shape: '0 to 1, harsh above 0.7',
  crush: '1 to 16 bits',
  coarse: '1 to 32, whole numbers',
  distort: '0 to 4',

  delay: '0 to 1, default 0',
  delaytime: '0 to 1 seconds',
  delayfeedback: '0 to 0.9, default 0.5, runs away at 1',
  room: '0 to 1',
  size: '0 to 1',
  orbit: 'whole numbers from 0',

  speed: '0.25 to 4, negative plays backwards',
  begin: '0 to 1',
  end: '0 to 1',
  legato: '0 to 2',
  clip: '0 to 2',

  slow: 'cycles, 2 is half speed',
  fast: 'cycles, 2 is double speed',
  ply: 'whole numbers',
  segment: 'events per cycle',
  degradeBy: '0 to 1, chance of dropping',
  sometimesBy: '0 to 1, chance of applying',

  juxBy: '0 to 1 stereo width',
  pressBy: '0 to 1',
  shuffle: 'whole numbers',
  scramble: 'whole numbers',
  fastGap: 'cycles, 2 fills the first half',
  chop: 'whole numbers',
  striate: 'whole numbers',
  loopAt: 'cycles',
  cut: 'whole numbers, a group id',
  nudge: 'seconds, try -0.05 to 0.05',
  unison: 'whole numbers, 2 to 8',
  hcutoff: '20 to 20000 Hz',
  hresonance: '0 to 30',
  lpattack: '0 to 2 seconds',
  bandf: '20 to 20000 Hz',
  delayfb: '0 to 0.9',
  delayt: '0 to 1 seconds',
  scaleTranspose: 'whole numbers, scale steps',
  pw: '0 to 1',
  phaser: 'sweeps per cycle',
  tremolo: 'wobbles per cycle',
  vib: 'wobbles per cycle',
  roomsize: 'try 1 to 10',
};

export function rangeOf(name) {
  return RANGES[name] ?? null;
}

// A shortlist for the reference panel. Every range is also attached to its
// entry in tab-completion, which is the contextual place to read it; this page
// is for when you do not yet know the name to type.
const CONTROL_GROUPS = [
  ['level', ['gain', 'pan']],
  ['filter', ['cutoff', 'resonance', 'hpf', 'vowel']],
  ['envelope', ['attack', 'decay', 'sustain', 'release']],
  ['dirt', ['shape', 'crush', 'coarse']],
  ['space', ['delay', 'delayfeedback', 'room', 'size']],
  ['sample', ['speed', 'begin', 'end']],
];

export function controlReference() {
  return CONTROL_GROUPS.map(([heading, names]) => ({
    heading,
    entries: names.map((name) => ({ name, range: RANGES[name] ?? '' })),
  }));
}

let vocabulary = { methods: [], globals: [], sounds: [] };

// Pull the real names out of the loaded modules, so this never drifts from
// whatever version is installed.
export async function initVocabulary({ pattern, modules = [], dough }) {
  const methods = new Set();
  let proto = pattern ? Object.getPrototypeOf(pattern) : null;
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name.startsWith('_') || name === 'constructor' || !/^[a-z]/i.test(name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (descriptor && typeof descriptor.value === 'function') methods.add(name);
    }
    proto = Object.getPrototypeOf(proto);
  }

  const globals = new Set();
  for (const mod of modules) {
    for (const [name, value] of Object.entries(mod ?? {})) {
      if (typeof value === 'function' && !name.startsWith('_') && /^[a-z]/i.test(name)) globals.add(name);
    }
  }

  let sounds = [];
  try {
    sounds = Object.keys(dough?.soundMap?.get?.() ?? {});
  } catch {
    sounds = [];
  }

  vocabulary = {
    methods: [...methods].sort(),
    globals: [...globals].sort(),
    sounds: sounds.sort(),
  };
  return vocabulary;
}

export function describe(name) {
  if (name in UNSUPPORTED) return UNSUPPORTED[name];
  return CURATED[name] ?? null;
}

export function isUnsupported(name) {
  return name in UNSUPPORTED;
}

// Both of these lean on the editor's tokenizer rather than scanning for quotes
// and "//" here, so completion agrees with what the syntax highlighting says a
// character is. Counting double quotes was the old approach and it could not
// see `s('bd')` or a backticked mini-notation block as strings at all, so the
// completer offered function names inside them.
const QUOTES = new Set(['"', "'", '`']);

function kindsOf(line) {
  const kinds = new Array(line.length);
  let pos = 0;
  for (const segment of tokenize(line)) {
    for (let i = 0; i < segment.text.length; i++) kinds[pos + i] = segment.kind;
    pos += segment.text.length;
  }
  return kinds;
}

function inComment(kinds, col) {
  return col > 0 && kinds[col - 1] === 'comment';
}

// Where the string literal under the cursor opens, or -1 if the cursor is not
// inside one. Mini-notation is tokenized separately inside a string, so both
// kinds count as part of the same run.
function stringOpensAt(line, kinds, col) {
  const inside = (kind) => kind === 'string' || kind === 'mini';
  if (col === 0 || !inside(kinds[col - 1])) return -1;

  let open = col - 1;
  while (open > 0 && inside(kinds[open - 1])) open--;
  if (!QUOTES.has(line[open])) return -1;

  let end = col - 1;
  while (end + 1 < line.length && inside(kinds[end + 1])) end++;
  // sitting just past the closing quote is outside the string, not in it
  if (col - 1 === end && end > open && line[end] === line[open]) return -1;

  return open;
}

// What is the cursor sitting in: a method call after a dot, a bare word, or a
// string that names a sound?
export function contextAt(line, col) {
  const kinds = kindsOf(line);
  if (inComment(kinds, col)) return { kind: 'comment', token: '', start: col };

  const before = line.slice(0, col);
  const openIdx = stringOpensAt(line, kinds, col);

  if (openIdx >= 0) {
    const token = (before.slice(openIdx + 1).match(/[A-Za-z0-9_]*$/) ?? [''])[0];
    const call = before.slice(0, openIdx).match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*$/);
    const fn = call?.[1];
    const kind = fn === 'sound' || fn === 's' || fn === 'bank' ? 'sound' : 'string';
    return { kind, token, start: col - token.length };
  }

  const token = (before.match(/[A-Za-z0-9_]*$/) ?? [''])[0];
  const start = col - token.length;
  const prev = start > 0 ? before[start - 1] : '';
  return { kind: prev === '.' ? 'method' : 'global', token, start };
}

const LIMIT = 24;

function rank(names, token) {
  const lower = token.toLowerCase();
  const curatedPrefix = [];
  const plainPrefix = [];
  const curatedSub = [];
  const plainSub = [];

  for (const name of names) {
    const l = name.toLowerCase();
    const curated = name in CURATED;
    if (lower === '' ) {
      if (curated) curatedPrefix.push(name);
      continue; // with no prefix, only suggest the curated set
    }
    if (l.startsWith(lower)) (curated ? curatedPrefix : plainPrefix).push(name);
    else if (l.includes(lower)) (curated ? curatedSub : plainSub).push(name);
  }

  return [...curatedPrefix, ...plainPrefix, ...curatedSub, ...plainSub].slice(0, LIMIT);
}

export function completionsFor(line, col) {
  const ctx = contextAt(line, col);
  let pool;
  switch (ctx.kind) {
    case 'method': pool = vocabulary.methods; break;
    case 'global': pool = vocabulary.globals; break;
    case 'sound': pool = vocabulary.sounds; break;
    default: return { ...ctx, matches: [] };
  }
  // a bare cursor mid-code should not pop the whole dictionary
  if (ctx.kind === 'global' && ctx.token === '') return { ...ctx, matches: [] };
  return { ...ctx, matches: rank(pool, ctx.token) };
}
