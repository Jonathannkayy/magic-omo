#!/usr/bin/env node
// Generate docs/COMPATIBILITY.md and the README compatibility block from compat.json.
//   node scripts/gen-compat.js          write
//   node scripts/gen-compat.js --check  exit 1 if either file is out of date
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BEGIN = '<!-- BEGIN GENERATED: compat (npm run compat:gen) -->';
const END = '<!-- END GENERATED: compat -->';

const ICON = { verified: '✅ verified', unverified: '⚠️ unverified', broken: '❌ broken' };

function rowsFor(compat, mc) {
  return compat.matrix.filter((r) => r.magic_context === mc);
}

/** Matrix rows grouped by Magic Context version, newest pin first, then any orphan rows. */
export function groups(compat) {
  const out = compat.pins.map((p) => ({ pin: p, rows: rowsFor(compat, p.magic_context) }));
  const pinned = new Set(compat.pins.map((p) => p.magic_context));
  const orphans = [...new Set(compat.matrix.map((r) => r.magic_context))].filter((v) => !pinned.has(v));
  for (const v of orphans) out.push({ pin: { magic_context: v, schema_fence: rowsFor(compat, v)[0]?.schema_fence }, rows: rowsFor(compat, v) });
  return out;
}

/** The full matrix, grouped by Magic Context version. `evidence` is shown when any row has it. */
export function renderTable(compat) {
  const withEvidence = compat.matrix.some((r) => r.evidence);
  const head = ['Magic Context', 'Schema fence', 'OMO Native (`omo-ai`)', 'Senpi', 'Status', 'Verified', ...(withEvidence ? ['Evidence'] : []), 'Notes'];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const g of groups(compat)) {
    const dflt = g.pin.magic_context === compat.default_pin ? ' **(default)**' : '';
    if (!g.rows.length) {
      lines.push(`| **${g.pin.magic_context}**${dflt} | v${g.pin.schema_fence} | — | — | ⚠️ unverified | — |${withEvidence ? ' — |' : ''} No combination recorded yet. |`);
      continue;
    }
    g.rows.forEach((r, i) => {
      const label = i === 0 ? `**${g.pin.magic_context}**${dflt}` : '';
      const fence = i === 0 ? `v${r.schema_fence}` : '';
      const cells = [label, fence, `\`${r.omo}\``, `\`${r.senpi}\``, ICON[r.status] ?? r.status, r.verified_on ?? '—', ...(withEvidence ? [r.evidence ?? '—'] : []), r.notes];
      lines.push(`| ${cells.join(' | ')} |`);
    });
  }
  return lines.join('\n');
}

/** The pin table: one row per supported Magic Context version. */
export function renderPins(compat) {
  const lines = [
    '| Magic Context | Schema fence | Lockfile | npm integrity | Verified combinations |',
    '|---|---|---|---|---|',
  ];
  for (const p of compat.pins) {
    const verified = rowsFor(compat, p.magic_context).filter((r) => r.status === 'verified');
    const dflt = p.magic_context === compat.default_pin ? ' **(default)**' : '';
    lines.push(`| \`${p.magic_context}\`${dflt} | \`v${p.schema_fence}\` | [\`${p.lockfile}\`](../${p.lockfile}) | \`${p.integrity}\` | ${verified.length ? verified.map((r) => `omo-ai ${r.omo}`).join(', ') : '— (not yet)'} |`);
  }
  return lines.join('\n');
}

export function renderDoc(compat) {
  return `# Compatibility

> Generated from [\`compat.json\`](../compat.json) by \`npm run compat:gen\`. Do not edit by hand; CI fails on drift.

## Supported pins

magic-omo ships **every** Magic Context version in this table side by side and installs the one that
matches the hosts already running on your machine (\`magic-omo pins\` lists them, \`magic-omo setup --mc <version>\` overrides).

${renderPins(compat)}

Package: \`${compat.pins[0].package}\`. Each pin's exact dependency tree lives in its own lockfile and is
installed into \`~/.local/share/magic-omo/vendor/<version>/\`, integrity-checked and frozen with \`SHA256SUMS\`.

## Matrix

${renderTable(compat)}

## Rules

${compat.rules.map((r) => `- ${r}`).join('\n')}

\`magic-omo doctor\` reports an OMO/Senpi version that is not in a \`verified\` row as **WARN** (or **FAIL** with \`--strict\`).
`;
}

export function renderReadmeBlock(compat) {
  return `${BEGIN}\n${renderPins(compat).replace(/\]\(\.\.\//g, '](')}\n\n<details>\n<summary>Full verification matrix</summary>\n\n${renderTable(compat)}\n\n</details>\n${END}`;
}

export function spliceReadme(readme, compat) {
  const a = readme.indexOf(BEGIN);
  const b = readme.indexOf(END);
  if (a < 0 || b < 0) throw new Error('README is missing the generated compat markers');
  return readme.slice(0, a) + renderReadmeBlock(compat) + readme.slice(b + END.length);
}

function main() {
  const check = process.argv.includes('--check');
  const compat = JSON.parse(readFileSync(path.join(ROOT, 'compat.json'), 'utf8'));
  const targets = [
    [path.join(ROOT, 'docs', 'COMPATIBILITY.md'), () => renderDoc(compat)],
    [path.join(ROOT, 'README.md'), (cur) => spliceReadme(cur, compat)],
  ];
  let drift = 0;
  for (const [file, render] of targets) {
    let cur = '';
    try {
      cur = readFileSync(file, 'utf8');
    } catch { /* new */ }
    const next = render(cur);
    if (cur === next) continue;
    if (check) {
      console.error(`out of date: ${path.relative(ROOT, file)} (run npm run compat:gen)`);
      drift++;
    } else {
      writeFileSync(file, next);
      console.log(`wrote ${path.relative(ROOT, file)}`);
    }
  }
  if (check && !drift) console.log('compat docs up to date');
  process.exitCode = drift ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
