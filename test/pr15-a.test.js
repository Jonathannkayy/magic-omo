// Regressions for PR #15 review findings: pin selection with unknown peers or an
// unreadable database, doctor liveness/duplicates across every runtime path, the
// legacy flat vendor layout, vendorOk strictness, CLI value flags, status output
// after a failed selection, and install-record metadata persistence.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main, parseArgs } from '../src/cli.js';
import { pinFor } from '../src/compat.js';
import { runDoctor } from '../src/doctor.js';
import { planSettings } from '../src/edits.js';
import { guardRun } from '../src/guard.js';
import { readRecord } from '../src/install.js';
import * as P from '../src/paths.js';
import { allPaths, extensionDir, vendoredVersions, vendorRoot } from '../src/paths.js';
import { collectPeers, selectPin } from '../src/pins.js';
import { vendorOk, verifyVendor } from '../src/vendor.js';
import { capture, makeWorld, PIN } from './helpers.js';

const OTHER = pinFor('0.44.4');
const byId = (r, id) => r.checks.filter((c) => c.id === id);
const nullStream = { write: () => true };

async function cli(argv, w, env = w.env) {
  const io = capture();
  const code = await main(argv, { env, ...io });
  return { code, ...io.chunks };
}

function makePeersDisagree(w) {
  mkdirSync(path.join(w.home, '.config', 'opencode'), { recursive: true });
  writeFileSync(path.join(w.home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ plugin: ['@cortexkit/opencode-magic-context@0.43.2'] }));
  mkdirSync(path.dirname(w.env.MAGIC_OMO_HERMES_COMPAT), { recursive: true });
  writeFileSync(w.env.MAGIC_OMO_HERMES_COMPAT, JSON.stringify({ supported_series: [0, 44] }));
}

const exts = (w) => JSON.parse(readFileSync(w.settingsFile, 'utf8')).extensions;

// -- 1. doctor liveness must not depend on pin selection succeeding (src/doctor.js:75)
test('pr15 #1: a loaded non-default runtime stays live when pin selection fails; guard auto-uninstalls', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  const original = readFileSync(w.settingsFile, 'utf8');
  assert.equal((await cli(['setup', '--yes', '--mc', OTHER.magic_context, '--no-todowrite'], w)).code, 0);
  assert.ok(exts(w).includes(extensionDir(w.env, OTHER.magic_context)));
  makePeersDisagree(w);
  const r = await runDoctor({ env: w.env });
  assert.equal(r.pin_error, 'peers-disagree');
  assert.equal(r.pin, null, 'the DEFAULT_PIN stand-in is not reported as selected');
  assert.equal(r.live, true, 'the 0.44.4 runtime OMO loads is live regardless of selection');
  assert.deepEqual(r.live_paths, [extensionDir(w.env, OTHER.magic_context)]);
  const g = await guardRun(w.env, { stderr: nullStream });
  assert.match(g.action, /auto-uninstalled/);
  assert.equal(readFileSync(w.settingsFile, 'utf8'), original);
});

