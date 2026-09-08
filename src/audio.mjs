import './shim.mjs';
import { AudioContext } from 'node-web-audio-api';
import { createBusChain } from './buseffects.mjs';
import { createOrbitInserts } from './orbitinsert.mjs';

let ctx = null;
let dough = null;
let lastError = null;
let masterAnalyser = null;
let waveBuffer = null;
let reclaimTimer = null;

// Silent mode runs everything except the sound: the transport, the roll, the
// editor and every key still work, but no audio device is opened. Useful for
// editing where you cannot make noise, and it makes the whole interface
// testable without touching hardware.
let silent = false;
let silentOrigin = 0;

let busChain = null;

// mix is 0 to 1. The graph lives in buseffects.mjs so the bounce builds the same one.
export function setBusEffect(name, mix) {
  return busChain ? busChain.setMix(name, mix) : false;
}

export function setBusParam(name, param, value) {
  return busChain ? busChain.setParam(name, param, value) : false;
}

export function busEffectNames() {
  return busChain ? busChain.names() : [];
}

export function isSilent() {
  return silent;
}
let realDestination = null;
let capacityWatch = null;

// node-web-audio-api keeps disconnected nodes in the render graph until V8
// collects their wrappers, and the wrappers are tiny enough that V8 never runs:
// dead nodes pile up until render load passes realtime and audio drops out.
// Forcing it every 4s measured 0.49 load against 1.23, worst pause 7.3ms on a
// 150ms lookahead.
const RECLAIM_MS = Number(process.env.STRUDEL_TERM_GC_MS ?? 4000);

// Render load and underruns, straight from the audio backend. Above 1.0 means
// the renderer needs more than realtime to produce realtime, which is audible.
let loadPeak = 0;
let underruns = 0;

function watchRenderLoad(context) {
  const capacity = context.renderCapacity;
  if (!capacity?.addEventListener) return;
  capacityWatch = capacity;
  capacity.addEventListener('update', (event) => {
    loadPeak = Math.max(loadPeak, event.peakLoad ?? 0);
    underruns += event.underrunRatio ?? 0;
  });
  capacity.start?.({ updateInterval: 1 });
}

// Reading resets the peak, so each read covers the period since the last one.
export function renderStats() {
  const stats = { peakLoad: loadPeak, underruns };
  loadPeak = 0;
  return stats;
}

export function reclaimAvailable() {
  return typeof global.gc === 'function';
}

function startReclaiming() {
  if (reclaimTimer || !reclaimAvailable() || RECLAIM_MS <= 0) return;
  reclaimTimer = setInterval(() => {
    try {
      global.gc();
    } catch {
      // nothing to be done; audio will degrade slowly
    }
  }, RECLAIM_MS);
  reclaimTimer.unref?.();
}

