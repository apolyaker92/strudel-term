// Editing notes in the roll by rewriting the source they came from. The
// transpiler tags every mini-notation string with its offset and each hap
// carries the locations that produced it, so a note on screen traces back to
// the characters that made it. Pitches invented by a chord voicing or an
// arpeggiator have no source text and are reported as not editable.

import { noteToMidi, midi2note } from '@strudel/core';
import { Scale, Note } from '@tonaljs/tonal';

// The quoted string a location sits inside, so a token can be judged by the
// call it belongs to rather than by its text alone.
function enclosingString(code, loc) {
  const open = code.lastIndexOf('"', loc.start);
  if (open === -1) return null;
  const close = code.indexOf('"', loc.end);
  if (close === -1) return null;
  return { start: open, end: close, text: code.slice(open + 1, close) };
}

function isScaleString(code, range) {
  return /\.scale\(\s*$/.test(code.slice(Math.max(0, range.start - 24), range.start));
}

export function scaleForHap(hap, code) {
  for (const loc of hap.context?.locations ?? []) {
    const range = enclosingString(code, loc);
    if (range && isScaleString(code, range)) return range.text;
  }
  return null;
}

function scaleNotes(name) {
  if (!name) return [];
  const [root, ...rest] = name.split(':');
  return Scale.get(`${root} ${rest.join(' ')}`).notes ?? [];
}

/**
 * Move a note name by scale steps rather than semitones. Returns null when the
 * scale is unknown or the note is not in it, so the caller can fall back to a
 * chromatic move instead of producing something wrong.
 */
export function shiftInScale(text, steps, scaleName) {
  const notes = scaleNotes(scaleName);
  if (!notes.length) return null;

  const chroma = Note.chroma(Note.pitchClass(text));
  const octave = Note.octave(text);
  if (chroma == null || octave == null) return null;

  const index = notes.findIndex((n) => Note.chroma(n) === chroma);
  if (index < 0) return null;

  const target = index + steps;
  const wrapped = ((target % notes.length) + notes.length) % notes.length;
  const moved = notes[wrapped] + (octave + Math.floor(target / notes.length));
  return /^[a-z]/.test(text) ? moved.toLowerCase() : moved;
}

function asMidi(text) {
  try {
    const midi = noteToMidi(text);
    return Number.isFinite(midi) ? midi : null;
  } catch {
    return null;
  }
}

// Which of a hap's locations holds its pitch. A hap carries every mini string
// that contributed, sound name and scale included, so the match must be exact:
// enharmonic matching read the "C" in scale("C:major") as the note C3 and a
// transpose rewrote it to scale("Db3:major").
export function locationFor(hap, code) {
  const locations = hap.context?.locations ?? [];
  const degree = hap.value?.n;
  const note = hap.value?.note;

  // degrees first: with n().scale(), the literal you typed is the degree, and
  // the note name is derived from a scale that must not be edited
  if (degree != null) {
    for (const loc of locations) {
      const text = code.slice(loc.start, loc.end);
      if (text === String(degree)) return { ...loc, text, kind: 'degree' };
    }
    return null;
  }

  if (note != null) {
    for (const loc of locations) {
      const text = code.slice(loc.start, loc.end);
      if (text.toLowerCase() === String(note).toLowerCase()) {
        return { ...loc, text, kind: 'note' };
      }
    }

    // n("0 2 4").scale(...) turns degrees into note names, so the literal no
    // longer matches the value. A bare integer outside the scale string is the
    // degree that produced it.
    for (const loc of locations) {
      const text = code.slice(loc.start, loc.end);
      if (!/^-?\d+$/.test(text)) continue;
      const range = enclosingString(code, loc);
      if (range && isScaleString(code, range)) continue;
      return { ...loc, text, kind: 'degree' };
    }
  }
  return null;
}

// In time order, which is what makes the first one the one under the playhead.
export function editableNotes(haps, code) {
  return haps
    .filter((hap) => hap.whole)
    .map((hap) => {
      const location = locationFor(hap, code);
      return location ? { hap, location, begin: hap.whole.begin.valueOf() } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.begin - b.begin || a.location.start - b.location.start);
}

/**
 * Rewrite one note by a number of steps. Note names move by semitones and keep
 * their spelling style; scale degrees move by one degree, since a degree is
 * already relative to whatever scale is in force.
 */
export function shift(text, steps, kind = 'note') {
  if (kind === 'degree' || /^-?\d+$/.test(text)) {
    return String(Number(text) + steps);
  }
  const midi = asMidi(text);
  if (midi == null) return null;
  const moved = midi2note(midi + steps);
  // strudel writes note names capitalised; keep the case the source used
  return /^[a-z]/.test(text) ? moved.toLowerCase() : moved;
}

// The mini string a note lives in, so its siblings and its rests can be found.
// It has to be the string holding the pitch, not merely the first one that is
// not a scale: a hap also carries the sound name, which comes first.
export function stringRangeFor(hap, code) {
  const location = locationFor(hap, code);
  return location ? enclosingString(code, location) : null;
}

// Mini notation this cannot reason about. Polymeter changes the step rate of a
// whole group, and the `%` that goes with it, so the slots inside are not
// independent of each other the way the rest are.
const UNSUPPORTED_MINI = /[{}]/;

// Characters that shape the sequence rather than name a sound. Stepping over
// them is safe because every slot is replaced by its exact source range, so
// nothing around it moves.
const STRUCTURE = ' \t[]<>(),_.';

// Operators whose operand is a count or a probability, not a pitch. Without
// skipping the operand, the 3 in `c4*3` and the 0.5 in `c4?0.5` would each look
// like a slot and editing one would rewrite the wrong characters.
const OPERATORS = '*!@/:?';

const SLOT_CHAR = /[A-Za-z0-9#'-]/;

// Rests included, in source order. Brackets, chords and alternation are walked
// rather than refused: they change the slot-to-time mapping, which this does not
// need, since each slot carries the exact range that produced it. Null for
// notation it cannot account for.
export function flatSlots(code, range) {
  if (!range) return null;
  const body = code.slice(range.start + 1, range.end);
  if (UNSUPPORTED_MINI.test(body)) return null;

  const slots = [];
  const push = (from, to, text) =>
    slots.push({
      start: range.start + 1 + from,
      end: range.start + 1 + to,
      text,
      isRest: text === '~',
      index: slots.length,
    });

  let i = 0;
  while (i < body.length) {
    const ch = body[i];

    if (STRUCTURE.includes(ch)) {
      i++;
      continue;
    }

    if (OPERATORS.includes(ch)) {
      i++;
      // a patterned operand such as *<2 3> is more than this can follow
      if (body[i] === '<' || body[i] === '[') return null;
      while (i < body.length && /[A-Za-z0-9.]/.test(body[i])) i++;
      continue;
    }

    if (ch === '~') {
      push(i, i + 1, '~');
      i++;
      continue;
    }

    if (SLOT_CHAR.test(ch)) {
      const from = i;
      while (i < body.length && SLOT_CHAR.test(body[i])) i++;
      push(from, i, body.slice(from, i));
      continue;
    }

    // something this does not recognise: refuse rather than rewrite blind
    return null;
  }

  return slots.length ? slots : null;
}

export function firstEditableSequence(notes, code) {
  return editableSequences(notes, code)[0] ?? null;
}

// In source order, one entry per distinct mini string. Every string is tried,
// not just whichever note sorts first: stopping there hid an editable melody
// behind an unsupported layer above it.
export function editableSequences(notes, code) {
  const byStart = new Map();
  for (const note of notes) {
    const range = stringRangeFor(note.hap, code);
    if (!range || byStart.has(range.start)) continue;
    if (!flatSlots(code, range)) {
      // remembered as refused, so a later note in the same string is not retried
      byStart.set(range.start, null);
      continue;
    }
    byStart.set(range.start, { rangeStart: range.start, hap: note.hap });
  }
  return [...byStart.values()].filter(Boolean).sort((a, b) => a.rangeStart - b.rangeStart);
}

// What to put in an empty slot: whatever the nearest filled neighbour holds.
// Copying the neighbour keeps the notation consistent, so a degree pattern gets
// a degree and a note pattern gets a note name.
export function seedPitchFor(slots, index) {
  for (let step = 1; step < slots.length; step++) {
    for (const candidate of [slots[index - step], slots[index + step]]) {
      if (candidate && !candidate.isRest) return candidate.text;
    }
  }
  return 'c3';
}

export function positionToOffset(text, line, col) {
  const lines = text.split('\n');
  const row = Math.max(0, Math.min(lines.length - 1, line));
  let offset = 0;
  for (let i = 0; i < row; i++) offset += lines[i].length + 1;
  return offset + Math.max(0, Math.min(lines[row].length, col));
}

export function offsetToPosition(text, offset) {
  const before = text.slice(0, offset);
  const lastBreak = before.lastIndexOf('\n');
  return { line: before.split('\n').length - 1, col: offset - (lastBreak + 1) };
}

export function applyEdit(code, location, replacement) {
  return code.slice(0, location.start) + replacement + code.slice(location.end);
}
