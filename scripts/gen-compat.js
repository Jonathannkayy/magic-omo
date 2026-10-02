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

export function renderTable(compat) {
  const icon = { verified: '✅ verified', unverified: '⚠️ unverified', broken: '❌ broken' };
  const rows = compat.matrix.map(
    (r) => `| ${r.magic_context} | v${r.schema_fence} | ${r.omo} | ${r.senpi} | ${icon[r.status] ?? r.status} | ${r.verified_on ?? '—'} | ${r.notes} |`,
  );
  return [
    '| Magic Context (`@cortexkit/pi-magic-context`) | Schema fence | OMO Native (`omo-ai`) | Senpi | Status | Verified | Notes |',
    '|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

export function renderDoc(compat) {
  const p = compat.pin;
  return `# Compatibility

> Generated from [\`compat.json\`](../compat.json) by \`npm run compat:gen\`. Do not edit by hand; CI fails on drift.

## Current pin

| Field | Value |
|---|---|
| Package | \`${p.package}\` |
| Version | \`${p.magic_context}\` |
| npm integrity | \`${p.integrity}\` |
| DB schema fence | \`v${p.schema_fence}\` (\`LATEST_SUPPORTED_VERSION\` in the build) |
| Verified OMO Native | \`omo-ai ${p.omo}\` |
| Verified Senpi | \`@code-yeongyu/senpi ${p.senpi}\` |

## Matrix

${renderTable(compat)}

## Rules

${compat.rules.map((r) => `- ${r}`).join('\n')}

\`magic-omo doctor\` reports an OMO/Senpi version that is not in a \`verified\` row as **WARN** (or **FAIL** with \`--strict\`).
`;
}

export function renderReadmeBlock(compat) {
  return `${BEGIN}\n${renderTable(compat)}\n${END}`;
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
