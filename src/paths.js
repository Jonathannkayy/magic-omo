// Path resolution. Every location is derived from the environment and
// os.homedir(); nothing is hardcoded to a particular machine.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Home as OMO sees it (omo-ai bin/lib/agent-dir.js runtimeHome). */
export function runtimeHome(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/** The real account home, independent of $HOME (used for isolation refusals). */
export function accountHome() {
  try {
    return os.userInfo().homedir;
  } catch {
    return os.homedir();
  }
}

export const AGENT_DIR_ENV_NAMES = ['OMO_CODING_AGENT_DIR', 'SENPI_CODING_AGENT_DIR', 'PI_CODING_AGENT_DIR'];

/** OMO agent dir: first non-empty env override, else $HOME/.omo/agent (mirrors omo-ai). */
export function agentDir(env = process.env) {
  for (const name of AGENT_DIR_ENV_NAMES) {
    const v = env[name]?.trim();
    if (v) return { path: path.resolve(v), source: name };
  }
  return { path: path.join(runtimeHome(env), '.omo', 'agent'), source: 'default ($HOME/.omo/agent)' };
}

/** Senpi prefers settings.jsonc over settings.json in the same directory. */
export function settingsPath(env = process.env) {
  const dir = agentDir(env).path;
  const jsonc = path.join(dir, 'settings.jsonc');
  if (existsSync(jsonc)) return jsonc;
  return path.join(dir, 'settings.json');
}

/** OMO user config: $HOME/.omo/omo.jsonc, else omo.json; a new file is omo.jsonc. */
export function omoConfigPath(env = process.env) {
  const dir = path.join(runtimeHome(env), '.omo');
  const jsonc = path.join(dir, 'omo.jsonc');
  const json = path.join(dir, 'omo.json');
  if (existsSync(jsonc)) return jsonc;
  if (existsSync(json)) return json;
  return jsonc;
}

export function configHome(env = process.env) {
  const x = env.XDG_CONFIG_HOME;
  if (x && path.isAbsolute(x)) return x;
  return path.join(runtimeHome(env), '.config');
}

export function dataHome(env = process.env) {
  const x = env.XDG_DATA_HOME?.trim();
  return x || path.join(runtimeHome(env), '.local', 'share');
}

/** Shared Magic Context user config (read by every host). */
export function mcConfigPath(env = process.env) {
  const base = path.join(configHome(env), 'cortexkit', 'magic-context');
  for (const ext of ['.jsonc', '.json']) {
    if (existsSync(base + ext)) return base + ext;
  }
  return `${base}.jsonc`;
}

/** Magic Context storage dir, exactly like packages/plugin/src/shared/data-path.ts (production branch). */
export function mcStorage(env = process.env) {
  const explicit = env.MAGIC_CONTEXT_STORAGE_DIR?.trim();
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error('MAGIC_CONTEXT_STORAGE_DIR must be an absolute path');
    return { dir: explicit, source: 'environment override (MAGIC_CONTEXT_STORAGE_DIR)' };
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) return { dir: path.join(xdg, 'cortexkit', 'magic-context'), source: 'XDG_DATA_HOME' };
  // data-path.ts uses os.homedir(), which is $HOME on POSIX; runtimeHome(env) is the same value
  // but honours an injected env (tests, sandboxes).
  return { dir: path.join(runtimeHome(env), '.local', 'share', 'cortexkit', 'magic-context'), source: 'platform default' };
}

export function mcDbPath(env = process.env) {
  return path.join(mcStorage(env).dir, 'context.db');
}

/** magic-omo's own home: vendor tree, install records, backups, logs. */
export function magicOmoHome(env = process.env) {
  const v = env.MAGIC_OMO_HOME?.trim();
  if (v) return path.resolve(v);
  const xdg = env.XDG_DATA_HOME?.trim();
  return path.join(xdg || path.join(runtimeHome(env), '.local', 'share'), 'magic-omo');
}

/** Root of the per-version vendor trees. */
export function vendorRoot(env = process.env) {
  return path.join(magicOmoHome(env), 'vendor');
}

/** Vendor tree for one Magic Context version: <magic-omo home>/vendor/<version>/ */
export function vendorDir(env = process.env, version) {
  if (!version) throw new Error('vendorDir() needs the Magic Context version');
  return path.join(vendorRoot(env), String(version));
}

const VERSION_DIR = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

/** Versions with a vendor tree on disk, newest-first by name (the legacy flat `node_modules` is not a version). */
export function vendoredVersions(env = process.env) {
  try {
    return readdirSync(vendorRoot(env), { withFileTypes: true })
      .filter((d) => d.isDirectory() && VERSION_DIR.test(d.name)).map((d) => d.name).sort().reverse();
  } catch {
    return [];
  }
}

export function extensionDir(env = process.env, version, pkg = '@cortexkit/pi-magic-context') {
  return path.join(vendorDir(env, version), 'node_modules', ...pkg.split('/'));
}

/** Extension path of the pre-multi-pin flat layout: <magic-omo home>/vendor/node_modules/<pkg>. */
export function legacyExtensionDir(env = process.env, pkg = '@cortexkit/pi-magic-context') {
  return path.join(vendorRoot(env), 'node_modules', ...pkg.split('/'));
}

/**
 * Every extension path magic-omo itself may have put into OMO's extensions[]:
 * one per given/vendored version, the legacy flat layout, and any recorded path.
 */
export function ownExtensionPaths(env = process.env, { versions = [], recorded = [] } = {}) {
  const all = [...versions, ...vendoredVersions(env)].filter(Boolean).map((v) => extensionDir(env, v));
  return [...new Set([...all, legacyExtensionDir(env), ...recorded.filter((x) => typeof x === 'string' && x)])];
}

export function stateDir(env = process.env) {
  return path.join(magicOmoHome(env), 'state');
}

export function backupsDir(env = process.env) {
  return path.join(magicOmoHome(env), 'backups');
}

export function realish(p) {
  try {
    return realpathSync(p);
  } catch {
    // Resolve the nearest existing ancestor so not-yet-created paths still compare correctly.
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(realish(parent), path.basename(p));
  }
}

/** Install records are keyed by the real agent dir. */
export function recordPath(env = process.env) {
  const key = createHash('sha256').update(realish(agentDir(env).path)).digest('hex').slice(0, 12);
  return path.join(stateDir(env), `install-${key}.json`);
}

export function allPaths(env = process.env, version) {
  const ad = agentDir(env);
  const st = mcStorage(env);
  return {
    home: runtimeHome(env),
    agentDir: ad.path,
    agentDirSource: ad.source,
    settings: settingsPath(env),
    omoConfig: omoConfigPath(env),
    mcConfig: mcConfigPath(env),
    storageDir: st.dir,
    storageSource: st.source,
    db: path.join(st.dir, 'context.db'),
    magicOmoHome: magicOmoHome(env),
    vendorRoot: vendorRoot(env),
    magic_context: version,
    vendor: version ? vendorDir(env, version) : undefined,
    extension: version ? extensionDir(env, version) : undefined,
    record: recordPath(env),
  };
}
