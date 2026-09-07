// Single-line tokenizer for the strudel subset of JavaScript. Deliberately not
// a parser: it runs on every visible line every frame, and being wrong about an
// edge case costs a colour, not correctness.
//
// Mini-notation operators inside strings get their own kind, because that is
// where the actual musical syntax lives and it is the part worth learning to
// see at a glance.

const MINI_OPS = /(\.\.|[~*/<>[\],!@?:()])/g;

function splitMini(text) {
  const out = [];
  let last = 0;
  let match;
  MINI_OPS.lastIndex = 0;
  while ((match = MINI_OPS.exec(text))) {
    if (match.index > last) out.push({ text: text.slice(last, match.index), kind: 'string' });
    out.push({ text: match[0], kind: 'mini' });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: 'string' });
  return out;
}

export function tokenize(line) {
  const out = [];
  const push = (text, kind) => {
    if (text) out.push({ text, kind });
  };

  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);

    if (rest.startsWith('//')) {
      push(rest, 'comment');
      break;
    }

    const quote = line[i];
    if (quote === '"' || quote === "'" || quote === '`') {
      let j = i + 1;
      while (j < line.length && line[j] !== quote) {
        if (line[j] === '\\') j++;
        j++;
      }
      push(quote, 'string');
      for (const seg of splitMini(line.slice(i + 1, Math.min(j, line.length)))) {
        push(seg.text, seg.kind);
      }
      if (j < line.length) push(quote, 'string');
      i = j + 1;
      continue;
    }

    let m = /^\d+(?:\.\d+)?/.exec(rest);
    if (m) {
      push(m[0], 'number');
      i += m[0].length;
      continue;
    }

    m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
    if (m) {
      const name = m[0];
      const isMethod = line.slice(0, i).trimEnd().endsWith('.');
      const isCall = /^\s*\(/.test(line.slice(i + name.length));
      push(name, isMethod ? 'method' : isCall ? 'call' : 'text');
      i += name.length;
      continue;
    }

    m = /^\s+/.exec(rest);
    if (m) {
      push(m[0], 'text');
      i += m[0].length;
      continue;
    }

    m = /^[^\w\s"'`]+/.exec(rest);
    if (m) {
      push(m[0], 'punct');
      i += m[0].length;
      continue;
    }

    push(line[i], 'text');
    i += 1;
  }

  return out;
}

// Clip tokens to a horizontal window, for panes that scroll sideways.
export function sliceSegments(segments, from, to) {
  const out = [];
  let pos = 0;
  for (const seg of segments) {
    const start = pos;
    const end = pos + seg.text.length;
    pos = end;
    if (end <= from || start >= to) continue;
    const text = seg.text.slice(Math.max(0, from - start), Math.max(0, to - start));
    if (text) out.push({ text, kind: seg.kind });
  }
  return out;
}
