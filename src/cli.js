// magic-omo command-line interface.
import { createInterface } from 'node:readline/promises';
import { COMPAT, DEFAULT_PIN, PINS, PKG, rowsFor } from './compat.js';
import { formatDoctor, formatSummary, runDoctor } from './doctor.js';
import { guardInstall, guardRun, guardTargets, guardUninstall } from './guard.js';
import { applySetup, describeEdit, planSetup, readRecord, uninstall } from './install.js';
import { allPaths, vendoredVersions } from './paths.js';
import { collectPeers, describeSelection, selectPin } from './pins.js';
import { schemaVersion } from './db.js';
import { installVendor, pruneVendor, verifyVendor, vendorOk } from './vendor.js';

export const HELP = `magic-omo ${PKG.version} — Magic Context for OMO Native (unofficial community bridge)

Usage:
  magic-omo setup [--yes] [--dry-run] [--mc <version>] [--prune] [--keep-omo-memory] [--todowrite | --no-todowrite]
  magic-omo doctor [--json] [--quiet] [--strict] [--probe-models]
  magic-omo status [--json]
  magic-omo uninstall [--yes] [--dry-run]
  magic-omo guard install|uninstall [--dry-run] | guard run
  magic-omo pins [--json]
  magic-omo paths [--json]

setup      Installs the selected @cortexkit/pi-magic-context pin (default ${DEFAULT_PIN.magic_context}) into magic-omo's own
           vendor dir (npm --ignore-scripts, integrity-checked), adds it to OMO's extensions[],
           turns off OMO's AUTOMATIC memory subsystems in
           "[native]".memory (opt out: --keep-omo-memory), and OFFERS todowrite.enabled=false
           in the shared Magic Context config (asks first; --todowrite / --no-todowrite to decide
           non-interactively). Every change is backed up and revertible by \`uninstall\`.
           The pin is chosen so this machine stays on the Magic Context series its other hosts
           already run: --mc / MAGIC_OMO_MC_VERSION override it, --prune deletes the other
           vendored versions afterwards.
pins       List every Magic Context version magic-omo supports and its verified combinations.
doctor     Read-only health checks: PASS/WARN/FAIL/INFO. Exit 1 on any FAIL.
           --quiet         print only the summary line (same exit code)
           --strict        treat unverified OMO/Senpi versions as FAIL
           --probe-models  ask OMO to resolve each historian/dreamer model. This makes ONE small
                           real model call per distinct model on your account.
uninstall  Reverts exactly the recorded changes (nothing else). Running OMO sessions keep their
           old setup until restarted.
guard      run: doctor; if the bridge is live and a hard check fails, auto-uninstall + loud stderr.
           install: OPT-IN systemd --user path+timer (Linux) / launchd agent (macOS).

Environment: OMO_CODING_AGENT_DIR / SENPI_CODING_AGENT_DIR / PI_CODING_AGENT_DIR, XDG_CONFIG_HOME,
XDG_DATA_HOME, MAGIC_CONTEXT_STORAGE_DIR are honoured exactly like OMO and Magic Context do.
MAGIC_OMO_HOME overrides magic-omo's own data dir (default $XDG_DATA_HOME/magic-omo).`;

/** Flags that take a value, as `--mc 0.44.4` or `--mc=0.44.4`. */
export const VALUE_FLAGS = new Set(['mc']);

export function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v === undefined && VALUE_FLAGS.has(k) && argv[i + 1] && !argv[i + 1].startsWith('-')) {
        flags[k] = argv[++i];
      } else flags[k] = v ?? true;
    } else if (a === '-y') flags.yes = true;
    else if (a === '-h') flags.help = true;
    else pos.push(a);
  }
  return { cmd: pos[0], sub: pos[1], flags, pos };
}

