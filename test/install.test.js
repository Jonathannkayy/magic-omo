import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.js';
import { parse } from '../src/jsonc.js';
import { applySetup, planSetup, uninstall } from '../src/install.js';
import { allPaths } from '../src/paths.js';
import { capture, makeWorld, snapshot, sortedKeys } from './helpers.js';

async function cli(argv, w) {
  const io = capture();
  const code = await main(argv, { env: w.env, ...io });
  return { code, ...io.chunks };
}

test('setup --yes then uninstall --yes: settings.json sorted-key identical, omo.jsonc byte identical', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  const s0 = readFileSync(w.settingsFile, 'utf8');
  const o0 = readFileSync(w.omoConfigFile, 'utf8');
  const m0 = readFileSync(w.mcConfigFile, 'utf8');

  const r = await cli(['setup', '--yes'], w);
  assert.equal(r.code, 0, r.out + r.err);
  const p = allPaths(w.env);
  const s1 = JSON.parse(readFileSync(w.settingsFile, 'utf8'));
  assert.ok(s1.extensions.includes(p.extension));
  assert.deepEqual(s1.compaction, { enabled: true, summarizationMaxDurationMs: 1500000 }, 'native compaction untouched (resume recovery path) and siblings preserved');
  const o1 = parse(readFileSync(w.omoConfigFile, 'utf8'));
  for (const k of ['facts', 'recall', 'nudge', 'reflection', 'dream']) assert.equal(o1['[native]'].memory[k].enabled, false);
  assert.equal(o1['[native]'].memory.enabled, true, 'curated memory master switch untouched');
  assert.equal(o1['[native]'].memory.recall.maxItems, 8, 'existing recall object merged, not replaced');
  assert.ok(o1['[native]'].categories.quick, '[native] not replaced');
  assert.ok(readFileSync(w.omoConfigFile, 'utf8').includes('// curated memory stays ON'));
  assert.equal(readFileSync(w.mcConfigFile, 'utf8'), m0, '--yes never touches the shared MC config');

  const u = await cli(['uninstall', '--yes'], w);
  assert.equal(u.code, 0, u.out + u.err);
  assert.deepEqual(sortedKeys(JSON.parse(readFileSync(w.settingsFile, 'utf8'))), sortedKeys(JSON.parse(s0)));
  assert.equal(readFileSync(w.settingsFile, 'utf8'), s0, 'settings.json is even byte-identical');
  assert.equal(readFileSync(w.omoConfigFile, 'utf8'), o0, 'omo.jsonc comment-identical');
  assert.ok(!existsSync(p.record), 'record retired');
});

test('uninstall is surgical: keeps keys OMO rewrote after setup', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  assert.equal((await cli(['setup', '--yes'], w)).code, 0);
  // Simulate OMO rewriting settings.json (re-serialised, new tips, new model).
  const s = JSON.parse(readFileSync(w.settingsFile, 'utf8'));
  s.tipsHistory.shown.push('tip-c');
  s.defaultModel = 'claude-sonnet-5-5';
  writeFileSync(w.settingsFile, `${JSON.stringify(s, null, 2)}\n`);
  assert.equal((await cli(['uninstall', '--yes'], w)).code, 0);
  const after = JSON.parse(readFileSync(w.settingsFile, 'utf8'));
  assert.deepEqual(after.tipsHistory.shown, ['tip-a', 'tip-b', 'tip-c']);
  assert.equal(after.defaultModel, 'claude-sonnet-5-5');
  assert.equal(after.compaction.enabled, true);
  assert.ok(!('extensions' in after));
});

test('setup is idempotent: second run changes nothing', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  assert.equal((await cli(['setup', '--yes'], w)).code, 0);
  const snap1 = snapshot(w.home);
  const r = await cli(['setup', '--yes'], w);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /already installed and verified/);
  assert.match(r.out, /nothing to change/);
  const snap2 = snapshot(w.home);
  for (const k of Object.keys(snap1)) {
    if (k.includes('magic-omo') && !k.includes('vendor')) continue; // record timestamps may not change either, but allow
    assert.deepEqual(snap2[k], snap1[k], `changed on second run: ${k}`);
  }
  assert.deepEqual(Object.keys(snap2).sort(), Object.keys(snap1).sort(), 'no new files');
});

test('--dry-run writes nothing anywhere (full fs snapshot)', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  const before = snapshot(w.base);
  const r = await cli(['setup', '--dry-run'], w);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /Dry run complete/);
  assert.match(r.out, /\+ add extensions = /);
  assert.deepEqual(snapshot(w.base), before);
});

test('uninstall --dry-run writes nothing', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  await cli(['setup', '--yes'], w);
  const before = snapshot(w.base);
  const r = await cli(['uninstall', '--dry-run'], w);
  assert.equal(r.code, 0);
  assert.deepEqual(snapshot(w.base), before);
});

