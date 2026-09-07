#!/usr/bin/env node
// Audio nodes are only removed from the render graph when V8 collects their
// wrappers, and V8 will not do that on its own here because the JS heap stays
// tiny. Without --expose-gc the audio degrades into dropouts within a minute,
// so re-exec with it rather than leaving that to how you happened to launch.
if (typeof global.gc !== 'function' && !process.env.STRUDEL_TERM_NO_REEXEC) {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(
    process.execPath,
    ['--expose-gc', ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, STRUDEL_TERM_NO_REEXEC: '1' } },
  );
  process.exit(result.status ?? 0);
}

// must come first: it intercepts console before strudel and superdough load
import { releaseConsole } from './logcapture.mjs';
import { readFileSync, writeFileSync, existsSync, watch, realpathSync, appendFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from './engine.mjs';
import {
  closeAudio,
  loadSampleBank,
  preloadSounds,
  reclaimAvailable,
  renderStats,
  deviceIsRunning,
  contextState,
  setBusEffect,
  setBusParam,
} from './audio.mjs';
import { installFetchCache, DEFAULT_BANK, CACHE_DIR, cacheSize, clearCache } from './samples.mjs';
import * as sliders from './sliders.mjs';
import * as persist from './persist.mjs';
import * as tracks from './tracks.mjs';
import { writeAtomic, diskMatches } from './atomic.mjs';
import {
  editableNotes, scaleForHap, shift, shiftInScale, offsetToPosition,
  flatSlots, seedPitchFor, editableSequences, positionToOffset,
} from './rolledit.mjs';
import { panelRows, CHEATSHEET_ORDER, perf } from './tui.mjs';
import { Editor, parseKeys } from './editor.mjs';
import { initVocabulary, completionsFor } from './complete.mjs';
import { Tui } from './tui.mjs';

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  // logcapture has already intercepted console by this point, so write direct
  process.stdout.write(`strudel-term <file.str> [options]

Strudel live coding in the terminal. The file is created if it is missing.

OPTIONS
  --cps <n>            cycles per second, default 0.5
  --samples <bank>     sample bank, default ${DEFAULT_BANK}
  --no-samples         synths only, no network
  --latency <seconds>  audio buffer hint
  --silent             run the interface with no audio device at all
  --cache              report what the sample cache is holding
  --clear-cache        delete the cached samples, keeping saved positions

INSERT MODE (default)
  type to edit                  tab      complete, again to cycle
  shift+arrows  select          alt+arrows  move by word
  ctrl-w  delete word back      ctrl-u   delete to line start
  ctrl-k  delete to line end    ctrl-x/c/v  cut, copy, paste
  ctrl-z  undo                  ctrl-y   redo
  ctrl-s  save and evaluate     ctrl-p   play/pause
  ctrl-g  reference pages       ctrl-o   toggle scope
  ctrl-q  quit                  esc      command mode

COMMAND MODE (esc)
  space  play/pause             +/-      tempo
  m      mute track             s        solo track
  arrows pick a row, adjust it  b        bake slider values into the code
  e      note mode              x        bounce to a wav file
  [ ]    set loop in and out    \\        clear the loop
  , .    step a cycle           0        back to the top
  p      piano roll             w        scope
  t      arrangement strip      a        toggle auto-update
  ?      reference pages        r        reload from disk
  i      back to insert         q        quit

NOTE MODE (e from command mode)
  left/right   pick a slot in the sequence
  up/down      move a note by a semitone, or fill an empty slot
  ctrl+up/down move within the scale, when one is in force
  esc          back to command mode

Samples are cached in ${CACHE_DIR}, so later runs work offline.
Set STRUDEL_TERM_KEYLOG or STRUDEL_TERM_PERF to a path to record input or timing.
`);
  process.exit(0);
}

if (args.includes('--clear-cache')) {
  const { bytes, files } = clearCache();
  process.stdout.write(
    `cleared ${files} cached file${files === 1 ? '' : 's'}, ` +
    `${(bytes / 1048576).toFixed(1)}MB, from ${CACHE_DIR}\n`,
  );
  process.exit(0);
}

if (args.includes('--cache')) {
  const { bytes, files } = cacheSize();
  process.stdout.write(
    `${files} cached file${files === 1 ? '' : 's'}, ` +
    `${(bytes / 1048576).toFixed(1)}MB in ${CACHE_DIR}\n`,
  );
  process.exit(0);
}

let cps = 0.5;
let bank = DEFAULT_BANK;
let latency = null;
let silent = false;
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--cps') {
    const value = Number(args[++i]);
    if (Number.isFinite(value) && value > 0) cps = value;
    continue;
  }
  if (args[i] === '--samples') {
    bank = args[++i];
    continue;
  }
  if (args[i] === '--silent') {
    silent = true;
    bank = null;
    continue;
  }
  if (args[i] === '--no-samples') {
    bank = null;
    continue;
  }
  if (args[i] === '--latency') {
    const value = Number(args[++i]);
    if (Number.isFinite(value) && value > 0) latency = value;
    continue;
  }
  if (args[i].startsWith('-')) continue;
  positional.push(args[i]);
}

