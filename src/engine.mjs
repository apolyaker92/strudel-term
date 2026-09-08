import { evalScope } from '@strudel/core';
import { initAudio, audioTime, trigger, deviceLooksDead } from './audio.mjs';
import * as sliders from './sliders.mjs';
import * as tracks from './tracks.mjs';
import { densityFor, pageFor, PAGE_CYCLES } from './timeline.mjs';
import { installExtensions } from './install.mjs';
import { resetWaveIds } from './visualizers.mjs';

let scopeReady = null;

async function ensureScope() {
  scopeReady ??= (async () => {
    const core = await import('@strudel/core');
    sliders.attachCore(core);
    installExtensions(core);
    await evalScope(
      import('@strudel/core'),
      import('@strudel/mini'),
      // scale(), voicing() and chord() are dead without this
      import('@strudel/tonal'),
      // the transpiler rewrites every slider(...) call into one of these
      { sliderWithID: sliders.sliderWithID },
    );
    return await import('@strudel/transpiler');
  })();
  return scopeReady;
}

// Values reach superdough as control objects, so a bare mini pattern yielding a
// string or number has to be wrapped. The scope taps the master output, so
// nothing needs an `analyze` tag any more.
function asControls(value) {
  const base = value && typeof value === 'object' ? value : { note: value };

  // Global sends are only merged when they are actually turned up, and never
  // over a value the pattern set itself. Only the two superdough implements are
  // sent with the event; the bus effects are applied to the master output
  // instead and must not be pushed into a hap, where they would mean nothing.
  const { room, delay } = sliders.globals;
  if (!room && !delay) return base;
  const merged = { ...base };
  if (room && merged.room === undefined) merged.room = room;
  if (delay && merged.delay === undefined) merged.delay = delay;
  return merged;
}

// acorn attaches loc to syntax errors; strudel's mini parser reports a line in
// its message. Either is enough to point at the offending line.
function errorLocation(err) {
  const line = err?.loc?.line;
  if (Number.isFinite(line)) return { line, column: err.loc.column ?? 0 };
  const mini = /parse error at line (\d+)/.exec(err?.message ?? '');
  if (mini) return { line: Number(mini[1]), column: 0 };
  return null;
}

// A control called with no argument curries: `.crush()` does not mean
// "crush with a default", it consumes the pattern, so the hap value becomes
// { crush: { note, s, gain } } and every real control vanishes inside it.
// superdough then writes that object straight onto an AudioParam, and the
// binding throws from inside a forEach where the call site cannot catch it.
// So drop anything an AudioParam cannot accept before it ever gets there.
const CONTROL_HINT = 'a control called with no argument swallows the pattern instead';

export function sanitizeValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { value, dropped: [] };
  }
  let cleaned = null;
  const dropped = [];
  for (const [key, item] of Object.entries(value)) {
    const usable =
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      Array.isArray(item) ||
      (typeof item === 'number' && Number.isFinite(item));
    if (usable) continue;
    cleaned ??= { ...value };
    delete cleaned[key];
    dropped.push(key);
  }
  return { value: cleaned ?? value, dropped };
}

// Which sample names the pattern references, so they can be warmed before the
// first hit rather than during it.
function soundsUsedBy(pattern) {
  const names = new Set();
  try {
    for (const hap of pattern.queryArc(0, 2)) {
      const name = hap.value?.s ?? hap.value?.sound;
      if (typeof name === 'string') names.add(name);
    }
  } catch {
    // a pattern that will not query has no sounds we can warm
  }
  return [...names];
}

// A pattern can evaluate cleanly and still make no sound: queryArc may throw
// (strudel catches and logs it internally) or simply yield nothing. Probe it so
// silence has a visible cause.
function probe(pattern) {
  let haps;
  try {
    haps = pattern.queryArc(0, 2).filter((hap) => hap.whole);
  } catch (err) {
    return `pattern throws when queried: ${err.message}`;
  }
  if (haps.length === 0) return 'pattern produces no events (silence)';

  // catch the bad-control case at evaluation time, not when a note fires
  const dropped = new Set();
  for (const hap of haps) {
    for (const key of sanitizeValue(hap.value).dropped) dropped.add(key);
  }
  if (dropped.size) {
    return `${[...dropped].join(', ')} has no usable value (${CONTROL_HINT})`;
  }
  return null;
}

const TICK_MS = 20;
const SCHEDULE_AHEAD_S = 0.15; // how far past `now` we hand notes to superdough

// Cycle 0 is placed this far in the future when playback starts. Without it the
// first tick tries to schedule cycle 0 at the moment we started, which is
// already a few ms in the past by then, and superdough warns
// "cannot schedule sounds in the past". The display uses the same mapping, so
// the playhead still lines up with what you hear.
const START_LATENCY_S = 0.1;

