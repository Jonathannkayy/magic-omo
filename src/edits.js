// Pure planning of every configuration change magic-omo makes.
// Each planner takes the current file text and returns { text, edits[], notes[] }.
// Edits are recorded verbatim in the install record so uninstall can revert
// exactly those changes and nothing else.
import { findNode, parse, parseTree, revertEdit, setPath, appendElement, insertMember, removeArrayElementAt, replaceElement, toValue } from './jsonc.js';

export const OMO_AUTO_MEMORY_SUBSYSTEMS = Object.freeze(['facts', 'recall', 'nudge', 'reflection', 'dream']);

/**
 * settings.json: extensions[] += ext. Native compaction is deliberately LEFT AS IS.
 *
 * Unlike upstream's OMP setup, OMO Native must keep `compaction.enabled` on: Senpi's
 * resume admission (`sdk.js`, ModelUsabilityBudgetError) counts the full saved
 * transcript and only has a recovery path when compaction is enabled. With it off, a
 * session whose transcript outgrew the window refuses every turn. With it on, Magic
 * Context still owns the window: its `session_before_compact` handler cancels native
 * compaction (verified: 18-turn run to 96% with zero native compaction entries).
 */
export function planSettings(text, ext, { priorExt } = {}) {
  const edits = [];
  const notes = [];
  const root = parseTree(text);
  if (root.type !== 'object') throw new Error('settings file is not a JSON object');
  const exts = findNode(root, ['extensions']);
  if (!exts) {
    const r = insertMember(text, [], 'extensions', [ext]);
    text = r.text;
    edits.push(r.edit);
  } else if (exts.type !== 'array') {
    throw new Error('settings "extensions" is not an array; refusing to guess');
  } else if (toValue(exts).includes(ext)) {
    notes.push('extension path already present in extensions[]');
    if (priorExt && priorExt !== ext && toValue(exts).includes(priorExt)) {
      // Both runtimes are listed: OMO would load two Magic Contexts. Drop the stale
      // prior pin (last copy, the one setup would have swapped), recorded so
      // uninstall puts those exact bytes back in that exact slot.
      const r = removeArrayElementAt(text, ['extensions'], toValue(exts).lastIndexOf(priorExt));
      text = r.text;
      edits.push(r.edit);
      notes.push(`removing the stale previously installed runtime path (${priorExt})`);
    }
  } else if (priorExt && priorExt !== ext && toValue(exts).includes(priorExt)) {
    // A different pin was installed before: swap the entry in place, recorded so
    // uninstall still restores the ORIGINAL file exactly.
    const r = replaceElement(text, ['extensions'], priorExt, ext);
    text = r.text;
    edits.push(r.edit);
    notes.push(`replacing the previously installed runtime path (${priorExt})`);
  } else {
    const r = appendElement(text, ['extensions'], ext);
    text = r.text;
    edits.push(r.edit);
  }
  const comp = findNode(parseTree(text), ['compaction']);
  const compEnabled = comp && comp.type === 'object' ? toValue(comp).enabled : undefined;
  if (compEnabled === false) {
    notes.push('compaction.enabled is false: OMO cannot recover a resumed session that outgrew the window. Consider setting it back to true (doctor warns).');
  }
  return { text, edits, notes };
}

/** omo.jsonc: "[native]".memory.<subsystem>.enabled = false, merged, never replacing [native]. */
export function planMemoryPolicy(text) {
  const edits = [];
  const notes = [];
  for (const sub of OMO_AUTO_MEMORY_SUBSYSTEMS) {
    const r = setPath(text, ['[native]', 'memory', sub, 'enabled'], false);
    if (r.edit) {
      text = r.text;
      edits.push(r.edit);
    } else {
      notes.push(`[native].memory.${sub}.enabled already false`);
    }
  }
  return { text, edits, notes };
}

/** magic-context.jsonc: todowrite.enabled = false (only with explicit consent). */
export function planTodowrite(text) {
  const r = setPath(text, ['todowrite', 'enabled'], false);
  return { text: r.edit ? r.text : text, edits: r.edit ? [r.edit] : [], notes: r.edit ? [] : ['todowrite.enabled already false'] };
}

/** Text for a brand-new omo.jsonc / magic-context.jsonc. */
export const EMPTY_OBJECT_TEXT = '{\n}\n';

/** Revert recorded edits newest-first. Returns { text, results[] }. */
export function revertEdits(text, edits) {
  const results = [];
  for (const e of [...edits].reverse()) {
    const r = revertEdit(text, e);
    text = r.text;
    results.push({ path: [...e.path, ...(e.key ? [e.key] : [])].join('.'), op: e.op, status: r.status, ...(r.detail ? { detail: r.detail } : {}) });
  }
  return { text, results };
}

/** Read helpers that never throw. */
export function safeParse(text) {
  try {
    return { value: parse(text) };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

export function autoMemoryState(omoCfg) {
  const mem = omoCfg?.['[native]']?.memory;
  const out = {};
  for (const sub of OMO_AUTO_MEMORY_SUBSYSTEMS) out[sub] = mem?.[sub]?.enabled === false ? 'off' : 'on (default)';
  for (const sub of OMO_AUTO_MEMORY_SUBSYSTEMS) if (mem?.[sub]?.enabled === true) out[sub] = 'on';
  return out;
}
