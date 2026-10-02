import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isolationViolations } from '../src/isolation.js';
import { agentDir, mcConfigPath, mcStorage, magicOmoHome, omoConfigPath, settingsPath } from '../src/paths.js';
import { makeWorld } from './helpers.js';

test('agent dir: OMO > SENPI > PI env, else $HOME/.omo/agent (mirrors omo-ai agent-dir.js)', () => {
  const H = '/h';
  assert.equal(agentDir({ HOME: H }).path, '/h/.omo/agent');
  assert.equal(agentDir({ HOME: H, PI_CODING_AGENT_DIR: '/pi' }).path, '/pi');
  assert.equal(agentDir({ HOME: H, PI_CODING_AGENT_DIR: '/pi', SENPI_CODING_AGENT_DIR: '/senpi' }).path, '/senpi');
  const all = agentDir({ HOME: H, PI_CODING_AGENT_DIR: '/pi', SENPI_CODING_AGENT_DIR: '/senpi', OMO_CODING_AGENT_DIR: '/omo' });
  assert.deepEqual(all, { path: '/omo', source: 'OMO_CODING_AGENT_DIR' });
  assert.equal(agentDir({ HOME: H, OMO_CODING_AGENT_DIR: '   ' }).path, '/h/.omo/agent', 'blank is unset');
  assert.equal(agentDir({ HOME: H, OMO_CODING_AGENT_DIR: 'rel/dir' }).path, path.resolve('rel/dir'));
});

test('storage: MAGIC_CONTEXT_STORAGE_DIR > XDG_DATA_HOME > ~/.local/share (mirrors data-path.ts)', () => {
  assert.equal(mcStorage({ HOME: '/h' }).dir, '/h/.local/share/cortexkit/magic-context');
  assert.equal(mcStorage({ HOME: '/h', XDG_DATA_HOME: '/xd' }).dir, '/xd/cortexkit/magic-context');
  assert.equal(mcStorage({ HOME: '/h', XDG_DATA_HOME: '/xd', MAGIC_CONTEXT_STORAGE_DIR: '/s' }).dir, '/s');
  assert.throws(() => mcStorage({ MAGIC_CONTEXT_STORAGE_DIR: 'relative' }), /absolute/);
});

test('MC config honours absolute XDG_CONFIG_HOME only', () => {
  assert.equal(mcConfigPath({ HOME: '/h' }), '/h/.config/cortexkit/magic-context.jsonc');
  assert.equal(mcConfigPath({ HOME: '/h', XDG_CONFIG_HOME: '/xc' }), '/xc/cortexkit/magic-context.jsonc');
  assert.equal(mcConfigPath({ HOME: '/h', XDG_CONFIG_HOME: 'rel' }), '/h/.config/cortexkit/magic-context.jsonc');
});

test('omo config falls back to omo.json; settings prefers settings.jsonc', (t) => {
  const w = makeWorld({ omoConfig: null, settings: null });
  t.after(w.cleanup);
  assert.equal(omoConfigPath(w.env), path.join(w.home, '.omo', 'omo.jsonc'));
  writeFileSync(path.join(w.home, '.omo', 'omo.json'), '{}');
  assert.equal(omoConfigPath(w.env), path.join(w.home, '.omo', 'omo.json'));
  assert.equal(settingsPath(w.env), path.join(w.home, '.omo', 'agent', 'settings.json'));
  writeFileSync(path.join(w.home, '.omo', 'agent', 'settings.jsonc'), '{}');
  assert.equal(settingsPath(w.env), path.join(w.home, '.omo', 'agent', 'settings.jsonc'));
});

test('magic-omo home: MAGIC_OMO_HOME > XDG_DATA_HOME/magic-omo > ~/.local/share/magic-omo', () => {
  assert.equal(magicOmoHome({ HOME: '/h' }), '/h/.local/share/magic-omo');
  assert.equal(magicOmoHome({ HOME: '/h', XDG_DATA_HOME: '/xd' }), '/xd/magic-omo');
  assert.equal(magicOmoHome({ HOME: '/h', MAGIC_OMO_HOME: '/m' }), '/m');
});

test('isolation guard refuses when any target resolves into the real home live state', (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  const fakeReal = path.join(w.base, 'realhome');
  mkdirSync(path.join(fakeReal, '.omo', 'agent'), { recursive: true });
  mkdirSync(path.join(fakeReal, '.local', 'share', 'cortexkit', 'magic-context'), { recursive: true });
  assert.deepEqual(isolationViolations(w.env, fakeReal), []);
  const leakAgent = { ...w.env, OMO_CODING_AGENT_DIR: path.join(fakeReal, '.omo', 'agent') };
  assert.match(isolationViolations(leakAgent, fakeReal).join('\n'), /agentDir resolves into the real/);
  const leakStore = { ...w.env, MAGIC_CONTEXT_STORAGE_DIR: path.join(fakeReal, '.local', 'share', 'cortexkit', 'magic-context') };
  assert.match(isolationViolations(leakStore, fakeReal).join('\n'), /store resolves into the real Magic Context store/);
  // HOME pointing at the real home is caught even without overrides.
  assert.ok(isolationViolations({ HOME: fakeReal }, fakeReal).length >= 3);
});