function makeIO({ stdout = process.stdout, stderr = process.stderr, stdin = process.stdin } = {}) {
  return {
    out: (s = '') => stdout.write(`${s}\n`),
    err: (s = '') => stderr.write(`${s}\n`),
    stdout,
    stderr,
    async ask(question, def) {
      if (!stdin.isTTY) return def;
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        const a = (await rl.question(`${question} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
        if (!a) return def;
        return a === 'y' || a === 'yes';
      } finally {
        rl.close();
      }
    },
  };
}

const SETUP_BLOCKERS = new Set(['node', 'omo', 'senpi', 'senpi-hooks', 'db', 'series-opencode', 'series-hermes', 'settings', 'double-load']);

async function cmdSetup(flags, env, io) {
  const dry = Boolean(flags['dry-run']);
  const yes = Boolean(flags.yes);
  const memoryPolicy = !flags['keep-omo-memory'];
  const mc = typeof flags.mc === 'string' ? flags.mc : undefined;
  io.out(`magic-omo setup${dry ? ' (dry run: nothing will be written)' : ''}`);

  const base = allPaths(env);
  const record = readRecord(base);
  const sv = await schemaVersion(base.db, env);
  const sel = selectPin(env, collectPeers(env, { dbSchema: typeof sv.version === 'number' ? sv.version : undefined }), { record, override: mc });
  if (sel.error) {
    io.err(`setup refused — ${sel.detail}`);
    return 2;
  }
  const pin = sel.pin;
  io.out(`  pin: ${describeSelection(sel)}`);

  const pre = await runDoctor({ env, fullVendor: false, mc });
  const blockers = pre.checks.filter((c) => c.status === 'FAIL' && SETUP_BLOCKERS.has(c.id));
  if (blockers.length) {
    io.err('setup refused — fix these first:');
    for (const b of blockers) io.err(`  FAIL ${b.title}: ${b.detail}`);
    return 2;
  }
  for (const w of pre.checks.filter((c) => c.status === 'WARN' && ['omo', 'senpi'].includes(c.id))) io.out(`  WARN ${w.title}: ${w.detail}`);

  // 1. pinned runtime
  const v = verifyVendor(env, pin, { full: true });
  if (vendorOk(v)) io.out(`  = pinned runtime already installed and verified (${v.sums.checked} files)`);
  else if (dry) io.out(`  would install ${pin.package}@${pin.magic_context} into ${v.dir} (npm install --ignore-scripts --save-exact)`);
  else {
    io.out(`  installing ${pin.package}@${pin.magic_context} into ${v.dir}`);
    installVendor(env, pin, { log: (s) => io.out(`    ${s}`) });
  }

  // 2. todowrite consent (shared config)
  let todowrite = false;
  if (flags.todowrite === true) todowrite = true;
  else if (flags['no-todowrite']) todowrite = false;
  else if (!yes) {
    const paths = allPaths(env);
    todowrite = await io.ask(
      `Disable Magic Context's todowrite tool (OMO ships its own \`todo\`)? This edits the SHARED ${paths.mcConfig}, read by every Magic Context host (backed up first).`,
      false,
    );
  }

  // 3. plan
  const plan = planSetup(env, { pin, memoryPolicy, todowrite, record });
  const pending = plan.files.filter((f) => f.edits.length);
  io.out('');
  io.out(pending.length ? 'Planned changes (all recorded and revertible with `magic-omo uninstall`):' : 'Configuration already in place; nothing to change.');
  for (const f of pending) {
    io.out(`  ${f.file}${f.created ? ' (new file)' : ''}`);
    for (const e of f.edits) io.out(`    + ${describeEdit(e)}`);
  }
  if (!memoryPolicy) io.out('  (--keep-omo-memory: OMO automatic memory left as is)');
  if (dry) {
    io.out('\nDry run complete. Nothing was written.');
    return 0;
  }
  if (pending.length && !yes) {
    const go = await io.ask('Apply these changes?', true);
    if (!go) {
      io.out('Aborted; nothing changed in OMO configuration.');
      return 1;
    }
  }
  const res = applySetup(plan, env, { log: io.out });
  io.out(`\n  install record: ${res.recordPath}`);
  if (flags.prune) {
    const gone = pruneVendor(env, pin.magic_context);
    io.out(gone.length ? `  pruned other vendored runtimes: ${gone.join(', ')}` : '  nothing to prune');
  } else {
    const others = vendoredVersions(env).filter((x) => x !== pin.magic_context);
    if (others.length) io.out(`  other vendored runtimes kept: ${others.join(', ')} (delete with \`magic-omo setup --prune\`)`);
  }
  io.out('  Running OMO sessions keep their old setup until restarted. New sessions load Magic Context.');

  const post = await runDoctor({ env, mc });
  io.out('');
  io.out(formatDoctor(post, { color: io.stdout.isTTY }));
  return post.ok ? 0 : 1;
}

async function cmdDoctor(flags, env, io) {
  const r = await runDoctor({ env, strict: Boolean(flags.strict), probe: Boolean(flags['probe-models']) });
  if (flags.json) io.out(JSON.stringify(r, null, 2));
  else if (flags.quiet) io.out(formatSummary(r));
  else io.out(formatDoctor(r, { color: io.stdout.isTTY }));
  return r.ok ? 0 : 1;
}

async function cmdStatus(flags, env, io) {
  const paths = allPaths(env);
  const rec = readRecord(paths);
  const r = await runDoctor({ env, fullVendor: false });
  const s = {
    live: r.live,
    magic_context: r.pin.magic_context,
    pin_reason: r.pin_reason,
    record: rec ? paths.record : null,
    installed_at: rec?.installed_at ?? null,
    changed_files: rec?.files.map((f) => ({ file: f.file, edits: f.edits.length })) ?? [],
    worst: r.worst,
    guard: Object.keys(guardTargets(env).files),
  };
  if (flags.json) io.out(JSON.stringify(s, null, 2));
  else {
    io.out(`bridge: ${s.live ? 'LIVE (new OMO sessions load Magic Context)' : 'not installed'}`);
    io.out(`selected Magic Context: ${s.magic_context}${s.pin_reason ? ` (${s.pin_reason})` : ''}`);
    if (rec) {
      io.out(`installed: ${s.installed_at}  record: ${s.record}`);
      for (const f of s.changed_files) io.out(`  ${f.file}: ${f.edits} recorded change(s)`);
    }
    io.out(`doctor: ${s.worst}  (run \`magic-omo doctor\` for details)`);
  }
  return 0;
}

async function cmdUninstall(flags, env, io) {
  const dry = Boolean(flags['dry-run']);
  if (!dry && !flags.yes) {
    const go = await io.ask('Revert every change magic-omo recorded for this OMO agent dir?', true);
    if (!go) return 1;
  }
  const r = uninstall(env, { dryRun: dry, log: io.out });
  io.out(`uninstall: ${r.status}${dry ? ' (dry run)' : ''}`);
  const kept = r.results.filter((x) => x.status === 'modified');
  for (const k of kept) io.out(`  kept ${k.path} in ${k.file}: you changed it after setup, so it is yours now`);
  if (r.status !== 'not-installed') io.out('Running OMO sessions keep Magic Context until restarted. The vendored runtime stays in place (delete it with: rm -rf "' + allPaths(env).vendorRoot + '").');
  return 0;
}

async function cmdGuard(sub, flags, env, io) {
  if (sub === 'run') {
    const r = await guardRun(env);
    if (flags.json) io.out(JSON.stringify(r));
    return r.hardFails.length ? 1 : 0;
  }
  if (sub === 'install') {
    const t = guardInstall(env, { dryRun: Boolean(flags['dry-run']), log: io.out });
    io.out(`guard ${flags['dry-run'] ? 'would be ' : ''}installed (${t.kind}); silent while healthy, logs to ${allPaths(env).magicOmoHome}/guard.log`);
    return 0;
  }
  if (sub === 'uninstall') {
    guardUninstall(env, { dryRun: Boolean(flags['dry-run']), log: io.out });
    return 0;
  }
  io.err('usage: magic-omo guard install|uninstall|run');
  return 2;
}

export async function main(argv = process.argv.slice(2), { env = process.env, ...ioOpts } = {}) {
  const io = makeIO(ioOpts);
  const { cmd, sub, flags } = parseArgs(argv);
  try {
    if (flags.version || cmd === 'version') {
      io.out(PKG.version);
      return 0;
    }
    if (!cmd || flags.help || cmd === 'help') {
      io.out(HELP);
      return cmd || flags.help ? 0 : 2;
    }
    switch (cmd) {
      case 'setup': return await cmdSetup(flags, env, io);
      case 'doctor': return await cmdDoctor(flags, env, io);
      case 'status': return await cmdStatus(flags, env, io);
      case 'uninstall': return await cmdUninstall(flags, env, io);
      case 'guard': return await cmdGuard(sub, flags, env, io);
      case 'pins': {
        const rows = PINS.map((p) => ({
          magic_context: p.magic_context,
          schema_fence: p.schema_fence,
          integrity: p.integrity,
          lockfile: p.lockfile,
          default: p.magic_context === DEFAULT_PIN.magic_context,
          combinations: rowsFor(p.magic_context).map((r) => ({ omo: r.omo, senpi: r.senpi, status: r.status, verified_on: r.verified_on, evidence: r.evidence ?? null })),
        }));
        if (flags.json) io.out(JSON.stringify({ default_pin: COMPAT.default_pin, pins: rows }, null, 2));
        else {
          for (const p of rows) {
            io.out(`${p.magic_context}${p.default ? '  (default)' : ''}  schema fence v${p.schema_fence}`);
            for (const c of p.combinations) {
              const icon = c.status === 'verified' ? '✅' : c.status === 'broken' ? '❌' : '⚠️ ';
              io.out(`  ${icon} omo-ai ${c.omo} / senpi ${c.senpi}${c.verified_on ? `  verified ${c.verified_on}` : ''}`);
            }
            if (!p.combinations.length) io.out('  (no matrix rows)');
          }
        }
        return 0;
      }
      case 'paths': {
        const r = readRecord(allPaths(env));
        const p = allPaths(env, r?.magic_context ?? DEFAULT_PIN.magic_context);
        io.out(flags.json ? JSON.stringify(p, null, 2) : Object.entries(p).filter(([, v]) => v !== undefined).map(([k, v]) => `${k.padEnd(16)} ${v}`).join('\n'));
        return 0;
      }
      default:
        io.err(`unknown command: ${cmd}\n`);
        io.err(HELP);
        return 2;
    }
  } catch (e) {
    io.err(`magic-omo: ${e.message}`);
    return 1;
  }
}