// -- 2. selected + alternate runtime both in extensions[] is a hard duplicate (src/doctor.js:182)
test('pr15 #2: selected and alternate runtime both loaded => hard FAIL; alternate alone => pending swap', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  assert.equal((await cli(['setup', '--yes', '--mc', OTHER.magic_context, '--no-todowrite'], w)).code, 0);
  assert.equal((await cli(['setup', '--yes', '--mc', PIN.magic_context, '--no-todowrite'], w)).code, 0);
  assert.deepEqual(vendoredVersions(w.env).sort(), [PIN.magic_context, OTHER.magic_context].sort());
  const s = JSON.parse(readFileSync(w.settingsFile, 'utf8'));
  assert.ok(s.extensions.includes(allPaths(w.env, PIN.magic_context).extension));
  assert.ok(!s.extensions.includes(extensionDir(w.env, OTHER.magic_context)), 'setup swapped the entry');

  // Stale alternate while the selected one is NOT loaded: only a pending swap.
  const onlyOther = { ...s, extensions: s.extensions.map((e) => (e === allPaths(w.env, PIN.magic_context).extension ? extensionDir(w.env, OTHER.magic_context) : e)) };
  writeFileSync(w.settingsFile, JSON.stringify(onlyOther, null, 2));
  const r0 = await runDoctor({ env: w.env });
  assert.equal(byId(r0, 'pin-swap')[0]?.status, 'WARN');
  assert.equal(byId(r0, 'pin-duplicate').length, 0);
  assert.equal(byId(r0, 'double-load').length, 0);

  // Both loaded: OMO would run Magic Context twice.
  s.extensions.push(extensionDir(w.env, OTHER.magic_context));
  writeFileSync(w.settingsFile, JSON.stringify(s, null, 2));
  const r = await runDoctor({ env: w.env });
  const dup = byId(r, 'pin-duplicate')[0];
  assert.equal(dup?.status, 'FAIL');
  assert.equal(dup.hard, true);
  assert.equal(r.ok, false);
  assert.match((await guardRun(w.env, { stderr: nullStream })).action, /auto-uninstalled/);
});

// -- 3. upgrade from the pre-multi-pin flat vendor layout (src/vendor.js:37)
test('pr15 #3: setup migrates the legacy flat vendor path as a recorded, revertible swap', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  const original = readFileSync(w.settingsFile, 'utf8');
  // What the previous release left behind: <home>/vendor/node_modules/<pkg>, an
  // appendElement in settings and a record naming that path.
  const legacy = P.legacyExtensionDir(w.env);
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, 'package.json'), JSON.stringify({ name: '@cortexkit/pi-magic-context', version: '0.43.2' }));
  writeFileSync(path.join(vendorRoot(w.env), 'SHA256SUMS'), '');
  const old = planSettings(original, legacy);
  writeFileSync(w.settingsFile, old.text);
  const paths = allPaths(w.env);
  mkdirSync(path.dirname(paths.record), { recursive: true });
  writeFileSync(paths.record, JSON.stringify({
    tool: 'magic-omo', tool_version: '0.1.0', magic_context: '0.43.2', agent_dir: paths.agentDir, extension: legacy,
    installed_at: '2026-10-01T00:00:00.000Z',
    files: [{ role: 'settings', file: w.settingsFile, created: false, edits: old.edits, backups: [] }],
  }, null, 2));
  assert.ok(!vendoredVersions(w.env).includes('node_modules'), 'the flat layout is not a version');

  const pre = await runDoctor({ env: w.env, fullVendor: false });
  assert.equal(byId(pre, 'double-load').length, 0, 'the legacy path is ours, not a foreign loader');
  assert.equal(pre.live, true);

  const res = await cli(['setup', '--yes', '--no-todowrite'], w);
  assert.equal(res.code, 0, res.err);
  const now = exts(w);
  assert.ok(now.includes(allPaths(w.env, PIN.magic_context).extension));
  assert.ok(!now.includes(legacy), 'legacy entry replaced, not left as a second loader');
  const rec = readRecord(paths);
  assert.equal(rec.extension, allPaths(w.env, PIN.magic_context).extension);
  assert.ok(rec.files[0].edits.some((e) => e.op === 'replaceElement' && e.prior === legacy));

  assert.equal((await cli(['uninstall', '--yes'], w)).code, 0);
  assert.equal(readFileSync(w.settingsFile, 'utf8'), original, 'uninstall restores the pre-magic-omo file');
});

test('pr15 #3: record-less uninstall also removes the legacy flat path', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  const original = readFileSync(w.settingsFile, 'utf8');
  writeFileSync(w.settingsFile, planSettings(original, P.legacyExtensionDir(w.env)).text);
  const r = await cli(['uninstall', '--yes'], w);
  assert.equal(r.code, 0);
  assert.match(r.out, /reverted-without-record/);
  assert.ok(!exts(w).includes(P.legacyExtensionDir(w.env)));
});