const requested = resolve(process.cwd(), positional[0] ?? 'live.str');

if (!existsSync(requested)) {
  const template = resolve(fileURLToPath(new URL('../examples/first.str', import.meta.url)));
  writeFileSync(requested, existsSync(template) ? readFileSync(template, 'utf8') : 'note("c3 e3 g3").sound("sawtooth")\n');
}

// realpath it: /tmp is a symlink on macOS, and fs.watch needs the resolved
// path to deliver directory events reliably
const file = realpathSync(requested);

// Typing evaluates on a short debounce and saves on a longer one, so the sound
// follows the buffer without a keystroke. ctrl-s still forces both immediately.
const AUTO_EVAL_MS = 400;
const AUTO_SAVE_MS = 1500;

const state = {
  file: basename(file),
  mode: 'insert',
  error: null,
  status: '',
  auto: true,
  parseOk: true,
  hint: null,
  cheatsheet: null,
  slider: 0,
  note: 0,
  selectedStart: null,
  noteRangeStart: null,
  noteScale: null,
};
const editor = new Editor(readFileSync(file, 'utf8'));
const engine = new Engine({ cps });
if (process.env.STRUDEL_TERM_PERF) engine.perf = perf;
const tui = new Tui({ engine, state, editor });

// what we last wrote, so the watcher can tell our own saves from an edit made
// in another editor
let lastWritten = editor.text;
let lastRevision = editor.revision;
let evalTimer = null;
let saveTimer = null;
let stateTimer = null;
// { line, start, endCol, matches, index } while tab is cycling candidates
let completion = null;
// cut and copy go here; the system clipboard is the terminal's business
let clipboard = '';

function stamp() {
  return new Date().toLocaleTimeString();
}

async function evaluateBuffer() {
  clearTimeout(evalTimer);
  const err = await engine.setCode(editor.text);
  state.error = err;
  state.parseOk = !err;
  if (!err) {
    state.status = `evaluated ${stamp()}`;
    warmSounds();
  }
}

// Fire and forget: warming buffers must never hold up playback.
function warmSounds() {
  const names = engine.sounds;
  if (!names.length) return;
  preloadSounds(names).catch(() => {});
}

// Evaluate quietly. A buffer mid-edit often will not parse; that is normal, so
// keep the last working pattern playing and just flag it in the header.
async function autoEvaluate() {
  const err = await engine.setCode(editor.text, { quiet: true });
  state.parseOk = !err;
  if (!err) {
    state.error = null;
    state.status = `live ${stamp()}`;
    warmSounds();
  }
}

function cancelAuto() {
  clearTimeout(evalTimer);
  clearTimeout(saveTimer);
}

function scheduleAuto() {
  // turning it off used to leave a pending evaluation and save to fire anyway,
  // so the next keystroke still triggered one round after you had opted out
  if (!state.auto) {
    cancelAuto();
    return;
  }
  clearTimeout(evalTimer);
  evalTimer = setTimeout(autoEvaluate, AUTO_EVAL_MS);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // Only persist code that parses. Typing goes through plenty of broken
    // intermediate states and none of them belong on disk.
    if (editor.dirty && state.parseOk) save();
  }, AUTO_SAVE_MS);
}

// Has the file moved underneath us since we last read or wrote it? lastWritten
// is what this session believes is on disk, so anything else is someone else's
// work.
const changedOnDisk = () => !diskMatches(file, lastWritten);

/**
 * Write the buffer out, refusing when the file changed on disk and this is not
 * an explicit request. The watcher guards the buffer from disk; this guards
 * disk from the buffer, which auto-save used to overwrite silently.
 */
function save({ force = false } = {}) {
  if (!force && changedOnDisk()) {
    state.error = 'file changed on disk; ctrl-s overwrites it, esc then r takes the disk version';
    return false;
  }
  try {
    lastWritten = editor.text;
    writeAtomic(file, lastWritten);
    editor.dirty = false;
    return true;
  } catch (err) {
    state.error = `write failed: ${err.message}`;
    return false;
  }
}

function reloadFromDisk() {
  try {
    const text = readFileSync(file, 'utf8');
    editor.setText(text);
    lastRevision = editor.revision;
    lastWritten = text;
  } catch (err) {
    state.error = `read failed: ${err.message}`;
    return;
  }
  evaluateBuffer();
}

