import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { renderDoc, spliceReadme } from '../scripts/gen-compat.js';
import { guardTargets } from '../src/guard.js';
import { ROOT, makeWorld } from './helpers.js';

const compat = JSON.parse(readFileSync(path.join(ROOT, 'compat.json'), 'utf8'));

test('docs/COMPATIBILITY.md and README block match compat.json', () => {
  assert.equal(readFileSync(path.join(ROOT, 'docs', 'COMPATIBILITY.md'), 'utf8'), renderDoc(compat));
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.equal(spliceReadme(readme, compat), readme);
});

test('compat pin agrees with vendor/package.json and lockfile', () => {
  const v = JSON.parse(readFileSync(path.join(ROOT, 'vendor', 'package.json'), 'utf8'));
  assert.equal(v.dependencies[compat.pin.package], compat.pin.magic_context);
  const lock = JSON.parse(readFileSync(path.join(ROOT, 'vendor', 'package-lock.json'), 'utf8'));
  const e = lock.packages[`node_modules/${compat.pin.package}`];
  assert.equal(e.version, compat.pin.magic_context);
  assert.equal(e.integrity, compat.pin.integrity);
});

test('no hardcoded home paths in shipped source', () => {
  for (const f of ['src/paths.js', 'src/doctor.js', 'src/install.js', 'src/guard.js', 'src/vendor.js', 'src/omo.js', 'src/cli.js']) {
    assert.doesNotMatch(readFileSync(path.join(ROOT, f), 'utf8'), /['"`]\/root\b|\/home\/[a-z]/, f);
  }
});

test('guard units: systemd path+timer watch OMO, Senpi, extension, pin; launchd plist', (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  const s = guardTargets(w.env, 'linux');
  const pathUnit = Object.entries(s.files).find(([f]) => f.endsWith('.path'))[1];
  assert.match(pathUnit, /PathChanged=.*omo-ai\/package\.json/);
  assert.match(pathUnit, /PathChanged=.*senpi\/package\.json/);
  assert.match(pathUnit, /PathChanged=.*pi-magic-context\/package\.json/);
  assert.match(pathUnit, /PathChanged=.*compat\.json/);
  assert.ok(Object.keys(s.files).every((f) => f.startsWith(w.home)));
  const m = guardTargets(w.env, 'darwin');
  assert.match(Object.values(m.files)[0], /<key>WatchPaths<\/key>/);
});
