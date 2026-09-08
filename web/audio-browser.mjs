// Browser twin of src/audio.mjs. superdough is a browser library, so here it
// gets a real AudioContext instead of node-web-audio-api and src/shim.mjs
// pretending to be one. The forced GC goes too; that bug is the addon's.

import { createBusChain } from '../src/buseffects.mjs';

let ctx = null;
let dough = null;
let analyser = null;
let waveBuffer = null;
let bus = null;

export async function initAudio(latencyHint = null) {
  if (ctx) return;
  ctx = new AudioContext(latencyHint ? { latencyHint } : undefined);
  dough = await import('superdough');

  // Bus effects in front of the analyser, so the scope shows what you hear.
  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.connect(ctx.destination);
  bus = createBusChain(ctx, analyser);
  waveBuffer = new Float32Array(analyser.fftSize);

  const speakers = ctx.destination;

  // superdough sizes its output from destination.maxChannelCount. A GainNode
  // has none, so it reads undefined and the output stage dies in silence.
  for (const node of [analyser, bus.input]) {
    Object.defineProperty(node, 'maxChannelCount', {
      get: () => speakers.maxChannelCount,
      configurable: true,
    });
  }

  Object.defineProperty(ctx, 'destination', {
    get: () => bus.input,
    configurable: true,
  });
  // keep a handle on the real one so closeAudio can put it back
  ctx.__speakers = speakers;

  dough.setAudioContext(ctx);
  dough.registerSynthSounds();
  try {
    dough.registerZZFXSounds?.();
  } catch {
    // optional bank
  }
  try {
    await dough.loadWorklets?.();
  } catch {
    // worklet-backed sounds are unavailable; the rest still play
  }

  // A context made before a user gesture starts suspended.
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
}

export function audioTime() {
  return ctx ? ctx.currentTime : 0;
}

export function trigger(value, time, duration) {
  if (!dough) return null;
  try {
    const result = dough.superdough(value, time, duration);
    // superdough is async, so a bad event rejects rather than throwing
    if (result?.catch) result.catch(() => {});
    return null;
  } catch (err) {
    return err.message;
  }
}

export function analyserData(id) {
  if (!dough) return null;
  try {
    return dough.getAnalyzerData?.('time', id) ?? null;
  } catch {
    return null;
  }
}

export function waveform() {
  if (!analyser || !waveBuffer) return null;
  try {
    analyser.getFloatTimeDomainData(waveBuffer);
    return waveBuffer;
  } catch {
    return null;
  }
}

export function sampleRate() {
  return ctx ? ctx.sampleRate : 44100;
}

export function contextState() {
  return ctx ? ctx.state : 'closed';
}

// No device to lose in a tab, so these are constant.
export const deviceLooksDead = () => false;
export const isSilent = () => false;
export const workletWarning = () => null;
export const renderStats = () => ({});
export const reclaimAvailable = () => false;

export function setBusEffect(name, mix) {
  return bus ? bus.setMix(name, mix) : false;
}

export function setBusParam(name, param, value) {
  return bus ? bus.setParam(name, param, value) : false;
}

export function busEffectNames() {
  return bus ? bus.names() : [];
}

export async function loadSampleBank(url) {
  if (!dough) return;
  await dough.samples(url);
}

export async function preloadSounds() {
  // the browser caches the fetches
}

export async function deviceIsRunning() {
  return ctx?.state === 'running';
}

export async function closeAudio() {
  bus?.stop();
  await ctx?.close().catch(() => {});
  ctx = null;
  dough = null;
  bus = null;
}

