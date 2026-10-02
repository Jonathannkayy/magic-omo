// Mutating operations: setup (install) and uninstall.
//
// Rules: back up before writing; atomic temp+rename preserving mode; idempotent;
// every change is recorded so uninstall reverts EXACTLY those changes. OMO keeps
// rewriting settings.json (tipsHistory, last model, …), so uninstall never
// restores whole files — it surgically undoes recorded edits only.
import { existsSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { PIN, PKG } from './compat.js';
import { EMPTY_OBJECT_TEXT, planMemoryPolicy, planSettings, planTodowrite, revertEdits } from './edits.js';
import { atomicWrite, backup, readJson, stamp, writeJson } from './fsutil.js';
import { allPaths } from './paths.js';

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
 * opts: { memoryPolicy: bool, todowrite: bool }
 */
export function planSetup(env = process.env, { memoryPolicy = true, todowrite = false } = {}) {
  const paths = allPaths(env);
  const files = [];
  const settingsText = readText(paths.settings);
  const s = planSettings(settingsText ?? EMPTY_OBJECT_TEXT, paths.extension);
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

export function describeEdit(e) {
  const p = [...e.path, ...(e.key ? [e.key] : [])].join('.');
  if (e.op === 'appendElement') return `append ${JSON.stringify(e.value)} to ${p}`;
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
    magic_context: PIN.magic_context,
    agent_dir: paths.agentDir,
    extension: paths.extension,
    installed_at: new Date().toISOString(),
    files: [],
  };
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
  if (changed || !prior) {
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
    const r = revertEdits(text, [{ op: 'appendElement', path: ['extensions'], value: paths.extension }]);
    if (r.text === text) return { status: 'not-installed', results };
    log(`no install record; removing ${paths.extension} from extensions[] only (compaction left as is)`);
    if (!dryRun) {
      backup(paths.settings, path.join(paths.magicOmoHome, 'backups'), ts, `uninstall-settings-${path.basename(paths.settings)}`);
      atomicWrite(paths.settings, r.text);
    }
    return { status: 'reverted-without-record', results: r.results };
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
