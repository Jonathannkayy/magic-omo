import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.js';
import { buildFence, schemaVersion } from '../src/db.js';
import { runDoctor, otherMagicContextLoaders } from '../src/doctor.js';
import { guardRun } from '../src/guard.js';
import { classifyModel, collectPiModels, resolveForPi } from '../src/historian.js';
import { parse } from '../src/jsonc.js';
import { parseProbeOutput } from '../src/omo.js';
import { allPaths } from '../src/paths.js';
import { pluginEntryVersion } from '../src/peers.js';
import { capture, FIX, makeWorld } from './helpers.js';

const fx = (f) => readFileSync(path.join(FIX, f), 'utf8');
const byId = (r, id) => r.checks.filter((c) => c.id === id);
let sqlite;
try { sqlite = await import('node:sqlite'); } catch { sqlite = null; }

function makeDb(w, versions) {
  const dir = path.join(w.home, '.local', 'share', 'cortexkit', 'magic-context');
  mkdirSync(dir, { recursive: true });
  const db = new sqlite.DatabaseSync(path.join(dir, 'context.db'));
  db.exec(`create table schema_migrations(version integer); ${versions.map((v) => `insert into schema_migrations values (${v});`).join('')}`);
  db.close();
  return path.join(dir, 'context.db');
}

test('historian classifier mirrors harness-provider-map.ts', () => {
  assert.equal(resolveForPi('google/gemini-3.1-pro'), 'google-antigravity/gemini-3.1-pro');
  assert.equal(resolveForPi('openai/gpt-5.4'), 'openai-codex/gpt-5.4');
  assert.equal(resolveForPi('anthropic-subscription/claude-sonnet-5-5'), 'anthropic-subscription/claude-sonnet-5-5');
  assert.equal(classifyModel('google/gemini-3.1-pro').status, 'FAIL');
  assert.match(classifyModel('openai/gpt-5.4').message, /Model "openai-codex\/gpt-5.4" not found/);
  assert.equal(classifyModel('google-antigravity/x').status, 'FAIL');
  assert.equal(classifyModel('claude-sonnet-5-5').status, 'INFO');
  assert.match(classifyModel('claude-sonnet-5-5').message, /ambiguous across providers/);
  const p = classifyModel('anthropic-subscription/claude-sonnet-5-5');
  assert.equal(p.status, 'PASS');
  assert.match(p.message, /SHARED/);
});

test('collectPiModels walks historian/dreamer incl. fallbacks, object entries and tasks', () => {
  const m = collectPiModels(parse(fx('magic-context-bad.jsonc')));
  assert.deepEqual(m.map((x) => x.where), ['historian.pi.model', 'historian.pi.fallback_models[0]', 'dreamer.pi.model', 'dreamer.pi.tasks.verify.model']);
  assert.equal(m[1].model, 'openai/gpt-5.4');
});

test('probe output parsing: ambiguous / not found / ok / no auth / unknown', () => {
  assert.equal(parseProbeOutput(fx('probe-ambiguous.txt'), 'claude-sonnet-5-5').status, 'ambiguous');
  assert.equal(parseProbeOutput(fx('probe-notfound.txt'), 'google-antigravity/gemini-3.1-pro-preview').status, 'not_found');
  assert.equal(parseProbeOutput(fx('probe-ok.jsonl'), 'claude-sonnet-5-5').status, 'ok');
  assert.equal(parseProbeOutput(fx('probe-ok.jsonl'), 'anthropic-subscription/claude-sonnet-5-5').status, 'ok');
  assert.equal(parseProbeOutput('No API key found for venice.', 'x').status, 'no_auth');
  assert.equal(parseProbeOutput('', 'x').status, 'unknown');
});