export async function initAudio(latencyHint = null, options = {}) {
  if (options.silent) {
    silent = true;
    silentOrigin = performance.now();
    return;
  }
  if (ctx) return;

  // A bigger buffer is the standard cure for crackling. node-web-audio-api
  // accepts a latency hint in seconds, though it reports the resulting latency
  // as zero here, so the effect is audible rather than measurable.
  ctx = latencyHint ? new AudioContext({ latencyHint }) : new AudioContext();

  // Tap the master output instead of tagging every voice with `analyze`.
  // superdough's per-voice tap misses the sample path completely, so a
  // drums-only pattern read as silence on the scope. Shadowing `destination`
  // with a pass-through analyser catches everything that reaches the speakers,
  // synths and samples alike. AnalyserNode is transparent to audio, verified by
  // rendering the same graph with and without it.
  realDestination = ctx.destination;
  masterAnalyser = ctx.createAnalyser();
  masterAnalyser.fftSize = 2048;
  masterAnalyser.connect(realDestination);

  // Bus effects sit in front of the analyser, so the scope shows what you hear
  // rather than the signal before them.
  busChain = createBusChain(ctx, masterAnalyser);

  // superdough sizes its output from the destination's channel count, and a
  // GainNode or AnalyserNode has no maxChannelCount, which it reads as zero
  // channels. The shadowed destination is the one that has to answer.
  Object.defineProperty(masterAnalyser, 'maxChannelCount', {
    get: () => realDestination.maxChannelCount,
    configurable: true,
  });
  Object.defineProperty(busChain.input, 'maxChannelCount', {
    get: () => realDestination.maxChannelCount,
    configurable: true,
  });
  Object.defineProperty(ctx, 'destination', {
    get: () => busChain.input,
    configurable: true,
  });
  waveBuffer = new Float32Array(masterAnalyser.fftSize);

  // Contexts can come up suspended, and on a wedged device resume() never
  // settles, so it is raced against a timeout rather than awaited outright.
  if (ctx.state === 'suspended') {
    await Promise.race([
      ctx.resume().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  }

  startReclaiming();
  watchRenderLoad(ctx);

  dough = await import('superdough');

  // superdough keeps its context in a module-level singleton. Only
  // setAudioContext takes one: setDefaultAudioContext ignores its argument and
  // does `new AudioContext()`, opening a second device that nothing then
  // closes. Calling both, which this used to do, meant every run claimed the
  // output device twice and kept the spare.
  dough.setAudioContext(ctx);
  dough.registerSynthSounds();
  try {
    dough.registerZZFXSounds?.();
  } catch {
    // optional bank, ignore
  }

  // Worklet-backed sounds are authored as browser modules and may not resolve
  // here. The oscillator synths don't need them, so a failure is not fatal.
  try {
    await dough.loadWorklets?.();
  } catch (err) {
    lastError = `worklets unavailable: ${err.message}`;
  }
}

const orbitInserts = createOrbitInserts({ getContext: () => ctx, getDough: () => dough });

export function setOrbitFlangers(specs) {
  orbitInserts.setFlangers(specs);
}

// Time-domain samples for one .analyze() id, used by the wave visualizer.
// Null offline and before anything has played through that analyser.
export function analyserData(id) {
  if (silent || !dough) return null;
  try {
    return dough.getAnalyzerData?.('time', id) ?? null;
  } catch {
    return null;
  }
}

// Latest time-domain block from the master tap, or null before audio starts.
// The same buffer is reused each call; the renderer consumes it immediately.
export function waveform() {
  if (silent) return null;
  if (!masterAnalyser || !waveBuffer) return null;
  try {
    masterAnalyser.getFloatTimeDomainData(waveBuffer);
    return waveBuffer;
  } catch {
    return null;
  }
}

// How many variants of one sound to warm. Only the default one: `bd:0` is what
// you get without an index, and decoding is not free. Four variants of four
// sounds measured at 350ms of work the first time a new sound appears, which
// lands exactly when you type a sound name and is the worst possible moment.
// Asking for bd:3 still loads it lazily, once.
const PRELOAD_VARIANTS = 1;

export async function loadSampleBank(url) {
  if (!dough) throw new Error('audio not initialised');
  await dough.samples(url);
  return Object.keys(dough.soundMap?.get?.() ?? {}).length;
}

// superdough downloads a sample the first time it is triggered, which means the
// first hit of a new sound is swallowed while the file arrives. Warm the ones a
// pattern actually uses, so that never happens on a beat you meant to hear.
export async function preloadSounds(names) {
  if (!dough || !ctx || !names?.length) return 0;

  const jobs = [];
  for (const name of names) {
    let entry;
    try {
      entry = dough.getSound(name);
    } catch {
      continue;
    }
    const data = entry?.data;
    if (!data || data.type !== 'sample') continue;

    // a bank is either a flat list of urls or an object keyed by note
    const urls = Array.isArray(data.samples)
      ? data.samples
      : Object.values(data.samples ?? {}).flat();

    urls.slice(0, PRELOAD_VARIANTS).forEach((url, index) => {
      jobs.push(dough.loadBuffer(url, ctx, name, index).catch(() => {}));
    });
  }

  await Promise.all(jobs);
  return jobs.length;
}

// The clock only advances once the device is actually rendering. If it is not,
// everything downstream still behaves as though it is playing: the transport
// says playing, the roll draws, and nothing makes a sound. Report it instead.
// Cheap synchronous check. A context whose clock has not moved since the last
// look is not rendering, and scheduling into it blocks the calling thread
// inside the audio FFI, taking the UI down with it.
let lastSeenTime = -1;

export function deviceLooksDead() {
  if (silent) return false;
  if (!ctx) return true;
  const now = ctx.currentTime;
  const stalled = now === lastSeenTime;
  lastSeenTime = now;
  return ctx.state !== 'running' && stalled;
}

// An idle context's clock does not advance, so waiting on it to move before
// scheduling anything never resolves: the clock needs work to render, and the
// work was gated on the clock. Give it something silent to chew on, then poll.
export async function deviceIsRunning(timeoutMs = 3000) {
  if (silent) return true;
  if (!ctx) return false;

  try {
    const probe = ctx.createOscillator();
    const silence = ctx.createGain();
    silence.gain.value = 0;
    probe.connect(silence).connect(ctx.destination);
    probe.start();
    probe.stop(ctx.currentTime + 0.3);
  } catch {
    return false;
  }

  const deadline = Date.now() + timeoutMs;
  let last = ctx.currentTime;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (ctx.currentTime > last) return true;
    last = ctx.currentTime;
  }
  return false;
}

export function contextState() {
  if (silent) return 'silent';
  return ctx?.state ?? 'closed';
}

export function audioTime() {
  if (silent) return (performance.now() - silentOrigin) / 1000;
  return ctx ? ctx.currentTime : 0;
}

export function sampleRate() {
  return ctx ? ctx.sampleRate : 0;
}

export function workletWarning() {
  return lastError;
}

// value is a strudel control object, time is absolute audio-context seconds,
// duration is in seconds.
export function trigger(value, time, duration) {
  if (silent) return null;
  if (!dough) return null;
  try {
    dough.superdough(value, time, duration);
    orbitInserts.ensure(value?.orbit);
    return null;
  } catch (err) {
    return err.message;
  }
}

export async function closeAudio() {
  if (!ctx) return;
  const closing = ctx;
  const analyser = masterAnalyser;
  const original = realDestination;

  ctx = null;
  dough = null;
  masterAnalyser = null;
  waveBuffer = null;
  realDestination = null;
  // the oscillators would otherwise keep the graph alive after the context goes
  busChain?.stop();
  busChain = null;
  clearInterval(reclaimTimer);
  reclaimTimer = null;

  // Unwind in the reverse order it was built. The destination is a shadowed
  // getter returning the analyser, so close() would otherwise be reasoning
  // about a node that is not the real output.
  try {
    capacityWatch?.stop?.();
  } catch {
    // not all builds expose it
  }
  capacityWatch = null;

  try {
    analyser?.disconnect();
  } catch {
    // already disconnected
  }
  if (original) {
    try {
      Object.defineProperty(closing, 'destination', {
        get: () => original,
        configurable: true,
      });
    } catch {
      // leave the shadow in place rather than fail the shutdown
    }
  }

  try {
    await closing.close();
  } catch {
    // already gone
  }
}
