// Test fixtures: a fully fake, isolated world (HOME, agent dir, OMO package, Senpi,
// npm and omo stubs). Nothing here ever touches the real home or runs real omo.
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FIX = path.join(TEST_DIR, 'fixtures');
export const ROOT = path.resolve(TEST_DIR, '..');

const PIN = JSON.parse(readFileSync(path.join(ROOT, 'compat.json'), 'utf8')).pin;

function sh(file, body) {
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

/**
 * Build a fake world. Options:
 *   omoVersion, senpiVersion, compactHook, localSkip, settings (text|null),
 *   omoConfig (text|null), mcConfig (text|null), fence, integrity, probe (stdout for fake omo)
 */
export function makeWorld(opts = {}) {
  const base = mkdtempSync(path.join(process.env.MAGIC_OMO_TEST_TMP || os.tmpdir(), 'magic-omo-test-'));
  const home = path.join(base, 'home');
  const bin = path.join(base, 'bin');
  const omoPkg = path.join(base, 'global', 'lib', 'node_modules', 'omo-ai');
  const senpi = path.join(omoPkg, 'node_modules', '@code-yeongyu', 'senpi');
  mkdirSync(path.join(home, '.omo', 'agent'), { recursive: true });
  mkdirSync(path.join(home, '.config', 'cortexkit'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(omoPkg, 'bin'), { recursive: true });
  mkdirSync(path.join(senpi, 'dist', 'core', 'extensions'), { recursive: true });

  writeFileSync(path.join(omoPkg, 'package.json'), JSON.stringify({ name: 'omo-ai', version: opts.omoVersion ?? PIN.omo }));
  writeFileSync(path.join(senpi, 'package.json'), JSON.stringify({ name: '@code-yeongyu/senpi', version: opts.senpiVersion ?? PIN.senpi }));
  writeFileSync(path.join(senpi, 'dist', 'core', 'extensions', 'runner.js'),
    opts.compactHook === false ? 'export const x = 1;\n' : 'if (event.type === "session_before_compact") {}\n');
  writeFileSync(path.join(senpi, 'dist', 'core', 'package-manager.js'),
    opts.localSkip === false ? 'export const y = 2;\n' : 'if (parsed.type === "local" || parsed.pinned) { continue; }\n');

  // Fake `omo`: records its argv, prints the configured probe output. NEVER the real omo.
  const probeOut = opts.probe ?? '{"type":"session","model":"PLACEHOLDER"}';
  writeFileSync(path.join(base, 'probe-output.txt'), probeOut);
  sh(path.join(bin, 'omo'), `echo "$@" >> "${path.join(base, 'omo-calls.log')}"\ncat "${path.join(base, 'probe-output.txt')}"`);

  // Fake `npm`: `root -g` and `install` of the pinned package from a local fixture.
  const fence = opts.fence ?? PIN.schema_fence;
  const integrity = opts.integrity ?? PIN.integrity;
  sh(path.join(bin, 'npm'), `
case "$1" in
  root) echo "${path.join(base, 'global', 'lib', 'node_modules')}"; exit 0;;
  install)
    echo "$@" >> "${path.join(base, 'npm-calls.log')}"
    d=node_modules/@cortexkit/pi-magic-context
    mkdir -p "$d/dist"
    printf '{"name":"@cortexkit/pi-magic-context","version":"${PIN.magic_context}"}' > "$d/package.json"
    printf 'const LATEST_SUPPORTED_VERSION = ${fence};\\n' > "$d/dist/index-test.js"
    printf '{"name":"magic-omo-vendor","lockfileVersion":3,"packages":{"node_modules/@cortexkit/pi-magic-context":{"version":"${PIN.magic_context}","integrity":"${integrity}"}}}' > package-lock.json
    exit 0;;
esac
exit 1`);

  if (opts.settings !== null) {
    writeFileSync(path.join(home, '.omo', 'agent', 'settings.json'), opts.settings ?? readFileSync(path.join(FIX, 'settings.json'), 'utf8'));
  }
  if (opts.omoConfig !== null) {
    writeFileSync(path.join(home, '.omo', 'omo.jsonc'), opts.omoConfig ?? readFileSync(path.join(FIX, 'omo.jsonc'), 'utf8'));
  }
  if (opts.mcConfig !== null) {
    writeFileSync(path.join(home, '.config', 'cortexkit', 'magic-context.jsonc'), opts.mcConfig ?? readFileSync(path.join(FIX, 'magic-context.jsonc'), 'utf8'));
  }

  const env = {
    HOME: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    MAGIC_OMO_OMO_BIN: path.join(bin, 'omo'),
    MAGIC_OMO_OMO_PKG: omoPkg,
    MAGIC_OMO_NPM: path.join(bin, 'npm'),
    MAGIC_OMO_HERMES_COMPAT: path.join(base, 'no-hermes', 'magic_context_compat.json'),
  };
  return {
    base, home, bin, omoPkg, senpi, env,
    settingsFile: path.join(home, '.omo', 'agent', 'settings.json'),
    omoConfigFile: path.join(home, '.omo', 'omo.jsonc'),
    mcConfigFile: path.join(home, '.config', 'cortexkit', 'magic-context.jsonc'),
    setProbe: (s) => writeFileSync(path.join(base, 'probe-output.txt'), s),
    omoCalls: () => { try { return readFileSync(path.join(base, 'omo-calls.log'), 'utf8'); } catch { return ''; } },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** Map of every file under dir -> { size, mtimeMs, content } for "nothing changed" assertions. */
export function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else {
        const st = statSync(p);
        out[path.relative(dir, p)] = { size: st.size, mtimeMs: st.mtimeMs, mode: st.mode, content: readFileSync(p, 'utf8') };
      }
    }
  };
  walk(dir);
  return out;
}

export function sortedKeys(v) {
  if (Array.isArray(v)) return v.map(sortedKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedKeys(v[k])]));
  return v;
}

/** Capture CLI output. */
export function capture() {
  const chunks = { out: '', err: '' };
  const mk = (k) => ({ isTTY: false, write: (s) => { chunks[k] += s; return true; } });
  return { chunks, stdout: mk('out'), stderr: mk('err'), stdin: { isTTY: false } };
}

export { cpSync };
