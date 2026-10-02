// Minimal comment-preserving JSONC reader/editor.
//
// Parses JSON with comments and trailing commas into a position-annotated tree,
// then applies *targeted* text splices so every byte outside the edited span
// (comments, ordering, whitespace, unrelated keys) survives untouched. Every
// mutation returns enough information to undo it exactly; see `revert*`.

export class JsoncError extends Error {
  constructor(message, offset) {
    super(offset === undefined ? message : `${message} (at offset ${offset})`);
    this.name = 'JsoncError';
    this.offset = offset;
  }
}

/** Parse JSONC text into a position-annotated tree. */
export function parseTree(text) {
  let i = 0;
  const n = text.length;
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  function skip() {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (text[i] === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
        continue;
      }
      if (text[i] === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) throw new JsoncError('unterminated block comment', i);
        i = end + 2;
        continue;
      }
      return;
    }
  }

  function str() {
    const start = i;
    i++;
    while (i < n && text[i] !== '"') {
      if (text[i] === '\\') i++;
      else if (text[i] === '\n') throw new JsoncError('newline in string', i);
      i++;
    }
    if (i >= n) throw new JsoncError('unterminated string', start);
    i++;
    const raw = text.slice(start, i);
    return { type: 'string', start, end: i, value: JSON.parse(raw) };
  }

  function value() {
    skip();
    const c = text[i];
    if (c === '{') return obj();
    if (c === '[') return arr();
    if (c === '"') return str();
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) throw new JsoncError(`unexpected token ${JSON.stringify(c ?? 'EOF')}`, i);
    const start = i;
    i += m[0].length;
    return { type: 'literal', start, end: i, value: JSON.parse(m[0]) };
  }

  function obj() {
    const node = { type: 'object', start: i, end: -1, members: [] };
    i++;
    for (;;) {
      skip();
      if (text[i] === '}') { i++; node.end = i; return node; }
      if (text[i] !== '"') throw new JsoncError('expected property name', i);
      const k = str();
      skip();
      if (text[i] !== ':') throw new JsoncError('expected ":"', i);
      i++;
      const v = value();
      node.members.push({ key: k.value, keyStart: k.start, keyEnd: k.end, value: v });
      skip();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') continue;
      throw new JsoncError('expected "," or "}"', i);
    }
  }

  function arr() {
    const node = { type: 'array', start: i, end: -1, elements: [] };
    i++;
    for (;;) {
      skip();
      if (text[i] === ']') { i++; node.end = i; return node; }
      node.elements.push(value());
      skip();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') continue;
      throw new JsoncError('expected "," or "]"', i);
    }
  }

  const root = value();
  skip();
  if (i < n) throw new JsoncError('trailing content', i);
  return root;
}

/** Convert a tree node to a plain JS value. */
export function toValue(node) {
  if (node.type === 'object') {
    const o = {};
    for (const m of node.members) o[m.key] = toValue(m.value);
    return o;
  }
  if (node.type === 'array') return node.elements.map(toValue);
  return node.value;
}

export function parse(text) {
  return toValue(parseTree(text));
}

/** Find the node at `path` (array of keys). Returns undefined when absent. */
export function findNode(root, path) {
  let node = root;
  for (const key of path) {
    if (!node || node.type !== 'object') return undefined;
    // Last duplicate key wins, as in JSON.parse.
    const m = [...node.members].reverse().find((x) => x.key === key);
    if (!m) return undefined;
    node = m.value;
  }
  return node;
}

function findMember(objNode, key) {
  return [...objNode.members].reverse().find((x) => x.key === key);
}

