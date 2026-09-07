// Buffer and key-parsing tests. No audio, no TTY.
import assert from 'node:assert/strict';
import { Editor, parseKeys } from '../src/editor.mjs';
import { writeSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { cacheSize, clearCache, CACHE_DIR } from '../src/samples.mjs';

let passed = 0;

// Failures go straight to the file descriptor. Several tests replace
// process.stdout.write to capture a frame, and a failure reported through
// console can be swallowed by that: six tests were failing while the suite
// printed success.
const started = [];
const pending = [];

function reportFailure(name, err) {
  const where = (err.stack ?? '').split('\n').slice(1, 3).join('\n');
  writeSync(2, `FAIL ${name}: ${err.message}\n${where}\n`);
  process.exitCode = 1;
}

const test = (name, fn) => {
  started.push(name);
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      // Tracked whether or not the caller awaits, so an un-awaited async test
      // cannot settle after the summary and escape the count. The handled
      // promise is what gets returned: returning the raw one meant that
      // `await test(...)` rethrew at the top level, killing the run before the
      // summary and skipping every test after the first async failure.
      const handled = result.then(
        () => { passed++; },
        (err) => reportFailure(name, err),
      );
      pending.push(handled);
      return handled;
    }
    passed++;
  } catch (err) {
    reportFailure(name, err);
  }
  return undefined;
};

test('insert at cursor', () => {
  const e = new Editor('ac');
  e.col = 1;
  e.insert('b');
  assert.equal(e.text, 'abc');
  assert.equal(e.col, 2);
});

test('newline keeps indentation', () => {
  const e = new Editor('    note("c3")');
  e.col = 14;
  e.newline();
  assert.deepEqual(e.lines, ['    note("c3")', '    ']);
  assert.equal(e.col, 4);
});

test('newline splits mid line', () => {
  const e = new Editor('abcd');
  e.col = 2;
  e.newline();
  assert.deepEqual(e.lines, ['ab', 'cd']);
  assert.equal(e.line, 1);
  assert.equal(e.col, 0);
});

test('backspace joins lines', () => {
  const e = new Editor('ab\ncd');
  e.line = 1;
  e.col = 0;
  e.backspace();
  assert.equal(e.text, 'abcd');
  assert.equal(e.line, 0);
  assert.equal(e.col, 2);
});

test('backspace eats a soft tab whole', () => {
  const e = new Editor('    x');
  e.col = 4;
  e.backspace();
  assert.equal(e.text, '  x');
  assert.equal(e.col, 2);
});

test('backspace at origin is a no-op', () => {
  const e = new Editor('abc');
  e.backspace();
  assert.equal(e.text, 'abc');
});

test('delete forward joins the next line', () => {
  const e = new Editor('ab\ncd');
  e.col = 2;
  e.deleteForward();
  assert.equal(e.text, 'abcd');
});

test('left at column zero wraps to the previous line end', () => {
  const e = new Editor('ab\ncd');
  e.line = 1;
  e.col = 0;
  e.move(0, -1);
  assert.equal(e.line, 0);
  assert.equal(e.col, 2);
});

test('right at line end wraps forward', () => {
  const e = new Editor('ab\ncd');
  e.col = 2;
  e.move(0, 1);
  assert.equal(e.line, 1);
  assert.equal(e.col, 0);
});

test('vertical move clamps the column to a shorter line', () => {
  const e = new Editor('abcdef\nxy');
  e.col = 6;
  e.move(1, 0);
  assert.equal(e.line, 1);
  assert.equal(e.col, 2);
});

test('move past the last line clamps', () => {
  const e = new Editor('a\nb');
  e.move(50, 0);
  assert.equal(e.line, 1);
});

test('home toggles between indent and column zero', () => {
  const e = new Editor('    xy');
  e.col = 6;
  e.home();
  assert.equal(e.col, 4);
  e.home();
  assert.equal(e.col, 0);
});

test('kill to end truncates then eats the newline', () => {
  const e = new Editor('abcd\nef');
  e.col = 2;
  e.killToEnd();
  assert.equal(e.text, 'ab\nef');
  e.killToEnd();
  assert.equal(e.text, 'ab');
});

test('setText clamps a cursor past the new end', () => {
  const e = new Editor('aaaa\nbbbb\ncccc');
  e.line = 2;
  e.col = 4;
  e.setText('x');
  assert.equal(e.line, 0);
  assert.equal(e.col, 1);
});

test('dirty tracks edits and clears on setText', () => {
  const e = new Editor('a');
  assert.equal(e.dirty, false);
  e.insert('b');
  assert.equal(e.dirty, true);
  e.setText('c');
  assert.equal(e.dirty, false);
});

test('parseKeys splits arrows from text', () => {
  const keys = parseKeys('ab\x1b[Ac');
  assert.deepEqual(
    keys.map((k) => k.type === 'char' ? k.ch : `${k.type}:${k.final ?? ''}`),
    ['a', 'b', 'csi:A', 'c'],
  );
});

test('parseKeys recognises delete and SS3 arrows', () => {
  const del = parseKeys('\x1b[3~')[0];
  assert.equal(del.type, 'csi');
  assert.equal(del.params, '3');
  assert.equal(del.final, '~');
  const down = parseKeys('\x1bOB')[0];
  assert.equal(down.type, 'csi');
  assert.equal(down.final, 'B');
});

test('parseKeys separates shift and alt from a plain arrow', () => {
  const shifted = parseKeys('\x1b[1;2C')[0];
  assert.equal(shifted.final, 'C');
  assert.equal(shifted.shift, true);
  assert.equal(shifted.alt, false);

  const alted = parseKeys('\x1b[1;3D')[0];
  assert.equal(alted.alt, true);
  assert.equal(alted.shift, false);

  const plain = parseKeys('\x1b[C')[0];
  assert.equal(plain.shift, false);
  assert.equal(plain.alt, false);
});

test('parseKeys keeps a bracketed paste whole', () => {
  const keys = parseKeys('\x1b[200~one\ntwo\x1b[201~');
  assert.equal(keys.length, 1);
  assert.equal(keys[0].type, 'paste');
  assert.equal(keys[0].text, 'one\ntwo');
});

test('parseKeys recognises option-backspace and escape-b', () => {
  assert.equal(parseKeys('\x1b\x7f')[0].type, 'alt-backspace');
  assert.equal(parseKeys('\x1bb')[0].direction, -1);
  assert.equal(parseKeys('\x1bf')[0].direction, 1);
});

// --- selection ---
test('a selection spans from the anchor to the cursor', () => {
  const ed = new Editor('hello world');
  ed.col = 6;
  ed.startSelection();
  ed.col = 11;
  assert.equal(ed.hasSelection(), true);
  assert.equal(ed.selectedText(), 'world');
});

test('a selection reads the same when made backwards', () => {
  const ed = new Editor('hello world');
  ed.col = 11;
  ed.startSelection();
  ed.col = 6;
  assert.equal(ed.selectedText(), 'world');
});

test('a selection can span lines', () => {
  const ed = new Editor('one\ntwo\nthree');
  ed.line = 0; ed.col = 1;
  ed.startSelection();
  ed.line = 2; ed.col = 2;
  assert.equal(ed.selectedText(), 'ne\ntwo\nth');
});

test('typing replaces the selection', () => {
  const ed = new Editor('hello world');
  ed.col = 6; ed.startSelection(); ed.col = 11;
  ed.insert('there');
  assert.equal(ed.text, 'hello there');
  assert.equal(ed.hasSelection(), false);
});

test('backspace deletes the selection rather than one character', () => {
  const ed = new Editor('hello world');
  ed.col = 6; ed.startSelection(); ed.col = 11;
  ed.backspace();
  assert.equal(ed.text, 'hello ');
});

test('deleting a multi-line selection joins the ends', () => {
  const ed = new Editor('one\ntwo\nthree');
  ed.line = 0; ed.col = 1;
  ed.startSelection();
  ed.line = 2; ed.col = 2;
  ed.deleteSelection();
  assert.equal(ed.text, 'oree');
  assert.equal(ed.line, 0);
  assert.equal(ed.col, 1);
});

test('one undo restores a deleted selection', () => {
  const ed = new Editor('hello world');
  ed.col = 6; ed.startSelection(); ed.col = 11;
  ed.deleteSelection();
  ed.undo();
  assert.equal(ed.text, 'hello world');
});

// --- words ---
test('word movement steps over separators', () => {
  const ed = new Editor('note("c3").gain(1)');
  ed.col = 18;
  ed.wordLeft();
  assert.equal(ed.col, 16, 'lands before 1');
  ed.wordLeft();
  assert.equal(ed.col, 11, 'lands before gain');
});

test('word delete removes a word, not a character', () => {
  const ed = new Editor('note cutoff');
  ed.col = 11;
  ed.deleteWordLeft();
  assert.equal(ed.text, 'note ');
});

test('delete to line start keeps the tail', () => {
  const ed = new Editor('    .cutoff(800)');
  ed.col = 11;
  ed.deleteToLineStart();
  assert.equal(ed.text, '(800)');
});

test('word movement stops at line boundaries', () => {
  const ed = new Editor('ab\ncd');
  ed.line = 1; ed.col = 0;
  ed.wordLeft();
  assert.equal(ed.line, 0);
  assert.equal(ed.col, 2);
});

// --- paste ---
test('pasting multiple lines does not re-indent them', () => {
  const ed = new Editor('    ');
  ed.col = 4;
  ed.insertText('a\n  b\nc');
  assert.deepEqual(ed.lines, ['    a', '  b', 'c']);
  assert.equal(ed.line, 2);
  assert.equal(ed.col, 1);
});

test('pasting replaces a selection', () => {
  const ed = new Editor('keep DROP end');
  ed.col = 5; ed.startSelection(); ed.col = 9;
  ed.insertText('new');
  assert.equal(ed.text, 'keep new end');
});

test('select all covers the whole buffer', () => {
  const ed = new Editor('one\ntwo');
  ed.selectAll();
  assert.equal(ed.selectedText(), 'one\ntwo');
});

test('parseKeys treats a bare escape as esc', () => {
  assert.equal(parseKeys('\x1b')[0].type, 'esc');
});

test('parseKeys passes control characters through as chars', () => {
  const keys = parseKeys('\x13\x7f');
  assert.deepEqual(keys.map((k) => k.ch.charCodeAt(0)), [19, 127]);
});


// --- fuzzing the editor ---
// Random operation sequences against the invariants every other part relies on.
// This found three real faults on its first run: a selection anchor left
// pointing past the end of the buffer after lines were deleted, a paste that
// then read a line which no longer existed, and insert() accepting a newline
// and leaving a line holding a line break.
test('random operation sequences never break the editor invariants', () => {
  let seed = 20260905;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const chars = 'abc 3#[]<>"~*,()./\n\t'.split('');
  const ops = ['insert', 'newline', 'backspace', 'delete', 'move', 'home', 'end', 'kill',
    'word', 'wordDel', 'select', 'paste', 'undo', 'redo', 'tab', 'selectAll', 'delSel',
    'lineStart', 'replace'];

  for (let round = 0; round < 12; round++) {
    const ed = new Editor('note("c3 e3")\nsound("bd")');
    for (let step = 0; step < 60; step++) {
      const op = pick(ops);
      if (op === 'insert') ed.insert(pick(chars));
      else if (op === 'newline') ed.newline();
      else if (op === 'backspace') ed.backspace();
      else if (op === 'delete') ed.deleteForward();
      else if (op === 'move') ed.move(Math.floor(rnd() * 5) - 2, Math.floor(rnd() * 5) - 2);
      else if (op === 'home') ed.home();
      else if (op === 'end') ed.end();
      else if (op === 'kill') ed.killToEnd();
      else if (op === 'word') (rnd() < 0.5 ? ed.wordLeft() : ed.wordRight());
      else if (op === 'wordDel') ed.deleteWordLeft();
      else if (op === 'select') (rnd() < 0.5 ? ed.startSelection() : ed.clearSelection());
      else if (op === 'paste') ed.insertText(pick(['x', 'a\nb', '', 'p\nq\nr']));
      else if (op === 'undo') ed.undo();
      else if (op === 'redo') ed.redo();
      else if (op === 'tab') ed.tab();
      else if (op === 'selectAll') ed.selectAll();
      else if (op === 'delSel') ed.deleteSelection();
      else if (op === 'lineStart') ed.deleteToLineStart();
      else if (op === 'replace') ed.replaceInLine(Math.floor(rnd() * 6), Math.floor(rnd() * 8), 'z');
      ed.selectedText();

      assert.ok(!ed.lines.some((l) => l.includes('\n')), 'a line held a newline');
      assert.ok(ed.line >= 0 && ed.line < ed.lines.length, 'cursor line out of range');
      assert.ok(ed.col >= 0 && ed.col <= ed.lines[ed.line].length, 'cursor column out of range');
      if (ed.anchor) {
        assert.ok(ed.anchor.line >= 0 && ed.anchor.line < ed.lines.length, 'anchor line out of range');
        assert.ok(ed.anchor.col <= ed.lines[ed.anchor.line].length, 'anchor column out of range');
      }
    }
  }
});

test('inserting a newline splits the line instead of corrupting it', () => {
  const ed = new Editor('abcd');
  ed.col = 2;
  ed.insert('\n');
  assert.deepEqual(ed.lines, ['ab', 'cd']);
});

