// Mutating operations: setup (install) and uninstall.
//
// Rules: back up before writing; atomic temp+rename preserving mode; idempotent;
// every change is recorded so uninstall reverts EXACTLY those changes. OMO keeps
// rewriting settings.json (tipsHistory, last model, …), so uninstall never
// restores whole files — it surgically undoes recorded edits only.
import { existsSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { PKG } from './compat.js';
import { EMPTY_OBJECT_TEXT, planMemoryPolicy, planSettings, planTodowrite, revertEdits } from './edits.js';
import { atomicWrite, backup, readJson, stamp, writeJson } from './fsutil.js';
import { allPaths, extensionDir, legacyExtensionDir, ownExtensionPaths } from './paths.js';
import { findNode, parseTree, toValue } from './jsonc.js';

function readText(p) {
  return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
}

export function readRecord(paths) {
  try {
    return readJson(paths.record);
  } catch {
    return undefined;
  }
}

/**
 * Compute every change setup would make, without writing anything.
 * opts: { pin (required), memoryPolicy: bool, todowrite: bool, record }
 */
export function planSetup(env = process.env, { pin, memoryPolicy = true, todowrite = false, record } = {}) {
  if (!pin) throw new Error('planSetup needs the selected pin');
  const paths = allPaths(env, pin.magic_context);
  const settingsText = readText(paths.settings);
  const priorExt = priorExtension(env, paths, pin, record, settingsText);
  const files = [];
  const s = planSettings(settingsText ?? EMPTY_OBJECT_TEXT, paths.extension, { priorExt });
  files.push({ role: 'settings', file: paths.settings, created: settingsText === undefined, before: settingsText, after: s.text, edits: s.edits, notes: s.notes });
  if (memoryPolicy) {
    const t = readText(paths.omoConfig);
    const m = planMemoryPolicy(t ?? EMPTY_OBJECT_TEXT);
    files.push({ role: 'omo-memory', file: paths.omoConfig, created: t === undefined, before: t, after: m.text, edits: m.edits, notes: m.notes });
  }
  if (todowrite) {
    const t = readText(paths.mcConfig);
    const m = planTodowrite(t ?? EMPTY_OBJECT_TEXT);
    files.push({ role: 'mc-todowrite', file: paths.mcConfig, created: t === undefined, before: t, after: m.text, edits: m.edits, notes: m.notes });
  }
  return { paths, files };
}

function settingsExtensions(text) {
  if (text === undefined) return [];
  try {
    const n = findNode(parseTree(text), ['extensions']);
    return n?.type === 'array' ? toValue(n) : [];
  } catch {
    return [];
  }
}

/**
 * The runtime path a previous setup left in extensions[] that the selected one should
 * REPLACE (recorded, revertible). In order: the path the record says we installed
 * (covers the pre-multi-pin flat layout `<home>/vendor/node_modules/...`), the
 * record's version under the per-version layout, and the legacy flat path when
 * there is no record at all.
 */
export function priorExtension(env, paths, pin, record, settingsText) {
  const exts = settingsExtensions(settingsText);
  const candidates = [
    record?.extension,
    record?.magic_context ? extensionDir(env, record.magic_context, pin.package) : undefined,
    legacyExtensionDir(env, pin.package),
  ];
  return candidates.find((c) => typeof c === 'string' && c !== paths.extension && exts.includes(c));
}

export function describeEdit(e) {
  const p = [...e.path, ...(e.key ? [e.key] : [])].join('.');
  if (e.op === 'appendElement') return `append ${JSON.stringify(e.value)} to ${p}`;
  if (e.op === 'replaceElement') return `replace ${JSON.stringify(e.prior)} with ${JSON.stringify(e.value)} in ${p}`;
  if (e.op === 'insertMember') return `add ${p} = ${JSON.stringify(e.value)}`;
  if (e.op === 'replaceValue') return `set ${p} = ${JSON.stringify(e.value)} (was ${e.priorRaw})`;
  return `${e.op} ${p}`;
}

/**
 * Apply a plan produced by planSetup. Merges into an existing install record so a
 * second setup (e.g. adding todowrite later) stays revertible.
 */
export function applySetup(plan, _env = process.env, { log = () => {} } = {}) {
  const { paths } = plan;
  const ts = stamp();
  const prior = readRecord(paths);
  const record = prior ?? {
    tool: 'magic-omo',
    tool_version: PKG.version,
    magic_context: paths.magic_context,
    agent_dir: paths.agentDir,
    extension: paths.extension,
    installed_at: new Date().toISOString(),
    files: [],
  };
  const meta = (r) => JSON.stringify([r.tool_version, r.magic_context, r.extension]);
  const metaBefore = prior ? meta(prior) : undefined;
  record.tool_version = PKG.version;
  record.magic_context = paths.magic_context;
  record.extension = paths.extension;
  const metaChanged = prior !== undefined && meta(record) !== metaBefore;
  let changed = 0;
  for (const f of plan.files) {
    if (!f.edits.length) {
      for (const n of f.notes) log(`  = ${n}`);
      continue;
    }
    // Re-read right before writing: OMO may have rewritten the file since planning.
    const current = readText(f.file);
    if (current !== f.before) throw new Error(`${f.file} changed while planning; re-run setup`);
    const b = f.created ? undefined : backup(f.file, path.join(paths.magicOmoHome, 'backups'), ts, `${f.role}-${path.basename(f.file)}`);
    atomicWrite(f.file, f.after);
    changed++;
    for (const e of f.edits) log(`  + ${path.basename(f.file)}: ${describeEdit(e)}`);
    let entry = record.files.find((x) => x.file === f.file && x.role === f.role);
    if (!entry) {
      entry = { role: f.role, file: f.file, created: f.created, edits: [], backups: [] };
      record.files.push(entry);
    }
    entry.edits.push(...f.edits);
    if (b) entry.backups.push(b.path);
  }
  // The selected pin is part of the record even when no config file needed an edit
  // (e.g. the runtime path was already present): later setup/doctor runs read it.
  if (changed || !prior || metaChanged) {
    record.updated_at = new Date().toISOString();
    writeJson(paths.record, record);
  }
  return { record, changed, recordPath: paths.record };
}

/**
 * Revert everything the install record says we did.
 * Without a record, falls back to the minimal safe action: remove our extension path.
 */
export function uninstall(env = process.env, { dryRun = false, log = () => {} } = {}) {
  const paths = allPaths(env);
  const record = readRecord(paths);
  const ts = stamp();
  const results = [];
  if (!record) {
    const text = readText(paths.settings);
    if (text === undefined) return { status: 'not-installed', results };
    // No record: remove any of OUR vendored extension paths (one per installed version).
    const candidates = ownExtensionPaths(env);
    let out = text;
    const removed = [];
    for (const ext of candidates) {
      const r = revertEdits(out, [{ op: 'appendElement', path: ['extensions'], value: ext }]);
      if (r.text !== out) {
        out = r.text;
        removed.push(ext);
        results.push(...r.results.map((x) => ({ file: paths.settings, ...x })));
      }
    }
    if (!removed.length) return { status: 'not-installed', results };
    log(`no install record; removing ${removed.join(', ')} from extensions[] only (compaction left as is)`);
    if (!dryRun) {
      backup(paths.settings, path.join(paths.magicOmoHome, 'backups'), ts, `uninstall-settings-${path.basename(paths.settings)}`);
      atomicWrite(paths.settings, out);
    }
    return { status: 'reverted-without-record', results };
  }
  for (const entry of [...record.files].reverse()) {
    const text = readText(entry.file);
    if (text === undefined) {
      results.push({ file: entry.file, status: 'file-missing' });
      continue;
    }
    const r = revertEdits(text, entry.edits);
    for (const x of r.results) {
      results.push({ file: entry.file, ...x });
      log(`  ${x.status === 'reverted' ? '-' : '='} ${path.basename(entry.file)}: ${x.path} ${x.status}`);
    }
    if (r.text !== text && !dryRun) {
      backup(entry.file, path.join(paths.magicOmoHome, 'backups'), ts, `uninstall-${entry.role}-${path.basename(entry.file)}`);
      atomicWrite(entry.file, r.text);
    }
  }
  if (!dryRun) renameSync(paths.record, `${paths.record}.reverted-${ts}`);
  const modified = results.filter((r) => r.status === 'modified');
  return { status: modified.length ? 'reverted-with-user-changes-kept' : 'reverted', results };
}
