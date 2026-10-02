// Locating OMO Native (omo-ai) and its Senpi engine, and static contract checks.
// Nothing here executes `omo` except `probeModel`, which is opt-in.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function which(cmd, env = process.env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try {
        accessSync(p, constants.X_OK);
        return p;
      } catch { /* keep looking */ }
    }
  }
  return undefined;
}

function readJsonSafe(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
}

function npmRootGlobal(env) {
  const npm = env.MAGIC_OMO_NPM || which('npm', env);
  if (!npm) return undefined;
  const r = spawnSync(npm, ['root', '-g'], { encoding: 'utf8', env, timeout: 20_000 });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/**
 * Find the omo binary and the omo-ai package root.
 * Order: MAGIC_OMO_OMO_BIN, PATH lookup of `omo` (realpath -> package), `npm root -g`.
 */
export function locateOmo(env = process.env, { allowNpm = true } = {}) {
  const out = { bin: undefined, pkgRoot: undefined, version: undefined, senpiRoot: undefined, senpiVersion: undefined };
  out.bin = env.MAGIC_OMO_OMO_BIN?.trim() || which('omo', env);
  const candidates = [];
  if (env.MAGIC_OMO_OMO_PKG?.trim()) candidates.push(env.MAGIC_OMO_OMO_PKG.trim());
  if (out.bin) {
    try {
      const real = realpathSync(out.bin);
      // bin/omo.js -> package root
      candidates.push(path.dirname(path.dirname(real)));
      // nvm/npm layout: <prefix>/bin/omo -> <prefix>/lib/node_modules/omo-ai
      candidates.push(path.join(path.dirname(path.dirname(out.bin)), 'lib', 'node_modules', 'omo-ai'));
    } catch { /* dangling */ }
  }
  if (allowNpm) {
    const root = npmRootGlobal(env);
    if (root) candidates.push(path.join(root, 'omo-ai'));
  }
  for (const c of candidates) {
    const pj = readJsonSafe(path.join(c, 'package.json'));
    if (pj?.name === 'omo-ai') {
      out.pkgRoot = c;
      out.version = pj.version;
      break;
    }
  }
  if (out.pkgRoot) {
    for (const s of [
      path.join(out.pkgRoot, 'node_modules', '@code-yeongyu', 'senpi'),
      path.join(path.dirname(out.pkgRoot), '@code-yeongyu', 'senpi'),
    ]) {
      const pj = readJsonSafe(path.join(s, 'package.json'));
      if (pj?.name === '@code-yeongyu/senpi') {
        out.senpiRoot = s;
        out.senpiVersion = pj.version;
        break;
      }
    }
  }
  return out;
}

/** Static checks of the Senpi contract the bridge relies on. */
export function senpiContract(senpiRoot) {
  const read = (rel) => {
    try {
      return readFileSync(path.join(senpiRoot, rel), 'utf8');
    } catch {
      return undefined;
    }
  };
  const runner = read('dist/core/extensions/runner.js');
  const pm = read('dist/core/package-manager.js');
  return {
    compactHook: runner === undefined ? undefined : runner.includes('"session_before_compact"'),
    localPinnedSkip: pm === undefined ? undefined : /parsed\.type === "local" \|\| parsed\.pinned/.test(pm),
  };
}

/** Parse the output of the resolution probe. */
export function parseProbeOutput(output, model) {
  const text = String(output ?? '');
  const bare = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  const amb = /Model "([^"]+)" is ambiguous across providers:([^\n]*)/.exec(text);
  if (amb) return { status: 'ambiguous', detail: amb[0].trim() };
  const nf = /Model "([^"]+)" not found[^\n]*/.exec(text);
  if (nf) return { status: 'not_found', detail: nf[0].trim() };
  const nokey = /No API key found for ([^\s.]+)[^\n]*/.exec(text);
  if (nokey) return { status: 'no_auth', detail: nokey[0].trim() };
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`"model"\\s*:\\s*"(?:${esc(model)}|${esc(bare)})"`).test(text)) return { status: 'ok', detail: `resolved ${model}` };
  return { status: 'unknown', detail: text.trim().slice(-200) || 'no output' };
}

/**
 * OPT-IN: ask OMO to resolve `model` exactly the way a historian child is spawned.
 * This makes ONE real model call ("ok") on the user's account.
 */
export function probeModel(model, { bin, env = process.env, timeoutMs = 240_000 } = {}) {
  if (!bin) return { status: 'unavailable', detail: 'omo binary not found' };
  const args = ['--print', '--mode', 'json', '--no-session', '--no-extensions', '--no-skills', '--no-tools', '--model', model, 'ok'];
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...env, OMO_DISABLE_POSTHOG: '1', OMO_SENPI_DISABLE_POSTHOG: '1' },
  });
  if (r.error) return { status: 'unavailable', detail: String(r.error.message) };
  return parseProbeOutput(`${r.stdout ?? ''}\n${r.stderr ?? ''}`, model);
}

export function exists(p) {
  return Boolean(p) && existsSync(p);
}