test('doctor: bad historian config FAILs statically and probe skips FAIL lines', async (t) => {
  const w = makeWorld({ mcConfig: fx('magic-context-bad.jsonc') });
  t.after(w.cleanup);
  const r = await runDoctor({ env: w.env, probe: true });
  assert.equal(byId(r, 'model:historian.pi.model')[0].status, 'FAIL');
  assert.equal(byId(r, 'model:dreamer.pi.model')[0].status, 'PASS');
  assert.equal(byId(r, 'todowrite')[0].status, 'PASS');
  // Only the non-FAIL model was probed, through the fake omo stub.
  const calls = w.omoCalls().trim().split('\n');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /--print --mode json --no-session --no-extensions --no-skills --no-tools --model anthropic-subscription\/claude-sonnet-5-5 ok/);
  assert.equal(r.ok, false);
});

test('doctor: probe is opt-in; ambiguity => WARN with retry hint', async (t) => {
  const w = makeWorld({ probe: fx('probe-ambiguous.txt') });
  t.after(w.cleanup);
  const r0 = await runDoctor({ env: w.env });
  assert.equal(w.omoCalls(), '', 'no omo call without --probe-models');
  assert.equal(byId(r0, 'probe')[0].status, 'INFO');
  const r = await runDoctor({ env: w.env, probe: true });
  const pr = r.checks.find((c) => c.id === 'probe:claude-sonnet-5-5');
  assert.equal(pr.status, 'WARN');
  assert.match(pr.detail, /retry once/);
});

test('doctor: unverified OMO is WARN, FAIL with --strict; broken Senpi contract FAILs', async (t) => {
  const w = makeWorld({ omoVersion: '5.1.8', compactHook: false, localSkip: false });
  t.after(w.cleanup);
  const r = await runDoctor({ env: w.env });
  assert.equal(byId(r, 'omo')[0].status, 'WARN');
  assert.equal(byId(r, 'senpi-hooks')[0].status, 'FAIL');
  assert.equal(byId(r, 'update-immunity')[0].status, 'FAIL');
  const s = await runDoctor({ env: w.env, strict: true });
  assert.equal(byId(s, 'omo')[0].status, 'FAIL');
});

test('schema fence: buildFence reads LATEST_SUPPORTED_VERSION; DB newer than fence FAILs, equal PASSes', { skip: !sqlite && 'node:sqlite unavailable' }, async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  const io = capture();
  assert.equal(await main(['setup', '--yes'], { env: w.env, ...io }), 0, io.chunks.err);
  assert.equal(buildFence(allPaths(w.env).extension), 90);
  const db = makeDb(w, [89, 90]);
  assert.deepEqual(await schemaVersion(db, w.env), { version: 90, via: 'node:sqlite' });
  assert.equal(byId(await runDoctor({ env: w.env }), 'db')[0].status, 'PASS');
  const d2 = new sqlite.DatabaseSync(db);
  d2.exec('insert into schema_migrations values (91)');
  d2.close();
  const r = await runDoctor({ env: w.env });
  assert.equal(byId(r, 'db')[0].status, 'FAIL');
  assert.equal(byId(r, 'db')[0].hard, true);
});

test('schemaVersion falls back to sqlite3 CLI or skips cleanly', { skip: !sqlite && 'node:sqlite unavailable' }, async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  const db = makeDb(w, [90]);
  assert.ok((await schemaVersion(db, { ...w.env, MAGIC_OMO_SQLITE: 'none' })).skipped);
  const cli = await schemaVersion(db, { ...w.env, MAGIC_OMO_SQLITE: 'cli' });
  assert.ok(cli.version === 90 || cli.skipped, JSON.stringify(cli));
});

