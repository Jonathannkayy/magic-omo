// The pinned, vendored copy of @cortexkit/pi-magic-context.
//
// Installed into <magic-omo home>/vendor with `npm install --ignore-scripts --save-exact`
// from the lockfile shipped in this repo, verified against compat.json, then frozen
// with a SHA256SUMS manifest that doctor re-verifies on every run.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { PIN, ROOT } from './compat.js';
import { atomicWrite, sha256 } from './fsutil.js';
import { which } from './omo.js';
import { extensionDir, vendorDir } from './paths.js';

function walk(dir, base = dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, base, out);
    else if (ent.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

export function lockEntry(vdir) {
  for (const f of ['package-lock.json', path.join('node_modules', '.package-lock.json')]) {
    try {
      const lock = JSON.parse(readFileSync(path.join(vdir, f), 'utf8'));
      const e = lock.packages?.[`node_modules/${PIN.package}`];
      if (e) return { file: f, version: e.version, integrity: e.integrity };
    } catch { /* try next */ }
  }
  return undefined;
}

/** Verify the vendored tree. Returns { present, version, lock, sums: {checked, bad, missing} }. */
export function verifyVendor(env = process.env, { full = true } = {}) {
  const vdir = vendorDir(env);
  const ext = extensionDir(env, PIN.package);
  const res = { dir: vdir, ext, present: existsSync(path.join(ext, 'package.json')) };
  if (!res.present) return res;
  try {
    res.version = JSON.parse(readFileSync(path.join(ext, 'package.json'), 'utf8')).version;
  } catch (e) {
    res.version = undefined;
    res.error = String(e.message);
  }
  res.lock = lockEntry(vdir);
  res.lockOk = Boolean(res.lock && res.lock.version === PIN.magic_context && res.lock.integrity === PIN.integrity);
  const sumsFile = path.join(vdir, 'SHA256SUMS');
  if (!existsSync(sumsFile)) {
    res.sums = { missingManifest: true };
    return res;
  }
  if (!full) return res;
  let checked = 0;
  const bad = [];
  const missing = [];
  for (const line of readFileSync(sumsFile, 'utf8').split('\n')) {
    if (!line) continue;
    const h = line.slice(0, 64);
    const rel = line.slice(66);
    checked++;
    const fp = path.join(vdir, rel);
    if (!existsSync(fp)) missing.push(rel);
    else if (sha256(readFileSync(fp)) !== h) bad.push(rel);
  }
  res.sums = { checked, bad, missing };
  return res;
}

export function writeSums(vdir) {
  const files = walk(path.join(vdir, 'node_modules')).sort();
  const lines = files.map((rel) => `${sha256(readFileSync(path.join(vdir, 'node_modules', rel)))}  node_modules/${rel}`);
  atomicWrite(path.join(vdir, 'SHA256SUMS'), `${lines.join('\n')}\n`, { defaultMode: 0o644 });
  return files.length;
}

/**
 * Install the pinned package. `log` receives progress lines.
 * Throws on any verification failure (nothing in OMO is touched yet at this point).
 */
export function installVendor(env = process.env, { log = () => {} } = {}) {
  const vdir = vendorDir(env);
  mkdirSync(vdir, { recursive: true });
  // Ship the exact lockfile so transitive dependencies are reproducible too.
  copyFileSync(path.join(ROOT, 'vendor', 'package.json'), path.join(vdir, 'package.json'));
  copyFileSync(path.join(ROOT, 'vendor', 'package-lock.json'), path.join(vdir, 'package-lock.json'));
  const npm = env.MAGIC_OMO_NPM || which('npm', env);
  if (!npm) throw new Error('npm not found on PATH (needed once to fetch the pinned extension)');
  const args = ['install', '--ignore-scripts', '--save-exact', '--no-audit', '--no-fund', '--omit=peer', `${PIN.package}@${PIN.magic_context}`];
  log(`npm ${args.join(' ')}  (cwd ${vdir})`);
  const r = spawnSync(npm, args, { cwd: vdir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 });
  if (r.status !== 0) throw new Error(`npm install failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().slice(-400)}`);
  const lock = lockEntry(vdir);
  if (!lock) throw new Error(`lockfile has no entry for ${PIN.package}`);
  if (lock.version !== PIN.magic_context) throw new Error(`installed ${lock.version}, pin is ${PIN.magic_context}`);
  if (lock.integrity !== PIN.integrity) throw new Error(`integrity mismatch: got ${lock.integrity}, pin ${PIN.integrity}`);
  const ext = extensionDir(env, PIN.package);
  const v = JSON.parse(readFileSync(path.join(ext, 'package.json'), 'utf8')).version;
  if (v !== PIN.magic_context) throw new Error(`extension package.json says ${v}, pin is ${PIN.magic_context}`);
  const n = writeSums(vdir);
  log(`verified ${PIN.package}@${v} (${PIN.integrity.slice(0, 19)}…); SHA256SUMS over ${n} files`);
  return { dir: vdir, ext, files: n };
}

export function vendorSize(vdir) {
  try {
    return statSync(vdir).isDirectory();
  } catch {
    return false;
  }
}
