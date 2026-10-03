// Filesystem primitives: atomic writes that preserve mode, timestamped backups.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/**
 * Atomically replace `file` with `content` (temp file in the same directory +
 * rename). The existing file's mode is preserved; new files get `defaultMode`.
 */
export function atomicWrite(file, content, { defaultMode = 0o600 } = {}) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  let mode = defaultMode;
  if (existsSync(file)) mode = statSync(file).mode & 0o7777;
  const tmp = path.join(dir, `.${path.basename(file)}.magic-omo-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', mode);
  try {
    writeSync(fd, typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

export function writeJson(file, value, opts) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`, opts);
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Copy `file` into `<backupRoot>/<ts>/<label>` and return the backup path + sha256. */
export function backup(file, backupRoot, ts, label = path.basename(file)) {
  if (!existsSync(file)) return undefined;
  const dir = path.join(backupRoot, ts);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, label);
  copyFileSync(file, dest);
  const digest = sha256(readFileSync(dest));
  const sums = path.join(dir, 'SHA256SUMS');
  const prior = existsSync(sums) ? readFileSync(sums, 'utf8') : '';
  atomicWrite(sums, `${prior}${digest}  ${label}\n`);
  return { path: dest, sha256: digest, source: file };
}

/** True when `child` is inside directory `parent`. */
export function isWithin(parent, child) {
  return child.startsWith(parent);
}
