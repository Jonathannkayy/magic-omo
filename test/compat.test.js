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

test('every pin agrees with its vendor manifests, newest first, default_pin exists', () => {
  assert.ok(compat.pins.length >= 1);
  for (const pin of compat.pins) {
    const dir = path.join(ROOT, path.dirname(pin.lockfile));
    const v = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(v.dependencies[pin.package], pin.magic_context, pin.magic_context);
    const lock = JSON.parse(readFileSync(path.join(ROOT, pin.lockfile), 'utf8'));
    const e = lock.packages[`node_modules/${pin.package}`];
    assert.equal(e.version, pin.magic_context);
    assert.equal(e.integrity, pin.integrity);
  }
  const sorted = [...compat.pins].sort((a, b) => cmpVersion(b.magic_context, a.magic_context));
  assert.deepEqual(compat.pins.map((p) => p.magic_context), sorted.map((p) => p.magic_context), 'pins must be newest first');
  assert.ok(compat.pins.some((p) => p.magic_context === compat.default_pin), 'default_pin must be one of the pins');
  // Every matrix row belongs to a pin and repeats that pin's fence.
  for (const r of compat.matrix) {
    const pin = compat.pins.find((p) => p.magic_context === r.magic_context);
    assert.ok(pin, `matrix row for unpinned ${r.magic_context}`);
    assert.equal(r.schema_fence, pin.schema_fence);
  }
});

function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

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
