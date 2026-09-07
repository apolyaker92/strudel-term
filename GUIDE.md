# strudel-term guide

Everything the program does, and how to start using it. If you have not
installed it yet, the [README](README.md) covers that.

## Getting started

Open a file. It is created from a template if it does not exist.

```
strudel-term jam.str
```

You get one pane split into four parts:

```
strudel INSERT auto jam.str ▶ playing 120bpm cyc 4.2     header: mode, file, transport
  1 sound("bd ~ sn ~").gain(0.7)                         the code, edited in place
  2 note("a3 c4 e4").sound("triangle")
────────────────────────────────────────
C5 │    ███   ███                                        piano roll, one colour per sound
   │ ███   ███
tempo   ▓▓▓▓▓▓░░░░░  120 bpm                             mixer: tempo, sends, tracks, sliders
reverb  ░░░░░░░░░░░  off
wave │  ⢠⠤⢤⡀   ⣀⣤⡀                                       oscilloscope
evaluated 22:04:11   tab complete   ctrl-e notes         status and key reminders
```

Type. The pattern re-evaluates 400ms after you stop, and the file saves itself
1.5s after that. Only code that parses is written to disk, so a half-finished
edit never reaches the file or the speakers: the last working pattern keeps
playing and the header shows `auto·unparsed` until it parses again.

That is the whole loop. Everything below is detail.

If you are new to Strudel itself, `examples/course/` is six runnable files that
build from a single cycle to a full pattern. Start at `01-cycles.str` and read
the comments.

## Modes

`esc` leaves whatever you are in and returns to COMMAND.

**INSERT** is the default, and types normally.

```
tab            complete, again to cycle
ctrl-e         note mode, on the sequence under the cursor
ctrl-s         save and evaluate now
ctrl-z         undo
shift+arrows   select
ctrl-w         delete word
ctrl-p         play/pause, without leaving insert
ctrl-o         scope on/off
ctrl-g         reference pages
esc            command mode
```

**COMMAND** is for the transport and the mixer.

```
space   play/pause          +/-   tempo
↑↓      pick a mixer row    ←→    adjust it
m       mute track          s     solo track
b       bake slider values into the code
e       note mode           x     bounce to a wav
[ ]     loop in and out     \     clear the loop
, .     step a cycle        0     back to the top
p       piano roll          w     scope
t       arrangement strip   a     auto-update on/off
?       reference pages     r     reload from disk
i       back to insert      q     quit
```

**NOTES** edits pitches with the arrow keys and writes the result into your
code. `ctrl-e` from insert, or `e` from command.

```
←→        pick a slot        ↑↓       move a note, or fill an empty one
opt+←→    another sequence   opt+↑↓   move within the scale, if one is in force
esc       back to command
```

`ctrl-c` copies when something is selected and quits when nothing is. `ctrl-q`
always quits.

## Live controls

`slider(0.5)` anywhere a number goes becomes a row in the mixer. Moving it
changes the sound immediately, with no re-evaluation, so you can ride a filter
while the pattern runs.

```js
note("a2 c3").sound("sawtooth").cutoff(slider(700, 200, 4000))
```

The three arguments are the starting value, the minimum and the maximum. `b` in
command mode writes the current positions back into your file, replacing the
exact characters of each first argument. Positions are remembered per file, so
reopening it puts every fader back where you left it.

## The mixer

The panel lists tempo first, then the sends and bus effects, then one row per
track, then your sliders. `↑↓` picks a row and `←→` moves it.

**Tracks.** Each argument of a top-level `stack()` is a track. `m` mutes the
selected one and `s` solos it. A muted track stops playing and disappears from
the roll, so what you see stays what you hear. The fader rides `postgain`, which
sits after the pattern's own gain, so it never fights what the code asked for.

**Sends.** `reverb` and `delay` are merged into every event that does not
already set them itself.

**Bus effects.** `flanger` and `chorus` run on the master output rather than per
voice, because superdough implements neither. Turn one up and its own controls
appear beneath it:

```
flanger    ▓▓▓▓▓▓▓▓▓░░░░░░░  0.6
flan rate  ▓▓░░░░░░░░░░░░░░  1.2     sweep in Hz
flan depth ▓▓▓░░░░░░░░░░░░░  2       how far the delay moves, in ms
flan fdbk  ▓▓▓▓▓▓▓▓▓░░░░░░░  0.5     how much returns to the line
```

They collapse again when the effect goes back to zero. The two presets differ
only in those numbers: three milliseconds with feedback combs into a flanger,
twenty-five without thickens into a chorus, so giving the chorus some feedback
turns it into a slow flanger.