/** Detect the file's indent unit ("  ", "    " or "\t"). */
export function detectIndentUnit(text) {
  const m = /\n([ \t]+)["\]}{[]/.exec(text);
  if (!m) return '  ';
  if (m[1].startsWith('\t')) return '\t';
  return m[1].length >= 4 && m[1].length % 4 === 0 ? '    ' : m[1].length % 2 === 0 ? '  ' : m[1];
}

function lineIndentAt(text, pos) {
  const ls = text.lastIndexOf('\n', pos - 1) + 1;
  const m = /^[ \t]*/.exec(text.slice(ls, pos));
  return m ? m[0] : '';
}

function serialize(value, indent, unit) {
  const s = JSON.stringify(value, null, unit);
  return s.split('\n').map((line, idx) => (idx === 0 ? line : indent + line)).join('\n');
}

/** Layout used when inserting after the last child of a container node. */
function containerLayout(text, node, unit) {
  const children = node.type === 'object' ? node.members : node.elements;
  const containerIndent = lineIndentAt(text, node.start);
  if (children.length === 0) {
    return { empty: true, childIndent: containerIndent + unit, containerIndent, multiline: true };
  }
  const first = children[0];
  const firstStart = node.type === 'object' ? first.keyStart : first.start;
  const between = text.slice(node.start + 1, firstStart);
  const multiline = between.includes('\n');
  const last = children[children.length - 1];
  const lastStart = node.type === 'object' ? last.keyStart : last.start;
  const childIndent = multiline ? lineIndentAt(text, lastStart) : '';
  return { empty: false, multiline, childIndent, containerIndent };
}

/**
 * Insert `key: value` as the last member of the object at `path`.
 * Returns { text, edit } where edit records what is needed for an exact revert.
 */
export function insertMember(text, path, key, value) {
  const root = parseTree(text);
  const node = findNode(root, path);
  if (!node || node.type !== 'object') throw new JsoncError(`not an object: ${path.join('.') || '<root>'}`);
  if (findMember(node, key)) throw new JsoncError(`member already exists: ${[...path, key].join('.')}`);
  const unit = detectIndentUnit(text);
  const lay = containerLayout(text, node, unit);
  let at;
  let ins;
  const emptyInner = lay.empty ? text.slice(node.start + 1, node.end - 1) : undefined;
  if (lay.empty) {
    at = node.start + 1;
    ins = `\n${lay.childIndent}${JSON.stringify(key)}: ${serialize(value, lay.childIndent, unit)}\n${lay.containerIndent}`;
    // Replace the (whitespace/comment) inner text entirely; revert restores it verbatim.
    return {
      text: text.slice(0, at) + ins + text.slice(node.end - 1),
      edit: { op: 'insertMember', path, key, value, emptyInner },
    };
  }
  const last = node.members[node.members.length - 1];
  at = last.value.end;
  const sep = lay.multiline ? `\n${lay.childIndent}` : ' ';
  ins = `,${sep}${JSON.stringify(key)}: ${serialize(value, lay.childIndent, unit)}`;
  return { text: text.slice(0, at) + ins + text.slice(at), edit: { op: 'insertMember', path, key, value } };
}

/** Remove member `key` from the object at `path`, undoing `insertMember` exactly. */
export function removeMember(text, path, key, { emptyInner } = {}) {
  const root = parseTree(text);
  const node = findNode(root, path);
  if (!node || node.type !== 'object') return { text, removed: false };
  const idx = node.members.findLastIndex((m) => m.key === key);
  if (idx < 0) return { text, removed: false };
  const m = node.members[idx];
  if (node.members.length === 1) {
    const inner = emptyInner ?? '';
    return { text: text.slice(0, node.start + 1) + inner + text.slice(node.end - 1), removed: true };
  }
  if (idx > 0) {
    const from = node.members[idx - 1].value.end;
    return { text: text.slice(0, from) + text.slice(m.value.end), removed: true };
  }
  // First of several (somebody added members after ours): drop through the following comma.
  const next = node.members[1];
  const commaPos = text.indexOf(',', m.value.end);
  const to = commaPos >= 0 && commaPos < next.keyStart ? commaPos + 1 : m.value.end;
  const lead = text.slice(node.start + 1, m.keyStart);
  return { text: text.slice(0, node.start + 1) + lead + text.slice(to).replace(/^[ \t]*\n?[ \t]*/, ''), removed: true };
}

/** Replace the value at `path` (must exist). Returns prior raw text for revert. */
export function replaceValue(text, path, value) {
  const root = parseTree(text);
  const node = findNode(root, path);
  if (!node) throw new JsoncError(`no value at ${path.join('.')}`);
  const unit = detectIndentUnit(text);
  const priorRaw = text.slice(node.start, node.end);
  const raw = serialize(value, lineIndentAt(text, node.start), unit);
  return { text: text.slice(0, node.start) + raw + text.slice(node.end), edit: { op: 'replaceValue', path, value, priorRaw } };
}

/** Restore a raw value text at `path`. */
export function replaceRaw(text, path, raw) {
  const root = parseTree(text);
  const node = findNode(root, path);
  if (!node) throw new JsoncError(`no value at ${path.join('.')}`);
  return text.slice(0, node.start) + raw + text.slice(node.end);
}

/** Append a value to the array at `path`. */
export function appendElement(text, path, value) {
  const root = parseTree(text);
  const node = findNode(root, path);
  if (!node || node.type !== 'array') throw new JsoncError(`not an array: ${path.join('.')}`);
  const unit = detectIndentUnit(text);
  const lay = containerLayout(text, node, unit);
  if (lay.empty) {
    const emptyInner = text.slice(node.start + 1, node.end - 1);
    const ins = `\n${lay.childIndent}${serialize(value, lay.childIndent, unit)}\n${lay.containerIndent}`;
    return {
      text: text.slice(0, node.start + 1) + ins + text.slice(node.end - 1),
      edit: { op: 'appendElement', path, value, emptyInner },
    };
  }
  const last = node.elements[node.elements.length - 1];
  const sep = lay.multiline ? `\n${lay.childIndent}` : ' ';
  const ins = `,${sep}${serialize(value, lay.childIndent, unit)}`;
  return { text: text.slice(0, last.end) + ins + text.slice(last.end), edit: { op: 'appendElement', path, value } };
}

const same = (node, v) => JSON.stringify(toValue(node)) === JSON.stringify(v);

/**
 * Replace the (last) array element deep-equal to `prior` at `path` with `value`,
 * in place. The edit records the slot `index` and the element's ORIGINAL raw text
 * (`priorRaw`, comments and formatting inside it included) so revert puts exactly
 * those bytes back into exactly that slot.
 */
export function replaceElement(text, path, prior, value) {
  const root = parseTree(text);
  const node = findNode(root, path);
  if (!node || node.type !== 'array') throw new JsoncError(`not an array: ${path.join('.')}`);
  const want = JSON.stringify(prior);
  const idx = node.elements.findLastIndex((e) => JSON.stringify(toValue(e)) === want);
  if (idx < 0) throw new JsoncError(`no element ${want} in ${path.join('.')}`);
  const el = node.elements[idx];
  const raw = serialize(value, lineIndentAt(text, el.start), detectIndentUnit(text));
  const priorRaw = text.slice(el.start, el.end);
  return {
    text: text.slice(0, el.start) + raw + text.slice(el.end),
    edit: { op: 'replaceElement', path, value, prior, priorRaw, index: idx },
  };
}

/**
 * Remove the array element at `index` (exactly that slot). The edit records the
 * removed byte span and the neighbour it was attached to, so revert re-inserts the
 * identical bytes, and refuses when that neighbour is no longer where it was.
 */
export function removeArrayElementAt(text, path, index) {
  const root = parseTree(text);
  const node = findNode(root, path);
  if (!node || node.type !== 'array') throw new JsoncError(`not an array: ${path.join('.')}`);
  const el = node.elements[index];
  if (!el) throw new JsoncError(`no element at ${path.join('.')}[${index}]`);
  const prior = toValue(el);
  const base = { op: 'removeElement', path, index, prior, priorRaw: text.slice(el.start, el.end) };
  let from;
  let to;
  let anchor;
  if (node.elements.length === 1) {
    from = el.start;
    to = el.end;
    const t = text.slice(0, from) + text.slice(to);
    // Revert re-inserts at the same offset inside the (then element-less) array.
    return { text: t, edit: { ...base, removedRaw: text.slice(from, to), offset: from - node.start, innerAfter: t.slice(node.start + 1, node.end - 1 - (to - from)) } };
  }
  if (index > 0) {
    const prev = node.elements[index - 1];
    from = prev.end;
    to = el.end;
    anchor = { index: index - 1, raw: text.slice(prev.start, prev.end), side: 'after' };
  } else {
    const next = node.elements[1];
    from = el.start;
    to = next.start;
    anchor = { index: 0, raw: text.slice(next.start, next.end), side: 'before' };
  }
  return { text: text.slice(0, from) + text.slice(to), edit: { ...base, removedRaw: text.slice(from, to), anchor } };
}

function revertRemoveElement(text, root, edit) {
  const node = findNode(root, edit.path);
  const where = `${edit.path.join('.')}[${edit.index}]`;
  if (!node || node.type !== 'array') return { text, status: 'absent', detail: `${edit.path.join('.')} is gone; nothing restored` };
  if (!edit.anchor) {
    const inner = text.slice(node.start + 1, node.end - 1);
    if (node.elements.length || inner !== edit.innerAfter) {
      return { text, status: 'modified', detail: `${edit.path.join('.')} changed since setup; ${JSON.stringify(edit.prior)} not re-added at ${where} (left as is)` };
    }
    const at = node.start + edit.offset;
    return { text: text.slice(0, at) + edit.removedRaw + text.slice(at), status: 'reverted' };
  }
  const a = node.elements[edit.anchor.index];
  if (!a || text.slice(a.start, a.end) !== edit.anchor.raw) {
    return { text, status: 'modified', detail: `${edit.path.join('.')} was reordered or edited since setup; ${JSON.stringify(edit.prior)} not re-added at ${where} (left as is)` };
  }
  const at = edit.anchor.side === 'after' ? a.end : a.start;
  return { text: text.slice(0, at) + edit.removedRaw + text.slice(at), status: 'reverted' };
}

function revertReplaceElement(text, root, edit) {
  const node = findNode(root, edit.path);
  if (!node || node.type !== 'array') return { text, status: 'absent' };
  const has = (v) => node.elements.some((e) => same(e, v));
  if (edit.index === undefined || edit.priorRaw === undefined) {
    // Record written before slot/raw tracking: best-effort semantic revert.
    if (!has(edit.value)) return { text, status: has(edit.prior) ? 'absent' : 'modified' };
    return { text: replaceElement(text, edit.path, edit.value, edit.prior).text, status: 'reverted' };
  }
  const el = node.elements[edit.index];
  if (!el || !same(el, edit.value)) {
    // The recorded slot no longer holds our value (reordered, edited, entries
    // inserted before it). We cannot prove which slot is ours, so touch nothing.
    const where = `${edit.path.join('.')}[${edit.index}]`;
    const n = node.elements.filter((e) => same(e, edit.value)).length;
    const why = n ? `array reordered or edited; ${n} equal entr${n === 1 ? 'y' : 'ies'} elsewhere` : 'it is no longer present';
    return { text, status: n || !has(edit.prior) ? 'modified' : 'absent', detail: `${where} no longer holds ${JSON.stringify(edit.value)} (${why}); left as is` };
  }
  return { text: text.slice(0, el.start) + edit.priorRaw + text.slice(el.end), status: 'reverted' };
}

/** Remove every array element deep-equal to `value` at `path`. */
export function removeElement(text, path, value, { emptyInner } = {}) {
  let removed = 0;
  for (;;) {
    const root = parseTree(text);
    const node = findNode(root, path);
    if (!node || node.type !== 'array') return { text, removed };
    const want = JSON.stringify(value);
    const idx = node.elements.findLastIndex((e) => JSON.stringify(toValue(e)) === want);
    if (idx < 0) return { text, removed };
    const el = node.elements[idx];
    if (node.elements.length === 1) {
      text = text.slice(0, node.start + 1) + (emptyInner ?? '') + text.slice(node.end - 1);
    } else if (idx > 0) {
      text = text.slice(0, node.elements[idx - 1].end) + text.slice(el.end);
    } else {
      const next = node.elements[1];
      const commaPos = text.indexOf(',', el.end);
      const to = commaPos >= 0 && commaPos < next.start ? commaPos + 1 : el.end;
      text = text.slice(0, el.start) + text.slice(to).replace(/^[ \t]*\n?[ \t]*/, '');
    }
    removed++;
  }
}

/**
 * Ensure `path` holds `value` (a leaf), creating intermediate objects as needed.
 * Returns { text, edit } (edit undefined when already equal). The recorded edit
 * reverts exactly: either the created subtree is removed, or the prior raw value
 * is restored.
 */
export function setPath(text, path, value) {
  const root = parseTree(text);
  // Deepest existing prefix.
  let depth = 0;
  let node = root;
  while (depth < path.length) {
    if (node.type !== 'object') {
      throw new JsoncError(`cannot descend into non-object at ${path.slice(0, depth).join('.') || '<root>'}`);
    }
    const m = findMember(node, path[depth]);
    if (!m) break;
    node = m.value;
    depth++;
  }
  if (depth === path.length) {
    if (JSON.stringify(toValue(node)) === JSON.stringify(value)) return { text, edit: undefined };
    return replaceValue(text, path, value);
  }
  if (node.type !== 'object') {
    throw new JsoncError(`cannot descend into non-object at ${path.slice(0, depth).join('.') || '<root>'}`);
  }
  let sub = value;
  for (let k = path.length - 1; k > depth; k--) sub = { [path[k]]: sub };
  return insertMember(text, path.slice(0, depth), path[depth], sub);
}

/**
 * Revert one recorded edit. Returns { text, status, detail? } where status is one
 * of 'reverted', 'absent' (already gone), or 'modified' (user changed our value,
 * or the recorded array slot no longer validates: left alone on purpose; `detail`
 * says why).
 */
export function revertEdit(text, edit) {
  const root = parseTree(text);
  if (edit.op === 'insertMember') {
    const node = findNode(root, [...edit.path, edit.key]);
    if (!node) return { text, status: 'absent' };
    if (JSON.stringify(toValue(node)) !== JSON.stringify(edit.value)) return { text, status: 'modified' };
    return { text: removeMember(text, edit.path, edit.key, { emptyInner: edit.emptyInner }).text, status: 'reverted' };
  }
  if (edit.op === 'replaceValue') {
    const node = findNode(root, edit.path);
    if (!node) return { text, status: 'absent' };
    if (JSON.stringify(toValue(node)) !== JSON.stringify(edit.value)) return { text, status: 'modified' };
    return { text: replaceRaw(text, edit.path, edit.priorRaw), status: 'reverted' };
  }
  if (edit.op === 'appendElement') {
    const r = removeElement(text, edit.path, edit.value, { emptyInner: edit.emptyInner });
    return { text: r.text, status: r.removed ? 'reverted' : 'absent' };
  }
  if (edit.op === 'replaceElement') return revertReplaceElement(text, root, edit);
  if (edit.op === 'removeElement') return revertRemoveElement(text, root, edit);
  throw new JsoncError(`unknown edit op ${edit.op}`);
}
