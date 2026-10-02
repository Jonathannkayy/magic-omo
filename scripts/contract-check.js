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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { senpiContract, which } from '../src/omo.js';

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

/**
 * Resolve npm the same way the installer does (MAGIC_OMO_NPM, else a PATH lookup that
 * honours PATHEXT on Windows, where npm is `npm.cmd`), and say how to spawn it: since
 * the CVE-2024-27980 fix Node refuses to spawn a .cmd/.bat without a shell.
 */
export function resolveNpm(env = process.env, platform = process.platform) {
  const bin = env.MAGIC_OMO_NPM || which('npm', env);
  if (!bin) return undefined;
  return { bin, shell: platform === 'win32' && /\.(cmd|bat)$/i.test(bin) };
}

// Only plain npm version/tag specs reach the command line (they may go through a shell on Windows).
const SAFE_SPEC = /^[\w.^~<>=*+-]+$/;

/** Install `spec` into a temp dir with --ignore-scripts and return the package root. */
function installPackage(name, spec, tmp) {
  if (spec.includes('/') || spec.includes('\\') || spec.startsWith('.') || existsSync(spec)) {
    const root = path.resolve(spec);
    if (!existsSync(path.join(root, 'package.json'))) throw new Error(`${root} has no package.json`);
    return { root, source: 'path' };
  }
  if (!SAFE_SPEC.test(spec)) throw new Error(`refusing unusual version spec for ${name}: ${JSON.stringify(spec)}`);
  const npm = resolveNpm();
  if (!npm) throw new Error('npm not found on PATH (set MAGIC_OMO_NPM to override)');
  const dir = path.join(tmp, name.replace('/', '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'contract-check', version: '0.0.0', private: true }));
  const args = ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=peer', `${name}@${spec}`];
  const opts = { cwd: dir, encoding: 'utf8', timeout: 900_000 };
  // Every arg is a fixed flag or a SAFE_SPEC-checked `name@spec`, so the shell line needs no escaping.
  const r = npm.shell
    ? spawnSync(`"${npm.bin}" ${args.join(' ')}`, { ...opts, shell: true })
    : spawnSync(npm.bin, args, opts);
  if (r.error) throw new Error(`npm install ${name}@${spec} could not start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`npm install ${name}@${spec} failed: ${(r.stderr || r.stdout || '').trim().slice(-400)}`);
  return { root: path.join(dir, 'node_modules', ...name.split('/')), source: `npm ${spec}` };
}

/** The five OMO automatic-memory sub-keys magic-omo switches off. */
export const MEMORY_SUBKEYS = ['facts', 'recall', 'nudge', 'reflection', 'dream'];

const ID = '[A-Za-z_$][\\w$]*';
const esc = (id) => id.replace(/\$/g, '\\$');

/**
 * The `{...}` object literal that starts at text[open] (which must be `{`), with
 * string literals skipped so braces inside them do not count. Undefined if unbalanced.
 */
export function objectLiteralAt(text, open) {
  if (text[open] !== '{') return undefined;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  return undefined;
}

/** Top-level keys of an object literal (nested objects/calls/arrays skipped). */
export function topLevelKeys(obj) {
  const keys = [];
  let depth = 0;
  let expectKey = true;
  for (let i = 1; i < obj.length - 1; i++) {
    const ch = obj[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < obj.length && obj[i] !== ch; i++) if (obj[i] === '\\') i++;
      continue;
    }
    if ('{[('.includes(ch)) depth++;
    else if ('}])'.includes(ch)) depth--;
    else if (depth === 0 && ch === ',') expectKey = true;
    else if (depth === 0 && expectKey && /[A-Za-z_$]/.test(ch)) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(obj.slice(i));
      if (m) keys.push(m[1]);
      expectKey = false;
    }
  }
  return keys;
}

/**
 * The object literal of the schema assigned to `id` (`id=<factory>({...})`), choosing the
 * definition closest before `near` (minifiers reuse short names across scopes), else the
 * first one after it.
 */
export function schemaObjectFor(text, id, near) {
  const re = new RegExp(`(?:^|[^\\w$.])${esc(id)}\\s*=\\s*${ID}\\s*\\(\\s*\\{`, 'g');
  let before;
  let after;
  for (let m; (m = re.exec(text));) {
    const open = m.index + m[0].length - 1;
    if (open < near) before = open;
    else if (after === undefined) after = open;
  }
  const at = before ?? after;
  return at === undefined ? undefined : objectLiteralAt(text, at);
}

/**
 * Is `[native].memory.{facts,recall,nudge,reflection,dream}.enabled` still accepted?
 * The plugin bundle is minified, so identifiers are useless; we follow them instead:
 * find `memory:<parent>.optional()`, resolve <parent>'s object schema, require each of
 * the five sub-keys as `<key>:<child>.optional()|.default(`, then resolve EACH <child>'s
 * object schema and require a top-level `enabled` member in it. A bundle that drops
 * `enabled` from even one child fails.
 */
export function memorySchemaEvidence(text) {
  const anchors = [...text.matchAll(new RegExp(`memory\\s*:\\s*(${ID})\\s*\\.optional\\(\\)`, 'g'))];
  if (!anchors.length) return { ok: false, detail: 'no `memory:<schema>.optional()` member found in the config schema' };
  // A bundle carries several memory schemas (the strict user-config one, a defaults one, per
  // config variant). EVERY distinct one must still accept the keys: passing on the defaults
  // schema says nothing about whether the user's `[native].memory.<key>.enabled` validates.
  const seen = new Set();
  const ok = [];
  for (const a of anchors) {
    if (seen.has(a[1])) continue;
    seen.add(a[1]);
    const parent = schemaObjectFor(text, a[1], a.index);
    if (!parent) return { ok: false, detail: `memory schema \`${a[1]}\` has no resolvable object definition` };
    const missing = [];
    const noEnabled = [];
    for (const k of MEMORY_SUBKEYS) {
      const m = new RegExp(`(?:^|[{,])\\s*${k}\\s*:\\s*(${ID})\\s*\\.(?:optional|default)\\(`).exec(parent);
      if (!m) {
        missing.push(k);
        continue;
      }
      const child = schemaObjectFor(text, m[1], a.index);
      if (!child || !topLevelKeys(child).includes('enabled')) noEnabled.push(k);
    }
    if (missing.length) return { ok: false, detail: `memory schema \`${a[1]}\` is missing sub-keys: ${missing.join(', ')}` };
    if (noEnabled.length) return { ok: false, detail: `memory schema \`${a[1]}\`: no \`enabled\` field on ${noEnabled.join(', ')}` };
    ok.push(a[1]);
  }
  return { ok: true, detail: `${ok.length} memory schema(s) accept ${MEMORY_SUBKEYS.join('/')}, each with its own \`enabled\` field` };
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
