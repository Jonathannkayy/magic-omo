#!/usr/bin/env node
// Static upstream contract check: does a given omo-ai + Magic Context pair still
// expose everything magic-omo depends on? No secrets, no model calls, no network
// beyond `npm install --ignore-scripts` of the requested versions into a temp dir.
//
//   node scripts/contract-check.js --omo-ai 5.1.9 --mc 0.44.4 [--keep]
//   node scripts/contract-check.js --omo-ai /path/to/omo-ai --mc /path/to/pi-magic-context
//
// Prints {ok, checks:[{id, ok, detail}], versions} as JSON and exits 1 when a
// check fails (2 on a usage/setup error).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { senpiContract } from '../src/omo.js';

export function parseArgs(argv) {
  const out = { keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--omo-ai') out.omo = argv[++i];
    else if (a === '--mc') out.mc = argv[++i];
    else if (a === '--keep') out.keep = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
};

const readJson = (p) => {
  const t = read(p);
  if (t === undefined) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** Every *.js file under dir, recursively (bounded depth; bundles are flat). */
function jsFiles(dir, depth = 4, out = []) {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0 && e.name !== 'node_modules') jsFiles(p, depth - 1, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Install `spec` into a temp dir with --ignore-scripts and return the package root. */
function installPackage(name, spec, tmp) {
  if (spec.includes('/') || spec.startsWith('.') || existsSync(spec)) {
    const root = path.resolve(spec);
    if (!existsSync(path.join(root, 'package.json'))) throw new Error(`${root} has no package.json`);
    return { root, source: 'path' };
  }
  const dir = path.join(tmp, name.replace('/', '-'));
  writeFileSync(path.join(tmp, '.keep'), '');
  spawnSync('mkdir', ['-p', dir]);
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'contract-check', version: '0.0.0', private: true }));
  const r = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=peer', `${name}@${spec}`], {
    cwd: dir, encoding: 'utf8', timeout: 900_000,
  });
  if (r.status !== 0) throw new Error(`npm install ${name}@${spec} failed: ${(r.stderr || r.stdout || '').trim().slice(-400)}`);
  return { root: path.join(dir, 'node_modules', ...name.split('/')), source: `npm ${spec}` };
}

/** The five OMO automatic-memory sub-keys magic-omo switches off. */
export const MEMORY_SUBKEYS = ['facts', 'recall', 'nudge', 'reflection', 'dream'];

/**
 * Is `[native].memory.{facts,recall,nudge,reflection,dream}.enabled` still accepted?
 * The plugin bundle is minified, so identifiers are useless: we look for a strict
 * object schema region that declares `memory:<id>.optional()` and, nearby, all five
 * sub-keys, each on an object that carries an `enabled` field.
 */
