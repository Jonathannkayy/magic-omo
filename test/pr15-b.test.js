// PR #15 review fixes (part b): exact, index-validated array edits; the stale prior
// pin path is removed reversibly when both pins are present; an installed guard is
// regenerated when setup switches the pin. Nothing here touches real systemd/launchd:
// systemctl/launchctl are either injected or fake stubs first on the world's PATH.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.js';
import { planSettings, revertEdits } from '../src/edits.js';
import { guardInstall, guardInstalled, guardRefresh, guardTargets } from '../src/guard.js';
import { parse, removeArrayElementAt, replaceElement, revertEdit } from '../src/jsonc.js';
import { allPaths } from '../src/paths.js';
import { capture, makeWorld } from './helpers.js';

async function cli(argv, w) {
  const io = capture();
  const code = await main(argv, { env: w.env, ...io });
  return { code, ...io.chunks };
}

/** Fake systemctl/launchctl first on PATH: records argv, never the real thing. */
function stubServiceManagers(w) {
  const log = path.join(w.base, 'svc-calls.log');
  for (const cmd of ['systemctl', 'launchctl']) {
    const f = path.join(w.bin, cmd);
    writeFileSync(f, `#!/bin/sh\necho "${cmd} $@" >> "${log}"\n`);
    chmodSync(f, 0o755);
  }
  return () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
}

// ---------------------------------------------------------------- item 2: raw slice

test('replaceElement revert restores the ORIGINAL raw element (comments and formatting inside it)', () => {
  const text = `{
  "extensions": [
    "a",
    {
      // why this entry exists
      "path": "\\/opt\\/x",   /* escaped on purpose */
      "flags": [1,2]
    },
    "c"
  ]
}
`;
  const prior = parse(text).extensions[1];
  const r = replaceElement(text, ['extensions'], prior, '/new/ext');
  assert.deepEqual(parse(r.text).extensions, ['a', '/new/ext', 'c']);
  assert.equal(r.edit.index, 1);
  const back = revertEdit(r.text, r.edit);
  assert.equal(back.status, 'reverted');
  assert.equal(back.text, text, 'byte-identical, comments inside the element kept');
});

test('legacy replaceElement record without priorRaw/index still reverts semantically', () => {
  const text = '{"extensions": ["a", "b"]}';
  const r = replaceElement(text, ['extensions'], 'b', 'x');
  const legacy = { op: 'replaceElement', path: ['extensions'], value: 'x', prior: 'b' };
  assert.equal(revertEdit(r.text, legacy).text, text);
});

// ---------------------------------------------------------------- item 3: index validation

test('replaceElement revert targets the recorded slot, not a later equal value the user added', () => {
  const text = '{"extensions": ["a", "b", "a"]}';
  const r = replaceElement(text, ['extensions'], 'a', 'x'); // last "a" (index 2)
  assert.equal(r.edit.index, 2);
  // User appends another "x" afterwards.
  const user = r.text.replace(']', ', "x"]');
  const back = revertEdit(user, r.edit);
  assert.equal(back.status, 'reverted');
  assert.deepEqual(parse(back.text).extensions, ['a', 'b', 'a', 'x'], 'user-added "x" untouched');
});

test('replaceElement revert refuses (status modified) when the recorded slot no longer holds our value', () => {
  const text = '{"extensions": ["a", "b"]}';
  const r = replaceElement(text, ['extensions'], 'b', 'x'); // index 1
  for (const changed of ['{"extensions": ["x", "a", "b"]}', '{"extensions": ["u", "a", "x"]}'.replace('"a", ', ''), '{"extensions": ["x", "a"]}']) {
    const back = revertEdit(changed, r.edit);
    if (parse(changed).extensions[1] === 'x') continue; // slot still ours: covered above
    assert.equal(back.status, 'modified', changed);
    assert.equal(back.text, changed, `left untouched: ${changed}`);
    assert.match(back.detail, /extensions\[1\]/);
  }
  const res = revertEdits('{"extensions": ["x", "a"]}', [r.edit]);
  assert.equal(res.results[0].status, 'modified');
  assert.match(res.results[0].detail, /left as is/);
});

test('removeArrayElementAt reverts byte-identically from first, middle, last and sole positions', () => {
  const cases = [
    ['{\n  "e": [\n    "p", // c0\n    "q",\n    "r"\n  ]\n}\n', 0],
    ['{\n  "e": [\n    "p",\n    /* c1 */ "q", // tail\n    "r"\n  ]\n}\n', 1],
    ['{\n  "e": [\n    "p",\n    "q",\n    "r" // last\n  ]\n}\n', 2],
    ['{ "e": [ /* only */ "q" ] }', 0],
  ];
  for (const [text, idx] of cases) {
    const v = parse(text).e[idx];
    const r = removeArrayElementAt(text, ['e'], idx);
    const after = parse(r.text).e;
    assert.equal(after.length, parse(text).e.length - 1);
    assert.ok(!after.includes(v) || parse(text).e.filter((x) => x === v).length > 1);
    const back = revertEdit(r.text, r.edit);
    assert.equal(back.status, 'reverted', text);
    assert.equal(back.text, text, `exact restore for index ${idx}`);
  }
});