Everything in the mixer is session state rather than part of the file, so `b`
does not write any of it into your code. A bounce does include it.

## Editing notes

Note mode moves pitches with the arrow keys and rewrites the mini-notation to
match. The selection is highlighted in the roll and in the code at once, and
every move is an ordinary undoable edit.

Left and right step through every slot including rests, so an empty step can be
selected and filled: pressing up or down on a rest turns it into a note, copying
whatever notation its neighbours use, a degree for a degree pattern and a note
name for a note pattern.

Grouping does not get in the way. Brackets, alternation and chords are all
walked, so `"c4 [eb4 c5] ~ g4"` and `"<[eb3,g3] [ab2,c3]>"` are both editable.
Each slot carries the exact characters that produced it, so a replacement leaves
the structure around it untouched. Counts are not slots, so the `3` in `c4*3`
and the `0.5` in `c4?0.5` cannot be selected or overwritten.

Two things it will not do. Pitches invented by a chord voicing or an arpeggiator
have no source text and are reported as not editable. Polymeter, `{a b}%4`,
retimes a whole group rather than a slot, so a string containing it is refused
rather than edited on a guess.

Option rather than ctrl for the modifiers, because macOS gives ctrl with any
arrow to Mission Control and the window manager takes those before the terminal
sees them. `tab` and `shift-tab` also step between sequences, and `shift` with
the vertical arrows also moves in scale, for terminals that send option
differently.

## Piano roll and scope

The roll is coloured per sound, so each layer of a `stack()` reads as its own
voice, and notes grey at their onset. The scope taps the master output, so it
shows samples as well as synths, and auto-ranges the way a scope's auto setting
does so a quiet mix does not read as a flat line.

Both toggle from command mode, `p` and `w`, and the code pane takes back the
height rather than leaving empty screen. With both off you get roughly twice the
code on screen.

## Transport and arrangement

`[` and `]` set a loop at the playhead, `\` clears it, `,` and `.` step a cycle,
and `0` returns to the top. `t` shows an arrangement strip: 64 cycles at a
glance with event density, the loop region and the playhead.

## Bouncing

`x` renders to a wav next to your `.str`, using the loop region if there is one
and eight cycles otherwise. It runs in a separate process, so a bounce cannot
interrupt what you are listening to, and whatever the mixer had turned up is
passed to it. A mix that sums past full scale is scaled down rather than
clipped, and the amount is reported.

It also runs on its own:

```
npm run bounce -- jam.str out.wav --cycles 16 --cps 0.5
```

```
--cycles 8            how many cycles to render
--cps 0.5             cycles per second
--from 0              cycle to start at
--room, --delay       send levels
--flanger, --chorus   bus effect mixes
--flangerrate, --flangerdepth, --flangerfeedback     and the chorus equivalents
```

## Samples

`bd sn hh` and the rest of dirt-samples work. The bank loads at startup and
files are cached under `~/.cache/strudel-term`, so a second run needs no
network.

```
--cache         report what the cache is holding
--clear-cache   delete cached samples, keeping saved positions
--no-samples    synths only, no network
```

Saved slider positions live alongside the cache and are not touched by
`--clear-cache`. Positions for patterns you have deleted are cleaned up on their
own.

Synths need no download: `sawtooth square triangle sine supersaw pulse saw`,
plus the noises `white pink brown crackle`.

## Completion and reference

Tab completes and cycles. 157 methods carry a description and most a typical
range. Context decides the vocabulary: after a `.` you get pattern methods, on a
bare word top-level functions, inside `sound("…")` the registered sound names,
and inside a comment nothing.

`ctrl-g` cycles two reference pages, mini-notation and control ranges. Every
line in both was checked against this build.

Some controls strudel accepts do nothing here, because superdough does not
implement them: `leslie`, `ring`, `ringf`, `krush`, `squiz`, `waveloss` and
`triode`. Completion says so rather than letting you chase them by ear.

## Flags

```
--cps 0.5              cycles per second
--samples <bank>       sample bank, default github:tidalcycles/dirt-samples
--no-samples           synths only, no network
--latency <seconds>    audio buffer hint
--silent               run with no audio device at all
--cache                report what the sample cache is holding
--clear-cache          delete cached samples, keeping saved positions
```

`--silent` runs the whole interface, transport included, without opening an
audio device. Useful for editing where you cannot make noise.

`STRUDEL_TERM_KEYLOG=/path` records every key received and
`STRUDEL_TERM_PERF=/path` records frame times and audio render load. The
interface owns the screen, so these are the only way to see either.
