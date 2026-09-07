// Render a pattern to a wav, offline and in its own process. superdough keeps
// its context in a module singleton, so rendering inside the running app would
// swap the live context out from under playback.
//
//   node scripts/bounce.mjs <file.str> <out.wav> [--cycles 8] [--cps 0.5]
//     [--room] [--delay] [--flanger] [--chorus] and each effect's
//     [--<effect>rate] [--<effect>depth] [--<effect>feedback]
//
// The mixer is session state, not part of the file, so the app passes it in or
// the bounce is not what you were listening to.

import '../src/shim.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { writeAtomic } from '../src/atomic.mjs';
import { OfflineAudioContext } from 'node-web-audio-api';
import { evalScope } from '@strudel/core';
import { installFetchCache, DEFAULT_BANK } from '../src/samples.mjs';
import { installArp } from '../src/arp.mjs';
import { installTransposeAliases } from '../src/aliases.mjs';
import * as sliders from '../src/sliders.mjs';
import * as tracks from '../src/tracks.mjs';
import { encodeWav } from '../src/wav.mjs';
import { createBusChain, BUS_PRESETS, BUS_PARAMS } from '../src/buseffects.mjs';

const args = process.argv.slice(2);
const [source, output] = args.filter((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const at = args.findIndex((arg) => arg.toLowerCase() === `--${name.toLowerCase()}`);
  const value = at >= 0 ? Number(args[at + 1]) : NaN;
  return Number.isFinite(value) ? value : fallback;
};

if (!source || !output) {
  process.stdout.write(
    'usage: bounce.mjs <file.str> <out.wav> [--cycles 8] [--cps 0.5]\n' +
    '                  [--room 0] [--delay 0] [--flanger 0] [--chorus 0]\n' +
    '                  [--flangerrate] [--flangerdepth] [--flangerfeedback]\n' +
    '                  and the same for chorus\n',
  );
  process.exit(1);
}

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// Every one of these dumped a stack trace before. A bounce is spawned by the
// app, which shows the last line of output in its footer, so a stack fragment
// there is worse than useless.
const cycles = flag('cycles', 8);
const cps = flag('cps', 0.5);
const from = flag('from', 0);
// Sends are merged into each event, the same as the live scheduler does.
const sends = { room: flag('room', 0), delay: flag('delay', 0) };
const busMix = Object.fromEntries(
  Object.keys(BUS_PRESETS).map((name) => [name, flag(name, 0)]),
);
// Every bus parameter can be overridden, as --flangerrate, --flangerdepth and
// so on. Flags are matched lowercase, because the app passes the mixer's own
// keys through and those are camel case.
const busOverrides = {};
for (const name of Object.keys(BUS_PRESETS)) {
  for (const param of BUS_PARAMS) {
    const value = flag(`${name}${param.key}`.toLowerCase(), null);
    if (value === null) continue;
    busOverrides[name] = { ...(busOverrides[name] ?? {}), [param.key]: value };
  }
}
const sampleRate = 44100;

if (!existsSync(source)) die(`cannot read ${source}`);
if (!(cycles > 0)) die(`--cycles must be greater than zero, got ${cycles}`);
if (!(cps > 0)) die(`--cps must be greater than zero, got ${cps}`);
if (!(from >= 0)) die(`--from cannot be negative, got ${from}`);

const seconds = cycles / cps;
// an hour is far past anything useful and well past what fits in memory
if (seconds > 3600) die(`that would render ${Math.round(seconds)} seconds; use fewer cycles`);

installFetchCache();
const core = await import('@strudel/core');
sliders.attachCore(core);
installArp(core);
installTransposeAliases(core);
await evalScope(
  import('@strudel/core'),
  import('@strudel/mini'),
  import('@strudel/tonal'),
  { sliderWithID: sliders.sliderWithID },
);
const tp = await import('@strudel/transpiler');
const dough = await import('superdough');

let code;
try {
  code = readFileSync(source, 'utf8');
} catch (err) {
  die(`cannot read ${source}: ${err.message}`);
}

let pattern;
try {
  sliders.prepare(code, tp.transpiler(code, { emitWidgets: true })?.widgets ?? []);
  ({ pattern } = await tp.evaluate(code, { emitMiniLocations: true }));
} catch (err) {
  die(`${source} does not evaluate: ${err.message.split('\n')[0]}`);
}
if (typeof pattern?.queryArc !== 'function') {
  die(`${source} does not evaluate to a pattern`);
}

const layers = tracks.analyse(code);
let haps;
try {
  haps = pattern
    .queryArc(from, from + cycles)
    .filter((hap) => hap.whole && tracks.isAudible(tracks.trackOf(hap, layers)));
} catch (err) {
  die(`${source} fails when queried: ${err.message.split('\n')[0]}`);
}

const context = new OfflineAudioContext(2, Math.ceil(sampleRate * seconds), sampleRate);

// Same graph the live output builds, shadowing the destination so everything
// superdough plays passes through it.
const realDestination = context.destination;
const bus = createBusChain(context, realDestination, busOverrides);
Object.defineProperty(bus.input, 'maxChannelCount', {
  get: () => realDestination.maxChannelCount,
  configurable: true,
});
Object.defineProperty(context, 'destination', {
  get: () => bus.input,
  configurable: true,
});
for (const [name, mix] of Object.entries(busMix)) bus.setMix(name, mix);

// setAudioContext only: setDefaultAudioContext discards what it is given and
// builds a realtime context, so a bounce was opening the sound device it has no
// use for, in a child process, while the app was playing through it.
dough.setAudioContext(context);
dough.registerSynthSounds();
try {
  dough.registerZZFXSounds?.();
} catch {
  // optional bank
}
try {
  await dough.loadWorklets?.();
} catch {
  // worklet-backed sounds are unavailable offline; the rest still render
}

// Samples come from the on-disk cache after the first run, so a bounce is
// offline-safe once a sound has been heard.
const names = new Set(haps.map((hap) => hap.value?.s).filter(Boolean));
let sampled = 0;
try {
  await dough.samples(DEFAULT_BANK);
  for (const name of names) {
    const urls = dough.getSound?.(name)?.data?.samples;
    if (!Array.isArray(urls)) continue;
    await dough.loadBuffer(urls[0], context, name, 0);
    sampled++;
  }
} catch {
  process.stderr.write('samples unavailable, rendering synths only\n');
}

// superdough is async, so a failure arrives as a rejection rather than a throw:
// a try/catch around the call catches nothing and the process dies on an
// unhandled rejection instead of skipping one sound.
// Never over a value the pattern set for itself, matching the live scheduler.
function withSends(value) {
  const base = value && typeof value === 'object' ? value : { note: value };
  if (!sends.room && !sends.delay) return base;
  const merged = { ...base };
  if (sends.room && merged.room === undefined) merged.room = sends.room;
  if (sends.delay && merged.delay === undefined) merged.delay = sends.delay;
  return merged;
}

let scheduled = 0;
let skipped = 0;
const triggers = [];
for (const hap of haps) {
  const begin = hap.whole.begin.valueOf() - from;
  const duration = hap.whole.end.valueOf() - hap.whole.begin.valueOf();
  try {
    const result = dough.superdough(withSends(hap.value), begin / cps, duration / cps);
    scheduled++;
    if (result?.catch) triggers.push(result.catch(() => { skipped++; scheduled--; }));
  } catch {
    skipped++;
  }
}
await Promise.all(triggers);

const rendered = await context.startRendering();
const channels = [rendered.getChannelData(0), rendered.getChannelData(1)];

let peak = 0;
for (const channel of channels) {
  for (let i = 0; i < channel.length; i++) peak = Math.max(peak, Math.abs(channel[i]));
}

// A mix that sums past full scale would be hard clipped by the encoder, which
// sounds like distortion rather than like the music. Scale it down instead and
// say so, so the file is quieter but honest.
let normalised = null;
if (peak > 1) {
  normalised = 0.99 / peak;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) channel[i] *= normalised;
  }
}

writeAtomic(output, encodeWav(channels, sampleRate));
process.stdout.write(
  `wrote ${output}: ${seconds.toFixed(1)}s, ${scheduled} events` +
    `${skipped ? `, ${skipped} skipped` : ''}, ${sampled} sample sounds, peak ${peak.toFixed(3)}` +
    `${normalised ? ` (scaled by ${normalised.toFixed(2)} to avoid clipping)` : ''}\n`,
);
process.exit(0);
