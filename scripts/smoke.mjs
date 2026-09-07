// Headless check: evaluate a .str file, render it through superdough offline,
// and print the piano roll the TUI would draw. No speakers, no terminal needed.
import '../src/shim.mjs';
import { readFileSync } from 'node:fs';
import { OfflineAudioContext } from 'node-web-audio-api';
import { evalScope } from '@strudel/core';
import { installFetchCache, DEFAULT_BANK } from '../src/samples.mjs';
import * as sliders from '../src/sliders.mjs';
import { installArp } from '../src/arp.mjs';
import { installTransposeAliases } from '../src/aliases.mjs';
import { renderPianoRoll } from '../src/pianoroll.mjs';
import { renderWaveform } from '../src/waveform.mjs';

const file = process.argv[2] ?? new URL('../examples/first.str', import.meta.url);
const code = readFileSync(file, 'utf8');

installFetchCache();
sliders.attachCore(await import('@strudel/core'));
installArp(await import('@strudel/core'));
installTransposeAliases(await import('@strudel/core'));
await evalScope(
  import('@strudel/core'),
  import('@strudel/mini'),
  import('@strudel/tonal'),
  // the example uses slider(), which the transpiler rewrites into this
  { sliderWithID: sliders.sliderWithID },
);
const { evaluate } = await import('@strudel/transpiler');

const transpiled = (await import('@strudel/transpiler')).transpiler(code, { emitWidgets: true });
sliders.prepare(code, transpiled?.widgets ?? []);

const { pattern } = await evaluate(code);
if (!pattern) throw new Error('no pattern');
if (sliders.count()) console.log(`${sliders.count()} slider(s): ${sliders.list().map((s) => s.label).join(', ')}`);

const cps = 0.5;
const seconds = 4;
const haps = pattern.queryArc(0, seconds * cps).filter((h) => h.whole);
console.log(`pattern ok: ${haps.length} haps in ${seconds * cps} cycles\n`);

// render audio
const sd = await import('superdough');
const off = new OfflineAudioContext(2, 44100 * seconds, 44100);
// setAudioContext only: setDefaultAudioContext ignores the offline context and
// opens a real device, which fails outright on a machine that has none
sd.setAudioContext(off);
sd.registerSynthSounds();
try { sd.registerZZFXSounds?.(); } catch {}

// Samples come from the on-disk cache after the first run, so this stays fast
// and works with no network. Without the bank, a pattern using bd would abort
// the whole render.
let sampled = 0;
try {
  await sd.samples(DEFAULT_BANK);
  const names = new Set(haps.map((h) => h.value?.s).filter(Boolean));
  for (const name of names) {
    const urls = sd.getSound?.(name)?.data?.samples;
    if (!Array.isArray(urls)) continue;
    await sd.loadBuffer(urls[0], off, name, 0);
    sampled++;
  }
} catch (err) {
  console.log(`samples unavailable (${err.message}), synths only`);
}
console.log(`preloaded ${sampled} sample sound(s)`);

// superdough is async, so a bad event rejects rather than throwing and has to
// be caught off the promise. Of the two failures, only an unplayable value is
// this project's fault; a sound that never loaded means the sample bank was
// unreachable, which would make the suite red for the weather.
const UNREACHABLE = /not found! Is it loaded/;
let failed = 0;
let unreachable = 0;
const triggers = [];
const note = (err) => {
  const message = String(err?.message ?? err).split('\n')[0];
  if (UNREACHABLE.test(message)) {
    unreachable++;
    return;
  }
  failed++;
  if (failed <= 3) console.log('trigger err:', message);
};
for (const hap of haps) {
  const begin = hap.whole.begin.valueOf();
  const dur = hap.whole.end.valueOf() - begin;
  try {
    const result = sd.superdough(hap.value, begin / cps, dur / cps);
    if (result?.catch) triggers.push(result.catch(note));
  } catch (err) {
    note(err);
  }
}
await Promise.all(triggers);
if (unreachable) {
  console.log(`${unreachable} event(s) had no sound loaded, treating as unavailable samples`);
}
if (failed) {
  // Events that cannot play are the thing this exists to catch, so they fail
  // the run. Reporting them and exiting zero is how a broken example sat in
  // the repo: the suite was green on a working copy that had been edited past
  // the bug, and red only for anyone cloning it.
  console.log(`${failed} trigger(s) failed`);
  process.exitCode = 1;
}

const buf = await off.startRendering();
const d = buf.getChannelData(0);
let peak = 0, rms = 0;
for (let i = 0; i < d.length; i++) { peak = Math.max(peak, Math.abs(d[i])); rms += d[i] * d[i]; }
rms = Math.sqrt(rms / d.length);
console.log(`audio: peak ${peak.toFixed(3)}  rms ${rms.toFixed(4)}  ${peak > 0.005 ? 'OK' : 'SILENT'}\n`);

// render the roll at a few playhead positions
for (const cycle of [0.35, 1.1]) {
  console.log(`--- piano roll at cycle ${cycle} ---`);
  const lines = renderPianoRoll({
    haps: pattern.queryArc(Math.floor(cycle - 2), Math.ceil(cycle + 2)).filter((h) => h.whole),
    currentCycle: cycle,
    width: 96,
    height: 18,
    cyclesVisible: 2,
    playheadFrac: 0.3,
  });
  console.log(lines.join('\n'));
  console.log();
}
// The realtime analyser needs a live context, so exercise the scope renderer
// against the buffer we just rendered instead. Same code path the TUI uses.
console.log('--- waveform (first 30ms of the rendered mix) ---');
console.log(
  renderWaveform({ data: d.slice(0, 1323), width: 96, height: 6 }).join('\n'),
);

// exit with whatever the run earned: a hard 0 here discarded the trigger
// failures set above, which is why a broken example still passed
process.exit(process.exitCode ?? 0);
