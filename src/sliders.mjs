// Live sliders. The transpiler rewrites `slider(0.5)` into sliderWithID with a
// widget list of values, ranges and offsets; this supplies that function and
// returns a signal reading a mutable slot, so moving one needs no
// re-evaluation. Slots are keyed by order of appearance rather than by the
// generated id, which is an offset and would reset mid-performance on an edit
// above it.

import { BUS_PRESETS, BUS_PARAMS } from './buseffects.mjs';

// Tempo is not a slider in the code, it is session state, so it lives outside
// the registry and is rendered as the first row of the same panel. Keeping it
// out means `b` never tries to bake it into a source file that has nowhere to
// put it.
export const TEMPO_MIN_BPM = 40;
export const TEMPO_MAX_BPM = 200;

// the header has always shown cps * 240 as bpm; keep the two in step
export const bpmFromCps = (cps) => cps * 240;
export const cpsFromBpm = (bpm) => bpm / 240;

// Global sends, ridden from the panel rather than written into the pattern.
// Like tempo these are session state, so they stay out of the slider registry
// and out of `b`.
// Bus parameter values are keyed <effect><Param>, so flangerRate and the rest
// sit in the same flat bag as the sends and are saved and restored with them.
const busDefaults = {};
for (const [name, preset] of Object.entries(BUS_PRESETS)) {
  for (const param of BUS_PARAMS) {
    busDefaults[`${name}${param.key[0].toUpperCase()}${param.key.slice(1)}`] = preset[param.key];
  }
}

export const globals = { room: 0, delay: 0, flanger: 0, chorus: 0, ...busDefaults };

// room and delay are per-voice sends: they are merged into each event, because
// superdough implements them. flanger and chorus have no superdough control at
// all, so they are master bus effects instead, marked here so the engine knows
// not to try to send them with an event. Both kinds are ridden the same way.
export const GLOBAL_ROWS = [
  { key: 'room', label: 'reverb', min: 0, max: 1 },
  { key: 'delay', label: 'delay', min: 0, max: 1 },
];

// Each bus effect contributes its mix and then its own parameters. The
// parameter rows carry `showWith`, and the panel only lists them when that
// effect is turned up: four rows per effect on a panel that also has the tempo,
// the sends and every track would bury everything else.
for (const name of Object.keys(BUS_PRESETS)) {
  GLOBAL_ROWS.push({ key: name, label: name, min: 0, max: 1, bus: true });
  for (const param of BUS_PARAMS) {
    GLOBAL_ROWS.push({
      key: `${name}${param.key[0].toUpperCase()}${param.key.slice(1)}`,
      label: `${name.slice(0, 4)} ${param.label}`,
      min: param.min,
      max: param.max,
      bus: true,
      showWith: name,
      param: { effect: name, key: param.key },
    });
  }
}

export const BUS_ROWS = GLOBAL_ROWS.filter((row) => row.bus);

export function adjustGlobal(key, direction, steps = 40) {
  const row = GLOBAL_ROWS.find((r) => r.key === key);
  if (!row) return null;
  const step = (row.max - row.min) / steps;
  globals[key] = clamp(globals[key] + direction * step, row.min, row.max);
  return globals[key];
}

let core = null;
const slots = new Map(); // ordinal -> { value, min, max, label }
let idToSlot = new Map();

