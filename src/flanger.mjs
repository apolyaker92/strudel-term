// .flanger(amount) as a per pattern effect.
//
// superdough has no flanger, so the mixer's one runs on the master output. That
// is global by definition, and a pattern method should not be. Each call takes
// an orbit of its own, which is superdough's own idea of an effect bus, and the
// audio layer hangs a modulated delay on that orbit between its summing node
// and its output. That is how superdough inserts its own djf filter.
//
// Orbits are a shared namespace, so allocation starts well above the default of
// 1, and a pattern that sets its own orbit keeps it.

const FIRST_ORBIT = 8;

let next = FIRST_ORBIT;
let pending = [];

export function resetFlangers() {
  next = FIRST_ORBIT;
  pending = [];
}

/** Orbit and mix for every .flanger() in the last evaluation. */
export function flangerSpecs() {
  return pending;
}

// The transpiler turns a bare argument into mini notation, so a number can
// arrive as a Pattern. Same trick the visualizer kind uses.
function amountOf(value) {
  if (typeof value === 'number') return value;
  try {
    const first = value?.queryArc?.(0, 1)?.[0]?.value;
    return typeof first === 'number' ? first : Number(first) || 0;
  } catch {
    return 0;
  }
}

export function installFlanger(core) {
  core.Pattern.prototype.flanger = function flanger(amount) {
    const mix = amountOf(amount);
    const orbit = next++;
    pending.push({ orbit, mix });
    return this.orbit(orbit);
  };
}
