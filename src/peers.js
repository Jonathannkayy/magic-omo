// Read-only discovery of the OTHER Magic Context hosts that share context.db,
// so doctor can enforce the same-series rule.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from './jsonc.js';
import { configHome, runtimeHome } from './paths.js';

function readText(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

function nearestPkgVersion(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const pj = path.join(dir, 'package.json');
    const t = readText(pj);
    if (t) {
      try {
        const j = JSON.parse(t);
        if (typeof j.name === 'string' && j.name.includes('magic-context')) return { name: j.name, version: j.version };
      } catch { /* keep walking */ }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/** Version of one OpenCode plugin entry string, if it is a Magic Context plugin. */
export function pluginEntryVersion(entry) {
  if (typeof entry !== 'string' || !entry.includes('magic-context')) return undefined;
  const npm = /@cortexkit\/opencode-magic-context@(\d+\.\d+\.\d+[^\s"]*)/.exec(entry);
  if (npm) return { entry, version: npm[1], via: 'npm spec' };
  let p = entry;
  if (p.startsWith('file://')) {
    try {
      p = fileURLToPath(p);
    } catch { /* leave as is */ }
  }
  if (path.isAbsolute(p)) {
    const found = nearestPkgVersion(existsSync(p) ? path.dirname(p) : p);
    if (found?.version) return { entry, version: found.version, via: `package.json (${found.name})` };
  }
  const tag = /magic-context-(\d+\.\d+\.\d+)/.exec(entry);
  if (tag) return { entry, version: tag[1], via: 'path name' };
  return { entry, version: undefined, via: 'unversioned' };
}

/** Scan OpenCode's global config for Magic Context plugin entries. */
export function openCodeMagicContext(env = process.env) {
  const dir = path.join(configHome(env), 'opencode');
  const out = [];
  for (const f of ['opencode.json', 'opencode.jsonc', 'config.json']) {
    const fp = path.join(dir, f);
    const t = readText(fp);
    if (!t) continue;
    let cfg;
    try {
      cfg = parse(t);
    } catch {
      out.push({ file: fp, error: 'unparseable' });
      continue;
    }
    for (const e of Array.isArray(cfg.plugin) ? cfg.plugin : []) {
      const v = pluginEntryVersion(typeof e === 'string' ? e : Array.isArray(e) ? e[0] : undefined);
      if (v) out.push({ file: fp, ...v });
    }
  }
  return out;
}

function pyVersionDirs(libDir) {
  try {
    return readdirSync(libDir).filter((d) => /^python3\.\d+$/.test(d)).map((d) => path.join(libDir, d));
  } catch {
    return [];
  }
}

/** Candidate site-packages roots for a magic-hermes install (read-only probe). */
export function hermesCompatCandidates(env = process.env) {
  if (env.MAGIC_OMO_HERMES_COMPAT) return [env.MAGIC_OMO_HERMES_COMPAT];
  const home = runtimeHome(env);
  const libs = [
    path.join(home, '.local', 'lib'),
    path.join(home, '.hermes', 'venv', 'lib'),
    '/usr/local/lib/hermes-agent/venv/lib',
    '/opt/hermes-agent/venv/lib',
    '/usr/local/lib',
    '/usr/lib',
  ];
  const out = [];
  for (const lib of libs) {
    for (const py of pyVersionDirs(lib)) {
      for (const sp of ['site-packages', 'dist-packages']) out.push(path.join(py, sp, 'magic_hermes', 'magic_context_compat.json'));
    }
  }
  return out;
}

export function hermesCompat(env = process.env) {
  for (const p of hermesCompatCandidates(env)) {
    const t = readText(p);
    if (!t) continue;
    try {
      const j = JSON.parse(t);
      const s = Array.isArray(j.supported_series) ? j.supported_series.join('.') : undefined;
      return { file: p, series: s, tested: j.tested_version };
    } catch {
      return { file: p, error: 'unparseable' };
    }
  }
  return undefined;
}
