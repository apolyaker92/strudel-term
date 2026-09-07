// Master bus effects, built by both the live output and the offline bounce so
// the two cannot drift. superdough 1.3.0 has neither a flanger nor a chorus and
// no way to add one per voice, so these run on the master output. Both are one
// delay line swept by an LFO, told apart only by their numbers.

// rate is the sweep in Hz, depth how far the delay moves in milliseconds, and
// feedback how much of the line returns to it, which is what makes it resonate.
export const BUS_PRESETS = {
  flanger: { delay: 0.003, depth: 2, rate: 1.2, feedback: 0.5 },
  chorus: { delay: 0.025, depth: 6, rate: 1.2, feedback: 0 },
};

// What can be changed while it runs, with the range each is worth having.
export const BUS_PARAMS = [
  { key: 'rate', label: 'rate', min: 0.05, max: 8, unit: 'Hz' },
  { key: 'depth', label: 'depth', min: 0, max: 12, unit: 'ms' },
  { key: 'feedback', label: 'fdbk', min: 0, max: 0.9, unit: '' },
];

export function makeModDelay(context, { delay, depth, rate, feedback }) {
  const input = context.createGain();
  const line = context.createDelay(0.5);
  const wet = context.createGain();
  const lfo = context.createOscillator();
  const sweep = context.createGain();
  // Always built, even at zero. It used to be created only when the preset
  // asked for feedback, which meant a chorus could never be given any without
  // rebuilding the graph, and these are meant to be moved while they run.
  const loop = context.createGain();

  line.delayTime.value = delay;
  lfo.frequency.value = rate;
  sweep.gain.value = depth / 1000;
  loop.gain.value = feedback;
  // silent until turned up, so the chain costs nothing when nothing is on
  wet.gain.value = 0;

  input.connect(line);
  line.connect(wet);
  lfo.connect(sweep);
  sweep.connect(line.delayTime);
  line.connect(loop);
  loop.connect(line);
  lfo.start();

  return { input, output: wet, wet, lfo, sweep, loop, line };
}

/**
 * Build the bus and return its input plus a way to set each effect's mix.
 * Everything is wired in parallel with the dry signal, so an effect at zero is
 * bit identical to no effect at all.
 */
export function createBusChain(context, destination, overrides = {}) {
  const input = context.createGain();
  const output = context.createGain();
  const effects = {};
  const mixes = {};

  // Wet is added to dry rather than replacing it, which is what makes a flanger
  // comb rather than just delay, but it also means turning one up adds level.
  // At full mix on a busy pattern that was a peak of 1.36, which the bounce
  // scaled down and live playback would simply have clipped. The output is
  // trimmed by however much is currently turned up so the level stays put.
  const retrim = () => {
    const total = Object.values(mixes).reduce((sum, mix) => sum + mix, 0);
    const gain = 1 / (1 + 0.6 * total);
    try {
      output.gain.setTargetAtTime(gain, context.currentTime, 0.02);
    } catch {
      output.gain.value = gain;
    }
  };

  input.connect(output);
  output.connect(destination);
  for (const [name, preset] of Object.entries(BUS_PRESETS)) {
    const effect = makeModDelay(context, { ...preset, ...(overrides[name] ?? {}) });
    input.connect(effect.input);
    effect.output.connect(output);
    effects[name] = effect;
    mixes[name] = 0;
  }

  return {
    input,
    effects,
    names: () => Object.keys(effects),
    /**
     * Ramped rather than assigned: a step change in a gain feeding a delay line
     * is a click, and riding one of these is a stream of small steps. Offline
     * contexts have a currentTime of zero, where a ramp still resolves.
     */
    setMix(name, mix) {
      const effect = effects[name];
      if (!effect) return false;
      const target = Math.max(0, Math.min(1, Number(mix) || 0));
      try {
        effect.wet.gain.setTargetAtTime(target, context.currentTime, 0.02);
      } catch {
        effect.wet.gain.value = target;
      }
      mixes[name] = target;
      retrim();
      return true;
    },
    /**
     * Change one of an effect's parameters while it runs. Ramped, because a
     * step in a delay time is a click and these are meant to be ridden.
     */
    setParam(name, param, value) {
      const effect = effects[name];
      const meta = BUS_PARAMS.find((entry) => entry.key === param);
      if (!effect || !meta) return false;
      const clamped = Math.max(meta.min, Math.min(meta.max, Number(value)));
      if (!Number.isFinite(clamped)) return false;

      const target =
        param === 'rate' ? effect.lfo.frequency
          : param === 'depth' ? effect.sweep.gain
            : effect.loop.gain;
      // depth is carried in milliseconds, the delay line works in seconds
      const scaled = param === 'depth' ? clamped / 1000 : clamped;
      try {
        target.setTargetAtTime(scaled, context.currentTime, 0.02);
      } catch {
        target.value = scaled;
      }
      return true;
    },
    stop() {
      for (const effect of Object.values(effects)) {
        try {
          effect.lfo.stop();
          effect.lfo.disconnect();
        } catch {
          // already stopped
        }
      }
    },
  };
}