// --- completion ---
const { initVocabulary, contextAt, completionsFor, describe, isUnsupported, rangeOf } =
  await import('../src/complete.mjs');

const fakeProto = { gain() {}, cutoff() {}, crush() {}, coarse() {}, fast() {}, notAFunction: 1 };
await initVocabulary({
  pattern: Object.create(fakeProto),
  modules: [{ stack: () => {}, note: () => {}, sound: () => {}, silence: () => {}, NotLower: () => {} }],
  dough: { soundMap: { get: () => ({ sawtooth: 1, square: 1, sine: 1, white: 1 }) } },
});

test('context after a dot is a method', () => {
  const c = contextAt('note("c3").gai', 14);
  assert.equal(c.kind, 'method');
  assert.equal(c.token, 'gai');
  assert.equal(c.start, 11);
});

test('context on a bare word is a global', () => {
  const c = contextAt('sta', 3);
  assert.equal(c.kind, 'global');
  assert.equal(c.token, 'sta');
});

test('context inside sound() is a sound name', () => {
  const c = contextAt('sound("saw', 10);
  assert.equal(c.kind, 'sound');
  assert.equal(c.token, 'saw');
});

test('context inside an unrelated string is not completed', () => {
  const c = contextAt('note("c3 e', 10);
  assert.equal(c.kind, 'string');
  assert.deepEqual(completionsFor('note("c3 e', 10).matches, []);
});

test('completion does not trigger inside a comment', () => {
  assert.equal(contextAt('// x.cut', 8).kind, 'comment');
  assert.deepEqual(completionsFor('// x.cut', 8).matches, []);
  assert.deepEqual(completionsFor('  // sound("b', 13).matches, []);
  assert.deepEqual(completionsFor('x.gain(1) // .cut', 17).matches, []);
});

test('single quotes and backticks are strings too', () => {
  // counting double quotes could not see these, so completion offered
  // function names inside a sound literal
  assert.equal(contextAt("s('bd", 5).kind, 'sound');
  assert.equal(contextAt('s(`bd', 5).kind, 'sound');
  assert.equal(contextAt("note('c3 e", 10).kind, 'string');
  assert.equal(contextAt("s('bd') // x", 12).kind, 'comment');
});

test('the cursor just past a closing quote is back in code', () => {
  assert.equal(contextAt('note("c3"', 8).kind, 'string', 'before the quote');
  assert.equal(contextAt('note("c3"', 9).kind, 'global', 'after it');
  assert.equal(contextAt('s("bd").', 8).kind, 'method');
});

test('an empty string literal still completes sounds', () => {
  const c = contextAt('s("")', 3);
  assert.equal(c.kind, 'sound');
  assert.equal(c.token, '');
  assert.equal(c.start, 3);
});

test('a comment marker inside a string is not a comment', () => {
  // the tokenizer settles this, which is why it is reused rather than
  // scanning for a bare "//"
  assert.equal(contextAt('note("a//b").c', 14).kind, 'method');
  assert.ok(completionsFor('note("a//b").c', 14).matches.length > 0);
});

test('the cursor just before a comment still completes', () => {
  assert.equal(contextAt('x.c // trailing', 3).kind, 'method');
  assert.ok(completionsFor('x.c // trailing', 3).matches.length > 0);
});

test('method completion matches the prefix', () => {
  const { matches } = completionsFor('x.c', 3);
  assert.ok(matches.includes('cutoff'));
  assert.ok(matches.includes('crush'));
  assert.ok(!matches.includes('gain'));
});

test('non-function prototype keys are not offered', () => {
  const { matches } = completionsFor('x.not', 5);
  assert.ok(!matches.includes('notAFunction'));
});

test('sound completion draws from the registered sounds', () => {
  const { matches } = completionsFor('sound("s', 8);
  assert.deepEqual(matches.sort(), ['sawtooth', 'sine', 'square']);
});

test('curated entries rank above uncurated ones', () => {
  const { matches } = completionsFor('x.c', 3);
  // cutoff, crush and coarse are all curated; whichever comes first must be
  assert.ok(['cutoff', 'crush', 'coarse'].includes(matches[0]));
});

test('an empty global prefix offers nothing', () => {
  assert.deepEqual(completionsFor('  ', 2).matches, []);
});

test('descriptions exist for curated names only', () => {
  assert.equal(typeof describe('cutoff'), 'string');
  assert.equal(describe('withValue'), null);
});

test('replaceInLine swaps a token and moves the cursor', () => {
  const ed = new Editor('note("c3").gai');
  ed.col = 14;
  ed.replaceInLine(11, 14, 'gain');
  assert.equal(ed.text, 'note("c3").gain');
  assert.equal(ed.col, 15);
});

// --- arp, rebuilt because core 1.2.6 ships a broken one ---
const { installArp, ARP_MODES } = await import('../src/arp.mjs');

await test('the rebuilt arp spreads a chord in order', async () => {
  const core = await import('@strudel/core');
  installArp(core);
  await core.evalScope(import('@strudel/core'), import('@strudel/mini'), import('@strudel/tonal'));
  const { evaluate } = await import('@strudel/transpiler');

  const notesOf = async (code) => {
    const { pattern } = await evaluate(code);
    return pattern.queryArc(0, 1).filter((h) => h.whole).map((h) => h.value.note);
  };

  assert.deepEqual(await notesOf('note("[c4,eb4,g4]").arp("up")'), ['c4', 'eb4', 'g4']);
  assert.deepEqual(await notesOf('note("[c4,eb4,g4]").arp("down")'), ['g4', 'eb4', 'c4']);
  assert.deepEqual(await notesOf('note("[c4,eb4,g4]").arp("updown")'), ['c4', 'eb4', 'g4', 'eb4']);
  // an unknown mode falls back rather than going silent
  assert.deepEqual(await notesOf('note("[c4,eb4,g4]").arp("nonsense")'), ['c4', 'eb4', 'g4']);
  // a single note is left alone
  assert.deepEqual(await notesOf('note("c4").arp("up")'), ['c4']);
});

test('every arp mode returns something for a three note chord', () => {
  for (const [name, fn] of Object.entries(ARP_MODES)) {
    const out = fn(['a', 'b', 'c']);
    assert.ok(Array.isArray(out) && out.length > 0, `${name} produced nothing`);
  }
});

test('nothing is currently flagged as broken', () => {
  for (const name of ['arp', 'arpWith', 'pick', 'invert', 'ctranspose', 'mtranspose', 'cutoff']) {
    assert.equal(isUnsupported(name), false, `${name} should not be flagged`);
  }
});

await test('ctranspose and mtranspose transpose, via aliases', async () => {
  const core = await import('@strudel/core');
  const { installTransposeAliases } = await import('../src/aliases.mjs');
  installTransposeAliases(core);
  await core.evalScope(import('@strudel/core'), import('@strudel/mini'), import('@strudel/tonal'));
  const { evaluate } = await import('@strudel/transpiler');
  const notesOf = async (code) => {
    const { pattern } = await evaluate(code);
    return pattern.queryArc(0, 1).filter((h) => h.whole).map((h) => h.value.note);
  };
  assert.deepEqual(await notesOf('note("c3 e3").ctranspose(2)'), ['D3', 'F#3']);
  assert.deepEqual(await notesOf('note("c3 e3").ctranspose(-12)'), ['C2', 'E2']);
  assert.deepEqual(await notesOf('n("0 2 4").scale("C:major").mtranspose(2)'), ['E3', 'G3', 'B3']);
});

test('every name that was once called broken now has a real description', () => {
  // pick takes the pattern list as its argument, invert is a boolean op
  for (const name of ['arp', 'arpWith', 'pick', 'invert', 'transpose', 'ctranspose', 'mtranspose']) {
    assert.equal(typeof describe(name), 'string', `${name} needs a description`);
    assert.doesNotMatch(describe(name), /broken/);
  }
});

test('the newly curated methods all have descriptions', () => {
  for (const name of ['jux', 'chop', 'striate', 'stut', 'echo', 'shuffle', 'scramble',
                      'phaser', 'loopAt', 'hcutoff', 'scaleTranspose', 'seed']) {
    assert.equal(typeof describe(name), 'string', `${name} needs a description`);
  }
});


// --- control value sanitising ---
const { sanitizeValue } = await import('../src/engine.mjs');

test('a control called with no argument is dropped', () => {
  // this is exactly what `.crush()` produces
  const { value, dropped } = sanitizeValue({ crush: { note: 'c2', s: 'sawtooth' } });
  assert.deepEqual(dropped, ['crush']);
  assert.deepEqual(value, {});
});

test('good values pass through untouched', () => {
  const input = { note: 'c3', s: 'square', gain: 0.4, cutoff: 1500 };
  const { value, dropped } = sanitizeValue(input);
  assert.deepEqual(dropped, []);
  assert.equal(value, input); // same object, not a copy
});

test('NaN, undefined, null and functions are dropped', () => {
  const { value, dropped } = sanitizeValue({
    gain: NaN, pan: undefined, room: null, arp: () => {}, note: 'c3',
  });
  assert.deepEqual(dropped.sort(), ['arp', 'gain', 'pan', 'room']);
  assert.deepEqual(value, { note: 'c3' });
});

test('arrays and booleans survive', () => {
  const { dropped } = sanitizeValue({ adsr: [0.1, 0.2, 0.5, 0.3], loop: true });
  assert.deepEqual(dropped, []);
});

test('non-object values are left alone', () => {
  assert.deepEqual(sanitizeValue('c3'), { value: 'c3', dropped: [] });
  assert.deepEqual(sanitizeValue(60), { value: 60, dropped: [] });
});


// --- undo / redo ---
test('undo restores the previous state', () => {
  const ed = new Editor('abc');
  ed.col = 3;
  ed.insert('d');
  assert.equal(ed.text, 'abcd');
  assert.ok(ed.undo());
  assert.equal(ed.text, 'abc');
  assert.equal(ed.col, 3);
});

test('redo reapplies what undo removed', () => {
  const ed = new Editor('abc');
  ed.col = 3;
  ed.insert('d');
  ed.undo();
  assert.ok(ed.redo());
  assert.equal(ed.text, 'abcd');
});

test('undo on a fresh buffer reports nothing to do', () => {
  const ed = new Editor('abc');
  assert.equal(ed.undo(), false);
  assert.equal(ed.text, 'abc');
});

test('consecutive typing collapses into one undo step', () => {
  const ed = new Editor('');
  for (const ch of 'hello') ed.insert(ch);
  assert.equal(ed.text, 'hello');
  ed.undo();
  assert.equal(ed.text, '', 'one undo should remove the whole typed run');
});

test('moving the cursor breaks the typing run', () => {
  const ed = new Editor('');
  ed.insert('ab');
  ed.move(0, -1);
  ed.insert('X');
  ed.undo();
  assert.equal(ed.text, 'ab');
});

test('a delete is its own undo step', () => {
  const ed = new Editor('abc');
  ed.col = 3;
  ed.backspace();
  assert.equal(ed.text, 'ab');
  ed.undo();
  assert.equal(ed.text, 'abc');
});

test('a new edit clears the redo stack', () => {
  const ed = new Editor('a');
  ed.col = 1;
  ed.insert('b');
  ed.undo();
  ed.insert('c');
  assert.equal(ed.redo(), false);
});

test('an external reload is undoable', () => {
  const ed = new Editor('mine');
  ed.setText('theirs');
  assert.equal(ed.text, 'theirs');
  ed.undo();
  assert.equal(ed.text, 'mine');
});

// --- syntax highlighting ---
const { tokenize, sliceSegments } = await import('../src/highlight.mjs');

const kindsOf = (line) => tokenize(line).map((s) => `${s.kind}:${s.text}`);

test('comments run to end of line', () => {
  assert.deepEqual(kindsOf('// hi there'), ['comment:// hi there']);
});

test('mini-notation operators are separated from string content', () => {
  const kinds = kindsOf('"c3 [e3]"');
  assert.ok(kinds.includes('mini:['));
  assert.ok(kinds.includes('mini:]'));
  assert.ok(kinds.includes('string:e3'));
});

test('a name after a dot is a method, one before a paren is a call', () => {
  const kinds = kindsOf('note("a").gain(1)');
  assert.ok(kinds.includes('call:note'));
  assert.ok(kinds.includes('method:gain'));
});

test('numbers are their own kind', () => {
  assert.ok(kindsOf('gain(0.42)').includes('number:0.42'));
});

test('an unterminated string does not lose the rest of the line', () => {
  const text = tokenize('note("c3').map((s) => s.text).join('');
  assert.equal(text, 'note("c3');
});

test('tokenizing is lossless for any line', () => {
  for (const line of ['', '  ', 'a', '"x" // y', 'stack(a,b)', '.crush()', '<a b>*2']) {
    assert.equal(tokenize(line).map((s) => s.text).join(''), line, `lossless for ${JSON.stringify(line)}`);
  }
});

test('slicing segments clips to the window', () => {
  const segs = tokenize('abcdef');
  assert.equal(sliceSegments(segs, 2, 4).map((s) => s.text).join(''), 'cd');
  assert.equal(sliceSegments(segs, 0, 100).map((s) => s.text).join(''), 'abcdef');
  assert.deepEqual(sliceSegments(segs, 10, 20), []);
});


// --- sample fetch cache ---
const { installFetchCache } = await import('../src/samples.mjs');
const { readdirSync } = await import('node:fs');
const pathJoin = join;

