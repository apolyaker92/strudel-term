// Minimal line editor backing the code pane. Holds the buffer and the cursor;
// knows nothing about the screen. The TUI decides what's visible.

const TAB = '  ';

// Consecutive typing inside this window collapses into one undo step, so
// ctrl-z removes a word or a phrase rather than one character at a time.
const COALESCE_MS = 600;
const MAX_HISTORY = 300;

export class Editor {
  constructor(text = '') {
    this.lines = text.split('\n');
    this.line = 0;
    this.col = 0;
    this.dirty = false;
    // bumped by every mutation, so the caller can debounce off it without
    // having to hook each method
    this.revision = 0;

    // where a selection started; null when there is no selection
    this.anchor = null;

    this.history = [];
    this.future = [];
    this.lastEditKind = null;
    this.lastEditAt = 0;
  }

  // --- selection ---

  get position() {
    return { line: this.line, col: this.col };
  }

  startSelection() {
    this.anchor ??= this.position;
  }

  clearSelection() {
    this.anchor = null;
  }

  hasSelection() {
    if (!this.anchor) return false;
    return this.anchor.line !== this.line || this.anchor.col !== this.col;
  }

  // anchor and cursor in document order, so callers never handle both directions
  selectionRange() {
    if (!this.hasSelection()) return null;
    const a = this.anchor;
    const b = this.position;
    const aFirst = a.line < b.line || (a.line === b.line && a.col <= b.col);
    return aFirst ? { start: a, end: b } : { start: b, end: a };
  }

  selectedText() {
    const range = this.selectionRange();
    if (!range) return '';
    const { start, end } = range;
    if (start.line === end.line) return this.lines[start.line].slice(start.col, end.col);
    const parts = [this.lines[start.line].slice(start.col)];
    for (let i = start.line + 1; i < end.line; i++) parts.push(this.lines[i]);
    parts.push(this.lines[end.line].slice(0, end.col));
    return parts.join('\n');
  }

  deleteSelection() {
    const range = this.selectionRange();
    if (!range) return false;
    this.beginEdit('delete');
    const { start, end } = range;
    const head = this.lines[start.line].slice(0, start.col);
    const tail = this.lines[end.line].slice(end.col);
    this.lines.splice(start.line, end.line - start.line + 1, head + tail);
    this.line = start.line;
    this.col = start.col;
    this.anchor = null;
    this.touch();
    return true;
  }

  selectAll() {
    this.anchor = { line: 0, col: 0 };
    this.line = this.lines.length - 1;
    this.col = this.lines[this.line].length;
  }

  // --- words ---

  wordLeft() {
    if (this.col === 0) {
      if (this.line === 0) return;
      this.line -= 1;
      this.col = this.lines[this.line].length;
      return;
    }
    const before = this.lines[this.line].slice(0, this.col);
    // skip trailing separators, then the word itself
    const trimmed = before.replace(/[^A-Za-z0-9_$]+$/, '');
    const start = trimmed.replace(/[A-Za-z0-9_$]+$/, '');
    this.col = start.length;
  }

  wordRight() {
    const line = this.lines[this.line];
    if (this.col >= line.length) {
      if (this.line >= this.lines.length - 1) return;
      this.line += 1;
      this.col = 0;
      return;
    }
    const after = line.slice(this.col);
    const skipped = after.match(/^[^A-Za-z0-9_$]*[A-Za-z0-9_$]*/)?.[0] ?? '';
    this.col += Math.max(1, skipped.length);
  }

  deleteWordLeft() {
    if (this.deleteSelection()) return;
    if (this.col === 0) return this.backspace();
    const from = this.col;
    this.wordLeft();
    const to = this.col;
    this.col = from;
    this.replaceInLine(to, from, '');
  }

  deleteToLineStart() {
    if (this.deleteSelection()) return;
    if (this.col === 0) return this.backspace();
    this.replaceInLine(0, this.col, '');
  }

  snapshot() {
    return { lines: this.lines.slice(), line: this.line, col: this.col };
  }

  restore(state) {
    this.anchor = null;
    this.lines = state.lines.slice();
    this.line = state.line;
    this.col = state.col;
    this.clamp();
    this.dirty = true;
    this.revision++;
    this.lastEditKind = null;
  }