function shutdown(code = 0) {
  clearTimeout(evalTimer);
  clearTimeout(saveTimer);
  clearTimeout(stateTimer);
  saveState();
  // On the way out, save even if it does not parse: losing the work is worse
  // than an unparseable file, but say so once the screen is back.
  const savingBroken = editor.dirty && !state.parseOk;
  // Quitting must not silently pick a winner when both versions are real, so a
  // buffer that cannot be written goes to a sidecar rather than over the top of
  // whatever arrived while this session was open.
  let rescued = null;
  if (editor.dirty && !save()) {
    rescued = `${file}.bak`;
    try {
      writeAtomic(rescued, editor.text);
    } catch {
      rescued = null;
    }
  }
  tui.stop();
  releaseConsole();
  if (rescued) {
    process.stdout.write(
      `${file} changed on disk while this was open, so it was left alone.\n` +
      `Your version is in ${rescued}\n`,
    );
  } else if (savingBroken) {
    process.stdout.write(`saved ${file} with unparsed changes\n`);
  }
  engine.stop();

  // Closing the context is what hands the audio device back. Exiting before it
  // finishes leaves the device claimed, and on macOS that can stop every other
  // program from playing anything until it recovers, so this waits generously.
  // The timeout exists only so a wedged device cannot trap the process.
  let exited = false;
  const leave = () => {
    if (exited) return;
    exited = true;
    process.exit(code);
  };
  setTimeout(leave, 6000).unref?.();
  closeAudio().finally(leave);
}

// Tab completes when there is something to complete, and indents otherwise.
// Pressing it again cycles through the candidates in place.
function handleTab() {
  const cycling =
    completion && completion.line === editor.line && editor.col === completion.endCol;

  if (cycling) {
    completion.index = (completion.index + 1) % completion.matches.length;
  } else {
    const found = completionsFor(editor.lines[editor.line] ?? '', editor.col);
    if (!found.matches.length) {
      completion = null;
      editor.tab();
      return;
    }
    completion = {
      line: editor.line,
      start: found.start,
      matches: found.matches,
      index: 0,
      endCol: editor.col,
    };
  }

  editor.replaceInLine(completion.start, completion.endCol, completion.matches[completion.index]);
  completion.endCol = editor.col;
}

function refreshHint() {
  if (state.mode !== 'insert') {
    state.hint = null;
    return;
  }
  if (completion) {
    state.hint = {
      matches: completion.matches,
      index: completion.index,
      start: completion.start,
    };
    return;
  }
  const found = completionsFor(editor.lines[editor.line] ?? '', editor.col);
  state.hint = found.matches.length
    ? { matches: found.matches, index: 0, start: found.start }
    : null;
}

// In command mode the arrows drive the sliders rather than the cursor: there
// is nothing to type there, and reaching for a slider mid-performance should
// not cost a mode switch.
function handleSliderKey(final) {
  const rows = panelRows(engine);
  if (!rows.length) return false;
  const last = rows.length - 1;

  switch (final) {
    case 'A':
      state.slider = Math.max(0, (state.slider ?? 0) - 1);
      return true;
    case 'B':
      state.slider = Math.min(last, (state.slider ?? 0) + 1);
      return true;
    case 'C':
    case 'D': {
      const index = Math.min(state.slider ?? 0, last);
      const row = rows[index];
      const direction = final === 'C' ? 1 : -1;

      if (row.track !== undefined) {
        const level = tracks.adjustVolume(row.track, direction);
        state.status = `${row.label} ${level.toFixed(2)}`;
        scheduleStateSave();
        return true;
      }

      if (row.global) {
        const value = sliders.adjustGlobal(row.global, direction);
        state.status = `${row.label} ${value ? sliders.format(value, row.min, row.max) : 'off'}`;
        scheduleStateSave();
        return true;
      }

      if (row.tempo) {
        // same forty steps across the range as any other slider
        const step = (sliders.TEMPO_MAX_BPM - sliders.TEMPO_MIN_BPM) / 40;
        const bpm = Math.min(
          sliders.TEMPO_MAX_BPM,
          Math.max(sliders.TEMPO_MIN_BPM, row.value + direction * step),
        );
        engine.setCps(sliders.cpsFromBpm(bpm));
        state.status = `tempo ${Math.round(bpm)} bpm`;
        scheduleStateSave();
        return true;
      }

      const value = sliders.adjust(row.ordinal, direction);
      if (value != null) {
        if (row.param) setBusParam(row.param.effect, row.param.key, value);
        else if (row.bus) setBusEffect(row.key, value);
        state.status = `${row.label} ${sliders.format(value, row.min, row.max)}`;
        scheduleStateSave();
      }
      return true;
    }
    default:
      return false;
  }
}

const STATE_SAVE_MS = 800;

function currentState() {
  return {
    cps: engine.cps,
    globals: { ...sliders.globals },
    sliders: sliders.snapshot(),
    tracks: tracks.snapshot(),
  };
}