export class Engine {
  constructor({ cps = 0.5 } = {}) {
    this.cps = cps;
    this.pattern = null;
    this.source = '';
    this.layers = [];
    this.version = 0;
    this.playing = false;
    this.error = null;
    this.warning = null;
    this.errorLoc = null;
    this.sounds = [];
    this.sliderCount = 0;

    this.originAudio = 0;
    this.originCycle = 0;
    // { start, end } in cycles, or null
    this.loop = null;
    this.scheduledTo = 0; // cycle position audio has been scheduled up to
    this.timer = null;

    this.queryCache = { version: -1, from: 0, to: 0, haps: [] };
    // the overview costs milliseconds per page, so it is computed once per
    // pattern and reused until the pattern changes
    this.densityCache = { version: -1, page: -1, counts: [], refreshing: false };
  }

  async init(latencyHint = null, options = {}) {
    await initAudio(latencyHint, options);
    await ensureScope();
  }

  // Evaluate strudel source. Returns null on success, an error string otherwise,
  // and leaves the previously working pattern in place when evaluation fails so
  // a typo mid-performance doesn't drop the audio.
  //
  // quiet suppresses latching the error, for auto-evaluation while typing:
  // a half-written line is expected, not something to shout about.
  async setCode(code, { quiet = false } = {}) {
    const transpilerModule = await ensureScope();
    try {
      // Transpile once for the widget metadata, which evaluate() does not
      // return, so sliders can be given stable slots and readable labels.
      try {
        const meta = transpilerModule.transpiler(code, { emitWidgets: true });
        sliders.prepare(code, meta?.widgets ?? []);
      } catch {
        // a buffer that will not transpile has no sliders to prepare
      }

      // wave visualizers take an analyser id each as they evaluate, and the
      // source scan numbers them the same way, so the count starts clean
      resetWaveIds();

      // emitMiniLocations tags each event with the source that produced it,
      // which is what lets a note in the roll be edited back into the code
      const result = await transpilerModule.evaluate(code, { emitMiniLocations: true });

      // An unfinished chain like `.cutoff` evaluates to a curried function
      // rather than a pattern. That is truthy, so a plain existence check let it
      // through and the scheduler then failed on every tick. Check for the one
      // thing we actually need from it.
      if (typeof result?.pattern?.queryArc !== 'function') {
        throw new Error(
          result?.pattern
            ? 'not a pattern (unfinished method chain?)'
            : 'no pattern produced',
        );
      }
      this.pattern = result.pattern;
      this.version++;
      this.error = null;
      this.errorLoc = null;
      this.warning = probe(result.pattern);
      this.source = code;
      this.layers = tracks.analyse(code);
      tracks.prune(this.layers.length);
      this.sounds = soundsUsedBy(result.pattern);
      this.sliderCount = sliders.count();
      return null;
    } catch (err) {
      // recorded even when quiet, so the offending line is marked while you
      // type without the footer shouting about a half-written expression
      this.errorLoc = errorLocation(err);
      if (!quiet) this.error = err.message;
      return err.message;
    }
  }

  cycleAt(t) {
    return this.originCycle + (t - this.originAudio) * this.cps;
  }

  timeAt(cycle) {
    return this.originAudio + (cycle - this.originCycle) / this.cps;
  }

  get currentCycle() {
    return this.playing ? this.cycleAt(audioTime()) : this.originCycle;
  }

  // Move the playhead. Re-anchors the cycle-to-time mapping rather than
  // touching the pattern, so looping does not disturb the source or the
  // locations that note editing depends on.
  seek(cycle) {
    const target = Math.max(0, cycle);
    this.originCycle = target;
    this.originAudio = audioTime() + START_LATENCY_S;
    this.scheduledTo = target;
    this.queryCache.version = -1;
  }

  setLoop(start, end) {
    if (start == null || end == null || end <= start) {
      this.loop = null;
      return null;
    }
    this.loop = { start, end };
    return this.loop;
  }

  setCps(cps) {
    const clamped = Math.max(0.05, Math.min(4, cps));
    if (this.playing) {
      // re-anchor so the playhead doesn't jump when the tempo changes
      this.originCycle = this.currentCycle;
      this.originAudio = audioTime();
    }
    this.cps = clamped;
  }

  start() {
    if (this.playing) return;
    this.playing = true;
    this.originAudio = audioTime() + START_LATENCY_S;
    this.scheduledTo = this.originCycle;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (!this.playing) return;
    this.originCycle = this.currentCycle;
    this.playing = false;
    clearInterval(this.timer);
    this.timer = null;
  }

