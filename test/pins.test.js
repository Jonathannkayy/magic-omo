// Multi-pin behaviour: selectPin() decision table, and the setup -> peers move ->
// setup -> uninstall round trip that must restore the ORIGINAL settings file.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.js';
import { COMPAT, defaultPin, pinFor } from '../src/compat.js';
import { allPaths } from '../src/paths.js';
import { selectPin } from '../src/pins.js';
import { capture, makeWorld, sortedKeys } from './helpers.js';

const P44 = pinFor('0.44.4');
const P43 = pinFor('0.43.2');
const oc = (version) => ({ openCode: [{ version, series: version.replace(/^(\d+\.\d+).*/, '$1'), via: 'test' }] });

async function cli(argv, w) {
  const io = capture();
  const code = await main(argv, { env: w.env, ...io });
  return { code, ...io.chunks };
}

test('selectPin: explicit override wins, unknown version is an error', () => {
  assert.equal(selectPin({}, oc('0.43.2'), { override: '0.44.4' }).pin, P44);
  assert.equal(selectPin({ MAGIC_OMO_MC_VERSION: '0.44.4' }, oc('0.43.2')).pin, P44);
  assert.equal(selectPin({}, {}, { override: '0.99.0' }).error, 'unknown-pin');
});

test('selectPin: follows the peers, and the recorded pin while peers agree', () => {
  const a = selectPin({}, oc('0.43.9'));
  assert.equal(a.pin, P43);
  assert.match(a.reason, /OpenCode/);
  assert.equal(selectPin({}, oc('0.44.0')).pin, P44);
  // Recorded pin is kept when nothing contradicts it...
  assert.equal(selectPin({}, {}, { record: { magic_context: '0.44.4' } }).pin, P44);
  // ...but the peers win when they moved to another series.
  assert.equal(selectPin({}, oc('0.43.2'), { record: { magic_context: '0.44.4' } }).pin, P43);
});

test('selectPin: peers that disagree are an error naming who runs what', () => {
  const peers = { openCode: [{ version: '0.44.1', series: '0.44', via: 'npm spec' }], hermes: { series: '0.43', file: '/x/compat.json' } };
  const r = selectPin({}, peers);
  assert.equal(r.error, 'peers-disagree');
  assert.match(r.detail, /OpenCode runs 0\.44/);
  assert.match(r.detail, /magic-hermes runs 0\.43/);
});

test('selectPin: a peer series magic-omo does not pin is an error, not a silent downgrade', () => {
  const r = selectPin({}, oc('0.42.0'));
  assert.equal(r.error, 'no-pin-for-peers');
  assert.match(r.detail, /0\.42/);
});

test('selectPin: the database decides when there is no peer', () => {
  assert.equal(selectPin({}, { dbSchema: 90 }).pin, P43);
  assert.equal(selectPin({}, { dbSchema: 91 }).pin, P44);
  assert.equal(selectPin({}, { dbSchema: 85 }).pin, P43, 'oldest pin that can open it');
  assert.equal(selectPin({}, { dbSchema: 999 }).error, 'db-newer-than-every-pin');
  // Peers pick the series, but a database beyond that pin's fence is still refused.
  assert.equal(selectPin({}, { ...oc('0.43.2'), dbSchema: 91 }).error, 'db-newer-than-pin');
});

test('selectPin: no peers and no database falls back to default_pin', () => {
  const r = selectPin({}, {});
  assert.equal(r.pin, defaultPin());
  assert.equal(r.pin.magic_context, COMPAT.default_pin);
  assert.match(r.reason, /default_pin/);
});

