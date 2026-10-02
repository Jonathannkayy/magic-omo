// Read-only health checks. Nothing here writes anything (the DB is opened
// read-only; the optional model probe is the only thing that executes `omo`).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { COMPAT, hostStatus, PIN, PKG, series } from './compat.js';
import { buildFence, schemaVersion } from './db.js';
import { autoMemoryState, OMO_AUTO_MEMORY_SUBSYSTEMS, safeParse } from './edits.js';
import { classifyModel, collectPiModels } from './historian.js';
import { locateOmo, probeModel, senpiContract } from './omo.js';
import { allPaths } from './paths.js';
import { hermesCompat, openCodeMagicContext } from './peers.js';
import { verifyVendor } from './vendor.js';

export const STATUS_ORDER = { PASS: 0, INFO: 1, WARN: 2, FAIL: 3 };

function readText(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

/** Is the bridge's extension path present in OMO settings? */
export function bridgeState(paths) {
  const text = readText(paths.settings);
  if (text === undefined) return { settingsExists: false, live: false };
  const p = safeParse(text);
  if (p.error) return { settingsExists: true, parseError: p.error, live: false };
  const s = p.value;
  const exts = Array.isArray(s.extensions) ? s.extensions : [];
  return {
    settingsExists: true,
    settings: s,
    live: exts.includes(paths.extension),
    compactionEnabled: s.compaction?.enabled,
  };
}

/** Other ways Magic Context could ALSO be loaded into OMO (double-load conflict). */
export function otherMagicContextLoaders(settings, paths) {
  const found = [];
  const mc = (x) => typeof x === 'string' && /magic-context/i.test(x) && x !== paths.extension;
  for (const e of Array.isArray(settings?.extensions) ? settings.extensions : []) if (mc(e)) found.push(`settings extensions[]: ${e}`);
  for (const p of Array.isArray(settings?.packages) ? settings.packages : []) {
    const src = typeof p === 'string' ? p : p?.source;
    if (mc(src)) found.push(`settings packages[]: ${src}`);
  }
  try {
    for (const f of readdirSync(path.join(paths.agentDir, 'extensions'))) {
      if (/magic-context/i.test(f)) found.push(`auto-discovered ${path.join(paths.agentDir, 'extensions', f)}`);
    }
  } catch { /* no extensions dir */ }
  return found;
}

/**
 * Run every check. Options:
 *   env, strict (unverified host => FAIL), probe (run the opt-in model probe),
 *   fullVendor (hash every vendored file; default true).
 */
export async function runDoctor({ env = process.env, strict = false, probe = false, fullVendor = true, omoLocator = locateOmo } = {}) {
  const checks = [];
  const add = (id, status, title, detail, extra = {}) => checks.push({ id, status, title, detail, hard: false, ...extra });
  const paths = allPaths(env);

  // -- runtime
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('node', nodeMajor >= 20 ? 'PASS' : 'FAIL', 'Node.js runtime', `node ${process.versions.node} (magic-omo needs >= 20)`);
  add('paths', 'INFO', 'Resolved paths',
    `agent dir ${paths.agentDir} [${paths.agentDirSource}]; settings ${paths.settings}; omo config ${paths.omoConfig}; ` +
      `MC config ${paths.mcConfig}; store ${paths.storageDir} [${paths.storageSource}]`,
    { data: paths });

  // -- host
  const omo = omoLocator(env);
  if (!omo.pkgRoot) {
    add('omo', 'FAIL', 'OMO Native (omo-ai)', `not found (binary: ${omo.bin ?? 'not on PATH'}). Install OMO Native or set MAGIC_OMO_OMO_PKG.`, { hard: true });
  } else {
    const st = hostStatus('omo', omo.version);
    const status = st === 'verified' ? 'PASS' : strict ? 'FAIL' : 'WARN';
    add('omo', status, 'OMO Native (omo-ai)', `${omo.version} at ${omo.pkgRoot} — ${st === 'verified' ? 'verified' : `not verified with Magic Context ${PIN.magic_context} (verified: ${PIN.omo})`}`, { hard: status === 'FAIL', data: { version: omo.version, bin: omo.bin } });
  }
  if (omo.pkgRoot && !omo.senpiRoot) {
    add('senpi', 'FAIL', 'Senpi engine', 'not found under omo-ai', { hard: true });
  } else if (omo.senpiRoot) {
    const st = hostStatus('senpi', omo.senpiVersion);
    const status = st === 'verified' ? 'PASS' : strict ? 'FAIL' : 'WARN';
    add('senpi', status, 'Senpi engine', `${omo.senpiVersion} — ${st === 'verified' ? 'verified' : `not verified (verified: ${PIN.senpi})`}`, { hard: status === 'FAIL', data: { version: omo.senpiVersion } });
    const c = senpiContract(omo.senpiRoot);
    add('senpi-hooks', c.compactHook === false ? 'FAIL' : c.compactHook ? 'PASS' : 'WARN', 'Senpi extension hook contract',
      c.compactHook ? 'session_before_compact is dispatched' : c.compactHook === false ? 'session_before_compact no longer dispatched; Magic Context cannot own compaction' : 'runner.js unreadable', { hard: c.compactHook === false });
    add('update-immunity', c.localPinnedSkip === false ? 'FAIL' : c.localPinnedSkip ? 'PASS' : 'WARN', 'Update immunity of local extension',
      c.localPinnedSkip ? 'Senpi update checker skips local/pinned sources, so `omo update` never moves the bridge'
        : c.localPinnedSkip === false ? 'update checker no longer visibly skips local/pinned sources; re-verify before trusting `omo update`' : 'package-manager.js unreadable',
      { hard: c.localPinnedSkip === false });
  }

  // -- vendored extension
  const v = verifyVendor(env, { full: fullVendor });
  const bs = bridgeState(paths);
  if (!v.present) {
    add('vendor', bs.live ? 'FAIL' : 'INFO', 'Pinned Magic Context Pi runtime', `not installed at ${v.ext}${bs.live ? ' but OMO settings reference it' : ' (run `magic-omo setup`)'}`, { hard: bs.live });
  } else {
    const problems = [];
    if (v.version !== PIN.magic_context) problems.push(`version ${v.version} != pin ${PIN.magic_context}`);
    if (!v.lockOk) problems.push(`lockfile version/integrity does not match pin (${v.lock?.version ?? 'none'} ${v.lock?.integrity?.slice(0, 19) ?? ''})`);
    if (v.sums?.missingManifest) problems.push('SHA256SUMS manifest missing');
    if (v.sums?.bad?.length) problems.push(`${v.sums.bad.length} file(s) changed vs SHA256SUMS (e.g. ${v.sums.bad[0]})`);
    if (v.sums?.missing?.length) problems.push(`${v.sums.missing.length} file(s) missing (e.g. ${v.sums.missing[0]})`);
    add('vendor', problems.length ? 'FAIL' : 'PASS', 'Pinned Magic Context Pi runtime',
      problems.length ? problems.join('; ') : `${PIN.package}@${v.version}, integrity matches pin${v.sums?.checked ? `, ${v.sums.checked} files match SHA256SUMS` : ''}`,
      { hard: problems.length > 0 });
  }

  // -- schema fence
  const fence = v.present ? buildFence(v.ext) : undefined;
  if (v.present) {
    add('fence-build', fence === PIN.schema_fence ? 'PASS' : 'FAIL', 'Build schema fence',
      fence === undefined ? 'LATEST_SUPPORTED_VERSION not found in vendored dist' : `build supports schema <= v${fence} (pin v${PIN.schema_fence})`, { hard: fence !== PIN.schema_fence });
  }
  const effFence = fence ?? PIN.schema_fence;
  const sv = await schemaVersion(paths.db, env);
  if (sv.missing) add('db', 'INFO', 'Shared context.db', `no database yet at ${paths.db} (created on first Magic Context run)`);
  else if (sv.skipped) add('db', 'INFO', 'Shared context.db', `schema check skipped: ${sv.skipped}`);
  else if (sv.error) add('db', 'WARN', 'Shared context.db', `could not read schema (${sv.via}): ${sv.error}`);
  else if (sv.version > effFence) add('db', 'FAIL', 'Shared context.db', `schema v${sv.version} is NEWER than this build's fence v${effFence}: the pinned extension fails closed. Another host upgraded Magic Context; upgrade magic-omo to the same series.`, { hard: true, data: sv });
  else add('db', 'PASS', 'Shared context.db', `schema v${sv.version} <= fence v${effFence} (read-only via ${sv.via})`, { data: sv });

  // -- same-series rule
  const mySeries = series(PIN.magic_context);
  const oc = openCodeMagicContext(env);
  if (!oc.length) add('series-opencode', 'INFO', 'OpenCode Magic Context', 'no Magic Context plugin entry found in OpenCode config');
  for (const o of oc) {
    if (o.error) add('series-opencode', 'WARN', 'OpenCode Magic Context', `${o.file}: ${o.error}`);
    else if (!o.version) add('series-opencode', 'WARN', 'OpenCode Magic Context', `${o.entry}: version not detectable (unpinned/latest?); must be series ${mySeries}`);
    else add('series-opencode', series(o.version) === mySeries ? 'PASS' : 'FAIL', 'OpenCode Magic Context', `${o.version} via ${o.via} (bridge ${PIN.magic_context})`, { hard: series(o.version) !== mySeries });
  }
  const mh = hermesCompat(env);
  if (!mh) add('series-hermes', 'INFO', 'magic-hermes', 'not found (optional)');
  else if (mh.error) add('series-hermes', 'WARN', 'magic-hermes', `${mh.file}: ${mh.error}`);
  else add('series-hermes', mh.series === mySeries ? 'PASS' : 'FAIL', 'magic-hermes', `supported series ${mh.series} (bridge ${mySeries}) — ${mh.file}`, { hard: mh.series !== mySeries });

  // -- OMO settings
  if (!bs.settingsExists) {
    add('settings', 'INFO', 'OMO agent settings', `${paths.settings} does not exist yet`);
  } else if (bs.parseError) {
    add('settings', 'FAIL', 'OMO agent settings', `${paths.settings}: ${bs.parseError}`, { hard: true });
  } else {
    add('bridge', bs.live ? 'PASS' : 'INFO', 'Bridge loaded by OMO', bs.live ? `extensions[] contains ${paths.extension}` : 'not installed (extensions[] does not reference the pinned runtime)', { data: { live: bs.live } });
    if (bs.live) {
      add('compaction', bs.compactionEnabled === false ? 'WARN' : 'PASS', 'OMO native compaction setting',
        bs.compactionEnabled === false
          ? 'compaction.enabled=false: OMO\'s resume check has no recovery path, so a session that outgrew the window refuses every turn. Set compaction.enabled=true; Magic Context still cancels native compaction.'
          : 'compaction.enabled is on (recovery path kept; Magic Context cancels native compaction via session_before_compact)');
    }
    const others = otherMagicContextLoaders(bs.settings, paths);
    if (others.length) add('double-load', 'FAIL', 'Duplicate Magic Context loaders', others.join('; '), { hard: true });
  }

  // -- OMO automatic memory
  const omoText = readText(paths.omoConfig);
  if (omoText !== undefined) {
    const p = safeParse(omoText);
    if (p.error) add('omo-memory', 'WARN', 'OMO automatic memory', `${paths.omoConfig}: ${p.error}`);
    else {
      const st = autoMemoryState(p.value);
      const on = OMO_AUTO_MEMORY_SUBSYSTEMS.filter((k) => st[k] !== 'off');
      add('omo-memory', on.length === 0 ? 'PASS' : bs.live ? 'WARN' : 'INFO', 'OMO automatic memory',
        on.length === 0 ? '[native].memory facts/recall/nudge/reflection/dream are off; curated memory (`memory` tool, soul/persona) untouched'
          : `still on: ${on.join(', ')}. Two automatic memory injectors duplicate context (use \`magic-omo setup\`, or keep deliberately with --keep-omo-memory)`);
    }
  } else {
    add('omo-memory', bs.live ? 'WARN' : 'INFO', 'OMO automatic memory', `${paths.omoConfig} not found: OMO automatic memory runs with defaults (on)`);
  }

  // -- Magic Context config: historian/dreamer + todowrite
  const mcText = readText(paths.mcConfig);
  if (mcText === undefined) {
    add('mc-config', 'INFO', 'Magic Context config', `${paths.mcConfig} not found (Magic Context defaults apply)`);
  } else {
    const p = safeParse(mcText);
    if (p.error) add('mc-config', 'FAIL', 'Magic Context config', `${paths.mcConfig}: ${p.error}`, { hard: false });
    else {
      const cfg = p.value;
      const models = collectPiModels(cfg);
      if (!models.length) add('historian', 'WARN', 'Historian/dreamer model (pi)', 'no historian.pi model configured: Magic Context falls back to its defaults, which may not resolve on OMO');
      for (const m of models) {
        const c = classifyModel(m.model);
        add(`model:${m.where}`, c.status, `Model ${m.where}`, `${m.model} — ${c.message}`, { data: { model: m.model, spawned: c.spawned, code: c.code } });
      }
      if (probe) {
        const seen = new Set();
        for (const m of models) {
          if (seen.has(m.model)) continue;
          seen.add(m.model);
          const c = classifyModel(m.model);
          if (c.status === 'FAIL') continue;
          const r = probeModel(c.spawned, { bin: omo.bin, env });
          const map = { ok: 'PASS', ambiguous: 'WARN', not_found: 'FAIL', no_auth: 'FAIL', unknown: 'WARN', unavailable: 'WARN' };
          const hint = r.status === 'ambiguous'
            ? ' — OMO caches provider availability; retry once. If it persists, remove the unused credential for the second provider, or use an OMO-native prefix (and make sure other hosts reading historian.pi accept it).'
            : '';
          add(`probe:${m.model}`, map[r.status], `Probe ${m.model}`, `${r.status}: ${r.detail}${hint}`, { data: r });
        }
      } else if (models.some((m) => classifyModel(m.model).status !== 'FAIL')) {
        add('probe', 'INFO', 'Model resolution probe', 'skipped (opt-in: `magic-omo doctor --probe-models` makes one small model call per distinct model)');
      }
      const todo = cfg.todowrite?.enabled;
      add('todowrite', todo === false ? 'PASS' : 'INFO', 'Magic Context todowrite',
        todo === false ? 'disabled (OMO ships its own `todo` tool)' : 'enabled: OMO also has its own `todo` tool; consider todowrite.enabled=false (shared config — setup asks first)');
    }
  }

  add('restart', 'INFO', 'Running sessions', 'running OMO sessions keep the setup they started with; restart them after setup/uninstall');

  const worst = checks.reduce((w, c) => (STATUS_ORDER[c.status] > STATUS_ORDER[w] ? c.status : w), 'PASS');
  return {
    tool: 'magic-omo',
    version: PKG.version,
    pin: PIN,
    compat_rows: COMPAT.matrix.length,
    strict,
    ok: worst !== 'FAIL',
    worst,
    live: bs.live,
    counts: Object.fromEntries(['PASS', 'INFO', 'WARN', 'FAIL'].map((s) => [s, checks.filter((c) => c.status === s).length])),
    checks,
  };
}

const COLORS = { PASS: '\x1b[32m', INFO: '\x1b[36m', WARN: '\x1b[33m', FAIL: '\x1b[31m' };

export function formatDoctor(report, { color = false } = {}) {
  const lines = [`magic-omo ${report.version} doctor — Magic Context ${report.pin.magic_context} (schema fence v${report.pin.schema_fence})`, ''];
  for (const c of report.checks) {
    const tag = color ? `${COLORS[c.status]}${c.status.padEnd(4)}\x1b[0m` : c.status.padEnd(4);
    lines.push(`  ${tag}  ${c.title}: ${c.detail}`);
  }
  const k = report.counts;
  lines.push('', `${k.PASS} pass, ${k.WARN} warn, ${k.FAIL} fail, ${k.INFO} info — ${report.ok ? 'OK' : 'NEEDS ATTENTION'}`);
  return lines.join('\n');
}

export function hasFile(p) {
  return existsSync(p);
}