test('doctor: native compaction left ON passes; turned OFF warns (resume deadlock)', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  const io = capture();
  await main(['setup', '--yes'], { env: w.env, ...io });
  const s = JSON.parse(readFileSync(w.settingsFile, 'utf8'));
  assert.equal(s.compaction.enabled, true, 'setup must NOT disable native compaction');
  assert.equal(byId(await runDoctor({ env: w.env }), 'compaction')[0].status, 'PASS');

  // A user (or upstream's OMP guidance) turning it off is a WARN, not a silent pass:
  // Senpi's resume admission then has no recovery path for an oversized transcript.
  s.compaction.enabled = false;
  writeFileSync(w.settingsFile, JSON.stringify(s, null, 2));
  const warned = byId(await runDoctor({ env: w.env }), 'compaction')[0];
  assert.equal(warned.status, 'WARN');
  assert.match(warned.detail, /resume/i);
});

test('conflict detection: duplicate Magic Context loaders FAIL', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  const io = capture();
  await main(['setup', '--yes'], { env: w.env, ...io });
  const s = JSON.parse(readFileSync(w.settingsFile, 'utf8'));
  s.packages.push({ source: 'npm:@cortexkit/pi-magic-context@0.44.0' });
  writeFileSync(w.settingsFile, JSON.stringify(s, null, 2));
  mkdirSync(path.join(w.home, '.omo', 'agent', 'extensions', 'magic-context'), { recursive: true });
  const r = await runDoctor({ env: w.env });
  assert.equal(byId(r, 'double-load')[0].status, 'FAIL');
  assert.equal(otherMagicContextLoaders(s, allPaths(w.env)).length, 2);
});

test('same-series rule: OpenCode plugin + magic-hermes compat', async (t) => {
  assert.equal(pluginEntryVersion('@cortexkit/opencode-magic-context@0.44.1').version, '0.44.1');
  assert.equal(pluginEntryVersion('file:///x/magic-context-0.43.2/packages/plugin/dist/index.js').version, '0.43.2');
  assert.equal(pluginEntryVersion('some-other-plugin'), undefined);
  const w = makeWorld();
  t.after(w.cleanup);
  mkdirSync(path.join(w.home, '.config', 'opencode'), { recursive: true });
  writeFileSync(path.join(w.home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ plugin: ['@cortexkit/opencode-magic-context@0.44.1'] }));
  mkdirSync(path.dirname(w.env.MAGIC_OMO_HERMES_COMPAT), { recursive: true });
  writeFileSync(w.env.MAGIC_OMO_HERMES_COMPAT, JSON.stringify({ supported_series: [0, 43] }));
  const r = await runDoctor({ env: w.env });
  assert.equal(byId(r, 'series-opencode')[0].status, 'FAIL');
  assert.equal(byId(r, 'series-hermes')[0].status, 'PASS');
});

test('vendor tamper detected; guard auto-uninstalls only when live + hard fail', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  const io = capture();
  await main(['setup', '--yes'], { env: w.env, ...io });
  const p = allPaths(w.env);
  let err = '';
  const quiet = await guardRun(w.env, { stderr: { write: (s) => { err += s; } } });
  assert.equal(quiet.action, 'none');
  assert.equal(err, '', 'silent when healthy');
  writeFileSync(path.join(p.extension, 'dist', 'index-test.js'), 'tampered');
  const r = await guardRun(w.env, { stderr: { write: (s) => { err += s; } } });
  assert.match(r.action, /auto-uninstalled/);
  assert.match(err, /bridge was LIVE/);
  assert.ok(!(JSON.parse(readFileSync(w.settingsFile, 'utf8')).extensions ?? []).includes(p.extension));
  assert.match(readFileSync(path.join(p.magicOmoHome, 'guard.log'), 'utf8'), /SHA256SUMS/);
});

test('doctor --json exits nonzero on FAIL and emits parseable JSON', async (t) => {
  const w = makeWorld({ mcConfig: fx('magic-context-bad.jsonc') });
  t.after(w.cleanup);
  const io = capture();
  const code = await main(['doctor', '--json'], { env: w.env, ...io });
  assert.equal(code, 1);
  const j = JSON.parse(io.chunks.out);
  assert.equal(j.ok, false);
  assert.ok(j.checks.length > 5);
});
