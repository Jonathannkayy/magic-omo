// Unit tests for the upstream contract check. These never hit the network: they
// build tiny fake package trees and point the checkers at them.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkMagicContext, checkOmo, memorySchemaEvidence, parseArgs } from '../scripts/contract-check.js';

function tmpdir(t) {
  const d = mkdtempSync(path.join(process.env.MAGIC_OMO_TEST_TMP || os.tmpdir(), 'contract-test-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

// A minified schema region shaped like omo-ai's real plugin bundle.
const GOOD_SCHEMA = 'var Mu=nl({enabled:Xs().optional(),agent:Vs().min(1).optional(),reflection:ku.optional(),'
  + 'nudge:zu.optional(),facts:Ou.optional(),dream:Iu.optional(),recall:Su.optional()}).strict();'
  + 'x=nl({task:gd.optional(),memory:Mu.optional(),telemetry:Td.optional()}).strict();';

function fakeOmo(dir, { compactHook = true, localSkip = true, agentDir = true, schema = GOOD_SCHEMA, version = '5.1.9' } = {}) {
  const root = path.join(dir, 'omo-ai');
  write(path.join(root, 'package.json'), JSON.stringify({ name: 'omo-ai', version }));
  const senpi = path.join(root, 'node_modules', '@code-yeongyu', 'senpi');
  write(path.join(senpi, 'package.json'), JSON.stringify({ name: '@code-yeongyu/senpi', version: '2026.10.1-3' }));
  write(path.join(senpi, 'dist', 'core', 'extensions', 'runner.js'), compactHook ? 'if (e.type === "session_before_compact") {}' : 'export const x = 1;');
  write(path.join(senpi, 'dist', 'core', 'package-manager.js'), localSkip ? 'if (parsed.type === "local" || parsed.pinned) { continue; }' : 'export const y = 2;');
  write(path.join(root, 'bin', 'lib', 'agent-dir.js'), agentDir
    ? 'export const AGENT_DIR_ENV_NAMES = ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"]'
    : 'export const AGENT_DIR_ENV_NAMES = ["OMO_CODING_AGENT_DIR"]');
  write(path.join(root, 'plugin', 'extensions', 'omo-member.js'), schema);
  return root;
}

function fakeMc(dir, { pi = { extensions: ['./dist/index.js'] }, peers = { typebox: '*', '@earendil-works/pi-tui': '*', '@earendil-works/pi-coding-agent': '*' }, fence = 91 } = {}) {
  const root = path.join(dir, 'pi-magic-context');
  write(path.join(root, 'package.json'), JSON.stringify({ name: '@cortexkit/pi-magic-context', version: '0.44.4', pi, peerDependencies: peers }));
  write(path.join(root, 'dist', 'index.js'), fence === null ? 'export const x = 1;' : `const LATEST_SUPPORTED_VERSION = ${fence};`);
  return root;
}

const byId = (checks, id) => checks.find((c) => c.id === id);

test('parseArgs reads --omo-ai/--mc/--keep and rejects junk', () => {
  assert.deepEqual(parseArgs(['--omo-ai', '5.1.9', '--mc', '0.44.4']), { keep: false, omo: '5.1.9', mc: '0.44.4' });
  assert.equal(parseArgs(['--keep']).keep, true);
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
});

test('checkOmo passes on a healthy tree', (t) => {
  const r = checkOmo(fakeOmo(tmpdir(t)));
  assert.ok(r.checks.every((c) => c.ok), JSON.stringify(r.checks, null, 2));
  assert.deepEqual(r.versions, { 'omo-ai': '5.1.9', '@code-yeongyu/senpi': '2026.10.1-3' });
});

test('checkOmo catches each contract break individually', (t) => {
  const d = tmpdir(t);
  assert.equal(byId(checkOmo(fakeOmo(path.join(d, 'a'), { compactHook: false })).checks, 'senpi-compact-hook').ok, false);
  assert.equal(byId(checkOmo(fakeOmo(path.join(d, 'b'), { localSkip: false })).checks, 'senpi-local-pinned-skip').ok, false);
  const noEnv = byId(checkOmo(fakeOmo(path.join(d, 'c'), { agentDir: false })).checks, 'omo-agent-dir-env');
  assert.equal(noEnv.ok, false);
  assert.match(noEnv.detail, /SENPI_CODING_AGENT_DIR/);
});

test('memory schema evidence survives minifier renames but notices a dropped sub-key', () => {
  assert.equal(memorySchemaEvidence(GOOD_SCHEMA).ok, true);
  // Same shape, different mangled identifiers.
  assert.equal(memorySchemaEvidence(GOOD_SCHEMA.replace(/Mu|ku|zu|Ou|Iu|Su/g, (m) => `z${m}9`)).ok, true);
  const dropped = memorySchemaEvidence(GOOD_SCHEMA.replace('dream:Iu.optional(),', ''));
  assert.equal(dropped.ok, false);
  assert.match(dropped.detail, /dream/);
  assert.equal(memorySchemaEvidence('const a = 1;').ok, false);
});

test('checkMagicContext validates pi.extensions, peerDependencies and the fence', (t) => {
  const d = tmpdir(t);
  const good = checkMagicContext(fakeMc(path.join(d, 'g')));
  assert.ok(good.checks.every((c) => c.ok), JSON.stringify(good.checks));
  assert.equal(good.schema_fence, 91);
  assert.equal(byId(checkMagicContext(fakeMc(path.join(d, 'a'), { pi: null })).checks, 'mc-pi-extensions').ok, false);
  const extra = checkMagicContext(fakeMc(path.join(d, 'b'), { peers: { typebox: '*', react: '*' } }));
  assert.equal(byId(extra.checks, 'mc-peer-deps').ok, false);
  assert.match(byId(extra.checks, 'mc-peer-deps').detail, /react/);
  assert.equal(byId(checkMagicContext(fakeMc(path.join(d, 'c'), { fence: null })).checks, 'mc-schema-fence').ok, false);
});
