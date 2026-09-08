# Notes

The parts that needed working out, and the measurements behind them.

## Why this runs with --expose-gc

node-web-audio-api removes a node from the render graph only when V8 collects
its JavaScript wrapper. The wrapper is a few bytes and the audio buffers it
owns live on the Rust side, invisible to V8, so the heap sits near 15MB, V8
never collects, and disconnected nodes accumulate while the renderer walks all
of them every block.

Left alone, render load climbs past 1.0 and the output breaks into dropouts at
an unpredictable moment, because it depends on when V8 happens to run. It sounds
like intermittent buzzing that worsens the longer you play, survives silence,
and disappears on restart.

```
load 1.23  ->  one forced collection  ->  load 0.10
```

`cli.mjs` re-execs itself with `--expose-gc` and collects every four seconds.
Over a minute of a dense pattern that holds load flat at 0.49 with zero
underruns, against five seconds of dropouts without it. Worst collection pause
7.3ms against a 150ms scheduling lookahead, so it is inaudible.

Superdough is not at fault. A node census over 401 voices found 1604 gains
created and 1604 disconnected, nothing leaked. The gap is between a Rust audio
graph and a garbage collector that cannot see what those objects cost.

Ruled out first, each by measurement: stuck voices, polyphony limits, audio
buffer size, the master analyser, missing `ended` events, and clipping.

`STRUDEL_TERM_GC_MS` changes the period.

## A rebuilt arp

`@strudel/core` 1.2.6 ships an `arpWith` whose `innerJoin` leaves haps with an
undefined value, so `n.value.value` throws inside the query. strudel catches
that itself and logs it, which is why every form of `arp` goes silent rather
than erroring. 1.2.6 is the newest published core.

`collect()` and `squeezeBind` both work, and an arpeggio is an inner sequence
placed inside the outer hap's timespan, so `src/arp.mjs` rebuilds it on those
and re-registers over the original. Eight modes; an unrecognised mode falls back
to `up` rather than to silence.

## Two aliases

`ctranspose` and `mtranspose` are controls in this version of strudel, not
transforms: they set a value nothing in the audio path reads, so they appear to
do nothing. superdough never references either name.

Tidal treats them as chromatic and modal transpose, which strudel already
implements as `transpose()` and `scaleTranspose()`. `src/aliases.mjs` registers
them onto those. A deliberate divergence from upstream that loses no behaviour,
since nothing consumed the controls.

## The dependency patch

`@strudel/core` imports `SalatRepl` from `@kabelsalat/web`, whose `main` points
at a bundle with no ESM exports, so Node resolves it and the import throws. The
sibling `dist/index.mjs` is a real ES module. `scripts/patch-deps.mjs` repoints
it on postinstall. Upstream bug; delete the script once that package ships an
exports map.

Separately, `src/shim.mjs` supplies the browser globals superdough and strudel
touch at module scope: `window.addEventListener`, `document.dispatchEvent`,
`BaseAudioContext`. It must be imported before either.

## How the pieces fit

```
the editor buffer  <->  jam.str
     |                    ^  fs.watch on the parent directory, so an
     |  ctrl-s            |  edit from another editor still arrives
     v                    |
@strudel/transpiler  ->  pattern
     |
     +--> queryArc(now, now+150ms)  ->  superdough  ->  node-web-audio-api
     |
     +--> queryArc(window)          ->  piano roll

master analyser tap  ->  getFloatTimeDomainData  ->  braille scope
```

Two queries off one pattern: one schedules audio a fraction of a second ahead,
one feeds the display. They are separate because the display needs notes that
have not been scheduled yet and notes that already finished.

The scope taps the master output by shadowing `ctx.destination` with a
pass-through AnalyserNode. superdough's per-voice `analyze` control misses the
sample path entirely, so a drums-only pattern read as silence. The proxy must
forward `maxChannelCount`, or superdough sizes its output at zero channels and
throws.

## Sliders

The transpiler rewrites `slider(0.5)` into `sliderWithID('slider_<offset>',
0.5)` and returns a widget list with each slider's value, range and source
offsets. Supplying `sliderWithID` is all it takes to participate, and those
offsets make `b` an exact string replacement rather than a regex guess.

Slots are keyed by order of appearance, not by the generated id. That id is a
character offset, so typing above a slider would rename it and reset it
mid-performance.

## What has actually been heard

Almost all of this was built and checked headlessly: `--silent` runs, offline
bounces through `OfflineAudioContext`, and the test suite. That verifies the
code paths execute and the frames render. It says nothing about how any of it
sounds.

On 5 Sep 2026 a 32-second bounce of the full stack, drums, bass, chord stabs
and melody, with reverb and delay sends, was listened to and reported clean: no
artefacts, no dropouts, nothing wrong with the mix. That is the audio path
confirmed by ear for the first time, and it is the one thing headless testing
could never establish.

Still unheard: the interactive surface. The mixer, transport, timeline, note
mode and slider riding have never been driven by a person while listening.
Keys are only read when stdin is a TTY, so none of that can be exercised from
a scripted shell either.

## Traps worth knowing

**A control called with no argument curries.** `.crush()` does not mean "crush
with a default", it consumes the pattern, so the hap value becomes
`{ crush: { note, s, gain } }` and every real control disappears inside it.
superdough then writes that object onto an AudioParam and throws from inside a
`forEach` where no call site can catch it. Values are sanitised before they get
there and the footer names the control.

**`stut` and `echo` take their arguments in different orders.** `stut(count,
feedback, time)` and `echo(count, time, feedback)`. Confirmed by identical
output from `stut(3, 0.5, 0.125)` and `echo(3, 0.125, 0.5)`.

**Evaluating cleanly is not the same as making sound.** A pattern can throw
inside `queryArc`, which strudel catches and logs rather than raising, or simply
yield nothing. Every evaluation is probed and the footer reports
`pattern produces no events (silence)`.

## What does not work

Nothing currently known. An arity-aware sweep over all 148 curated methods,
trying argument counts from zero to three against three base patterns, found
145 producing events. The three that did not (`arpWith`, `euclidRot`, `pick`)
need argument shapes the sweep cannot express and all work by hand.

Worth repeating that sweep after a strudel upgrade.

## The dead control audit

Every one of the 59 controls carrying a documented range was rendered twice
through the real trigger path, once plain and once with the control set, and
the two buffers compared by RMS and checksum. A control with a range in the
reference panel that does nothing is the worst case: the docs promise a number
and the ear finds nothing.

Seven came back byte-identical: `pan`, `resonance`, `orbit`, `legato`, `clip`,
`overgain` and `unison`. Four of those were the probe's fault, not the
control's.

- `pan` only moves energy between channels, and the first probe summed to mono.
- `resonance` needs a cutoff engaged. With one: 0.061 to 0.093 RMS.
- `unison` needs a voice that has one, `supersaw`: 0.049 to 0.039.
- `legato` and `clip` are the same control and are half-implemented upstream.
  superdough honours them in `sampler.mjs`, `wavetable.mjs` and `sbd`, and the
  generic oscillator synth ignores them, so `.legato(0.2)` shortens `s("sbd")`
  from 0.096 to 0.079 and does nothing at all to a sawtooth.
- `orbit` is routing, so identical output is the correct answer.

That leaves `overgain`, which is genuinely dead: it is registered in
`@strudel/core/controls.mjs` and read nowhere in superdough. It joins `chorus`
in the unsupported table and its range entry is gone.

The lesson is the probe, not the controls. Four false positives in one run, all
from measuring in a context where the control had nothing to act on. Any repeat
of this sweep should give each control a base pattern it can actually change.