export function attachCore(strudelCore) {
  core = strudelCore;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Name the slider after the control it feeds, which is what you want to read
// in the panel: `.cutoff(slider(800))` shows up as "cutoff".
function labelFor(code, from) {
  // the offset points at the slider's own argument, so step back over the
  // `slider(` call before looking for the control that wraps it
  const before = code.slice(0, from).replace(/\bslider\s*\(\s*$/, '');
  const match = /\.?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(\s*$/.exec(before);
  return match ? match[1] : 'slider';
}

/**
 * Called with the transpiler's widget list before evaluation, so ids can be
 * resolved to stable slots and labels.
 */
export function prepare(code, widgets = []) {
  idToSlot = new Map();

  const sliders = widgets.filter((w) => w.type === 'slider');
  sliders.forEach((widget, ordinal) => {
    idToSlot.set(`slider_${widget.from}`, ordinal);

    const min = Number(widget.min ?? 0);
    const max = Number(widget.max ?? 1);
    const initial = Number(widget.value ?? min);
    const label = labelFor(code, widget.from);
    const existing = slots.get(ordinal);

    if (existing) {
      // keep whatever the user dialled in, but respect a changed range
      existing.min = min;
      existing.max = max;
      existing.label = label;
      existing.from = widget.from;
      existing.to = widget.to;
      existing.value = clamp(existing.value, min, max);
    } else {
      slots.set(ordinal, {
        value: clamp(Number.isFinite(initial) ? initial : min, min, max),
        min,
        max,
        label,
        from: widget.from,
        to: widget.to,
      });
    }
  });

  // Drop slots for sliders that are no longer in the file. Keys are compared as
  // ordinals, so this also clears the id-keyed fallback slots below: a plain
  // `ordinal >= sliders.length` test is false for a string key, which left
  // phantom rows in the panel and in saved state for the rest of the session.
  for (const key of [...slots.keys()]) {
    if (!Number.isInteger(key) || key >= sliders.length) slots.delete(key);
  }
  return sliders.length;
}

// Injected into the eval scope. The transpiler rewrites every `slider(...)`
// call into one of these.
//
// A slider that prepare() did not see still has to make sound, so it falls back
// to a slot keyed by its id rather than an ordinal. It is deliberately not a
// panel row: there is no source range to ride it back to. The next prepare()
// clears it.
export function sliderWithID(id, value = 0.5, min = 0, max = 1) {
  const ordinal = idToSlot.get(id);
  const key = ordinal ?? id;

  if (!slots.has(key)) {
    const initial = Number(value);
    slots.set(key, {
      value: clamp(Number.isFinite(initial) ? initial : Number(min), Number(min), Number(max)),
      min: Number(min),
      max: Number(max),
      label: 'slider',
      from: null,
      to: null,
    });
  }

  const slot = slots.get(key);
  if (!core) return slot.value;
  return core.signal(() => slot.value);
}

export function list() {
  return [...slots.entries()]
    .filter(([ordinal]) => Number.isInteger(ordinal))
    .sort((a, b) => a[0] - b[0])
    .map(([ordinal, slot]) => ({ ordinal, ...slot }));
}

export function count() {
  return list().length;
}

// steps is how many presses it takes to cross the whole range
export function adjust(ordinal, direction, steps = 40) {
  const slot = slots.get(ordinal);
  if (!slot) return null;
  const span = slot.max - slot.min;
  const step = span / steps;
  slot.value = clamp(slot.value + direction * step, slot.min, slot.max);
  return slot.value;
}

// Positions only, keyed by slot. Ranges and labels come back from the code on
// the next evaluation, so there is no point storing them.
export function snapshot() {
  const values = {};
  for (const { ordinal, value } of list()) values[ordinal] = value;
  return values;
}

// Applied after the first evaluation, once the slots and their ranges exist.
// A saved value outside a range the code has since changed is clamped rather
// than dropped, and slots that no longer exist are ignored.
export function restore(values) {
  if (!values || typeof values !== 'object') return 0;
  let restored = 0;
  for (const [key, raw] of Object.entries(values)) {
    const ordinal = Number(key);
    const slot = slots.get(ordinal);
    const value = Number(raw);
    if (!slot || !Number.isFinite(value)) continue;
    slot.value = clamp(value, slot.min, slot.max);
    restored++;
  }
  return restored;
}

export function reset() {
  slots.clear();
  idToSlot = new Map();
}

// Round for display and for writing back into source: enough digits to be
// useful, not so many that the code fills with noise.
export function format(value, min, max) {
  const span = Math.abs(max - min);
  const digits = span >= 100 ? 0 : span >= 10 ? 1 : span > 1 ? 2 : 3;
  return Number(value.toFixed(digits)).toString();
}

/**
 * Write the current values back into the source, replacing each slider's first
 * argument. The transpiler's offsets point at that argument, so this is an
 * exact replacement. Applied right to left so earlier offsets stay valid.
 */
export function bake(code) {
  const edits = list()
    .filter((slot) => slot.from != null && slot.to != null)
    .sort((a, b) => b.from - a.from);

  let out = code;
  let changed = 0;
  for (const slot of edits) {
    const text = format(slot.value, slot.min, slot.max);
    if (out.slice(slot.from, slot.to) === text) continue;
    out = out.slice(0, slot.from) + text + out.slice(slot.to);
    changed++;
  }
  return { code: out, changed };
}
