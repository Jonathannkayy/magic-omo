// The version contract (compat.json) and helpers to compare against it.
//
// compat.json carries several pins (newest first). Which one a machine uses is
// decided by selectPin() in ./pins.js; everything here is pure data access.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COMPAT = JSON.parse(readFileSync(path.join(ROOT, 'compat.json'), 'utf8'));
export const PINS = Object.freeze([...COMPAT.pins]);
export const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

export function series(version) {
  const m = /^(\d+)\.(\d+)/.exec(String(version ?? ''));
  return m ? `${m[1]}.${m[2]}` : undefined;
}

/** The pin for an exact Magic Context version, or undefined. */
export function pinFor(version, compat = COMPAT) {
  return compat.pins.find((p) => p.magic_context === version);
}

/** The newest pin with at least one verified matrix row (else the newest pin). */
export function newestVerifiedPin(compat = COMPAT) {
  return compat.pins.find((p) => compat.matrix.some((r) => r.magic_context === p.magic_context && r.status === 'verified')) ?? compat.pins[0];
}

/** compat.json's default_pin; falls back to the newest verified pin. */
export function defaultPin(compat = COMPAT) {
  return pinFor(compat.default_pin, compat) ?? newestVerifiedPin(compat);
}

export const DEFAULT_PIN = defaultPin();

/** Matrix rows for one Magic Context version. */
export function rowsFor(mc, compat = COMPAT) {
  return compat.matrix.filter((r) => r.magic_context === mc);
}

/** Classify a host (omo/senpi) version against the matrix rows for a Magic Context version. */
export function hostStatus(kind, version, mc = DEFAULT_PIN.magic_context) {
  if (!version) return 'missing';
  const rows = rowsFor(mc).filter((r) => r[kind] === version);
  if (rows.some((r) => r.status === 'verified')) return 'verified';
  if (rows.some((r) => r.status === 'broken')) return 'broken';
  if (rows.length) return 'listed-unverified';
  return 'unknown';
}

/** Host versions with a verified row for a Magic Context version. */
export function verifiedHosts(kind, mc) {
  return [...new Set(rowsFor(mc).filter((r) => r.status === 'verified').map((r) => r[kind]))];
}

/** Absolute paths of the vendor manifests shipped for a pin. */
export function pinManifests(pin) {
  const lock = path.join(ROOT, ...pin.lockfile.split('/'));
  return { lock, pkg: path.join(path.dirname(lock), 'package.json') };
}