test('setup 0.43.2, peers move to 0.44, setup again, uninstall => original settings.json byte-identical', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  const s0 = readFileSync(w.settingsFile, 'utf8');

  assert.equal((await cli(['setup', '--yes'], w)).code, 0);
  const ext43 = allPaths(w.env, '0.43.2').extension;
  assert.ok(JSON.parse(readFileSync(w.settingsFile, 'utf8')).extensions.includes(ext43));

  // OpenCode upgrades to the 0.44 series.
  mkdirSync(path.join(w.home, '.config', 'opencode'), { recursive: true });
  writeFileSync(path.join(w.home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ plugin: ['@cortexkit/opencode-magic-context@0.44.1'] }));

  const r2 = await cli(['setup', '--yes'], w);
  assert.equal(r2.code, 0, r2.out + r2.err);
  assert.match(r2.out, /pin: Magic Context 0\.44\.4/);
  const ext44 = allPaths(w.env, '0.44.4').extension;
  const after = JSON.parse(readFileSync(w.settingsFile, 'utf8'));
  assert.ok(after.extensions.includes(ext44), 'new pin path installed');
  assert.ok(!after.extensions.includes(ext43), 'old pin path swapped out');
  assert.equal(JSON.parse(readFileSync(allPaths(w.env).record, 'utf8')).magic_context, '0.44.4');

  const u = await cli(['uninstall', '--yes'], w);
  assert.equal(u.code, 0, u.out + u.err);
  assert.deepEqual(sortedKeys(JSON.parse(readFileSync(w.settingsFile, 'utf8'))), sortedKeys(JSON.parse(s0)));
  assert.equal(readFileSync(w.settingsFile, 'utf8'), s0, 'settings.json is byte-identical to the pre-install file');
});

test('setup --prune deletes the other vendored runtimes; without it they are kept', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  assert.equal((await cli(['setup', '--yes'], w)).code, 0);
  const r2 = await cli(['setup', '--yes', '--mc', '0.44.4'], w);
  assert.equal(r2.code, 0, r2.out + r2.err);
  assert.match(r2.out, /other vendored runtimes kept: 0\.43\.2/);
  const { vendoredVersions } = await import('../src/paths.js');
  assert.deepEqual(vendoredVersions(w.env).sort(), ['0.43.2', '0.44.4']);
  const r3 = await cli(['setup', '--yes', '--mc', '0.44.4', '--prune'], w);
  assert.equal(r3.code, 0, r3.out + r3.err);
  assert.deepEqual(vendoredVersions(w.env), ['0.44.4']);
});

test('magic-omo pins lists every pin and its combinations', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  const j = await cli(['pins', '--json'], w);
  assert.equal(j.code, 0);
  const parsed = JSON.parse(j.out);
  assert.deepEqual(parsed.pins.map((p) => p.magic_context), COMPAT.pins.map((p) => p.magic_context));
  assert.equal(parsed.default_pin, COMPAT.default_pin);
  assert.ok(parsed.pins.every((p) => Array.isArray(p.combinations)));
  const h = await cli(['pins'], w);
  assert.match(h.out, /0\.44\.4\s+schema fence v91/);
  assert.match(h.out, /\(default\)/);
});

test('doctor FAILs with a clear explanation when the peers disagree', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  mkdirSync(path.join(w.home, '.config', 'opencode'), { recursive: true });
  writeFileSync(path.join(w.home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ plugin: ['@cortexkit/opencode-magic-context@0.44.1'] }));
  mkdirSync(path.dirname(w.env.MAGIC_OMO_HERMES_COMPAT), { recursive: true });
  writeFileSync(w.env.MAGIC_OMO_HERMES_COMPAT, JSON.stringify({ supported_series: [0, 43] }));
  const d = await cli(['doctor', '--json'], w);
  assert.equal(d.code, 1);
  const rep = JSON.parse(d.out);
  const pin = rep.checks.find((c) => c.id === 'pin');
  assert.equal(pin.status, 'FAIL');
  assert.match(pin.detail, /do not agree on a series/);
  assert.match(pin.detail, /OpenCode runs 0\.44/);
  assert.match(pin.detail, /magic-hermes runs 0\.43/);
  // setup refuses rather than guessing.
  const s = await cli(['setup', '--yes'], w);
  assert.equal(s.code, 2);
  assert.match(s.err, /do not agree on a series/);
});
