import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { appendElement, insertMember, parse, revertEdit, setPath } from '../src/jsonc.js';
import { FIX } from './helpers.js';

const omo = readFileSync(path.join(FIX, 'omo.jsonc'), 'utf8');

test('parses JSONC with comments and trailing commas', () => {
  const v = parse(omo);
  assert.equal(v['[native]'].memory.recall.maxItems, 8);
  assert.deepEqual(v['[opencode]'].disabled_hooks, ['context-window-monitor', 'preemptive-compaction']);
});

test('rejects malformed input with an offset', () => {
  assert.throws(() => parse('{ "a": }'), /unexpected token/);
  assert.throws(() => parse('{ "a": 1 /* open'), /unterminated block comment/);
  assert.throws(() => parse('{"a":1} x'), /trailing content/);
});

test('setPath into existing object preserves every comment and unrelated byte', () => {
  const r = setPath(omo, ['[native]', 'memory', 'recall', 'enabled'], false);
  assert.ok(r.edit);
  assert.equal(parse(r.text)['[native]'].memory.recall.enabled, false);
  assert.equal(parse(r.text)['[native]'].memory.recall.maxItems, 8);
  for (const c of ['// OMO Native user config.', '// keep: Magic Context owns the window', '/* The native harness block. */', '// fast lane', '// curated memory stays ON']) {
    assert.ok(r.text.includes(c), `lost comment ${c}`);
  }
  // Only the one literal changed.
  assert.equal(r.text.length, omo.length + 1); // "true" -> "false"
});

test('setPath creates intermediate objects and revert removes them exactly', () => {
  const r = setPath(omo, ['[native]', 'memory', 'facts', 'enabled'], false);
  assert.deepEqual(parse(r.text)['[native]'].memory.facts, { enabled: false });
  const back = revertEdit(r.text, r.edit);
  assert.equal(back.status, 'reverted');
  assert.equal(back.text, omo);
});

test('setPath on equal value is a no-op', () => {
  const once = setPath(omo, ['[native]', 'memory', 'enabled'], true);
  assert.equal(once.edit, undefined);
  assert.equal(once.text, omo);
});

test('insertMember into empty object and revert restores inner whitespace/comments', () => {
  const src = '{\n  "a": { /* keep me */ },\n  "b": 1\n}\n';
  const r = insertMember(src, ['a'], 'x', { y: true });
  assert.deepEqual(parse(r.text).a, { x: { y: true } });
  assert.equal(revertEdit(r.text, r.edit).text, src);
});

test('appendElement on single-line and multi-line arrays round-trips', () => {
  for (const src of ['{"e":["a","b"]}', '{\n  "e": [\n    "a"\n  ]\n}\n', '{\n  "e": []\n}\n']) {
    const r = appendElement(src, ['e'], '/x/y');
    assert.equal(parse(r.text).e.at(-1), '/x/y');
    assert.equal(revertEdit(r.text, r.edit).text, src);
  }
});

test('revert leaves a value the user changed afterwards alone', () => {
  const r = setPath(omo, ['[native]', 'memory', 'facts', 'enabled'], false);
  const userEdited = setPath(r.text, ['[native]', 'memory', 'facts', 'enabled'], true).text;
  const back = revertEdit(userEdited, r.edit);
  assert.equal(back.status, 'modified');
  assert.equal(back.text, userEdited);
});

test('revert of replaceValue restores the original raw text', () => {
  const src = '{\n  "c": { "enabled": true , "n": 1 }\n}';
  const r = setPath(src, ['c', 'enabled'], false);
  assert.equal(r.edit.priorRaw, 'true');
  assert.equal(revertEdit(r.text, r.edit).text, src);
});

test('refuses to descend into non-objects', () => {
  assert.throws(() => setPath('{"a": [1]}', ['a', 'b'], 1), /non-object/);
});

test('tab-indented files keep tabs', () => {
  const src = '{\n\t"a": {\n\t\t"b": 1\n\t}\n}\n';
  const r = setPath(src, ['a', 'c', 'd'], false);
  assert.match(r.text, /\n\t\t"c": \{\n\t\t\t"d": false\n\t\t\}/);
});