// The bus effects live on audio nodes rather than in the pattern, so a restored
// value has to be pushed at the graph; nothing else will notice it.
function applyBusEffects() {
  for (const row of sliders.BUS_ROWS) {
    const value = sliders.globals[row.key];
    if (row.param) setBusParam(row.param.effect, row.param.key, value);
    else setBusEffect(row.key, value);
  }
}

function saveState() {
  persist.save(file, currentState());
}

// Off the startup path: pruning stats every remembered file and none of it is
// needed to draw the first frame.
function schedulePrune() {
  setTimeout(() => {
    try {
      persist.prune();
    } catch {
      // housekeeping is never worth taking the session down for
    }
  }, 2000).unref?.();
}

// Debounced: riding a slider fires this on every key press.
function scheduleStateSave() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(saveState, STATE_SAVE_MS);
}

function restoreState() {
  const saved = persist.load(file);
  if (!saved) return;

  if (Number.isFinite(saved.cps) && saved.cps > 0) engine.setCps(saved.cps);
  for (const row of sliders.GLOBAL_ROWS) {
    const value = Number(saved.globals?.[row.key]);
    if (Number.isFinite(value)) {
      sliders.globals[row.key] = Math.min(row.max, Math.max(row.min, value));
    }
  }
  tracks.restore(saved.tracks);
  applyBusEffects();
  const restored = sliders.restore(saved.sliders);
  const bits = [];
  if (restored) bits.push(`${restored} slider${restored === 1 ? '' : 's'}`);
  if (saved.globals?.room || saved.globals?.delay) bits.push('sends');
  if (bits.length) state.status = `restored ${bits.join(' and ')}`;
}

// --- note mode: move notes in the roll, writing the change back to the code ---

// Pinned to the source, not to playback. Rebuilding from whatever the playhead
// was over meant alternation and every(4, rev) moved the notes under the cursor
// each cycle, so the string is fixed on entering the mode.
function pinnedRange() {
  const start = state.noteRangeStart;
  if (start == null) return null;
  const text = editor.text;
  if (text[start] !== '"') return null;
  const end = text.indexOf('"', start + 1);
  return end === -1 ? null : { start, end, text: text.slice(start + 1, end) };
}

function editContext() {
  const range = pinnedRange();
  if (!range) return null;
  const slots = flatSlots(editor.text, range);
  if (!slots) return null;
  return { scale: state.noteScale, items: slots, structured: false };
}

// Called once, on entering the mode. Returns either a sequence or the reason
// there isn't one: "it did not work" covers several different situations and
// the fix differs for each.
function findSequence() {
  if (!engine.pattern || !engine.source) return { error: 'nothing evaluated yet to edit' };

  // the source the engine evaluated must still match the buffer, or the
  // offsets point at the wrong characters
  if (engine.source !== editor.text) {
    return { error: 'buffer has unevaluated edits, ctrl-s first' };
  }

  const cycle = Math.floor(engine.currentCycle);
  let haps;
  try {
    haps = engine.pattern.queryArc(cycle, cycle + 2);
  } catch {
    return { error: 'could not read the pattern here' };
  }
  const notes = editableNotes(haps, engine.source);
  if (!notes.length) return { error: 'no notes under the playhead to edit' };

  const sequences = editableSequences(notes, engine.source);
  if (!sequences.length) {
    return { error: 'note mode needs a flat sequence; polymeter is not editable' };
  }
  // the one the cursor is in, or the closest to it
  const found = nearestSequence(sequences, cursorOffset()) ?? sequences[0];
  return { rangeStart: found.rangeStart, scale: scaleForHap(found.hap, engine.source) };
}

function cursorOffset() {
  return positionToOffset(editor.text, editor.line, editor.col);
}

// How far the cursor is from a sequence: zero when it is inside it. Used to
// start note mode on the part you were looking at rather than on whichever
// sequence happens to come first in the file.
function distanceTo(sequence, offset) {
  const end = editor.text.indexOf('"', sequence.rangeStart + 1);
  const last = end === -1 ? editor.text.length : end;
  if (offset >= sequence.rangeStart && offset <= last) return 0;
  return offset < sequence.rangeStart ? sequence.rangeStart - offset : offset - last;
}

function nearestSequence(sequences, offset) {
  let best = null;
  let bestDistance = Infinity;
  for (const sequence of sequences) {
    const distance = distanceTo(sequence, offset);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = sequence;
    }
  }
  return best;
}

// Derived from the engine, because only the haps say which strings hold
// pitches: a text scan would happily offer sound("bd sn") as a melody.
function allSequences() {
  if (!engine.pattern || engine.source !== editor.text) return [];
  const cycle = Math.floor(engine.currentCycle);
  try {
    const haps = engine.pattern.queryArc(cycle, cycle + 2);
    return editableSequences(editableNotes(haps, engine.source), engine.source);
  } catch {
    return [];
  }
}