test('--keep-omo-memory leaves omo.jsonc untouched', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  const o0 = readFileSync(w.omoConfigFile, 'utf8');
  assert.equal((await cli(['setup', '--yes', '--keep-omo-memory'], w)).code, 0);
  assert.equal(readFileSync(w.omoConfigFile, 'utf8'), o0);
});

test('--todowrite edits the shared MC config with backup and uninstall reverts it', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  const m0 = readFileSync(w.mcConfigFile, 'utf8');
  assert.equal((await cli(['setup', '--yes', '--todowrite'], w)).code, 0);
  assert.equal(parse(readFileSync(w.mcConfigFile, 'utf8')).todowrite.enabled, false);
  assert.ok(readFileSync(w.mcConfigFile, 'utf8').includes('// Shared Magic Context config'));
  const p = allPaths(w.env);
  const backups = readdirSync(path.join(p.magicOmoHome, 'backups'));
  const files = backups.flatMap((d) => readdirSync(path.join(p.magicOmoHome, 'backups', d)));
  assert.ok(files.some((f) => f.startsWith('mc-todowrite-')), 'backup of shared config taken');
  assert.equal((await cli(['uninstall', '--yes'], w)).code, 0);
  assert.equal(readFileSync(w.mcConfigFile, 'utf8'), m0);
});

test('missing settings/omo config: setup creates them and uninstall leaves equivalent empty objects', async (t) => {
  const w = makeWorld({ settings: null, omoConfig: null });
  t.after(w.cleanup);
  assert.equal((await cli(['setup', '--yes'], w)).code, 0);
  const s = JSON.parse(readFileSync(w.settingsFile, 'utf8'));
  assert.equal(s.compaction, undefined, 'setup never writes a compaction block');
  assert.ok(s.extensions.length === 1);
  assert.equal((await cli(['uninstall', '--yes'], w)).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(w.settingsFile, 'utf8')), {});
  assert.deepEqual(parse(readFileSync(w.omoConfigFile, 'utf8')), {});
});

test('atomic writes preserve file mode', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  chmodSync(w.settingsFile, 0o640);
  await cli(['setup', '--yes'], w);
  assert.equal(statSync(w.settingsFile).mode & 0o777, 0o640);
});

test('setup verifies the pinned integrity and refuses a mismatch before touching OMO', async (t) => {
  const w = makeWorld({ integrity: 'sha512-AAAA' });
  t.after(w.cleanup);
  const s0 = readFileSync(w.settingsFile, 'utf8');
  const r = await cli(['setup', '--yes'], w);
  assert.equal(r.code, 1);
  assert.match(r.err, /integrity mismatch/);
  assert.equal(readFileSync(w.settingsFile, 'utf8'), s0);
});

test('npm is invoked with --ignore-scripts --save-exact for the exact pin', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  await cli(['setup', '--yes'], w);
  const calls = readFileSync(path.join(w.base, 'npm-calls.log'), 'utf8');
  assert.match(calls, /install --ignore-scripts --save-exact .*@cortexkit\/pi-magic-context@0\.43\.2/);
});

test('install record merges later additions; uninstall without record removes only our path', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  await cli(['setup', '--yes'], w);
  await cli(['setup', '--yes', '--todowrite'], w);
  const p = allPaths(w.env);
  const rec = JSON.parse(readFileSync(p.record, 'utf8'));
  assert.deepEqual(rec.files.map((f) => f.role).sort(), ['mc-todowrite', 'omo-memory', 'settings']);
  // Lose the record: uninstall falls back to removing just the extension path.
  writeFileSync(p.record + '.lost', readFileSync(p.record));
  const fs = await import('node:fs');
  fs.rmSync(p.record);
  const res = uninstall(w.env);
  assert.equal(res.status, 'reverted-without-record');
  const s = JSON.parse(readFileSync(w.settingsFile, 'utf8'));
  assert.ok(!(s.extensions ?? []).includes(p.extension));
});

test('applySetup refuses if the file changed between plan and apply', (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  const plan = planSetup(w.env);
  writeFileSync(w.settingsFile, readFileSync(w.settingsFile, 'utf8').replace('"dark"', '"light"'));
  assert.throws(() => applySetup(plan, w.env), /changed while planning/);
});

test('setup refuses when the shared DB schema is newer than the fence', { skip: !process.features?.typescript && false }, async (t) => {
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch {
    t.skip('node:sqlite unavailable');
    return;
  }
  const w = makeWorld();
  t.after(w.cleanup);
  const dir = path.join(w.home, '.local', 'share', 'cortexkit', 'magic-context');
  (await import('node:fs')).mkdirSync(dir, { recursive: true });
  const db = new sqlite.DatabaseSync(path.join(dir, 'context.db'));
  db.exec('create table schema_migrations(version integer); insert into schema_migrations values (90),(91);');
  db.close();
  const s0 = readFileSync(w.settingsFile, 'utf8');
  const r = await cli(['setup', '--yes'], w);
  assert.equal(r.code, 2);
  assert.match(r.err, /schema v91 is NEWER than this build's fence v90/);
  assert.equal(readFileSync(w.settingsFile, 'utf8'), s0);
});