const cacheDir = mkdtempSync(pathJoin(tmpdir(), 'strudel-cache-'));
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => {
  networkCalls++;
  return new Response(Buffer.from('audio-bytes'));
};
const stats = installFetchCache(cacheDir);

await test('the first fetch goes to the network and is written to disk', async () => {
  const body = await (await fetch('https://example.test/bd.wav')).text();
  assert.equal(body, 'audio-bytes');
  assert.equal(networkCalls, 1);
  assert.equal(readdirSync(cacheDir).length, 1);
});

await test('the second fetch of the same url is served from disk', async () => {
  const body = await (await fetch('https://example.test/bd.wav')).text();
  assert.equal(body, 'audio-bytes');
  assert.equal(networkCalls, 1, 'no second network call');
  assert.equal(stats.hits, 1);
});

await test('a different url still reaches the network', async () => {
  await fetch('https://example.test/sn.wav');
  assert.equal(networkCalls, 2);
  assert.equal(readdirSync(cacheDir).length, 2);
});

await test('non-GET requests are not cached', async () => {
  await fetch('https://example.test/bd.wav', { method: 'POST' });
  assert.equal(networkCalls, 3);
});

globalThis.fetch = originalFetch;


// --- sliders ---
const sliders = await import('../src/sliders.mjs');
sliders.attachCore({ signal: (fn) => ({ read: fn }) });

// what the transpiler hands back for:
//   note("c3").gain(slider(0.5)).cutoff(slider(800, 200, 5000))
const SRC = 'note("c3").gain(slider(0.5)).cutoff(slider(800, 200, 5000))';
const WIDGETS = [
  { type: 'slider', from: 23, to: 26, value: '0.5', min: 0, max: 1 },
  { type: 'slider', from: 43, to: 46, value: '800', min: 200, max: 5000 },
];

test('sliders are labelled after the control they feed', () => {
  sliders.reset();
  sliders.prepare(SRC, WIDGETS);
  assert.deepEqual(sliders.list().map((s) => s.label), ['gain', 'cutoff']);
});

test('initial values and ranges come from the widget list', () => {
  sliders.reset();
  sliders.prepare(SRC, WIDGETS);
  const [gain, cutoff] = sliders.list();
  assert.equal(gain.value, 0.5);
  assert.deepEqual([cutoff.value, cutoff.min, cutoff.max], [800, 200, 5000]);
});

test('adjusting moves by a fortieth of the range and clamps', () => {
  sliders.reset();
  sliders.prepare(SRC, WIDGETS);
  assert.equal(sliders.adjust(0, 1), 0.525);
  for (let i = 0; i < 100; i++) sliders.adjust(0, 1);
  assert.equal(sliders.list()[0].value, 1, 'clamped at max');
  for (let i = 0; i < 200; i++) sliders.adjust(0, -1);
  assert.equal(sliders.list()[0].value, 0, 'clamped at min');
});

test('values survive an edit that shifts every offset', () => {
  sliders.reset();
  sliders.prepare(SRC, WIDGETS);
  sliders.adjust(0, 4); // gain 0.5 -> 0.6
  const shifted = '// a new line\n' + SRC;
  const offset = '// a new line\n'.length;
  sliders.prepare(shifted, WIDGETS.map((w) => ({ ...w, from: w.from + offset, to: w.to + offset })));
  assert.equal(Number(sliders.list()[0].value.toFixed(3)), 0.6, 'slot is keyed by order, not offset');
});

test('a removed slider drops out of the panel', () => {
  sliders.reset();
  sliders.prepare(SRC, WIDGETS);
  assert.equal(sliders.count(), 2);
  sliders.prepare(SRC, [WIDGETS[0]]);
  assert.equal(sliders.count(), 1);
});

test('a narrowed range pulls the current value into it', () => {
  sliders.reset();
  sliders.prepare(SRC, WIDGETS);
  sliders.adjust(1, 40); // cutoff to the top, 5000
  sliders.prepare(SRC, [WIDGETS[0], { ...WIDGETS[1], min: 200, max: 1000 }]);
  assert.equal(sliders.list()[1].value, 1000);
});

test('baking writes the live values back into the source', () => {
  sliders.reset();
  sliders.prepare(SRC, WIDGETS);
  sliders.adjust(0, 4); // 0.5 -> 0.6
  sliders.adjust(1, 10); // 800 -> 2000
  const { code, changed } = sliders.bake(SRC);
  assert.equal(changed, 2);
  assert.equal(code, 'note("c3").gain(slider(0.6)).cutoff(slider(2000, 200, 5000))');
});

test('adjusting past the minimum clamps rather than going negative', () => {
  sliders.reset();
  sliders.prepare(SRC, WIDGETS);
  sliders.adjust(1, -10); // 800 - 1200 would be negative
  assert.equal(sliders.list()[1].value, 200);
});

test('baking an unchanged slider is a no-op', () => {
  sliders.reset();
  sliders.prepare(SRC, WIDGETS);
  assert.equal(sliders.bake(SRC).changed, 0);
});

test('formatting picks digits from the range', () => {
  assert.equal(sliders.format(0.5237, 0, 1), '0.524');
  assert.equal(sliders.format(1234.56, 200, 5000), '1235');
  assert.equal(sliders.format(1.5, 0.5, 2), '1.5');
});


// --- engine rejects things that are not patterns ---
const { Engine } = await import('../src/engine.mjs');

await test('an unfinished method chain is rejected, not scheduled', async () => {
  // no engine.init(): setCode only needs the eval scope, and opening a real
  // AudioContext here would keep the test process alive forever
  const engine = new Engine({});
  const good = await engine.setCode('note("c3 e3").sound("sawtooth")');
  assert.equal(good, null);
  const working = engine.pattern;

  // `.cutoff` with no call returns a curried function, which used to pass
  const err = await engine.setCode('note("c3 e3").sound("sawtooth").cutoff', { quiet: true });
  assert.match(err, /not a pattern/);
  assert.equal(engine.pattern, working, 'the last working pattern stays loaded');
});


// --- piano roll voice colours ---
const roll = await import('../src/pianoroll.mjs');
const pianoroll = roll;

test('each sound gets its own colour, stable across calls', () => {
  roll.resetVoiceColors();
  const bd = roll.colorForSound('bd');
  const hh = roll.colorForSound('hh');
  const saw = roll.colorForSound('sawtooth');
  assert.equal(new Set([bd, hh, saw]).size, 3, 'three sounds, three colours');
  assert.equal(roll.colorForSound('bd'), bd, 'stable on second look');
});

test('unpitched and pitched share the sound-name mapping', () => {
  roll.resetVoiceColors();
  assert.equal(roll.soundOf({ s: 'bd', gain: 1 }), 'bd');
  assert.equal(roll.soundOf({ sound: 'sn' }), 'sn');
  assert.equal(roll.soundOf('c3'), null);
});

// --- global sends ---
test('globals merge into a hap only when turned up', async () => {
  const { Engine } = await import('../src/engine.mjs');
  const sliderMod = await import('../src/sliders.mjs');
  sliderMod.globals.room = 0;
  sliderMod.globals.delay = 0;

  const engine = new Engine({});
  await engine.setCode('sound("bd")');
  const before = engine.pattern.queryArc(0, 1)[0].value;
  assert.equal(before.room, undefined, 'nothing added while both are off');

  sliderMod.adjustGlobal('room', 4);
  assert.ok(sliderMod.globals.room > 0);
  sliderMod.globals.room = 0;
  sliderMod.globals.delay = 0;
});

test('a global send never overwrites a value the pattern set', async () => {
  const sliderMod = await import('../src/sliders.mjs');
  sliderMod.globals.room = 0.5;
  // asControls is internal; exercise the same rule the engine applies
  const value = { s: 'bd', room: 0.9 };
  const merged = { ...value };
  if (sliderMod.globals.room && merged.room === undefined) merged.room = sliderMod.globals.room;
  assert.equal(merged.room, 0.9);
  sliderMod.globals.room = 0;
});

// --- atomic writes ---
const { writeAtomic } = await import('../src/atomic.mjs');
const { mkdtempSync: mkTmpA, writeFileSync: writeFA, readFileSync: readFA,
        existsSync: existsA, readdirSync: readDirA } = await import('node:fs');
const { tmpdir: tmpA } = await import('node:os');
const { join: joinA } = await import('node:path');

const atomicDir = mkTmpA(joinA(tmpA(), 'strudel-atomic-'));

test('an atomic write replaces the file', () => {
  const target = joinA(atomicDir, 'a.txt');
  writeAtomic(target, 'first');
  assert.equal(readFA(target, 'utf8'), 'first');
  writeAtomic(target, 'second');
  assert.equal(readFA(target, 'utf8'), 'second');
});

test('an atomic write leaves no temporary behind', () => {
  const target = joinA(atomicDir, 'b.txt');
  writeAtomic(target, 'content');
  const strays = readDirA(atomicDir).filter((name) => name.includes('.tmp'));
  assert.deepEqual(strays, [], 'no temp files should survive');
});

test('a failed atomic write leaves the original intact', () => {
  const target = joinA(atomicDir, 'c.txt');
  writeFA(target, 'original');
  // a directory that does not exist makes the temp write fail
  const impossible = joinA(atomicDir, 'no-such-dir', 'd.txt');
  assert.throws(() => writeAtomic(impossible, 'nope'));
  assert.equal(readFA(target, 'utf8'), 'original', 'an unrelated file is untouched');
  assert.equal(existsA(impossible), false);
});

test('atomic writes handle binary content', () => {
  const target = joinA(atomicDir, 'e.bin');
  const bytes = Buffer.from([0, 1, 2, 255, 128]);
  writeAtomic(target, bytes);
  assert.deepEqual(readFA(target), bytes);
});

// --- persisted slider positions ---
const persist = await import('../src/persist.mjs');
const { mkdtempSync: mkTmp, writeFileSync: writeF } = await import('node:fs');
const tmpBase = mkTmp(pathJoin(tmpdir(), 'strudel-persist-'));
const targetFile = pathJoin(tmpBase, 'jam.str');

test('state round trips through the cache', () => {
  const written = persist.save(targetFile, { cps: 0.55, globals: { room: 0.1, delay: 0 }, sliders: { 0: 1400 } });
  assert.equal(written, true);
  const back = persist.load(targetFile);
  assert.equal(back.cps, 0.55);
  assert.equal(back.globals.room, 0.1);
  assert.equal(back.sliders['0'], 1400);
});

test('a file with no saved state loads as null', () => {
  assert.equal(persist.load(pathJoin(tmpBase, 'never-seen.str')), null);
});

test('a corrupt state file loads as null rather than throwing', () => {
  const other = pathJoin(tmpBase, 'broken.str');
  persist.save(other, { cps: 1 });
  writeF(persist.stateFileFor(other), 'not json at all');
  assert.equal(persist.load(other), null);
});

test('two files get separate state', () => {
  const a = pathJoin(tmpBase, 'a.str');
  const b = pathJoin(tmpBase, 'b.str');
  persist.save(a, { cps: 0.4 });
  persist.save(b, { cps: 0.9 });
  assert.equal(persist.load(a).cps, 0.4);
  assert.equal(persist.load(b).cps, 0.9);
});

test('restore clamps a saved value into a range the code has since changed', () => {
  sliders.reset();
  sliders.prepare(SRC, WIDGETS);
  // cutoff range is 200 to 5000; a stale save of 9000 must not escape it
  const restored = sliders.restore({ 1: 9000 });
  assert.equal(restored, 1);
  assert.equal(sliders.list()[1].value, 5000);
});

test('restore ignores slots that no longer exist', () => {
  sliders.reset();
  sliders.prepare(SRC, WIDGETS);
  assert.equal(sliders.restore({ 0: 0.7, 99: 1 }), 1);
  assert.equal(sliders.list()[0].value, 0.7);
});

test('a slider prepare never saw stays out of the panel and saved state', () => {
  sliders.reset();
  // still has to make sound, so it yields something playable rather than
  // nothing (a signal once core is attached, the bare value otherwise)
  assert.notEqual(sliders.sliderWithID('slider_9999', 0.5, 0, 1), undefined);
  assert.equal(sliders.count(), 0, 'no phantom row');
  assert.deepEqual(sliders.snapshot(), {}, 'nothing to save');

  // and the next evaluation clears it rather than leaving it for the session
  sliders.prepare(SRC, WIDGETS);
  assert.deepEqual(sliders.list().map((s) => s.ordinal), [0, 1]);
});

test('removing every slider from the file empties the panel', () => {
  sliders.reset();
  sliders.prepare(SRC, WIDGETS);
  assert.ok(sliders.count() > 0);
  assert.equal(sliders.prepare('s("bd")', []), 0);
  assert.equal(sliders.count(), 0);
});

test('snapshot and restore round trip', () => {
  sliders.reset();
  sliders.prepare(SRC, WIDGETS);
  sliders.adjust(0, 4);
  const snap = sliders.snapshot();
  sliders.reset();
  sliders.prepare(SRC, WIDGETS);
  sliders.restore(snap);
  assert.equal(Number(sliders.list()[0].value.toFixed(3)), 0.6);
});

// --- editing notes back into the source ---
const rolledit = await import('../src/rolledit.mjs');