// Ordered by position in the source, so this walks down the file and wraps.
function cycleSequence(direction) {
  const sequences = allSequences();
  if (sequences.length < 2) {
    state.status =
      sequences.length === 1
        ? 'this is the only editable sequence here'
        : 'buffer has unevaluated edits, ctrl-s first';
    return;
  }
  const at = sequences.findIndex((seq) => seq.rangeStart === state.noteRangeStart);
  const next = sequences[(at + direction + sequences.length) % sequences.length];

  state.noteRangeStart = next.rangeStart;
  state.noteScale = scaleForHap(next.hap, engine.source);
  state.note = 0;
  const context = editContext();
  if (!context) {
    state.status = 'that sequence is no longer editable';
    return;
  }
  selectItem(context, 0);
  state.status = `sequence ${sequences.indexOf(next) + 1} of ${sequences.length}`;
}

// So entering the mode keeps your place instead of jumping to the front.
function slotNearest(context, offset) {
  let best = 0;
  let bestDistance = Infinity;
  context.items.forEach((item, index) => {
    const distance =
      offset >= item.start && offset <= item.end
        ? 0
        : Math.min(Math.abs(offset - item.start), Math.abs(offset - item.end));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

function selectItem(context, index) {
  const item = context.items[index];
  if (!item) return;
  const from = offsetToPosition(editor.text, item.start);
  const to = offsetToPosition(editor.text, item.end);
  if (from.line !== to.line) return;
  editor.line = from.line;
  editor.col = to.col;
  editor.anchor = { line: from.line, col: from.col };
  state.selectedStart = item.start;
}

function moveItem(steps, useScale) {
  const context = editContext();
  if (!context) {
    state.status = 'nothing editable here';
    return;
  }
  const index = Math.min(state.note, context.items.length - 1);
  const item = context.items[index];

  let replacement;
  if (item.isRest) {
    // an empty slot becomes a note, copying whatever its neighbours use
    replacement = seedPitchFor(context.items, index);
  } else {
    if (useScale) {
      replacement = shiftInScale(item.text, steps, context.scale);
      if (!replacement && context.scale) {
        state.status = `${item.text} is not in ${context.scale}`;
      }
    }
    replacement ??= shift(item.text, steps, item.kind);
  }

  if (!replacement) {
    state.status = `cannot move ${item.text}`;
    return;
  }

  const from = offsetToPosition(editor.text, item.start);
  const to = offsetToPosition(editor.text, item.end);
  if (from.line !== to.line) {
    state.status = 'that spans lines';
    return;
  }
  editor.line = from.line;
  editor.replaceInLine(from.col, to.col, replacement);
  lastRevision = editor.revision;
  const report = item.isRest ? `added ${replacement}` : `${item.text} to ${replacement}`;

  // report after evaluating, or the evaluation's own status overwrites it
  // before a frame is ever drawn
  evaluateBuffer().then(() => {
    const refreshed = editContext();
    if (refreshed) selectItem(refreshed, Math.min(index, refreshed.items.length - 1));
    state.status = report;
  });
}

// Option, not ctrl: macOS gives ctrl with any arrow to Mission Control, so the
// window manager takes those first. Option arrives either as a CSI with the alt
// flag or, in Terminal.app, as the ESC b and ESC f already parsed as word
// movement, so both count. Tab and shift are the fallback nothing intercepts.
function handleNoteKey(key) {
  if (key.type === 'esc') {
    state.mode = 'command';
    state.selectedStart = null;
    state.noteRangeStart = null;
    editor.clearSelection();
    return true;
  }

  // tab steps to the next sequence, so it has to be caught before completion
  if (key.type === 'char' && key.ch === '\t') {
    cycleSequence(1);
    return true;
  }
  // option with left or right, as Terminal.app sends it
  if (key.type === 'word') {
    cycleSequence(key.direction);
    return true;
  }
  if (key.type !== 'csi') return false;

  const context = editContext();
  const total = context ? context.items.length : 0;
  const wide = key.alt || key.shift || key.ctrl || key.cmd;

  switch (key.final) {
    case 'Z': // shift-tab
      cycleSequence(-1);
      return true;
    case 'C':
      if (wide) {
        cycleSequence(1);
        return true;
      }
      state.note = Math.min(state.note + 1, Math.max(0, total - 1));
      if (context) selectItem(context, state.note);
      return true;
    case 'D':
      if (wide) {
        cycleSequence(-1);
        return true;
      }
      state.note = Math.max(0, state.note - 1);
      if (context) selectItem(context, state.note);
      return true;
    case 'A':
      moveItem(1, wide);
      return true;
    case 'B':
      moveItem(-1, wide);
      return true;
    default:
      return true;
  }
}

// Starts on the sequence under the cursor. Reachable from insert with ctrl-e,
// not just from command with e: the cursor is already on the part you want, and
// going out to command mode first only risks losing that place.
function enterNoteMode() {
  const found = findSequence();
  if (found.error) {
    state.status = found.error;
    return;
  }
  state.noteRangeStart = found.rangeStart;
  state.noteScale = found.scale;
  const context = editContext();
  if (!context) {
    state.status = 'no editable sequence here';
    return;
  }
  state.mode = 'notes';
  state.note = slotNearest(context, cursorOffset());
  selectItem(context, state.note);
}

// Rendering runs in its own process. superdough keeps its audio context in a
// module singleton, so bouncing in-process would mean swapping the live context
// out from under playback; a child gets its own and cannot interrupt anything.
let bouncing = false;

async function bounce() {
  if (bouncing) {
    state.status = 'already bouncing';
    return;
  }
  if (editor.dirty && !state.parseOk) {
    state.status = 'fix the syntax before bouncing';
    return;
  }
  if (editor.dirty && !save()) {
    // the child renders the file, so bouncing now would render someone else's
    state.status = 'file changed on disk, ctrl-s or reload before bouncing';
    return;
  }

  const loop = engine.loop;
  const cycles = loop ? loop.end - loop.start : 8;
  const from = loop ? loop.start : 0;
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  const target = file.replace(/\.str$/, '') + `-${stamp}.wav`;

  bouncing = true;
  state.status = `bouncing ${cycles} cycles…`;

  const { spawn } = await import('node:child_process');
  const script = fileURLToPath(new URL('../scripts/bounce.mjs', import.meta.url));
  // The mixer is session state, not part of the file, so the child has no way
  // to know about it. Without this a bounce was missing whatever was turned up:
  // reverb, delay, flanger and chorus alike, which is not what you were
  // listening to when you pressed the key.
  const mixer = [];
  for (const row of sliders.GLOBAL_ROWS) {
    const value = sliders.globals[row.key];
    // parameters always have a value and must be passed even at zero, since
    // zero feedback is a real setting; only the mixes are skipped when off
    if (row.param || value) mixer.push(`--${row.key.toLowerCase()}`, String(value));
  }

  const child = spawn(
    process.execPath,
    [
      script, file, target,
      '--cycles', String(cycles),
      '--cps', String(engine.cps),
      '--from', String(from),
      ...mixer,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('close', (code) => {
    bouncing = false;
    const line = output.trim().split('\n').filter(Boolean).pop() ?? '';
    state.status = code === 0 ? line.replace(/^wrote /, 'wrote ') : `bounce failed: ${line.slice(0, 60)}`;
  });
}

function cycleReference() {
  const index = CHEATSHEET_ORDER.indexOf(state.cheatsheet ?? null);
  state.cheatsheet = CHEATSHEET_ORDER[(index + 1) % CHEATSHEET_ORDER.length];
}

function bakeSliders() {
  const { code, changed } = sliders.bake(editor.text);
  if (!changed) {
    state.status = 'sliders already match the code';
    return;
  }
  editor.setText(code);
  editor.dirty = true;
  lastRevision = editor.revision;
  state.status = `baked ${changed} slider value${changed === 1 ? '' : 's'}`;
  save();
  evaluateBuffer();
}

function handleCsi(key) {
  const { params, final, shift, alt } = key;
  if (state.mode === 'command' && handleSliderKey(final)) return;

  // shift extends a selection from wherever it started; anything else drops it
  if (shift) editor.startSelection();
  else editor.clearSelection();

  const step = params.split(';')[0];

  switch (final) {
    case 'A': return editor.move(-1, 0);
    case 'B': return editor.move(1, 0);
    case 'C': return alt ? editor.wordRight() : editor.move(0, 1);
    case 'D': return alt ? editor.wordLeft() : editor.move(0, -1);
    case 'H': return editor.home();
    case 'F': return editor.end();
    case '~':
      if (step === '3') return editor.deleteForward();
      if (step === '1' || step === '7') return editor.home();
      if (step === '4' || step === '8') return editor.end();
      if (step === '5') return editor.move(-10, 0);
      if (step === '6') return editor.move(10, 0);
      return;
    default:
      return;
  }
}

function handleCommandKey(ch) {
  switch (ch) {
    case ' ': return engine.toggle();
    case '+':
    case '=': return engine.setCps(engine.cps * 1.05);
    case '-':
    case '_': return engine.setCps(engine.cps / 1.05);
    case 'w': return tui.toggleWaveform();
    case 'p': return tui.toggleRoll();
    case 't': return tui.toggleTimeline();
    case 'x': return bounce();
    case '[': {
      const start = Math.floor(engine.currentCycle);
      const end = engine.loop?.end ?? start + 4;
      const loop = engine.setLoop(start, end);
      state.status = loop ? `loop ${loop.start} to ${loop.end}` : 'loop cleared';
      return;
    }
    case ']': {
      const end = Math.ceil(engine.currentCycle);
      const start = engine.loop?.start ?? Math.max(0, end - 4);
      const loop = engine.setLoop(start, end);
      state.status = loop ? `loop ${loop.start} to ${loop.end}` : 'loop needs an earlier start';
      return;
    }
    case '\\':
      engine.setLoop(null, null);
      state.status = 'loop cleared';
      return;
    case '0':
      engine.seek(engine.loop?.start ?? 0);
      state.status = 'back to the top';
      return;
    case ',':
      engine.seek(Math.max(0, Math.floor(engine.currentCycle) - 1));
      return;
    case '.':
      engine.seek(Math.floor(engine.currentCycle) + 1);
      return;
    case 'm':
    case 's': {
      const row = panelRows(engine)[state.slider ?? 0];
      if (!row || row.track === undefined) {
        state.status = 'pick a track row first';
        return;
      }
      if (ch === 'm') tracks.toggleMute(row.track);
      else tracks.toggleSolo(row.track);
      const now = tracks.stateOf(row.track);
      state.status = `${row.label} ${now.soloed ? 'solo' : now.muted ? 'muted' : 'on'}`;
      scheduleStateSave();
      return;
    }
    case 'a':
      state.auto = !state.auto;
      state.status = state.auto ? 'auto-update on' : 'auto-update off';
      if (state.auto) scheduleAuto();
      else cancelAuto();
      return;
    case '?':
      return cycleReference();
    case 'b':
      return bakeSliders();
    case 'e':
      return enterNoteMode();
    case 'r': return reloadFromDisk();
    case 'q': return shutdown();
    case 'i':
    case '\r':
      state.mode = 'insert';
      return;
    default:
      return;
  }
}

function handleKey(key) {
  if (state.mode === 'notes' && handleNoteKey(key)) return;
  if (key.type === 'csi') return handleCsi(key);

  if (key.type === 'paste') {
    if (state.mode !== 'insert') return;
    return editor.insertText(key.text);
  }
  if (key.type === 'alt-backspace') {
    if (state.mode !== 'insert') return;
    return editor.deleteWordLeft();
  }
  if (key.type === 'word') {
    editor.clearSelection();
    return key.direction < 0 ? editor.wordLeft() : editor.wordRight();
  }

  if (key.type === 'esc') {
    state.mode = 'command';
    editor.clearSelection();
    return;
  }

  const ch = key.ch;
  const code = ch.charCodeAt(0);

  // control keys work in either mode
  switch (code) {
    case 3: // ctrl-c copies a selection, and quits when there is none
      if (editor.hasSelection()) {
        clipboard = editor.selectedText();
        state.status = `copied ${clipboard.length} characters`;
        return;
      }
      return shutdown();
    case 17: // ctrl-q always quits
      return shutdown();
    case 19: // ctrl-s: an explicit save wins over whatever is on disk
      save({ force: true });
      return evaluateBuffer();
    case 16: // ctrl-p
      return engine.toggle();
    case 15: // ctrl-o, was ctrl-w before word delete took that
      return tui.toggleWaveform();
    case 5: // ctrl-e enters note mode on the sequence under the cursor
      return enterNoteMode();
    case 7: // ctrl-g cycles: off, notation, control ranges
      return cycleReference();
  }

  if (state.mode === 'command') return handleCommandKey(ch);

  if (ch === '\r' || ch === '\n') return editor.newline();
  if (code === 127 || code === 8) return editor.backspace();
  if (ch === '\t') return handleTab();
  if (code === 26) return void editor.undo(); // ctrl-z
  if (code === 25) return void editor.redo(); // ctrl-y
  if (code === 11) return editor.killToEnd(); // ctrl-k
  if (code === 21) return editor.deleteToLineStart(); // ctrl-u
  if (code === 23) return editor.deleteWordLeft(); // ctrl-w
  if (code === 24) { // ctrl-x cut
    if (!editor.hasSelection()) return;
    clipboard = editor.selectedText();
    editor.deleteSelection();
    state.status = `cut ${clipboard.length} characters`;
    return;
  }
  if (code === 22) { // ctrl-v paste
    if (!clipboard) return;
    return editor.insertText(clipboard);
  }
  if (code === 1) return editor.home(); // ctrl-a
  if (code === 5) return editor.end(); // ctrl-e
  if (code >= 32) return editor.insert(ch);
}

await engine.init(latency, { silent });

if (!reclaimAvailable()) {
  state.error = 'running without --expose-gc: audio will degrade into dropouts over time';
}

// Cache before the first fetch so the sample map is stored too.
installFetchCache();

if (bank) {
  state.status = 'loading samples…';
  try {
    const count = await loadSampleBank(bank);
    state.status = `${count} sounds available`;
  } catch (err) {
    // no network and nothing cached: synths still work, so carry on
    state.error = `samples unavailable (${err.message}); synths still work`;
  }
}

await evaluateBuffer();

// After the first evaluation, so the slots and their ranges exist to clamp into
restoreState();
schedulePrune();

// Names come from the loaded modules, so completion tracks whatever version is
// installed rather than a list that goes stale.
try {
  const core = await import('@strudel/core');
  const tonal = await import('@strudel/tonal');
  const dough = await import('superdough');
  await initVocabulary({
    pattern: engine.pattern ?? core.silence,
    modules: [core, tonal],
    dough,
  });
} catch (err) {
  state.error = `completion unavailable: ${err.message}`;
}

// Watch the directory, not the file: vim and friends replace the inode on
// write, which silently kills a file watch.
let debounce = null;
watch(dirname(file), (_event, changed) => {
  if (changed && changed !== basename(file)) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    if (text === lastWritten) return; // our own save
    if (text === editor.text) return; // nothing new
    if (editor.dirty) {
      // someone else wrote the file while this buffer has unsaved edits.
      // Refuse to throw the buffer away; r reloads from disk on purpose.
      state.error = 'file changed on disk, buffer has unsaved edits (esc then r to take the disk version)';
      return;
    }
    editor.setText(text);
    lastRevision = editor.revision;
    lastWritten = text;
    // note mode holds offsets into the old text; they mean nothing now
    if (state.mode === 'notes') {
      state.mode = 'command';
      state.noteRangeStart = null;
      state.selectedStart = null;
    }
    state.status = `reloaded ${stamp()}`;
    evaluateBuffer();
  }, 60);
});

// Set STRUDEL_TERM_KEYLOG=/path to record every key the app actually receives.
// The TUI owns the screen, so this is the only way to see input problems.
const keyLog = process.env.STRUDEL_TERM_KEYLOG;

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (buf) => {
    const raw = buf.toString();
    if (keyLog) {
      const desc = [...raw].map((c) => {
        const n = c.charCodeAt(0);
        return n < 32 || n === 127 ? `<${n}>` : c;
      }).join('');
      appendFileSync(keyLog, `${Date.now()} mode=${state.mode} raw=${JSON.stringify(desc)}\n`);
    }
    for (const key of parseKeys(raw)) {
      const isTab = key.type === 'char' && key.ch === '\t';
      handleKey(key);
      if (!isTab) completion = null;
    }
    refreshHint();

    if (editor.revision !== lastRevision) {
      lastRevision = editor.revision;
      scheduleAuto();
    }
  });
} else if (keyLog) {
  appendFileSync(keyLog, 'stdin is not a TTY, no key handling\n');
}

// With STRUDEL_TERM_PERF set, report what the audio backend is actually doing.
// Peak load over 1.0 is the renderer failing to keep up, which is audible.
if (process.env.STRUDEL_TERM_PERF) {
  const statsTimer = setInterval(() => {
    const { peakLoad, underruns } = renderStats();
    const heap = process.memoryUsage().heapUsed / 1048576;
    perf(
      `audio peakLoad=${peakLoad.toFixed(2)} underruns=${underruns.toFixed(4)} ` +
      `gc=${reclaimAvailable() ? 'on' : 'OFF'} heap=${heap.toFixed(1)}MB`,
    );
  }, 5000);
  statsTimer.unref?.();
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
// Superdough throws from inside async audio callbacks, so those land here
// rather than at any call site. Dying mid-performance is the worst possible
// response: show it and keep playing. Only bail if it starts repeating, which
// means something is wrong every tick rather than once.
let runtimeErrors = 0;
let uiReady = false;

function onRuntimeError(err) {
  if (!uiReady) {
    tui.stop();
    releaseConsole();
    console.error(err);
    shutdown(1);
    return;
  }
  runtimeErrors++;
  state.error = `runtime error: ${err?.message ?? err}`;
  if (runtimeErrors > 50) {
    state.error = 'too many runtime errors, stopping';
    shutdown(1);
  }
}

process.on('uncaughtException', onRuntimeError);
process.on('unhandledRejection', onRuntimeError);

tui.start();
uiReady = true;

// A device that never starts rendering looks exactly like one that is playing
// silently, so say so rather than leaving it a mystery.
// Start playback only once the device is confirmed alive. Scheduling into a
// wedged context blocks inside the audio FFI, which freezes the redraw and the
// key handling too: the program looks hung rather than silent.
// Keep looking for a while: a device can take a moment to come up, and
// refusing to play on a machine that is merely slow is worse than a late start.
(async () => {
  for (const attempt of [0, 1, 2]) {
    if (await deviceIsRunning()) {
      engine.start();
      state.error = null;
      if (attempt > 0) state.status = 'audio device came up late, playing';
      return;
    }
    state.error = `waiting for the audio device (context ${contextState()})…`;
  }
  state.error =
    `audio device never started (context ${contextState()}): playback disabled. ` +
    'quit, then try: sudo killall coreaudiod';
})();
