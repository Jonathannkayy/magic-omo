// Unit tests for the upstream contract check. These never hit the network: they
// build tiny fake package trees and point the checkers at them.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  checkMagicContext, checkOmo, memorySchemaEvidence, objectLiteralAt, parseArgs, resolveNpm, topLevelKeys,
} from '../scripts/contract-check.js';

function tmpdir(t) {
  const d = mkdtempSync(path.join(process.env.MAGIC_OMO_TEST_TMP || os.tmpdir(), 'contract-test-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

// A minified schema region shaped like omo-ai 5.1.9's real plugin bundle
// (plugin/extensions/omo.js): one child object schema per memory sub-key, a strict
// user-config parent referencing them with .optional(), a defaults parent with
// .default({...}), and the top-level config objects that carry `memory:<parent>.optional()`.
const CHILD = {
  reflection: 'Ya=Io({enabled:go().optional(),trigger:Va.optional(),merge:Mo(["auto","integration"]).optional()}).strict()',
  nudge: 'ts=Io({enabled:go().optional(),every_user_turns:fo().int().min(1).optional()}).strict()',
  facts: 'ns=Io({enabled:go().optional(),debounce_settles:fo().int().min(1).optional()}).strict()',
  dream: 'rs=Io({enabled:go().optional(),idle_minutes:fo().int().min(0).optional()}).strict()',
  recall: 'es=Io({enabled:go().optional(),max_items:fo().int().min(1).max(5).optional(),event_caps:Xa.optional()}).strict()',
};
const DEFAULT_CHILD = {
  reflection: 'Fa=Io({enabled:go().default(!0),trigger:Da.default({step_count:25,on_compaction:!0})})',
  nudge: 'Ua=Io({enabled:go().default(!0),every_user_turns:fo().int().min(1).default(10)})',
  facts: 'Wa=Io({enabled:go().default(!0),debounce_settles:fo().int().min(1).default(4)})',
  dream: 'Ha=Io({enabled:go().default(!0),idle_minutes:fo().int().min(0).default(30)})',
  recall: 'Ba=Io({enabled:go().default(!0),max_items:fo().int().min(1).max(5).default(2)})',
};
function schema({ child = CHILD, defaults = DEFAULT_CHILD } = {}) {
  return `var ${Object.values(defaults).join(',')},${Object.values(child).join(',')},`
    + 'ls=Io({enabled:go().default(!0),agent:Li().min(1).default("auto"),reflection:Fa.default({enabled:!0,merge:"auto"}),'
    + 'nudge:Ua.default({enabled:!0}),facts:Wa.default({enabled:!0,debounce_settles:4}),dream:Ha.default({enabled:!0}),recall:Ba.default({enabled:!0})}),'
    + 'cs=Io({enabled:go().optional(),agent:Li().min(1).optional(),reflection:Ya.optional(),nudge:ts.optional(),'
    + 'facts:ns.optional(),dream:rs.optional(),people:is.optional(),recall:es.optional()}).strict(),'
    + 'il=Io({task:Fs.optional(),memory:cs.optional(),telemetry:Vs.optional()}).strict(),'
    + 'al=Io({$schema:Li().optional(),memory:ls.optional(),telemetry:Ys.optional()}).strict();';
}
const GOOD_SCHEMA = schema();
/** GOOD_SCHEMA with `enabled` removed from one strict (user-config) child schema. */
const withoutEnabled = (key, table = 'child') => {
  const src = table === 'child' ? CHILD : DEFAULT_CHILD;
  const stripped = { ...src, [key]: src[key].replace(/enabled:go\(\)\.(optional\(\)|default\(!0\)),/, '') };
  assert.notEqual(stripped[key], src[key]);
  return schema(table === 'child' ? { child: stripped } : { defaults: stripped });
};

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
  assert.equal(memorySchemaEvidence(GOOD_SCHEMA).ok, true, memorySchemaEvidence(GOOD_SCHEMA).detail);
  // Same shape, every mangled identifier renamed consistently (including a `$`).
  const renamed = GOOD_SCHEMA.replace(/\b(Ya|ts|ns|rs|es|Fa|Ua|Wa|Ha|Ba|cs|ls)\b/g, (m) => `$${m}9`);
  assert.equal(memorySchemaEvidence(renamed).ok, true, memorySchemaEvidence(renamed).detail);
  const dropped = memorySchemaEvidence(GOOD_SCHEMA.replace('dream:rs.optional(),', ''));
  assert.equal(dropped.ok, false);
  assert.match(dropped.detail, /dream/);
  assert.equal(memorySchemaEvidence('const a = 1;').ok, false);
});

test('memory schema evidence fails when any ONE child schema loses `enabled`', () => {
  for (const key of ['facts', 'recall', 'nudge', 'reflection', 'dream']) {
    for (const table of ['child', 'defaults']) {
      const ev = memorySchemaEvidence(withoutEnabled(key, table));
      assert.equal(ev.ok, false, `${table}.${key}: ${ev.detail}`);
      assert.match(ev.detail, new RegExp(`no \`enabled\` field on ${key}`), ev.detail);
    }
  }
  // `enabled` surviving only on the parent, or only inside a nested object, is not enough.
  const nested = { ...CHILD, facts: 'ns=Io({debounce_settles:fo().optional(),opts:Io({enabled:go().optional()})}).strict()' };
  assert.equal(memorySchemaEvidence(schema({ child: nested })).ok, false);
  // A child whose definition vanished from the bundle fails too.
  const gone = { ...CHILD, recall: 'zz=Io({enabled:go().optional()}).strict()' };
  assert.match(memorySchemaEvidence(schema({ child: gone })).detail, /recall/);
});

test('checkOmo reports omo-memory-schema FAIL for a bundle missing one child `enabled`', (t) => {
  const r = checkOmo(fakeOmo(tmpdir(t), { schema: withoutEnabled('nudge') }));
  const c = byId(r.checks, 'omo-memory-schema');
  assert.equal(c.ok, false);
  assert.match(c.detail, /nudge/);
});

test('objectLiteralAt / topLevelKeys ignore braces in strings and nested members', () => {
  const t = 'x=Io({a:Li().default("}{"),b:Io({enabled:go()}),enabled:go().optional()})';
  const obj = objectLiteralAt(t, t.indexOf('{'));
  assert.equal(obj, t.slice(t.indexOf('{'), -1));
  assert.deepEqual(topLevelKeys(obj), ['a', 'b', 'enabled']);
});

test('resolveNpm uses MAGIC_OMO_NPM / PATH and a shell only for Windows .cmd shims', () => {
  assert.deepEqual(resolveNpm({ MAGIC_OMO_NPM: '/usr/bin/npm' }, 'linux'), { bin: '/usr/bin/npm', shell: false });
  assert.deepEqual(resolveNpm({ MAGIC_OMO_NPM: 'C:\\nodejs\\npm.cmd' }, 'win32'), { bin: 'C:\\nodejs\\npm.cmd', shell: true });
  assert.equal(resolveNpm({ PATH: '' }, 'linux'), undefined);
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