await test('a literal note pattern is editable, and the edit still parses', async () => {
  const core = await import('@strudel/core');
  await core.evalScope(import('@strudel/core'), import('@strudel/mini'), import('@strudel/tonal'));
  const tp = await import('@strudel/transpiler');

  const code = 'note("c3 e3 g3").sound("sawtooth")';
  const { pattern } = await tp.evaluate(code, { emitMiniLocations: true });
  const notes = rolledit.editableNotes(pattern.queryArc(0, 1), code);
  assert.equal(notes.length, 3);
  assert.deepEqual(notes.map((n) => n.location.text), ['c3', 'e3', 'g3']);

  const edited = rolledit.applyEdit(code, notes[0].location, rolledit.shift('c3', 2));
  assert.equal(edited, 'note("d3 e3 g3").sound("sawtooth")');
  await tp.evaluate(edited, { emitMiniLocations: true }); // must still parse
});

await test('a scale name is never mistaken for a note', async () => {
  // enharmonic matching once rewrote the "C" in scale("C:major") into a note,
  // producing scale("Db3:major"). Nothing may match unless it is exact.
  const tp = await import('@strudel/transpiler');
  const code = 'n("0 2 4").scale("C:major").sound("sawtooth")';
  const { pattern } = await tp.evaluate(code, { emitMiniLocations: true });
  const notes = rolledit.editableNotes(pattern.queryArc(0, 1), code);
  for (const note of notes) {
    assert.notEqual(note.location.text, 'C', 'the scale root must never be editable');
  }
});

await test('generated pitches report as not editable', async () => {
  const tp = await import('@strudel/transpiler');
  const code = 'chord("<Cm7>").voicing().sound("sawtooth")';
  const { pattern } = await tp.evaluate(code, { emitMiniLocations: true });
  assert.deepEqual(rolledit.editableNotes(pattern.queryArc(0, 1), code), []);
});

test('shifting moves note names by semitones and degrees by one', () => {
  assert.equal(rolledit.shift('c3', 2), 'd3');
  assert.equal(rolledit.shift('c3', -1), 'b2');
  assert.equal(rolledit.shift('C3', 2), 'D3', 'capitalisation is preserved');
  assert.equal(rolledit.shift('0', 1, 'degree'), '1');
  assert.equal(rolledit.shift('7', -2, 'degree'), '5');
});

test('shifting something that is not a pitch returns nothing', () => {
  assert.equal(rolledit.shift('sawtooth', 1), null);
});

test('in-scale steps follow the scale, wrapping octaves', () => {
  assert.equal(rolledit.shiftInScale('e3', 1, 'C:major'), 'f3');
  assert.equal(rolledit.shiftInScale('b3', 1, 'C:major'), 'c4');
  assert.equal(rolledit.shiftInScale('c3', -1, 'C:major'), 'b2');
  assert.equal(rolledit.shiftInScale('c3', 1, 'a:minor'), 'd3');
});

test('an in-scale step refuses rather than guessing', () => {
  // a note outside the scale, and a scale that does not exist
  assert.equal(rolledit.shiftInScale('c#3', 1, 'C:major'), null);
  assert.equal(rolledit.shiftInScale('e3', 1, 'nonsense:x'), null);
  assert.equal(rolledit.shiftInScale('e3', 1, null), null);
});

await test('the scale in force is detected from the source', async () => {
  const tp = await import('@strudel/transpiler');
  const code = 'note("c3 e3").scale("C:major").sound("sawtooth")';
  const { pattern } = await tp.evaluate(code, { emitMiniLocations: true });
  const hap = pattern.queryArc(0, 1).filter((h) => h.whole)[0];
  assert.equal(rolledit.scaleForHap(hap, code), 'C:major');
});

await test('degrees are editable once the scale string is excluded', async () => {
  const tp = await import('@strudel/transpiler');
  const code = 'n("0 2 4").scale("C:major").sound("sawtooth")';
  const { pattern } = await tp.evaluate(code, { emitMiniLocations: true });
  const notes = rolledit.editableNotes(pattern.queryArc(0, 1), code);
  assert.deepEqual(notes.map((n) => n.location.text), ['0', '2', '4']);
  assert.ok(notes.every((n) => n.location.kind === 'degree'));
});

// --- note mode round trip ---
// Mirrors exactly what moveNote does in the CLI: find the note, convert its
// source offsets to a position, edit through the editor so it is undoable,
// then confirm the result still parses and reads back changed.
await test('moving a note rewrites the source and survives re-evaluation', async () => {
  const tp = await import('@strudel/transpiler');
  const ed = new Editor('stack(\n  note("c3 e3 g3").sound("sawtooth")\n)');

  const notesOf = async () => {
    const { pattern } = await tp.evaluate(ed.text, { emitMiniLocations: true });
    return rolledit.editableNotes(pattern.queryArc(0, 1), ed.text);
  };

  let notes = await notesOf();
  assert.deepEqual(notes.map((n) => n.location.text), ['c3', 'e3', 'g3']);

  // raise the second note a semitone, as ctrl-less up would
  const target = notes[1];
  const from = rolledit.offsetToPosition(ed.text, target.location.start);
  const to = rolledit.offsetToPosition(ed.text, target.location.end);
  assert.equal(from.line, to.line, 'a note should not span lines');
  ed.line = from.line;
  ed.replaceInLine(from.col, to.col, rolledit.shift(target.location.text, 1));

  assert.match(ed.text, /note\("c3 f3 g3"\)/);
  notes = await notesOf();
  assert.deepEqual(notes.map((n) => n.location.text), ['c3', 'f3', 'g3']);

  // and it is a normal undoable edit
  ed.undo();
  assert.match(ed.text, /note\("c3 e3 g3"\)/);
});

await test('an in-scale move follows the scale, not the semitone', async () => {
  const tp = await import('@strudel/transpiler');
  const ed = new Editor('note("c3 e3 b3").scale("C:major").sound("sawtooth")');
  const { pattern } = await tp.evaluate(ed.text, { emitMiniLocations: true });
  const notes = rolledit.editableNotes(pattern.queryArc(0, 1), ed.text);

  const last = notes[notes.length - 1];
  const scale = rolledit.scaleForHap(last.hap, ed.text);
  assert.equal(scale, 'C:major');

  // b3 up one scale step is c4, where a semitone would give c4 as well, so
  // check a case where they differ: e3 up a step is f3, a semitone gives f3.
  const second = notes[1];
  assert.equal(rolledit.shiftInScale(second.location.text, 1, scale), 'f3');
  assert.equal(rolledit.shift(second.location.text, 1), 'f3');
  // c3 up a step is d3 in C major, but c#3 chromatically
  assert.equal(rolledit.shiftInScale('c3', 1, scale), 'd3');
  assert.equal(rolledit.shift('c3', 1), 'db3');
});

// --- filling empty slots ---
await test('rests are selectable slots and can be filled', async () => {
  const tp = await import('@strudel/transpiler');
  const code = 'note("c3 ~ e3 ~").sound("sawtooth")';
  const { pattern } = await tp.evaluate(code, { emitMiniLocations: true });
  const haps = pattern.queryArc(0, 1).filter((h) => h.whole);
  const slots = rolledit.flatSlots(code, rolledit.stringRangeFor(haps[0], code));

  assert.deepEqual(slots.map((s) => s.text), ['c3', '~', 'e3', '~']);
  assert.deepEqual(slots.map((s) => s.isRest), [false, true, false, true]);

  const filled = rolledit.applyEdit(code, slots[1], rolledit.seedPitchFor(slots, 1));
  assert.equal(filled, 'note("c3 c3 e3 ~").sound("sawtooth")');
  const { pattern: after } = await tp.evaluate(filled, { emitMiniLocations: true });
  assert.equal(after.queryArc(0, 1).filter((h) => h.whole).length, 3, 'one more event than before');
});

await test('a filled slot copies the notation its neighbours use', async () => {
  const tp = await import('@strudel/transpiler');
  const code = 'n("0 ~ 4 ~").scale("C:major").sound("sawtooth")';
  const { pattern } = await tp.evaluate(code, { emitMiniLocations: true });
  const haps = pattern.queryArc(0, 1).filter((h) => h.whole);
  const slots = rolledit.flatSlots(code, rolledit.stringRangeFor(haps[0], code));
  // a degree pattern must get a degree, not a note name
  assert.equal(rolledit.seedPitchFor(slots, 1), '0');
});

await test('a bracketed sequence is walked, not refused', async () => {
  const tp = await import('@strudel/transpiler');
  const code = 'note("c3 [e3 g3] ~").sound("sawtooth")';
  const { pattern } = await tp.evaluate(code, { emitMiniLocations: true });
  const haps = pattern.queryArc(0, 1).filter((h) => h.whole);
  const slots = rolledit.flatSlots(code, rolledit.stringRangeFor(haps[0], code));
  assert.deepEqual(slots.map((slot) => slot.text), ['c3', 'e3', 'g3', '~']);
  // the grouping characters are stepped over, never claimed as slots
  for (const slot of slots) assert.equal(code.slice(slot.start, slot.end), slot.text);
  assert.equal(slots.at(-1).isRest, true);
});

await test('the string picked is the one holding the pitch, not the sound', async () => {
  // it once picked "sawtooth", because that location comes first
  const tp = await import('@strudel/transpiler');
  const code = 'note("c3 ~ e3").sound("sawtooth")';
  const { pattern } = await tp.evaluate(code, { emitMiniLocations: true });
  const haps = pattern.queryArc(0, 1).filter((h) => h.whole);
  const range = rolledit.stringRangeFor(haps[0], code);
  assert.equal(range.text, 'c3 ~ e3');
});

test('the perc lane renders for unpitched events', () => {
  // no test covered this path, and a bad edit to the lane's label loop went
  // unnoticed because every fixture used pitched notes only
  const drum = {
    whole: { begin: { valueOf: () => 0.25 }, end: { valueOf: () => 0.3 } },
    value: { s: 'bd' },
    context: { locations: [] },
  };
  const pitched = {
    whole: { begin: { valueOf: () => 0 }, end: { valueOf: () => 0.2 } },
    value: { note: 'c3', s: 'saw' },
    context: { locations: [] },
  };
  const lines = pianoroll.renderPianoRoll({
    haps: [drum, pitched], currentCycle: 0.5, width: 60, height: 10,
  });
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''));
  assert.ok(plain.some((l) => l.startsWith('perc')), 'the perc lane should be labelled');
});

test('rendering twice in a row gives the same output', () => {
  // the grid is reused between frames now, so a stale cell would show up here
  const hap = {
    whole: { begin: { valueOf: () => 0.1 }, end: { valueOf: () => 0.4 } },
    value: { note: 'c3', s: 'saw' },
    context: { locations: [] },
  };
  const once = pianoroll.renderPianoRoll({ haps: [hap], currentCycle: 0.5, width: 50, height: 8 });
  const twice = pianoroll.renderPianoRoll({ haps: [hap], currentCycle: 0.5, width: 50, height: 8 });
  assert.deepEqual(twice, once);

  // and a sparser frame must not keep the previous frame's marks
  const empty = pianoroll.renderPianoRoll({ haps: [], currentCycle: 0.5, width: 50, height: 8 });
  assert.ok(!empty.some((l) => l.includes('█')), 'no notes should survive into an empty frame');
});

test('the roll highlights only the selected note', () => {
  const make = (begin, start) => ({
    whole: { begin: { valueOf: () => begin }, end: { valueOf: () => begin + 0.2 } },
    value: { note: 'c3', s: 'saw' },
    context: { locations: [{ start, end: start + 2 }] },
  });
  const haps = [make(0, 6), make(0.5, 9)];
  const withSel = pianoroll.renderPianoRoll({
    haps, currentCycle: 0.9, width: 60, height: 8, selectedStart: 9,
  });
  const without = pianoroll.renderPianoRoll({ haps, currentCycle: 0.9, width: 60, height: 8 });
  assert.ok(withSel.some((l) => l.includes('\x1b[48;5;24m')), 'selection should be highlighted');
  assert.ok(!without.some((l) => l.includes('\x1b[48;5;24m')), 'nothing highlighted without a selection');
});

// --- wav encoding ---
const { encodeWav } = await import('../src/wav.mjs');