test('removeArrayElementAt revert refuses when its anchor neighbour moved', () => {
  const text = '{"e": ["p", "q", "r"]}';
  const r = removeArrayElementAt(text, ['e'], 2); // anchor: "q" at index 1
  const back = revertEdit('{"e": ["q", "p"]}', r.edit);
  assert.equal(back.status, 'modified');
  assert.equal(back.text, '{"e": ["q", "p"]}');
});

// ---------------------------------------------------------------- item 1: both pins present

test('planSettings removes the stale prior pin reversibly when the selected pin is already present', () => {
  const text = '{\n  "extensions": [\n    "/u/ext",\n    "/v/0.43.2/ext", // old pin\n    "/v/0.44.4/ext"\n  ]\n}\n';
  const r = planSettings(text, '/v/0.44.4/ext', { priorExt: '/v/0.43.2/ext' });
  assert.deepEqual(parse(r.text).extensions, ['/u/ext', '/v/0.44.4/ext'], 'only one Magic Context runtime loaded');
  assert.equal(r.edits.length, 1);
  assert.equal(r.edits[0].op, 'removeElement');
  assert.match(r.notes.join('\n'), /stale/);
  assert.equal(revertEdits(r.text, r.edits).text, text, 'uninstall restores it exactly');
  // Selected present, prior absent: still a no-op.
  const same = planSettings(r.text, '/v/0.44.4/ext', { priorExt: '/v/0.43.2/ext' });
  assert.equal(same.edits.length, 0);
});

test('setup with both pin paths present leaves one runtime; uninstall removes only what setup added', async (t) => {
  const s0 = '{\n  "theme": "dark",\n  "extensions": [\n    "/opt/user-ext"\n  ]\n}\n';
  const w = makeWorld({ settings: s0 });
  t.after(w.cleanup);
  assert.equal((await cli(['setup', '--yes'], w)).code, 0); // 0.43.2 appended
  const ext43 = allPaths(w.env, '0.43.2').extension;
  const ext44 = allPaths(w.env, '0.44.4').extension;
  // Something outside magic-omo (hand edit, a crashed earlier run) also added 0.44.
  const mid = readFileSync(w.settingsFile, 'utf8').replace(JSON.stringify(ext43), `${JSON.stringify(ext43)}, ${JSON.stringify(ext44)}`);
  writeFileSync(w.settingsFile, mid);
  const r = await cli(['setup', '--yes', '--mc', '0.44.4'], w);
  assert.equal(r.code, 0, r.out + r.err);
  const exts = parse(readFileSync(w.settingsFile, 'utf8')).extensions;
  assert.ok(exts.includes(ext44));
  assert.ok(!exts.includes(ext43), 'stale prior runtime removed, not double-loaded');
  assert.equal((await cli(['uninstall', '--yes'], w)).code, 0);
  // Our append is undone; the externally added 0.44 path is not ours to remove.
  const fin = parse(readFileSync(w.settingsFile, 'utf8')).extensions;
  assert.deepEqual(fin, ['/opt/user-ext', ext44], 'ours gone, the externally added path kept');
});

// ---------------------------------------------------------------- core invariant

test('invariant: setup -> pin swap -> uninstall is byte-identical with comments around/inside the swapped element and a duplicate equal value', async (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  const ext43 = allPaths(w.env, '0.43.2').extension;
  // The user already lists the 0.43 runtime, written with escaped slashes and wrapped
  // in comments, next to a duplicated unrelated entry.
  const esc = JSON.stringify(ext43).replace(/\//g, '\\/');
  const s0 = `{
  // user settings
  "theme": "dark",
  "extensions": [
    "/opt/user-ext", /* dup on purpose */
    /* before ours */ ${esc} /* after ours */,
    "/opt/user-ext" // dup
  ],
  "compaction": { "enabled": true }
}
`;
  writeFileSync(w.settingsFile, s0);
  const o0 = readFileSync(w.omoConfigFile, 'utf8');
  assert.equal((await cli(['setup', '--yes', '--mc', '0.43.2'], w)).code, 0);
  assert.equal(readFileSync(w.settingsFile, 'utf8'), s0, '0.43 already listed: settings untouched');
  const r = await cli(['setup', '--yes', '--mc', '0.44.4'], w);
  assert.equal(r.code, 0, r.out + r.err);
  const swapped = parse(readFileSync(w.settingsFile, 'utf8')).extensions;
  assert.deepEqual(swapped, ['/opt/user-ext', allPaths(w.env, '0.44.4').extension, '/opt/user-ext']);
  const u = await cli(['uninstall', '--yes'], w);
  assert.equal(u.code, 0, u.out + u.err);
  assert.equal(readFileSync(w.settingsFile, 'utf8'), s0, 'settings.json byte-identical (escapes + comments kept)');
  const o1 = readFileSync(w.omoConfigFile, 'utf8');
  const comments = (s) => s.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g) ?? [];
  assert.deepEqual(comments(o1), comments(o0), 'omo.jsonc comment-identical');
  assert.equal(o1, o0);
});

