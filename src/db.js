// Read-only access to the shared Magic Context database and the build's schema fence.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { which } from './omo.js';

let sqliteMod;
async function nodeSqlite() {
  if (sqliteMod !== undefined) return sqliteMod;
  try {
    const orig = process.emitWarning;
    process.emitWarning = () => {};
    try {
      sqliteMod = await import('node:sqlite');
    } finally {
      process.emitWarning = orig;
    }
  } catch {
    sqliteMod = null;
  }
  return sqliteMod;
}

/**
 * Return { version, via } or { error, via } or { skipped } for `select max(version) from schema_migrations`.
 * The database is opened READ-ONLY; nothing is ever written.
 */
export async function schemaVersion(dbPath, env = process.env) {
  if (!existsSync(dbPath)) return { missing: true };
  const forced = env.MAGIC_OMO_SQLITE; // 'node' | 'cli' | 'none' (tests)
  const mod = forced === 'cli' || forced === 'none' ? null : await nodeSqlite();
  if (mod?.DatabaseSync) {
    let db;
    try {
      db = new mod.DatabaseSync(dbPath, { readOnly: true });
      const row = db.prepare('select max(version) as v from schema_migrations').get();
      return { version: row?.v ?? null, via: 'node:sqlite' };
    } catch (e) {
      return { error: String(e.message || e), via: 'node:sqlite' };
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }
  const bin = forced === 'none' ? undefined : env.MAGIC_OMO_SQLITE3 || which('sqlite3', env);
  if (bin) {
    const r = spawnSync(bin, ['-readonly', dbPath, 'select max(version) from schema_migrations;'], { encoding: 'utf8', timeout: 15_000 });
    if (r.status === 0) {
      const v = r.stdout.trim();
      return { version: v === '' ? null : Number(v), via: 'sqlite3 -readonly' };
    }
    return { error: (r.stderr || '').trim() || `sqlite3 exit ${r.status}`, via: 'sqlite3 -readonly' };
  }
  return { skipped: 'no node:sqlite and no sqlite3 binary' };
}

/** Find `LATEST_SUPPORTED_VERSION = N` in the vendored extension's dist bundle. */
export function buildFence(extDir) {
  const dist = path.join(extDir, 'dist');
  let files;
  try {
    files = readdirSync(dist).filter((f) => f.endsWith('.js'));
  } catch {
    return undefined;
  }
  for (const f of files) {
    const m = /LATEST_SUPPORTED_VERSION\s*=\s*(\d+)/.exec(readFileSync(path.join(dist, f), 'utf8'));
    if (m) return Number(m[1]);
  }
  return undefined;
}