// -- 4. vendorOk requires a positive, full verification (src/vendor.js:73)
test('pr15 #4: vendorOk rejects zero-file and partial (full:false) verification', async (t) => {
  const ok = { present: true, pin: '0.43.2', version: '0.43.2', lockOk: true };
  assert.equal(vendorOk({ ...ok, sums: { checked: 3, bad: [], missing: [] } }), true);
  assert.equal(vendorOk({ ...ok, sums: { checked: 0, bad: [], missing: [] } }), false, 'empty manifest');
  assert.equal(vendorOk({ ...ok }), false, 'full:false leaves sums undefined');
  assert.equal(vendorOk({ ...ok, sums: { missingManifest: true } }), false);

  const w = makeWorld();
  t.after(w.cleanup);
  assert.equal((await cli(['setup', '--yes', '--no-todowrite'], w)).code, 0);
  assert.equal(vendorOk(verifyVendor(w.env, PIN, { full: true })), true);
  assert.equal(vendorOk(verifyVendor(w.env, PIN, { full: false })), false);
  writeFileSync(path.join(allPaths(w.env, PIN.magic_context).vendor, 'SHA256SUMS'), '');
  assert.equal(vendorOk(verifyVendor(w.env, PIN, { full: true })), false);
  const again = await cli(['setup', '--yes', '--dry-run', '--no-todowrite'], w);
  assert.match(again.out, /would install/, 'an empty manifest is not "already installed and verified"');
});

// -- 5. an OpenCode entry of unknown version is not "no OpenCode" (src/pins.js:32)
test('pr15 #5: undetectable OpenCode Magic Context version fails selection unless --mc is given', async (t) => {
  const unknown = { openCode: [{ entry: '@cortexkit/opencode-magic-context', version: undefined, series: undefined, via: 'unversioned' }] };
  const r = selectPin({}, unknown);
  assert.equal(r.error, 'peer-version-unknown');
  assert.match(r.detail, /--mc/);
  assert.equal(selectPin({}, { openCode: [{ file: '/x/opencode.json', error: 'unparseable' }] }).error, 'peer-version-unknown');
  const forced = selectPin({}, unknown, { override: OTHER.magic_context });
  assert.equal(forced.pin, OTHER);
  assert.match(forced.warnings.join(' '), /unknown series/);

  const w = makeWorld();
  t.after(w.cleanup);
  mkdirSync(path.join(w.home, '.config', 'opencode'), { recursive: true });
  writeFileSync(path.join(w.home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ plugin: ['@cortexkit/opencode-magic-context'] }));
  const refused = await cli(['setup', '--yes', '--no-todowrite'], w);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /peer-version-unknown|cannot tell which Magic Context series/);
  assert.match(refused.err, /--mc/);
  const ok = await cli(['setup', '--yes', '--no-todowrite', '--mc', PIN.magic_context], w);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.err, /WARNING: .*unknown series/);
});