// ---------------------------------------------------------------- item 4: guard refresh

test('guardRefresh is a no-op when the guard is not installed (stays opt-in)', (t) => {
  const w = makeWorld();
  t.after(w.cleanup);
  const calls = [];
  const r = guardRefresh(w.env, { platform: 'linux', exec: (...a) => { calls.push(a); return { ok: true, out: '' }; } });
  assert.equal(r.refreshed, false);
  assert.equal(r.reason, 'not-installed');
  assert.equal(guardInstalled(w.env, 'linux'), false);
  assert.ok(Object.keys(guardTargets(w.env, 'linux').files).every((f) => !existsSync(f)), 'nothing written');
  assert.deepEqual(calls, []);
});

test('guardRefresh rewrites stale units and reloads systemd / launchd via the injected runner', async (t) => {
  for (const platform of ['linux', 'darwin']) {
    const w = makeWorld();
    t.after(w.cleanup);
    const svc = stubServiceManagers(w); // belt and braces: the injected exec is what must be used
    assert.equal((await cli(['setup', '--yes', '--mc', '0.43.2', '--prune'], w)).code, 0);
    guardInstall(w.env, { platform, activate: false });
    assert.equal(guardInstalled(w.env, platform), true);
    const ext44pkg = path.join(allPaths(w.env, '0.44.4').extension, 'package.json');
    const unitText = () => Object.keys(guardTargets(w.env, platform).files).map((f) => readFileSync(f, 'utf8')).join('\n');
    assert.ok(!unitText().includes(ext44pkg));

    const calls = [];
    const exec = (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { ok: true, out: '' }; };
    // Unchanged world: nothing to do.
    assert.equal(guardRefresh(w.env, { platform, exec }).reason, 'up-to-date');
    assert.deepEqual(calls, []);

    // Simulate a pin switch recorded by setup (no CLI here, so only `exec` can run).
    const rec = allPaths(w.env).record;
    writeFileSync(rec, JSON.stringify({ ...JSON.parse(readFileSync(rec, 'utf8')), magic_context: '0.44.4' }));
    const r = guardRefresh(w.env, { platform, exec });
    assert.equal(r.refreshed, true);
    assert.ok(unitText().includes(ext44pkg), `${platform}: new runtime path watched`);
    if (platform === 'linux') {
      assert.deepEqual(calls, ['systemctl --user daemon-reload', 'systemctl --user restart magic-omo-guard.path magic-omo-guard.timer']);
    } else {
      const plist = Object.keys(guardTargets(w.env, platform).files)[0];
      assert.deepEqual(calls, [`launchctl unload ${plist}`, `launchctl load -w ${plist}`]);
    }
    assert.equal(svc(), '', 'the PATH service managers were never invoked');
  }
});

test('setup that switches the pin regenerates an installed guard (stub systemctl, never the real one)', async (t) => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return t.skip('guard unsupported here');
  const w = makeWorld();
  t.after(w.cleanup);
  const svc = stubServiceManagers(w);
  assert.equal((await cli(['setup', '--yes', '--mc', '0.43.2'], w)).code, 0);
  assert.equal(svc(), '', 'no guard installed: setup never calls the service manager');
  guardInstall(w.env, { activate: false });
  const ext44pkg = path.join(allPaths(w.env, '0.44.4').extension, 'package.json');

  const r = await cli(['setup', '--yes', '--mc', '0.44.4'], w);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /guard units regenerated/);
  const units = Object.keys(guardTargets(w.env).files).map((f) => readFileSync(f, 'utf8')).join('\n');
  assert.ok(units.includes(ext44pkg));
  assert.match(svc(), process.platform === 'linux' ? /systemctl --user daemon-reload/ : /launchctl load -w/);

  // Re-running setup on the same pin does not touch the guard again.
  const before = svc();
  assert.equal((await cli(['setup', '--yes', '--mc', '0.44.4'], w)).code, 0);
  assert.equal(svc(), before);
});