  // Record the pre-edit state, coalescing runs of plain typing.
  beginEdit(kind) {
    const now = Date.now();
    const coalesce =
      kind === 'insert' && this.lastEditKind === 'insert' && now - this.lastEditAt < COALESCE_MS;

    if (!coalesce) {
      this.history.push(this.snapshot());
      if (this.history.length > MAX_HISTORY) this.history.shift();
      this.future.length = 0;
    }
    this.lastEditKind = kind;
    this.lastEditAt = now;
  }

  undo() {
    if (!this.history.length) return false;
    this.future.push(this.snapshot());
    this.restore(this.history.pop());
    return true;
  }

  redo() {
    if (!this.future.length) return false;
    this.history.push(this.snapshot());
    this.restore(this.future.pop());
    return true;
  }

  touch() {
    this.dirty = true;
    this.revision++;
    // every mutation ends with the cursor and the anchor inside the buffer.
    // Deleting lines used to leave a selection anchor pointing past the end,
    // and the next edit through it read a line that was no longer there.
    this.clamp();
  }

  get text() {
    return this.lines.join('\n');
  }

  // Replace the buffer from disk, keeping the cursor as close as possible.
  setText(text) {
    this.history.push(this.snapshot());
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.future.length = 0;
    this.lastEditKind = null;
    this.lines = text.split('\n');
    this.dirty = false;
    this.revision++;
    this.clamp();
  }

  clamp() {
    if (this.lines.length === 0) this.lines = [''];
    this.line = Math.max(0, Math.min(this.lines.length - 1, this.line));
    this.col = Math.max(0, Math.min(this.lines[this.line].length, this.col));
    if (this.anchor) {
      const line = Math.max(0, Math.min(this.lines.length - 1, this.anchor.line));
      const col = Math.max(0, Math.min(this.lines[line].length, this.anchor.col));
      this.anchor = { line, col };
    }
  }

  insert(str) {
    // A newline here would leave a line holding a line break, which every
    // other operation assumes cannot happen. Route it through the splitter.
    if (str.includes('\n') || str.includes('\r')) return this.insertText(str);

    this.deleteSelection();
    this.beginEdit('insert');
    const line = this.lines[this.line];
    this.lines[this.line] = line.slice(0, this.col) + str + line.slice(this.col);
    this.col += str.length;
    this.touch();
  }

  newline() {
    this.deleteSelection();
    this.beginEdit('newline');
    const line = this.lines[this.line];
    const before = line.slice(0, this.col);
    const after = line.slice(this.col);
    // keep the current indentation, which matters a lot in stacked patterns
    const indent = (before.match(/^\s*/) ?? [''])[0];
    this.lines.splice(this.line, 1, before, indent + after);
    this.line += 1;
    this.col = indent.length;
    this.touch();
  }

  backspace() {
    if (this.deleteSelection()) return;
    this.beginEdit('delete');
    if (this.col > 0) {
      const line = this.lines[this.line];
      // eat a full soft tab when the cursor sits just past one
      const width = line.slice(0, this.col).endsWith(TAB) && this.col % TAB.length === 0 ? TAB.length : 1;
      this.lines[this.line] = line.slice(0, this.col - width) + line.slice(this.col);
      this.col -= width;
      this.touch();
    } else if (this.line > 0) {
      const prev = this.lines[this.line - 1];
      const cur = this.lines[this.line];
      this.col = prev.length;
      this.lines.splice(this.line - 1, 2, prev + cur);
      this.line -= 1;
      this.touch();
    }
  }

  deleteForward() {
    if (this.deleteSelection()) return;
    this.beginEdit('delete');
    const line = this.lines[this.line];
    if (this.col < line.length) {
      this.lines[this.line] = line.slice(0, this.col) + line.slice(this.col + 1);
      this.touch();
    } else if (this.line < this.lines.length - 1) {
      this.lines.splice(this.line, 2, line + this.lines[this.line + 1]);
      this.touch();
    }
  }

  killToEnd() {
    this.beginEdit('kill');
    const line = this.lines[this.line];
    if (this.col < line.length) {
      this.lines[this.line] = line.slice(0, this.col);
    } else if (this.line < this.lines.length - 1) {
      this.lines.splice(this.line + 1, 1);
    }
    this.touch();
  }

  tab() {
    this.insert(TAB);
  }