export function memorySchemaEvidence(text) {
  const anchor = /memory\s*:\s*[A-Za-z_$][\w$]*\s*\.optional\(\)/.exec(text);
  if (!anchor) return { ok: false, detail: 'no `memory:<schema>.optional()` member found in the config schema' };
  // Take a generous window around the anchor: the sub-schemas are defined next to it.
  const from = Math.max(0, anchor.index - 20000);
  const region = text.slice(from, anchor.index + 20000);
  const missing = MEMORY_SUBKEYS.filter((k) => !new RegExp(`${k}\\s*:\\s*[A-Za-z_$][\\w$]*\\s*\\.(optional|default)\\(`).test(region));
  const enabled = /enabled\s*:\s*[A-Za-z_$][\w$]*\(\)\s*\.(optional|default)\(/.test(region);
  if (missing.length) return { ok: false, detail: `memory schema found but sub-keys missing: ${missing.join(', ')}` };
  if (!enabled) return { ok: false, detail: 'memory sub-schemas found but no `enabled` field near them' };
  return { ok: true, detail: `memory schema accepts ${MEMORY_SUBKEYS.join('/')} with an \`enabled\` field` };
}

export function checkOmo(omoRoot) {
  const checks = [];
  const pkg = readJson(path.join(omoRoot, 'package.json'));
  const senpiRoot = path.join(omoRoot, 'node_modules', '@code-yeongyu', 'senpi');
  const senpiAlt = path.join(path.dirname(omoRoot), '@code-yeongyu', 'senpi');
  const sr = existsSync(path.join(senpiRoot, 'package.json')) ? senpiRoot : senpiAlt;
  const senpiPkg = readJson(path.join(sr, 'package.json'));
  const c = senpiContract(sr);

  checks.push({ id: 'senpi-present', ok: Boolean(senpiPkg), detail: senpiPkg ? `@code-yeongyu/senpi ${senpiPkg.version} at ${sr}` : `senpi not found under ${omoRoot}` });
  checks.push({
    id: 'senpi-compact-hook',
    ok: c.compactHook === true,
    detail: c.compactHook === true ? 'runner.js dispatches "session_before_compact"'
      : c.compactHook === false ? 'runner.js no longer dispatches "session_before_compact": Magic Context cannot own compaction'
        : 'dist/core/extensions/runner.js unreadable',
  });
  checks.push({
    id: 'senpi-local-pinned-skip',
    ok: c.localPinnedSkip === true,
    detail: c.localPinnedSkip === true ? 'package-manager.js still skips local/pinned sources (`omo update` cannot move the bridge)'
      : c.localPinnedSkip === false ? 'package-manager.js no longer visibly skips local/pinned sources'
        : 'dist/core/package-manager.js unreadable',
  });

  const agentDir = read(path.join(omoRoot, 'bin', 'lib', 'agent-dir.js'));
  const envNames = ['OMO_CODING_AGENT_DIR', 'SENPI_CODING_AGENT_DIR', 'PI_CODING_AGENT_DIR'];
  const missingEnv = agentDir === undefined ? envNames : envNames.filter((n) => !agentDir.includes(n));
  checks.push({
    id: 'omo-agent-dir-env',
    ok: agentDir !== undefined && missingEnv.length === 0,
    detail: agentDir === undefined ? 'bin/lib/agent-dir.js unreadable' : missingEnv.length ? `agent-dir.js no longer honours: ${missingEnv.join(', ')}` : `agent-dir.js honours ${envNames.join(', ')}`,
  });

  const bundles = jsFiles(path.join(omoRoot, 'plugin', 'extensions'));
  let best = { ok: false, detail: 'no plugin bundle contains a config schema' };
  for (const f of bundles) {
    const ev = memorySchemaEvidence(readFileSync(f, 'utf8'));
    if (ev.ok) {
      best = { ...ev, detail: `${path.basename(f)}: ${ev.detail}` };
      break;
    }
    if (!best.file) best = { ...ev, detail: `${path.basename(f)}: ${ev.detail}` };
  }
  checks.push({ id: 'omo-memory-schema', ...best });

  return { checks, versions: { 'omo-ai': pkg?.version, '@code-yeongyu/senpi': senpiPkg?.version } };
}

const ALLOWED_PEERS = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox'];

export function checkMagicContext(mcRoot) {
  const checks = [];
  const pkg = readJson(path.join(mcRoot, 'package.json'));
  const exts = pkg?.pi?.extensions;
  checks.push({
    id: 'mc-pi-extensions',
    ok: Array.isArray(exts) && exts.length > 0,
    detail: Array.isArray(exts) ? `package.json pi.extensions = ${JSON.stringify(exts)}` : 'package.json has no pi.extensions array: Senpi cannot load it as a Pi extension',
  });
  const peers = Object.keys(pkg?.peerDependencies ?? {});
  const unexpected = peers.filter((p) => !ALLOWED_PEERS.includes(p));
  checks.push({
    id: 'mc-peer-deps',
    ok: peers.length > 0 && unexpected.length === 0,
    detail: unexpected.length ? `unexpected peerDependencies: ${unexpected.join(', ')}` : `peerDependencies limited to ${peers.join(', ') || '(none declared)'}`,
  });
  let fence;
  for (const f of jsFiles(path.join(mcRoot, 'dist'), 2)) {
    const m = /LATEST_SUPPORTED_VERSION\s*=\s*(\d+)/.exec(readFileSync(f, 'utf8'));
    if (m) {
      fence = Number(m[1]);
      break;
    }
  }
  checks.push({ id: 'mc-schema-fence', ok: Number.isInteger(fence), detail: Number.isInteger(fence) ? `LATEST_SUPPORTED_VERSION = ${fence}` : 'LATEST_SUPPORTED_VERSION not found in dist' });
  return { checks, versions: { '@cortexkit/pi-magic-context': pkg?.version }, schema_fence: fence };
}

export function run({ omo, mc, keep = false } = {}) {
  const tmp = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'magic-omo-contract-'));
  try {
    const o = installPackage('omo-ai', omo, tmp);
    const m = installPackage('@cortexkit/pi-magic-context', mc, tmp);
    const ro = checkOmo(o.root);
    const rm = checkMagicContext(m.root);
    const checks = [...ro.checks, ...rm.checks];
    return {
      ok: checks.every((c) => c.ok),
      checks,
      versions: { ...ro.versions, ...rm.versions },
      schema_fence: rm.schema_fence ?? null,
      sources: { 'omo-ai': o.source, '@cortexkit/pi-magic-context': m.source },
    };
  } finally {
    if (!keep) rmSync(tmp, { recursive: true, force: true });
    else console.error(`kept ${tmp}`);
  }
}

const USAGE = `contract-check — static upstream contract check (no secrets, no model calls)

  node scripts/contract-check.js --omo-ai <version|path> --mc <version|path> [--keep]

Verifies that Senpi still dispatches session_before_compact and still skips
local/pinned sources, that omo-ai honours the agent-dir environment variables and
still accepts the [native].memory sub-keys magic-omo switches off, and that the
Magic Context build still declares pi.extensions, sane peerDependencies and a
schema fence. Prints JSON; exit 1 on a failed check, 2 on a usage error.`;

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (args.help || !args.omo || !args.mc) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  let res;
  try {
    res = run(args);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e.message), checks: [], versions: {} }, null, 2));
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify(res, null, 2));
  process.exitCode = res.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