  toggle() {
    this.playing ? this.stop() : this.start();
  }

  tick() {
    if (!this.pattern) return;

    // Wrap before scheduling, so the notes queued next come from the top of the
    // loop. Anything already handed to the audio engine still sounds, which is
    // at most the scheduling lookahead.
    if (this.loop && this.currentCycle >= this.loop.end) {
      this.seek(this.loop.start);
    }

    // If the device stops rendering mid-session, scheduling into it blocks the
    // whole event loop. Stop instead, and say so.
    if (deviceLooksDead()) {
      this.stop();
      this.error = 'audio device stopped rendering: playback halted';
      return;
    }
    const started = this.perf ? performance.now() : 0;
    if (this.perf && this.lastTickAt) {
      const gap = started - this.lastTickAt;
      if (gap > 40) this.perf(`tick gap ${gap.toFixed(1)}ms`);
    }
    if (this.perf) this.lastTickAt = started;
    const target = this.cycleAt(audioTime() + SCHEDULE_AHEAD_S);
    if (target <= this.scheduledTo) return;

    // A long stall (laptop sleeping, a slow redraw) would otherwise dump every
    // missed note at once. Skip the gap instead.
    if (target - this.scheduledTo > 2) this.scheduledTo = target - 0.1;

    let haps;
    try {
      haps = this.pattern.queryArc(this.scheduledTo, target);
    } catch (err) {
      this.error = `query failed: ${err.message}`;
      this.scheduledTo = target;
      return;
    }

    for (const hap of haps) {
      if (!hap.whole || !hap.hasOnset()) continue;
      const begin = hap.whole.begin.valueOf();
      if (begin < this.scheduledTo) continue;
      const durationCycles = hap.whole.end.valueOf() - begin;
      const when = this.timeAt(begin);
      if (when < audioTime()) continue; // a stall pushed this into the past
      // a muted track is simply not scheduled
      const track = tracks.trackOf(hap, this.layers);
      if (!tracks.isAudible(track)) continue;

      const { value, dropped } = sanitizeValue(hap.value);
      if (dropped.length) {
        this.warning = `${dropped.join(', ')} has no usable value (${CONTROL_HINT})`;
      }
      // Track level rides postgain, which defaults to 1 and sits after the
      // pattern's own gain, so a fader never fights what the code asked for.
      const level = tracks.volumeOf(track);
      const mixed = level === 1
        ? asControls(value)
        : { ...asControls(value), postgain: (value?.postgain ?? 1) * level };

      const err = trigger(mixed, when, durationCycles / this.cps);
      if (err) this.error = err;
    }

    this.scheduledTo = target;
    if (this.perf) {
      const took = performance.now() - started;
      if (took > 5) this.perf(`tick work ${took.toFixed(1)}ms, ${haps.length} haps`);
    }
  }

  // Event counts per cycle for the arrangement strip.
  //
  // Counting 64 cycles takes about 4ms, and doing it inside a draw was the
  // whole reason frames after an evaluation ran 13 to 17ms instead of 0.15ms.
  // The stale counts are returned instead and a refresh is scheduled, since one
  // frame of staleness in an overview is invisible.
  densityPage(cycle = this.currentCycle) {
    const page = pageFor(cycle);
    const cache = this.densityCache;

    if (cache.version === this.version && cache.page === page) {
      return { page, counts: cache.counts };
    }

    if (!cache.refreshing) {
      cache.refreshing = true;
      const refresh = () => {
        cache.refreshing = false;
        cache.counts = densityFor(this.pattern, page);
        cache.version = this.version;
        cache.page = page;
      };
      // immediate on the first ever call, so the strip is never blank
      if (cache.version === -1) refresh();
      else setTimeout(refresh, 0).unref?.();
    }

    // pad rather than return a short array while the first count is pending
    const counts = cache.counts.length ? cache.counts : new Array(PAGE_CYCLES).fill(0);
    return { page, counts };
  }

  // Queried a whole cycle at a time and cached, so a 30fps redraw does not
  // re-query constantly.
  visibleHaps(from, to) {
    if (!this.pattern) return [];
    const lo = Math.floor(from);
    const hi = Math.ceil(to);
    const c = this.queryCache;
    if (c.version !== this.version || c.from !== lo || c.to !== hi) {
      try {
        // what you see is what you hear: muted layers leave the roll too
        c.haps = this.pattern
          .queryArc(lo, hi)
          .filter((h) => h.whole && tracks.isAudible(tracks.trackOf(h, this.layers)));
      } catch {
        c.haps = [];
      }
      c.version = this.version;
      c.from = lo;
      c.to = hi;
    }
    return c.haps;
  }
}