// -- 6. an existing but uninspectable database is not a fresh machine (src/pins.js:121)
test('pr15 #6: a skipped/failed schema probe refuses selection; --mc proceeds with a warning', async (t) => {
  assert.equal(collectPeers({}, { db: { missing: true } }).dbProblem, undefined);
  assert.equal(collectPeers({}, { db: { version: 91, via: 'x' } }).dbSchema, 91);
  const skipped = collectPeers({}, { db: { skipped: 'no node:sqlite and no sqlite3 binary' } });
  assert.equal(selectPin({}, skipped).error, 'db-unreadable');
  assert.equal(selectPin({}, collectPeers({}, { db: { error: 'file is not a database', via: 'node:sqlite' } })).error, 'db-unreadable');
  assert.equal(selectPin({}, skipped, { record: { magic_context: PIN.magic_context } }).error, 'db-unreadable', 'a record does not vouch for the DB');
  assert.match(selectPin({}, skipped, { override: PIN.magic_context }).warnings[0], /not inspected/);

  const w = makeWorld();
  t.after(w.cleanup);
  const dir = path.join(w.home, '.local', 'share', 'cortexkit', 'magic-context');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'context.db'), 'not inspected');
  const env = { ...w.env, MAGIC_OMO_SQLITE: 'none' };
  const refused = await cli(['setup', '--yes', '--no-todowrite'], w, env);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /could not be inspected/);
  assert.equal(readRecord(allPaths(env)), undefined, 'nothing installed');
  const r = await runDoctor({ env });
  assert.equal(byId(r, 'pin')[0].status, 'FAIL');
  const forced = await cli(['setup', '--yes', '--no-todowrite', '--mc', PIN.magic_context], w, env);
  assert.equal(forced.code, 0, forced.err);
  assert.match(forced.err, /WARNING: the shared context\.db exists but was not inspected/);
});

// -- 7. value flags must have a value (src/cli.js:57)
test('pr15 #7: --mc without a value is a usage error, never a silent fallback', async (t) => {
  assert.throws(() => parseArgs(['setup', '--mc']), /--mc needs a value/);
  assert.throws(() => parseArgs(['setup', '--mc', '--yes']), /--mc needs a value/);
  assert.throws(() => parseArgs(['setup', '--mc', '-y']), /--mc needs a value/);
  assert.throws(() => parseArgs(['setup', '--mc=']), /--mc needs a value/);
  assert.equal(parseArgs(['setup', '--mc', '0.44.4']).flags.mc, '0.44.4');
  assert.equal(parseArgs(['setup', '--mc=0.44.4', '--yes']).flags.mc, '0.44.4');

  const w = makeWorld();
  t.after(w.cleanup);
  const r = await cli(['setup', '--mc', '--yes'], w);
  assert.equal(r.code, 2);
  assert.match(r.err, /--mc needs a value/);
  assert.equal(readRecord(allPaths(w.env)), undefined, 'nothing installed');
});

// -- 8. status must not present the fallback as the selected pin (src/cli.js:189)
test('pr15 #8: status shows pin_error instead of the DEFAULT_PIN fallback', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  makePeersDisagree(w);
  const j = await cli(['status', '--json'], w);
  const s = JSON.parse(j.out);
  assert.equal(s.magic_context, null);
  assert.equal(s.pin_error, 'peers-disagree');
  assert.match(s.pin_error_detail, /do not agree/);
  const h = await cli(['status'], w);
  assert.match(h.out, /selected Magic Context: NONE — pin selection failed \(peers-disagree\)/);
  assert.doesNotMatch(h.out, new RegExp(`selected Magic Context: ${PIN.magic_context.replace(/\./g, '\\.')}`));
  const d = await cli(['doctor'], w);
  assert.match(d.out, /NO Magic Context pin selected \(peers-disagree\)/);
});

// -- 9. record metadata persists even without config edits (src/install.js:79)
test('pr15 #9: the selected pin is written to the record when no config file changes', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  assert.equal((await cli(['setup', '--yes', '--no-todowrite'], w)).code, 0);
  const paths = allPaths(w.env);
  const rec = readRecord(paths);
  // The record names another pin, but the selected runtime is already in extensions[].
  writeFileSync(paths.record, JSON.stringify({ ...rec, magic_context: OTHER.magic_context, extension: extensionDir(w.env, OTHER.magic_context) }, null, 2));
  const r = await cli(['setup', '--yes', '--no-todowrite', '--mc', PIN.magic_context], w);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Configuration already in place/);
  const after = readRecord(paths);
  assert.equal(after.magic_context, PIN.magic_context);
  assert.equal(after.extension, allPaths(w.env, PIN.magic_context).extension);
  assert.deepEqual(after.files, rec.files, 'edits untouched');
});