  // Bracketed paste: insert verbatim, with no auto-indent per line, which is
  // what turns pasted code into a staircase.
  insertText(text) {
    this.deleteSelection();
    this.beginEdit('paste');
    this.clamp();
    const incoming = text.replace(/\r\n?/g, '\n').split('\n');
    const line = this.lines[this.line];
    const head = line.slice(0, this.col);
    const tail = line.slice(this.col);
    if (incoming.length === 1) {
      this.lines[this.line] = head + incoming[0] + tail;
      this.col += incoming[0].length;
    } else {
      const last = incoming[incoming.length - 1];
      const block = [head + incoming[0], ...incoming.slice(1, -1), last + tail];
      this.lines.splice(this.line, 1, ...block);
      this.line += incoming.length - 1;
      this.col = last.length;
    }
    this.touch();
  }

  // Leaves the cursor after the replacement.
  replaceInLine(start, end, text) {
    this.beginEdit('replace');
    const line = this.lines[this.line];
    const from = Math.max(0, Math.min(line.length, start));
    const to = Math.max(from, Math.min(line.length, end));
    this.lines[this.line] = line.slice(0, from) + text + line.slice(to);
    this.col = from + text.length;
    this.touch();
  }

  move(dLine, dCol) {
    this.lastEditKind = null;
    if (dCol) {
      const target = this.col + dCol;
      if (target < 0 && this.line > 0) {
        this.line -= 1;
        this.col = this.lines[this.line].length;
      } else if (target > this.lines[this.line].length && this.line < this.lines.length - 1) {
        this.line += 1;
        this.col = 0;
      } else {
        this.col = Math.max(0, Math.min(this.lines[this.line].length, target));
      }
    }
    if (dLine) {
      this.line = Math.max(0, Math.min(this.lines.length - 1, this.line + dLine));
      this.col = Math.min(this.col, this.lines[this.line].length);
    }
  }

  home() {
    // first non-space, then column zero, the way most editors toggle
    const indent = (this.lines[this.line].match(/^\s*/) ?? [''])[0].length;
    this.col = this.col === indent ? 0 : indent;
  }

  end() {
    this.col = this.lines[this.line].length;
  }
}

// Split a raw stdin chunk into key tokens. Escape sequences arrive whole in
// practice, and a paste arrives as one chunk of printable text.
export function parseKeys(str) {
  const keys = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === '\x1b') {
      const rest = str.slice(i);

      // a bracketed paste is one event, however many newlines it contains
      if (rest.startsWith('\x1b[200~')) {
        const end = rest.indexOf('\x1b[201~');
        const text = end === -1 ? rest.slice(6) : rest.slice(6, end);
        keys.push({ type: 'paste', text });
        i += end === -1 ? rest.length : end + 6;
        continue;
      }
      if (rest.startsWith('\x1b[201~')) {
        i += 6;
        continue;
      }

      // option-backspace arrives as escape then delete
      if (rest.startsWith('\x1b\x7f')) {
        keys.push({ type: 'alt-backspace' });
        i += 2;
        continue;
      }

      // some terminals send option-left/right as escape b and escape f
      if (rest.startsWith('\x1bb') || rest.startsWith('\x1bf')) {
        keys.push({ type: 'word', direction: rest[1] === 'b' ? -1 : 1 });
        i += 2;
        continue;
      }

      const csi = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(rest);
      if (csi) {
        // "1;2C" is shift-right, "1;3C" alt-right: a modifier bitfield offset
        // by one. Bit 8 is meta in xterm and super in kitty, where command
        // would land if a terminal forwarded it; Terminal.app never does.
        const modifier = Number(csi[1].split(';')[1] ?? 1) - 1;
        keys.push({
          type: 'csi',
          params: csi[1],
          final: csi[2],
          shift: (modifier & 1) === 1,
          alt: (modifier & 2) === 2,
          ctrl: (modifier & 4) === 4,
          cmd: (modifier & 8) === 8,
        });
        i += csi[0].length;
        continue;
      }
      const ss3 = /^\x1bO([A-Za-z])/.exec(rest);
      if (ss3) {
        keys.push({ type: 'csi', params: '', final: ss3[1] });
        i += ss3[0].length;
        continue;
      }
      keys.push({ type: 'esc' });
      i += 1;
      continue;
    }
    keys.push({ type: 'char', ch: str[i] });
    i += 1;
  }
  return keys;
}