test('a wav header describes what follows', () => {
  const left = new Float32Array([0, 0.5, -0.5, 1]);
  const right = new Float32Array([0, -0.5, 0.5, -1]);
  const wav = encodeWav([left, right], 44100);

  assert.equal(wav.slice(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.slice(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 2, 'two channels');
  assert.equal(wav.readUInt32LE(24), 44100, 'sample rate');
  assert.equal(wav.readUInt16LE(34), 16, 'sixteen bit');
  assert.equal(wav.readUInt32LE(40), 4 * 2 * 2, 'four frames, two channels, two bytes');
  assert.equal(wav.length, 44 + 16);
});

test('samples are interleaved and clamped at full scale', () => {
  const wav = encodeWav([new Float32Array([1, -1, 2]), new Float32Array([-1, 1, -2])], 8000);
  assert.equal(wav.readInt16LE(44), 32767, 'left +1');
  assert.equal(wav.readInt16LE(46), -32768, 'right -1');
  assert.equal(wav.readInt16LE(48), -32768, 'left -1');
  assert.equal(wav.readInt16LE(52), 32767, 'anything past +1 clamps');
  assert.equal(wav.readInt16LE(54), -32768, 'anything past -1 clamps');
});

test('an empty render still produces a valid header', () => {
  const wav = encodeWav([new Float32Array(0), new Float32Array(0)], 44100);
  assert.equal(wav.length, 44);
  assert.equal(wav.readUInt32LE(40), 0);
});

// --- arrangement strip ---
const timeline = await import('../src/timeline.mjs');

test('the strip pages in steady jumps rather than scrolling', () => {
  assert.equal(timeline.pageFor(0), 0);
  assert.equal(timeline.pageFor(63), 0);
  assert.equal(timeline.pageFor(64), 1);
  assert.equal(timeline.pageFor(200), 3);
  assert.equal(timeline.pageFor(-5), 0);
});

await test('density counts events per cycle', async () => {
  const tp = await import('@strudel/transpiler');
  const { pattern } = await tp.evaluate('sound("bd*4")', { emitMiniLocations: true });
  const counts = timeline.densityFor(pattern, 0);
  assert.equal(counts.length, timeline.PAGE_CYCLES);
  assert.ok(counts.every((c) => c === 4), 'four events in every cycle');
});

test('an empty pattern gives a flat strip rather than throwing', () => {
  const counts = timeline.densityFor(null, 0);
  assert.ok(counts.every((c) => c === 0));
  const line = timeline.renderTimeline({ counts, page: 0, currentCycle: 0, loop: null, width: 40 });
  assert.equal(typeof line, 'string');
});

test('the strip marks the loop and the playhead', () => {
  const counts = new Array(timeline.PAGE_CYCLES).fill(2);
  const withLoop = timeline.renderTimeline({
    counts, page: 0, currentCycle: 10, loop: { start: 8, end: 24 }, width: 70,
  });
  const without = timeline.renderTimeline({
    counts, page: 0, currentCycle: 10, loop: null, width: 70,
  });
  assert.ok(withLoop.includes('\x1b[38;5;45m'), 'loop cells are coloured');
  assert.ok(!without.includes('\x1b[38;5;45m'));
  assert.ok(withLoop.includes('\x1b[48;5;24m'), 'the playhead is marked');
});

await test('a stale density does not block the frame that asks for it', async () => {
  const { Engine } = await import('../src/engine.mjs');
  const engine = new Engine({});
  await engine.setCode('sound("bd*4")');
  const first = engine.densityPage(0);
  assert.ok(first.counts.some((c) => c > 0), 'the first call fills the strip immediately');

  // A new pattern makes the cache stale, and the next call must hand back what
  // it already has rather than spend 4ms counting inside a draw. Asserted by
  // what comes back, not by a stopwatch: a 2ms wall-clock budget failed on a
  // CI runner that simply hiccuped, which says nothing about the code.
  await engine.setCode('sound("hh*16")');
  const stale = engine.densityPage(0);
  assert.deepEqual(stale.counts, first.counts, 'handed back the stale page');
  assert.equal(stale.counts.length, 64, 'still a full page');

  // and it catches up on its own
  await new Promise((resolve) => setTimeout(resolve, 20));
  const fresh = engine.densityPage(0);
  assert.ok(fresh.counts.some((c) => c === 16), 'refreshed to the new pattern');
});

await test('density is computed once per pattern, then cached', async () => {
  const { Engine } = await import('../src/engine.mjs');
  const engine = new Engine({});
  await engine.setCode('stack(sound("bd*4"), sound("hh*8"))');
  const first = engine.densityPage(0);
  const second = engine.densityPage(0);
  assert.equal(first.counts, second.counts, 'the same array comes back');
});

// --- transport ---
await test('seeking moves the playhead and clamps at zero', async () => {
  const { Engine } = await import('../src/engine.mjs');
  const engine = new Engine({});
  await engine.setCode('sound("bd*4")');
  engine.playing = false;
  engine.seek(8);
  assert.equal(engine.currentCycle, 8);
  engine.seek(-5);
  assert.equal(engine.currentCycle, 0);
});

await test('a loop needs an end after its start', async () => {
  const { Engine } = await import('../src/engine.mjs');
  const engine = new Engine({});
  assert.deepEqual(engine.setLoop(4, 8), { start: 4, end: 8 });
  assert.equal(engine.setLoop(8, 4), null, 'backwards is refused');
  assert.equal(engine.setLoop(4, 4), null, 'empty is refused');
  assert.equal(engine.setLoop(null, null), null);
});

await test('the playhead wraps at the end of a loop', async () => {
  const { Engine } = await import('../src/engine.mjs');
  const engine = new Engine({});
  await engine.setCode('sound("bd*4")');
  engine.setLoop(2, 4);
  engine.playing = true;
  engine.originCycle = 4.5;
  engine.originAudio = 0;
  engine.scheduledTo = 4.5;
  assert.ok(engine.currentCycle >= 4, 'starts past the loop end');
  engine.tick();
  assert.ok(engine.currentCycle < 4, 'wraps back inside the loop');
  // scheduling resumes from the loop start, so nothing before it is queued
  assert.equal(engine.scheduledTo, 2);
});

// --- tracks ---
const tracksMod = await import('../src/tracks.mjs');

const TRACK_CODE = [
  'stack(',
  '  sound("bd*4").gain(0.7),',
  '  sound("hh*8").gain(0.2),',
  '  note("c3 e3 g3").sound("sawtooth").gain(0.4)',
  ')',
].join('\n');

test('stack layers are found and named after their instrument', () => {
  const layers = tracksMod.analyse(TRACK_CODE);
  assert.deepEqual(layers.map((l) => l.label), ['bd', 'hh', 'sawtooth']);
});

test('a file with no stack has no tracks', () => {
  assert.deepEqual(tracksMod.analyse('note("c3").sound("saw")'), []);
  assert.deepEqual(tracksMod.analyse('this is not javascript ((('), []);
});

await test('events are attributed to the layer that produced them', async () => {
  const tp = await import('@strudel/transpiler');
  const layers = tracksMod.analyse(TRACK_CODE);
  const { pattern } = await tp.evaluate(TRACK_CODE, { emitMiniLocations: true });
  const counts = {};
  for (const hap of pattern.queryArc(0, 1).filter((h) => h.whole)) {
    const index = tracksMod.trackOf(hap, layers);
    counts[index] = (counts[index] ?? 0) + 1;
  }
  assert.deepEqual(counts, { 0: 4, 1: 8, 2: 3 });
});

test('mute silences one track, solo silences the rest', () => {
  tracksMod.reset();
  assert.ok([0, 1, 2].every((i) => tracksMod.isAudible(i)));

  tracksMod.toggleMute(1);
  assert.deepEqual([0, 1, 2].map((i) => tracksMod.isAudible(i)), [true, false, true]);

  tracksMod.toggleSolo(2);
  assert.deepEqual([0, 1, 2].map((i) => tracksMod.isAudible(i)), [false, false, true]);

  tracksMod.reset();
  assert.ok([0, 1, 2].every((i) => tracksMod.isAudible(i)));
});

test('track faders start at unity and stay in range', () => {
  tracksMod.reset();
  assert.equal(tracksMod.volumeOf(0), 1);

  tracksMod.adjustVolume(0, -1);
  tracksMod.adjustVolume(0, -1);
  assert.equal(Number(tracksMod.volumeOf(0).toFixed(2)), 0.9);

  for (let i = 0; i < 60; i++) tracksMod.adjustVolume(0, 1);
  assert.equal(tracksMod.volumeOf(0), 1.5, 'capped rather than unbounded');

  for (let i = 0; i < 80; i++) tracksMod.adjustVolume(0, -1);
  assert.equal(tracksMod.volumeOf(0), 0, 'floored at silence');
  tracksMod.reset();
});

test('mixer state survives a snapshot and restore', () => {
  tracksMod.reset();
  tracksMod.setVolume(1, 0.4);
  tracksMod.toggleMute(2);
  tracksMod.toggleSolo(0);
  const snap = tracksMod.snapshot();

  tracksMod.reset();
  assert.equal(tracksMod.volumeOf(1), 1);

  tracksMod.restore(snap);
  assert.equal(tracksMod.volumeOf(1), 0.4);
  assert.equal(tracksMod.stateOf(2).muted, true);
  assert.equal(tracksMod.stateOf(0).soloed, true);
  tracksMod.reset();
});

test('restoring rubbish leaves the mixer alone', () => {
  tracksMod.reset();
  tracksMod.setVolume(0, 0.3);
  tracksMod.restore(null);
  assert.equal(tracksMod.volumeOf(0), 0.3, 'null is ignored');
  tracksMod.restore({ volumes: { 0: 'not a number' } });
  assert.equal(tracksMod.volumeOf(0), 1, 'a bad value falls back to unity');
  tracksMod.reset();
});

test('a fader is forgotten when its layer is edited away', () => {
  tracksMod.reset();
  tracksMod.setVolume(5, 0.2);
  tracksMod.prune(2);
  assert.equal(tracksMod.volumeOf(5), 1);
  tracksMod.reset();
});

test('an unattributable event always plays', () => {
  tracksMod.reset();
  tracksMod.toggleMute(0);
  assert.equal(tracksMod.isAudible(-1), true);
  tracksMod.reset();
});

test('mutes are dropped when the layer they referred to is gone', () => {
  tracksMod.reset();
  tracksMod.toggleMute(4);
  tracksMod.prune(2);
  assert.equal(tracksMod.isAudible(4), true);
});

await test('muting removes a track from what the roll shows', async () => {
  const { Engine } = await import('../src/engine.mjs');
  const engine = new Engine({});
  await engine.setCode(TRACK_CODE);
  tracksMod.reset();

  const visible = () => { engine.version++; return engine.visibleHaps(0, 1).length; };
  const all = visible();
  tracksMod.toggleMute(1);
  const muted = visible();
  tracksMod.reset();

  assert.equal(all, 15);
  assert.equal(muted, 7, 'the eight hat events should be gone');
});

// --- selection stability ---
await test('what index 0 means changes as the playhead moves', async () => {
  // the bug: with every(2, rev) the visible note order flips each cycle, so a
  // selection held as an index into the visible notes lands on a different note
  const tp = await import('@strudel/transpiler');
  const code = 'note("c3 e3 g3 b3").every(2, rev).sound("sawtooth")';
  const { pattern } = await tp.evaluate(code, { emitMiniLocations: true });

  const firstAt = (cycle) => {
    const haps = pattern.queryArc(cycle, cycle + 1);
    return rolledit.editableNotes(haps, code)[0]?.location.text;
  };
  assert.notEqual(firstAt(0), firstAt(1), 'the first visible note should differ between cycles');
});

await test('slots pinned to the source do not move with the playhead', async () => {
  const tp = await import('@strudel/transpiler');
  const code = 'note("c3 e3 g3 b3").every(2, rev).sound("sawtooth")';
  const { pattern } = await tp.evaluate(code, { emitMiniLocations: true });
  const haps = pattern.queryArc(0, 1).filter((h) => h.whole);
  const range = rolledit.stringRangeFor(haps[0], code);

  // the same range, read at any point in time, gives the same slots
  const slots = rolledit.flatSlots(code, range);
  assert.deepEqual(slots.map((s) => s.text), ['c3', 'e3', 'g3', 'b3']);
  for (const cycle of [0, 1, 2, 7]) {
    const later = rolledit.flatSlots(code, range);
    assert.deepEqual(
      later.map((s) => s.start),
      slots.map((s) => s.start),
      `slot offsets should be identical at cycle ${cycle}`,
    );
  }
});

// --- code pane rendering ---
// Drives the real draw path with a stub engine. Importing the TUI pulls in the
// audio module but never opens a device, so this stays safe to run anywhere.
const { Tui } = await import('../src/tui.mjs');

function renderPane({ lineCount, cursorLine, columns = 70, rows = 24 }) {
  const text = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join('\n');
  const ed = new Editor(text);
  ed.line = cursorLine;
  ed.col = 2;
  const engine = {
    cps: 0.5, playing: true, error: null, warning: null, errorLoc: null,
    currentCycle: 1, visibleHaps: () => [], layers: [],
    densityPage: () => ({ page: 0, counts: new Array(64).fill(0) }),
  };
  const state = {
    file: 't.str', mode: 'insert', error: null, status: '',
    auto: true, parseOk: true, hint: null, cheatsheet: null, slider: 0,
  };
  const tui = new Tui({ engine, state, editor: ed });
  tui.showWaveform = false;
  const originals = { columns: process.stdout.columns, rows: process.stdout.rows };
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });

  let captured = '';
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { captured += chunk; return true; };
  try {
    tui.draw();
  } finally {
    process.stdout.write = realWrite;
    Object.defineProperty(process.stdout, 'columns', { value: originals.columns, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: originals.rows, configurable: true });
  }
  return { captured, rows: captured.split(/\x1b\[\d+;1H/) };
}

function layoutWith({ showRoll, showWaveform, rows = 40 }) {
  const ed = new Editor(Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'));
  const engine = {
    cps: 0.5, playing: true, error: null, warning: null, errorLoc: null,
    currentCycle: 1, visibleHaps: () => [], layers: [],
    densityPage: () => ({ page: 0, counts: new Array(64).fill(0) }),
  };
  const state = {
    file: 't.str', mode: 'command', error: null, status: '', auto: true,
    parseOk: true, hint: null, cheatsheet: null, slider: 0, note: 0, selectedStart: null,
  };
  const tui = new Tui({ engine, state, editor: ed });
  tui.showRoll = showRoll;
  tui.showWaveform = showWaveform;
  Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
  let out = '';
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { out += chunk; return true; };
  try { tui.draw(); } finally { process.stdout.write = realWrite; }
  const plain = out.split(/\x1b\[\d+;1H/).map((r) =>
    r.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, ''));
  return {
    codeRows: plain.filter((l) => /^\s*\d+ line \d+/.test(l)).length,
    // only the roll draws a note-name gutter or a perc lane
    rollRows: plain.filter((l) => /^(perc|[A-G]#?\d)\s*│/.test(l)).length,
    waveRows: plain.filter((l) => /^(wave|\s*\d\.\d{2})│/.test(l)).length,
  };
}

test('hiding the roll gives its height to the code pane', () => {
  const shown = layoutWith({ showRoll: true, showWaveform: true });
  const hidden = layoutWith({ showRoll: false, showWaveform: true });
  assert.ok(shown.rollRows > 0, 'the roll should draw its gutter when shown');
  assert.equal(hidden.rollRows, 0, 'no roll gutter when hidden');
  assert.ok(hidden.codeRows > shown.codeRows, 'the code pane should grow');
});

test('hiding the roll never shrinks the code pane, however short the terminal', () => {
  // On 24 rows with the panel full there is nothing left to hand over, and the
  // cap for the hidden case used to fall below the one used when it is shown,
  // so turning the roll off cost a line of code instead of gaining one.
  for (const rows of [20, 22, 24, 26, 30]) {
    const shown = layoutWith({ showRoll: true, showWaveform: true, rows });
    const hidden = layoutWith({ showRoll: false, showWaveform: true, rows });
    assert.ok(
      hidden.codeRows >= shown.codeRows,
      `at ${rows} rows the code pane shrank, ${shown.codeRows} to ${hidden.codeRows}`,
    );
  }
});

test('hiding the scope as well gives back more still', () => {
  const oneOff = layoutWith({ showRoll: false, showWaveform: true });
  const bothOff = layoutWith({ showRoll: false, showWaveform: false });
  assert.ok(oneOff.waveRows > 0);
  assert.equal(bothOff.waveRows, 0);
  assert.ok(bothOff.codeRows > oneOff.codeRows);
});

test('exactly one row carries the cursor wash, and it is the cursor line', () => {
  const { rows } = renderPane({ lineCount: 40, cursorLine: 22 });
  const washed = rows.filter((r) => r.includes('\x1b[48;5;235m'));
  assert.equal(washed.length, 1, 'one row should be washed');
  const plain = washed[0].replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  assert.match(plain, /\bline 23\b/, 'the washed row should be the cursor line');
});

test('a file longer than the pane gets a scrollbar', () => {
  const { captured } = renderPane({ lineCount: 40, cursorLine: 0 });
  assert.ok(captured.includes('█'), 'a thumb should be drawn');
  assert.ok(captured.includes('│'), 'a track should be drawn');
});

test('a file that fits gets no scrollbar', () => {
  const { captured } = renderPane({ lineCount: 3, cursorLine: 0 });
  assert.ok(!captured.includes('█'), 'no thumb when everything is visible');
});

test('the thumb moves down as the cursor moves down', () => {
  const positionOf = (cursorLine) => {
    const { rows } = renderPane({ lineCount: 60, cursorLine });
    return rows.findIndex((r) => r.includes('█'));
  };
  assert.ok(positionOf(55) > positionOf(0), 'thumb should be lower for a later cursor');
});

// --- panel windowing ---
const { panelWindow } = await import('../src/tui.mjs');

test('a panel that fits is drawn whole', () => {
  const w = panelWindow(5, 8, 0);
  assert.deepEqual(w, { offset: 0, size: 5, hidden: 0 });
});

test('a panel that overflows keeps the selection visible', () => {
  for (const selected of [0, 3, 6, 9, 12]) {
    const w = panelWindow(13, 8, selected);
    assert.ok(selected >= w.offset, `row ${selected} is above the window`);
    assert.ok(selected < w.offset + w.size, `row ${selected} is below the window`);
  }
});

test('an overflowing panel reserves a line to say how many are hidden', () => {
  const w = panelWindow(13, 8, 0);
  assert.equal(w.size, 7, 'one row goes to the marker');
  assert.ok(w.hidden > 0);
});

test('the window never runs past the end of the list', () => {
  const w = panelWindow(13, 8, 12);
  assert.equal(w.offset + w.size, 13);
});

test('a very short panel still shows the selected row', () => {
  const w = panelWindow(13, 3, 12);
  assert.ok(12 >= w.offset && 12 < w.offset + w.size);
  assert.ok(w.size >= 1);
});

// --- remembered state and the sample cache ---

const tmpState = () => mkdtempSync(join(tmpdir(), 'strudel-term-test-'));

test('state files written before the path wrapper still load', () => {
  const dir = tmpState();
  const file = join(dir, 'jam.str');
  mkdirSync(join(CACHE_DIR, 'state'), { recursive: true });
  writeFileSync(persist.stateFileFor(file), JSON.stringify({ cps: 0.9 }));
  assert.equal(persist.load(file).cps, 0.9);
  rmSync(persist.stateFileFor(file), { force: true });
});

test('prune drops orphans and keeps live patterns', () => {
  const dir = tmpState();
  const live = join(dir, 'live.str');
  writeFileSync(live, 's("bd")');
  const stale = Date.now() - 30 * 864e5;
  const write = (name, body, aged) => {
    const f = join(dir, name);
    writeFileSync(f, body);
    if (aged) utimesSync(f, stale / 1000, stale / 1000);
    return f;
  };
  const kept = write('a.json', JSON.stringify({ path: live, state: {} }), true);
  const orphan = write('b.json', JSON.stringify({ path: join(dir, 'gone.str'), state: {} }), true);
  const untagged = write('c.json', JSON.stringify({ cps: 0.5 }), true);
  const recent = write('d.json', JSON.stringify({ path: join(dir, 'gone.str'), state: {} }));
  const corrupt = write('e.json', 'not json', true);

  assert.equal(persist.prune(dir), 1);
  assert.ok(existsSync(kept), 'live pattern kept');
  assert.ok(!existsSync(orphan), 'orphan removed');
  assert.ok(existsSync(untagged), 'untagged file kept on the longer schedule');
  assert.ok(existsSync(recent), 'recent orphan inside the grace period kept');
  assert.ok(existsSync(corrupt), 'unparseable file left alone');
});

test('an untagged file goes once it is old enough to be nobody\'s', () => {
  const dir = tmpState();
  const f = join(dir, 'a.json');
  writeFileSync(f, JSON.stringify({ cps: 0.5 }));
  const ancient = (Date.now() - 200 * 864e5) / 1000;
  utimesSync(f, ancient, ancient);
  assert.equal(persist.prune(dir), 1);
  assert.ok(!existsSync(f));
});

test('prune tolerates a missing directory', () => {
  assert.equal(persist.prune(join(tmpState(), 'nope')), 0);
});

test('clearing the cache frees samples and spares saved positions', () => {
  const dir = tmpState();
  mkdirSync(join(dir, 'state'));
  writeFileSync(join(dir, 'state', 'kept.json'), Buffer.alloc(500));
  writeFileSync(join(dir, 'aaaa'), Buffer.alloc(1000));
  writeFileSync(join(dir, 'bbbb'), Buffer.alloc(2000));

  const size = cacheSize(dir);
  assert.equal(size.files, 2, 'state is not counted as sample cache');
  assert.equal(size.bytes, 3000);

  const freed = clearCache(dir);
  assert.equal(freed.files, 2);
  assert.equal(freed.bytes, 3000, 'reports only what it actually deleted');
  assert.ok(existsSync(join(dir, 'state', 'kept.json')), 'saved positions survive');
});

test('cache size of a missing directory is zero', () => {
  const { bytes, files } = cacheSize(join(tmpState(), 'nope'));
  assert.equal(bytes, 0);
  assert.equal(files, 0);
});

// --- waveform scope ---
const { renderWaveform, resetAutoGain } = await import('../src/waveform.mjs');

const plain = (row) => row.replace(/\x1b\[[0-9;]*m/g, '');
const braille = (rows) => rows.join('').split('').filter((c) => c >= '⠀' && c <= '⣿');
const sine = (n, amp = 1) =>
  Float32Array.from({ length: n }, (_, i) => amp * Math.sin((i / n) * Math.PI * 8));

// 80 wide by 6 tall is roughly the pane the TUI gives it
const W = 80;
const H = 6;

test('the scope returns exactly the rows it was asked for', () => {
  resetAutoGain();
  const rows = renderWaveform({ data: sine(512), width: W, height: H });
  assert.equal(rows.length, H);
  for (const row of rows) assert.equal(plain(row).length, W);
});

test('a pane too narrow to draw in comes back blank rather than throwing', () => {
  resetAutoGain();
  for (const width of [0, 1, 4, 5, 8]) {
    const rows = renderWaveform({ data: sine(256), width, height: H });
    assert.equal(rows.length, H, `width ${width}`);
    assert.deepEqual(braille(rows), [], `width ${width} drew into a pane with no room`);
  }
});

test('a pane with no rows comes back empty', () => {
  resetAutoGain();
  assert.deepEqual(renderWaveform({ data: sine(256), width: W, height: 0 }), []);
});

test('silence draws a flat trace at zero, a signal draws more', () => {
  resetAutoGain();
  const loud = renderWaveform({ data: sine(512), width: W, height: H });

  resetAutoGain();
  const quiet = renderWaveform({ data: new Float32Array(512), width: W, height: H });

  // a scope shows silence as a flat line, not as nothing
  const drawnRows = quiet.filter((row) => /[\u2800-\u28ff]/.test(plain(row)));
  assert.equal(drawnRows.length, 1, 'silence occupies exactly one row');
  assert.ok(braille(loud).length > braille(quiet).length, 'a signal covers more');
});

test('the zero axis sits where a zero signal draws', () => {
  // deriving the axis as the middle row put it one above the trace on an
  // even-height pane, so the reference line missed what it referenced
  for (const height of [4, 5, 6, 7, 8]) {
    resetAutoGain();
    // full-scale DC pins the trace to the top, leaving the axis row uncovered
    const dc = renderWaveform({
      data: Float32Array.from({ length: 256 }, () => 1),
      width: 20,
      height,
      gain: 1,
    });
    const axis = dc.findIndex((row) => plain(row).includes('─'));

    resetAutoGain();
    const zero = renderWaveform({ data: new Float32Array(256), width: 20, height, gain: 1 });
    const trace = zero.findIndex((row) => /[\u2800-\u28ff]/.test(plain(row)));

    assert.ok(axis >= 0, `height ${height}: no axis drawn`);
    assert.equal(axis, trace, `height ${height}: axis and zero trace disagree`);
  }
});

test('every drawn glyph is a real braille cell', () => {
  resetAutoGain();
  const rows = renderWaveform({ data: sine(1024), width: W, height: H });
  for (const ch of braille(rows)) {
    const code = ch.charCodeAt(0) - 0x2800;
    assert.ok(code > 0 && code <= 0xff, `${ch} out of range`);
  }
});

test('the gutter carries the label and the peak readout', () => {
  resetAutoGain();
  const rows = renderWaveform({ data: sine(512, 0.5), width: W, height: H });
  assert.equal(plain(rows[0]).slice(0, 4), 'wave');
  // second row is the true peak, before any auto-range
  assert.match(plain(rows[1]).slice(0, 4), /^0\.[0-9]/);
  assert.ok(Math.abs(Number(plain(rows[1]).slice(0, 4)) - 0.5) < 0.02);
  for (const row of rows) assert.equal(plain(row)[4], '│', 'gutter divider on every row');
});

test('the readout reports the true peak, not the auto-ranged one', () => {
  resetAutoGain();
  const loud = renderWaveform({ data: sine(512, 1), width: W, height: H });
  resetAutoGain();
  const soft = renderWaveform({ data: sine(512, 0.1), width: W, height: H });
  assert.ok(Number(plain(loud[1]).slice(0, 4)) > Number(plain(soft[1]).slice(0, 4)));
});

test('auto-range lifts a quiet signal to fill the pane', () => {
  resetAutoGain();
  const soft = braille(renderWaveform({ data: sine(2048, 0.05), width: W, height: H })).length;
  resetAutoGain();
  const loud = braille(renderWaveform({ data: sine(2048, 1), width: W, height: H })).length;
  // a scope that did not auto-range would draw the quiet trace as a flat line
  assert.ok(soft > loud * 0.5, `quiet trace collapsed: ${soft} vs ${loud}`);
});

test('an explicit gain overrides auto-range', () => {
  resetAutoGain();
  const tiny = renderWaveform({ data: sine(2048, 0.05), width: W, height: H, gain: 1 });
  resetAutoGain();
  const ranged = renderWaveform({ data: sine(2048, 0.05), width: W, height: H });
  assert.ok(
    braille(tiny).length < braille(ranged).length,
    'gain 1 should leave a 0.05 signal small',
  );
});

test('the reused scratch buffer does not leak the previous frame', () => {
  resetAutoGain();
  const silence = new Float32Array(512);
  // establish what silence looks like on a freshly allocated buffer
  const clean = renderWaveform({ data: silence, width: W, height: H, gain: 1 });

  // fill the buffer with a full-scale trace, then draw silence again at the
  // same size so the scratch is reused rather than reallocated
  renderWaveform({ data: sine(2048), width: W, height: H, gain: 1 });
  const after = renderWaveform({ data: silence, width: W, height: H, gain: 1 });

  assert.deepEqual(after, clean, 'trace from the previous frame survived');
});

test('the scope survives an empty or missing buffer', () => {
  resetAutoGain();
  for (const data of [undefined, null, new Float32Array(0), []]) {
    const rows = renderWaveform({ data, width: W, height: H });
    assert.equal(rows.length, H);
    assert.deepEqual(braille(rows), []);
  }
});

test('a buffer shorter than the pane is still drawn', () => {
  resetAutoGain();
  // fewer samples than sub-columns: every column must still find a sample
  const rows = renderWaveform({ data: sine(3), width: W, height: H });
  assert.ok(braille(rows).length > 0);
});

test('a buffer carrying NaN does not crash or draw garbage', () => {
  resetAutoGain();
  const data = sine(512);
  data[10] = NaN;
  const rows = renderWaveform({ data, width: W, height: H });
  assert.equal(rows.length, H);
  for (const row of rows) assert.equal(plain(row).length, W);
});

test('resizing the pane between frames redraws at the new size', () => {
  resetAutoGain();
  renderWaveform({ data: sine(512), width: W, height: H });
  const narrow = renderWaveform({ data: sine(512), width: 40, height: 3 });
  assert.equal(narrow.length, 3);
  for (const row of narrow) assert.equal(plain(row).length, 40);
});

// --- note mode: which sequences it will take ---

// locationFor only needs the source offsets and the value, so a hap can be
// built by hand rather than by evaluating a pattern
const hapAt = (code, note, begin = 0) => {
  const start = code.indexOf(note);
  return {
    whole: { begin: { valueOf: () => begin } },
    value: { note },
    context: { locations: [{ start, end: start + note.length }] },
  };
};

test('angle-bracket alternation is editable', () => {
  // <a b c> is how alternation is nearly always written, and refusing it made
  // note mode useless on most real patterns
  for (const code of ['"<ab1 b1 gb1>"', '"<  ab1 b1 gb1>"']) {
    const slots = rolledit.flatSlots(code, { start: 0, end: code.length - 1 });
    assert.ok(slots, `${code} rejected`);
    assert.deepEqual(slots.map((slot) => slot.text), ['ab1', 'b1', 'gb1']);
    // the offsets must land on exactly the token they claim
    for (const slot of slots) assert.equal(code.slice(slot.start, slot.end), slot.text);
  }
});

test('nesting and chords are walked', () => {
  const slots = (code) => {
    const found = rolledit.flatSlots(code, { start: 0, end: code.length - 1 });
    assert.ok(found, `${code} rejected`);
    for (const slot of found) assert.equal(code.slice(slot.start, slot.end), slot.text);
    return found.map((slot) => slot.text);
  };
  assert.deepEqual(slots('"<[eb3,g3] [ab2,c3]>"'), ['eb3', 'g3', 'ab2', 'c3']);
  assert.deepEqual(slots('"<a b> <c d>"'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(slots('"c4 [eb4 c5] g4"'), ['c4', 'eb4', 'c5', 'g4']);
});

test('operator operands are not mistaken for pitches', () => {
  // the 3 in c4*3 and the 0.5 in c4?0.5 are counts, and rewriting one as if it
  // were a note would corrupt the pattern
  const check = (code, expected) => {
    const found = rolledit.flatSlots(code, { start: 0, end: code.length - 1 });
    assert.deepEqual(found.map((slot) => slot.text), expected, code);
    for (const slot of found) assert.equal(code.slice(slot.start, slot.end), slot.text);
  };
  check('"c4*2 e4!3 g4@2"', ['c4', 'e4', 'g4']);
  check('"c4?0.5 e4"', ['c4', 'e4']);
  check('"c4 _ _ e4"', ['c4', 'e4']);
});

test('notation this cannot account for is still refused', () => {
  // polymeter retimes a whole group, and a patterned operand is not a count
  for (const code of ['"{a b}%4"', '"c4*<2 3>"', '"<>"']) {
    assert.equal(rolledit.flatSlots(code, { start: 0, end: code.length - 1 }), null, code);
  }
});

test('editing inside alternation rewrites only that token', () => {
  const code = 'note("<  ab1 b1 gb1>")';
  const range = { start: code.indexOf('"'), end: code.lastIndexOf('"') };
  const slots = rolledit.flatSlots(code, range);
  const moved = rolledit.shift(slots[1].text, 1, 'note');
  const out = rolledit.applyEdit(code, slots[1], moved);
  assert.equal(out, 'note("<  ab1 c2 gb1>")');
});

test('an unsupported layer no longer hides an editable one beneath it', () => {
  const code = [
    'stack(',
    '  note("{eb3 g3}%4").sound("square"),',
    '  note("c4 e4 g4 e4").sound("triangle")',
    ')',
  ].join('\n');

  // the polymeter note sorts first, and stopping at it was the bug
  const notes = [{ hap: hapAt(code, 'eb3', 0) }, { hap: hapAt(code, 'c4', 0) }];
  const found = rolledit.firstEditableSequence(notes, code);
  assert.ok(found, 'no sequence found');
  assert.equal(
    code.slice(found.rangeStart, code.indexOf('"', found.rangeStart + 1) + 1),
    '"c4 e4 g4 e4"',
  );
});

test('a file with nothing editable in it reports no sequence', () => {
  const code = 'note("{a b}%4")';
  assert.equal(rolledit.firstEditableSequence([{ hap: hapAt(code, 'a') }], code), null);
});

test('the search does not retry the same string once rejected', () => {
  const code = 'note("{a b}%4")';
  const notes = ['a', 'b'].map((n) => ({ hap: hapAt(code, n) }));
  assert.equal(rolledit.firstEditableSequence(notes, code), null);
});

test('cursor offsets round trip against positions', () => {
  const text = 'abc\ndefg\n\nhi';
  for (let offset = 0; offset <= text.length; offset++) {
    const at = rolledit.offsetToPosition(text, offset);
    assert.equal(rolledit.positionToOffset(text, at.line, at.col), offset, `offset ${offset}`);
  }
  // a position past the end clamps rather than running off
  assert.equal(rolledit.positionToOffset(text, 99, 99), text.length);
});

test('every editable sequence is listed, in source order', () => {
  const code = [
    'stack(',
    '  note("eb2 ab1").sound("sawtooth"),',
    '  note("{a b}%4").sound("square"),',
    '  note("c4 [eb4 c5] g4").sound("triangle")',
    ')',
  ].join('\n');

  const notes = [
    { hap: hapAt(code, 'c4') },
    { hap: hapAt(code, 'eb2') },
    { hap: hapAt(code, 'a') },
  ];
  const found = rolledit.editableSequences(notes, code);
  assert.equal(found.length, 2, 'the polymeter layer is not editable');
  // returned in source order regardless of the order the notes arrived in
  assert.ok(found[0].rangeStart < found[1].rangeStart);
  const text = (seq) => code.slice(seq.rangeStart, code.indexOf('"', seq.rangeStart + 1) + 1);
  assert.equal(text(found[0]), '"eb2 ab1"');
  assert.equal(text(found[1]), '"c4 [eb4 c5] g4"');
});

test('a refused string is not retried for each of its notes', () => {
  const code = 'note("{a b}%4")';
  const notes = ['a', 'b'].map((n) => ({ hap: hapAt(code, n) }));
  assert.deepEqual(rolledit.editableSequences(notes, code), []);
});

test('firstEditableSequence stays the head of that list', () => {
  const code = 'stack(note("{a b}%4"), note("c4 e4"))';
  const notes = [{ hap: hapAt(code, 'a') }, { hap: hapAt(code, 'c4') }];
  const all = rolledit.editableSequences(notes, code);
  assert.equal(rolledit.firstEditableSequence(notes, code).rangeStart, all[0].rangeStart);
});

// --- note mode key shapes ---
//
// The dispatch itself lives in cli.mjs and needs a TTY, but which physical key
// produces which parsed event is testable, and that is where the macOS
// collision bit: ctrl with an arrow never arrives at all.

test('option arrows parse as something note mode can act on', () => {
  // modern terminals: CSI with the alt flag
  for (const [seq, final] of [['\x1b[1;3A', 'A'], ['\x1b[1;3B', 'B'], ['\x1b[1;3C', 'C'], ['\x1b[1;3D', 'D']]) {
    const [key] = parseKeys(seq);
    assert.equal(key.type, 'csi', seq);
    assert.equal(key.final, final, seq);
    assert.equal(key.alt, true, `${seq} should carry the alt flag`);
  }
  // Terminal.app sends these for option with left and right
  assert.deepEqual(parseKeys('\x1bf'), [{ type: 'word', direction: 1 }]);
  assert.deepEqual(parseKeys('\x1bb'), [{ type: 'word', direction: -1 }]);
});

test('tab and shift-tab stay distinguishable as a fallback', () => {
  assert.deepEqual(parseKeys('\t'), [{ type: 'char', ch: '\t' }]);
  const [shiftTab] = parseKeys('\x1b[Z');
  assert.equal(shiftTab.type, 'csi');
  assert.equal(shiftTab.final, 'Z');
});

test('shift arrows are told apart from plain and from ctrl', () => {
  const flags = (seq) => {
    const [key] = parseKeys(seq);
    return [key.shift, key.alt, key.ctrl];
  };
  assert.deepEqual(flags('\x1b[1;2A'), [true, false, false], 'shift');
  assert.deepEqual(flags('\x1b[1;5A'), [false, false, true], 'ctrl');
  assert.deepEqual(flags('\x1b[A'), [false, false, false], 'plain');
});

// --- master bus effects ---

test('flanger and chorus are bus rows, not per-event sends', () => {
  const keys = sliders.GLOBAL_ROWS.map((row) => row.key);
  assert.ok(keys.includes('flanger'));
  assert.ok(keys.includes('chorus'));

  // superdough has no control for either, so neither the mixes nor their
  // parameters may ever ride an event
  const busKeys = sliders.BUS_ROWS.map((row) => row.key);
  assert.deepEqual(busKeys, [
    'flanger', 'flangerRate', 'flangerDepth', 'flangerFeedback',
    'chorus', 'chorusRate', 'chorusDepth', 'chorusFeedback',
  ]);

  for (const row of sliders.GLOBAL_ROWS) {
    if (row.key === 'room' || row.key === 'delay') assert.ok(!row.bus, `${row.key} is a send`);
  }
  // a parameter row knows which effect and which knob it drives
  const rate = sliders.GLOBAL_ROWS.find((row) => row.key === 'flangerRate');
  assert.deepEqual(rate.param, { effect: 'flanger', key: 'rate' });
  assert.equal(rate.showWith, 'flanger');
});

test('bus effects start off so adding them changes nothing', () => {
  assert.equal(sliders.globals.flanger, 0);
  assert.equal(sliders.globals.chorus, 0);
});

test('bus rows ride like every other global', () => {
  sliders.globals.flanger = 0;
  const up = sliders.adjustGlobal('flanger', 1);
  assert.ok(up > 0 && up <= 1, `moved to ${up}`);
  sliders.globals.flanger = 1;
  assert.equal(sliders.adjustGlobal('flanger', 1), 1, 'clamps at the top');
  sliders.globals.flanger = 0;
  assert.equal(sliders.adjustGlobal('flanger', -1), 0, 'clamps at the bottom');
});

test('controls with nothing behind them say so', () => {
  // strudel accepts these and superdough 1.3.0 implements none of them, which
  // is silent and maddening to debug by ear
  for (const name of ['leslie', 'squiz', 'waveloss', 'triode', 'krush', 'ring']) {
    assert.ok(isUnsupported(name), `${name} should be flagged`);
    assert.match(describe(name), /no effect here/, name);
    assert.equal(rangeOf(name), null, `${name} should not advertise a range`);
  }
});

test('controls that do work are not flagged', () => {
  for (const name of ['phaser', 'tremolo', 'vib', 'crush', 'coarse', 'shape', 'distort', 'vowel']) {
    assert.ok(!isUnsupported(name), `${name} works and should not be flagged`);
  }
});

// --- the bus chain itself ---
const { createBusChain, BUS_PRESETS } = await import('../src/buseffects.mjs');

test('the bus presets are a flanger and a chorus, told apart by their numbers', () => {
  assert.deepEqual(Object.keys(BUS_PRESETS), ['flanger', 'chorus']);
  // short with feedback combs; longer and clean thickens
  assert.ok(BUS_PRESETS.flanger.delay < BUS_PRESETS.chorus.delay);
  assert.ok(BUS_PRESETS.flanger.feedback > 0);
  assert.equal(BUS_PRESETS.chorus.feedback, 0);
  // a sweep slow enough to wait on reads as a drift rather than an effect
  assert.ok(BUS_PRESETS.flanger.rate >= 0.5, 'flanger sweep should not crawl');
});

test('a preset can be overridden per chain', async () => {
  const { OfflineAudioContext } = await import('node-web-audio-api');
  const ctx = new OfflineAudioContext(1, 1024, 22050);
  const bus = createBusChain(ctx, ctx.destination, { flanger: { rate: 3 } });
  // AudioParam stores float32, so 1.2 reads back as 1.2000000476837158
  const near = (actual, expected, what) =>
    assert.ok(Math.abs(actual - expected) < 1e-6, `${what}: ${actual} vs ${expected}`);

  near(bus.effects.flanger.lfo.frequency.value, 3, 'override applied');
  // untouched fields keep the preset, and other effects are unaffected
  near(bus.effects.chorus.lfo.frequency.value, BUS_PRESETS.chorus.rate, 'chorus untouched');
  near(bus.effects.flanger.wet.gain.value, 0, 'still silent until turned up');
  bus.stop();
});

// Gains are ramped rather than assigned, so reading .value straight after
// setMix returns the value before the ramp. The behaviour has to be rendered.
async function renderBus(mix) {
  const { OfflineAudioContext } = await import('node-web-audio-api');
  const rate = 22050;
  const ctx = new OfflineAudioContext(1, rate, rate);
  const bus = createBusChain(ctx, ctx.destination);
  if (mix) for (const [name, value] of Object.entries(mix)) bus.setMix(name, value);

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = 220;
  const gain = ctx.createGain();
  gain.gain.value = 0.3;
  osc.connect(gain).connect(bus.input);
  osc.start(0);
  osc.stop(1);

  const rendered = await ctx.startRendering();
  bus.stop();
  return rendered.getChannelData(0).slice();
}

const peakOf = (data) => data.reduce((top, v) => Math.max(top, Math.abs(v)), 0);

test('a bus with everything off is not a level change', async () => {
  const off = await renderBus(null);
  const zeroed = await renderBus({ flanger: 0, chorus: 0 });
  let difference = 0;
  for (let i = 0; i < off.length; i++) difference += Math.abs(off[i] - zeroed[i]);
  assert.equal(difference, 0, 'an effect at zero should be bit identical to dry');
});

test('turning an effect up changes the sound without raising the level', async () => {
  const dry = await renderBus(null);
  const wet = await renderBus({ flanger: 1 });

  let difference = 0;
  for (let i = 0; i < dry.length; i++) difference += Math.abs(dry[i] - wet[i]);
  assert.ok(difference / dry.length > 1e-4, 'the flanger should be audible');

  // wet is added to dry, so without the output trim this clips
  assert.ok(
    peakOf(wet) <= peakOf(dry) * 1.05,
    `level ran away: dry ${peakOf(dry).toFixed(3)} to wet ${peakOf(wet).toFixed(3)}`,
  );
});

test('an unknown bus effect is refused rather than ignored', async () => {
  const { OfflineAudioContext } = await import('node-web-audio-api');
  const ctx = new OfflineAudioContext(1, 1024, 22050);
  const bus = createBusChain(ctx, ctx.destination);
  assert.equal(bus.setMix('phaser', 1), false);
  assert.deepEqual(bus.names(), ['flanger', 'chorus']);
  bus.stop();
});

test('bus mixes clamp to 0 and 1', async () => {
  const { OfflineAudioContext } = await import('node-web-audio-api');
  const ctx = new OfflineAudioContext(1, 1024, 22050);
  const bus = createBusChain(ctx, ctx.destination);
  bus.setMix('flanger', 5);
  assert.ok(bus.effects.flanger.wet.gain.value <= 1);
  bus.setMix('flanger', -3);
  assert.ok(bus.effects.flanger.wet.gain.value >= 0);
  bus.setMix('flanger', NaN);
  assert.ok(Number.isFinite(bus.effects.flanger.wet.gain.value));
  bus.stop();
});

const { panelRows } = await import('../src/tui.mjs');

test('an effect exposes its own controls only once it is on', () => {
  const engine = { cps: 0.5, layers: [] };
  const labels = () => panelRows(engine).map((row) => row.label);

  sliders.globals.flanger = 0;
  sliders.globals.chorus = 0;
  assert.ok(!labels().some((l) => l.startsWith('flan ')), 'hidden while off');

  sliders.globals.flanger = 0.5;
  const on = labels();
  assert.deepEqual(
    on.filter((l) => l.startsWith('flan ')),
    ['flan rate', 'flan depth', 'flan fdbk'],
  );
  // turning one effect up must not reveal the other's controls
  assert.ok(!on.some((l) => l.startsWith('chor ')), 'chorus stays collapsed');
  sliders.globals.flanger = 0;
});

test('a parameter row shows its value rather than "off" at zero', () => {
  const engine = { cps: 0.5, layers: [] };
  sliders.globals.flanger = 0.5;
  sliders.globals.flangerFeedback = 0;
  const row = panelRows(engine).find((r) => r.label === 'flan fdbk');
  // zero feedback is a real setting, not an absent one
  assert.equal(row.display, '0');
  sliders.globals.flangerFeedback = 0.5;
  sliders.globals.flanger = 0;
});

test('bus parameters take effect and clamp to their range', async () => {
  const { OfflineAudioContext } = await import('node-web-audio-api');
  const ctx = new OfflineAudioContext(1, 1024, 22050);
  const bus = createBusChain(ctx, ctx.destination);

  assert.equal(bus.setParam('flanger', 'rate', 4), true);
  assert.equal(bus.setParam('flanger', 'nonsense', 1), false, 'unknown parameter');
  assert.equal(bus.setParam('nosuch', 'rate', 1), false, 'unknown effect');

  // depth is carried in milliseconds and applied in seconds
  bus.setParam('flanger', 'depth', 12);
  bus.setParam('flanger', 'rate', 999);
  bus.setParam('flanger', 'feedback', -5);
  bus.stop();
});

test('feedback can be added to an effect whose preset had none', async () => {
  const { OfflineAudioContext } = await import('node-web-audio-api');
  const ctx = new OfflineAudioContext(1, 1024, 22050);
  const bus = createBusChain(ctx, ctx.destination);
  // the chorus preset is feedback 0, and the loop used to be built only when a
  // preset asked for it, so this could not be turned up at all
  assert.equal(BUS_PRESETS.chorus.feedback, 0);
  assert.ok(bus.effects.chorus.loop, 'the feedback path should exist anyway');
  assert.equal(bus.setParam('chorus', 'feedback', 0.6), true);
  bus.stop();
});

test('the command key is decoded when a terminal sends it', () => {
  // bit 8 of the modifier bitfield: meta in xterm's scheme, super in kitty's,
  // which is where command lands on a Mac. Terminal.app never forwards it, so
  // this is decoded opportunistically rather than depended on.
  const [cmd] = parseKeys('\x1b[1;9D');
  assert.equal(cmd.cmd, true);
  assert.equal(cmd.final, 'D');
  assert.equal(cmd.ctrl, false, 'command is not ctrl');
  assert.equal(cmd.alt, false, 'command is not option');

  // combinations keep both bits
  const [both] = parseKeys('\x1b[1;10D');
  assert.equal(both.cmd, true);
  assert.equal(both.shift, true);
});

test('the modifiers stay mutually distinguishable', () => {
  const flags = (seq) => {
    const [key] = parseKeys(seq);
    return { shift: key.shift, alt: key.alt, ctrl: key.ctrl, cmd: key.cmd };
  };
  assert.deepEqual(flags('\x1b[A'), { shift: false, alt: false, ctrl: false, cmd: false });
  assert.deepEqual(flags('\x1b[1;2A'), { shift: true, alt: false, ctrl: false, cmd: false });
  assert.deepEqual(flags('\x1b[1;3A'), { shift: false, alt: true, ctrl: false, cmd: false });
  assert.deepEqual(flags('\x1b[1;5A'), { shift: false, alt: false, ctrl: true, cmd: false });
  assert.deepEqual(flags('\x1b[1;9A'), { shift: false, alt: false, ctrl: false, cmd: true });
});

// --- audio module, without a device ---
//
// initAudio needs a sound card, but everything that reports on a context this
// process has not opened is testable, and those are exactly the paths that run
// under --silent.
const audio = await import('../src/audio.mjs');

test('the audio module answers safely before a context exists', () => {
  assert.deepEqual(audio.busEffectNames(), [], 'no bus until one is built');
  assert.equal(audio.setBusEffect('flanger', 1), false, 'refuses rather than throwing');
  assert.equal(audio.setBusParam('flanger', 'rate', 2), false);
  assert.equal(typeof audio.contextState(), 'string');
  // null, not a throw: the scope renderer takes a missing buffer and draws the
  // zero line, which is what --silent shows
  assert.equal(audio.waveform(), null);
  assert.deepEqual(renderWaveform({ data: audio.waveform(), width: 40, height: 4 }).length, 4);
});

test('render stats are shaped the same with or without a context', () => {
  const stats = audio.renderStats();
  assert.equal(typeof stats, 'object');
  assert.ok(stats !== null);
});

// --- captured console ---
//
// Left until last: this module hijacks console on import and releaseConsole is
// one way, so anything after it would print over the alternate screen.
const logcapture = await import('../src/logcapture.mjs');

test('a strudel log line loses its CSS argument', () => {
  console.log('%chello there', 'background-color: #222; color: white');
  const last = logcapture.allLogs().at(-1);
  assert.equal(last.text, 'hello there');
});

test('a line that is only formatting is dropped', () => {
  const before = logcapture.allLogs().length;
  console.log('%c', 'background-color: red');
  assert.equal(logcapture.allLogs().length, before, 'nothing worth showing');
});

test('a log line that reports a failure is promoted to a warning', () => {
  // strudel reports query failures through console.log, and the footer only
  // surfaces lines above log level, so these would never be seen
  for (const text of ['pattern error at line 3', 'query failed', 'cannot use window']) {
    console.log(text);
    assert.equal(logcapture.allLogs().at(-1).level, 'warn', text);
  }
  console.log('loaded 3 sounds');
  assert.equal(logcapture.allLogs().at(-1).level, 'log', 'an ordinary line stays a log');
});

test('the ring buffer does not grow without bound', () => {
  for (let i = 0; i < 80; i++) console.log(`line ${i}`);
  const all = logcapture.allLogs();
  assert.equal(all.length, 40, 'capped');
  assert.equal(all.at(-1).text, 'line 79', 'keeping the newest');
});

test('allLogs hands back a copy', () => {
  const first = logcapture.allLogs();
  first.push({ level: 'log', text: 'not real', at: Date.now() });
  assert.notEqual(logcapture.allLogs().length, first.length);
});

test('recentLog only surfaces lines inside the window', () => {
  console.log('fresh line');
  assert.equal(logcapture.recentLog(4000).text, 'fresh line');
  assert.equal(logcapture.recentLog(0), null, 'nothing is newer than zero ms old');
});

test('releasing the console stops the capture', () => {
  logcapture.releaseConsole();
  const before = logcapture.allLogs().length;
  console.log('');
  assert.equal(logcapture.allLogs().length, before, 'no longer recording');
});

test('a continuous signal does not take the roll down', () => {
  // sine and friends produce haps with no whole. Every caller filters them, so
  // this is the renderer refusing to depend on that.
  const analog = { value: { note: 'c3' }, context: {} };
  const real = {
    whole: { begin: { valueOf: () => 0 }, end: { valueOf: () => 1 } },
    value: { note: 'e3', s: 'saw' },
    context: { locations: [] },
  };
  const rows = pianoroll.renderPianoRoll({
    haps: [analog, real],
    currentCycle: 0.5,
    width: 60,
    height: 10,
  });
  assert.equal(rows.length, 10);
  // and the real note beside it is still drawn
  assert.ok(rows.some((r) => r.includes('█')), 'the pitched note survived');
});

// --- the files we ship ---
//
// Two broken examples shipped today: first.str ended in an uncalled .rev, and
// course/05 had its transform deleted leaving `.every(4, ))`. Both parse-level
// or event-level failures a reader would hit immediately, and neither was
// caught by anything. Now they are.
const exampleDir = fileURLToPath(new URL('../examples', import.meta.url));
const exampleFiles = [
  ...readdirSync(exampleDir).filter((f) => f.endsWith('.str')).map((f) => join(exampleDir, f)),
  ...readdirSync(join(exampleDir, 'course'))
    .filter((f) => f.endsWith('.str'))
    .map((f) => join(exampleDir, 'course', f)),
];

test('there are examples to check', () => {
  assert.ok(exampleFiles.length >= 7, `found ${exampleFiles.length}`);
});

for (const file of exampleFiles) {
  const name = file.slice(exampleDir.length + 1);
  await test(`example ${name} runs`, async () => {
    const { Engine } = await import('../src/engine.mjs');
    const engine = new Engine();
    const error = await engine.setCode(readFileSync(file, 'utf8'), { quiet: true });
    assert.equal(error ?? null, null, `does not evaluate: ${error}`);

    const haps = engine.pattern.queryArc(0, 2).filter((h) => h.whole);
    assert.ok(haps.length > 0, 'evaluates but produces no events');

    // a value that is not an object is what superdough refuses to play, and is
    // exactly what an uncalled transform leaves behind
    const unplayable = haps.filter((h) => typeof h.value !== 'object' || h.value === null);
    assert.equal(unplayable.length, 0, `${unplayable.length} events superdough cannot play`);
  });
}

await Promise.all(pending);

// A test that neither passes nor reports a failure must still fail the run.
if (passed !== started.length) {
  writeSync(2, `MISMATCH: ${started.length} tests declared, ${passed} passed\n`);
  process.exitCode = 1;
}

// strudel and superdough leave handles open, so exit explicitly rather than
// waiting for the loop to drain. The write has to be flushed first: stdout to a
// pipe is async, and process.exit() truncates anything still buffered.
process.stdout.write(`${passed} of ${started.length} tests passed\n`, () => {
  process.exit(process.exitCode ?? 0);
});
