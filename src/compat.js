// The version contract (compat.json) and helpers to compare against it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COMPAT = JSON.parse(readFileSync(path.join(ROOT, 'compat.json'), 'utf8'));
export const PIN = COMPAT.pin;
export const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

export function series(version) {
  const m = /^(\d+)\.(\d+)/.exec(String(version ?? ''));
  return m ? `${m[1]}.${m[2]}` : undefined;
}

/** Classify a host (omo/senpi) version against the matrix rows for the pinned MC. */
export function hostStatus(kind, version) {
  if (!version) return 'missing';
  const rows = COMPAT.matrix.filter((r) => r.magic_context === PIN.magic_context && r[kind] === version);
  if (rows.some((r) => r.status === 'verified')) return 'verified';
  if (rows.length) return 'listed-unverified';
  return 'unknown';
}
