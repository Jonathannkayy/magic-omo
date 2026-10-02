// magic-omo command-line interface.
import { createInterface } from 'node:readline/promises';
import { PIN, PKG } from './compat.js';
import { formatDoctor, runDoctor } from './doctor.js';
import { guardInstall, guardRun, guardTargets, guardUninstall } from './guard.js';
import { applySetup, describeEdit, planSetup, readRecord, uninstall } from './install.js';
import { allPaths } from './paths.js';
import { verifyVendor, installVendor } from './vendor.js';

export const HELP = `magic-omo ${PKG.version} — Magic Context for OMO Native (unofficial community bridge)

Usage:
  magic-omo setup [--yes] [--dry-run] [--keep-omo-memory] [--todowrite | --no-todowrite]
  magic-omo doctor [--json] [--strict] [--probe-models]
  magic-omo status [--json]
  magic-omo uninstall [--yes] [--dry-run]
  magic-omo guard install|uninstall [--dry-run] | guard run
  magic-omo paths [--json]

setup      Installs the pinned @cortexkit/pi-magic-context ${PIN.magic_context} into magic-omo's own
           vendor dir (npm --ignore-scripts, integrity-checked), adds it to OMO's extensions[],
           turns off OMO's AUTOMATIC memory subsystems in
           "[native]".memory (opt out: --keep-omo-memory), and OFFERS todowrite.enabled=false
           in the shared Magic Context config (asks first; --todowrite / --no-todowrite to decide
           non-interactively). Every change is backed up and revertible by \`uninstall\`.
doctor     Read-only health checks: PASS/WARN/FAIL/INFO. Exit 1 on any FAIL.
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

export function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v ?? true;
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
  io.out(`magic-omo setup${dry ? ' (dry run: nothing will be written)' : ''}`);

  const pre = await runDoctor({ env, fullVendor: false });
  const blockers = pre.checks.filter((c) => c.status === 'FAIL' && SETUP_BLOCKERS.has(c.id));
  if (blockers.length) {
    io.err('setup refused — fix these first:');
    for (const b of blockers) io.err(`  FAIL ${b.title}: ${b.detail}`);
    return 2;
  }
  for (const w of pre.checks.filter((c) => c.status === 'WARN' && ['omo', 'senpi'].includes(c.id))) io.out(`  WARN ${w.title}: ${w.detail}`);

  // 1. pinned runtime
  const v = verifyVendor(env, { full: true });
  const vendorOk = v.present && v.version === PIN.magic_context && v.lockOk && !v.sums?.missingManifest && !v.sums?.bad?.length && !v.sums?.missing?.length;
  if (vendorOk) io.out(`  = pinned runtime already installed and verified (${v.sums.checked} files)`);
  else if (dry) io.out(`  would install ${PIN.package}@${PIN.magic_context} into ${v.dir} (npm install --ignore-scripts --save-exact)`);
  else {
    io.out(`  installing ${PIN.package}@${PIN.magic_context} into ${v.dir}`);
    installVendor(env, { log: (s) => io.out(`    ${s}`) });
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
  const plan = planSetup(env, { memoryPolicy, todowrite });
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
  io.out('  Running OMO sessions keep their old setup until restarted. New sessions load Magic Context.');

  const post = await runDoctor({ env });
  io.out('');
  io.out(formatDoctor(post, { color: io.stdout.isTTY }));
  return post.ok ? 0 : 1;
}

async function cmdDoctor(flags, env, io) {
  const r = await runDoctor({ env, strict: Boolean(flags.strict), probe: Boolean(flags['probe-models']) });
  if (flags.json) io.out(JSON.stringify(r, null, 2));
  else io.out(formatDoctor(r, { color: io.stdout.isTTY }));
  return r.ok ? 0 : 1;
}

async function cmdStatus(flags, env, io) {
  const paths = allPaths(env);
  const rec = readRecord(paths);
  const r = await runDoctor({ env, fullVendor: false });
  const s = {
    live: r.live,
    magic_context: PIN.magic_context,
    record: rec ? paths.record : null,
    installed_at: rec?.installed_at ?? null,
    changed_files: rec?.files.map((f) => ({ file: f.file, edits: f.edits.length })) ?? [],
    worst: r.worst,
    guard: Object.keys(guardTargets(env).files),
  };
  if (flags.json) io.out(JSON.stringify(s, null, 2));
  else {
    io.out(`bridge: ${s.live ? 'LIVE (new OMO sessions load Magic Context)' : 'not installed'}`);
    io.out(`pinned Magic Context: ${s.magic_context}`);
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
  if (r.status !== 'not-installed') io.out('Running OMO sessions keep Magic Context until restarted. The vendored runtime stays in place (delete it with: rm -rf "' + allPaths(env).vendor + '").');
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
      case 'paths': {
        const p = allPaths(env);
        io.out(flags.json ? JSON.stringify(p, null, 2) : Object.entries(p).map(([k, v]) => `${k.padEnd(16)} ${v}`).join('\n'));
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
