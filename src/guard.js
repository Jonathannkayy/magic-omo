// Guard: re-run doctor whenever something it depends on changes. If the bridge is
// live and a HARD check fails, it auto-uninstalls (fail safe = OMO back on its own
// compaction) and says so loudly. Silent when healthy.
//
// `guard install` is OPT-IN and writes user-level units only:
//   Linux: ~/.config/systemd/user/magic-omo-guard.{service,path,timer}
//   macOS: ~/Library/LaunchAgents/io.github.jonathannkayy.magic-omo-guard.plist
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './compat.js';
import { runDoctor } from './doctor.js';
import { atomicWrite } from './fsutil.js';
import { uninstall } from './install.js';
import { locateOmo, which } from './omo.js';
import { allPaths, configHome, runtimeHome } from './paths.js';

export const UNIT = 'magic-omo-guard';
export const LAUNCHD_LABEL = 'io.github.jonathannkayy.magic-omo-guard';

export function guardLogPath(env = process.env) {
  return path.join(allPaths(env).magicOmoHome, 'guard.log');
}

export async function guardRun(env = process.env, { doctor = runDoctor, stderr = process.stderr } = {}) {
  const report = await doctor({ env, fullVendor: true });
  const hardFails = report.checks.filter((c) => c.status === 'FAIL' && c.hard);
  const res = { live: report.live, hardFails: hardFails.map((c) => `${c.title}: ${c.detail}`), action: 'none' };
  if (report.live && hardFails.length) {
    const u = uninstall(env);
    res.action = `auto-uninstalled (${u.status})`;
    const msg = [
      `[${new Date().toISOString()}] magic-omo guard: bridge was LIVE and a hard check failed:`,
      ...res.hardFails.map((f) => `  - ${f}`),
      `  -> ${res.action}. OMO Native is back on its own compaction for NEW sessions; running sessions keep the old setup until restarted.`,
      '  Fix the cause (usually: upgrade magic-omo to the Magic Context series your other hosts run), then `magic-omo setup` again.',
    ].join('\n');
    stderr.write(`\n${msg}\n\n`);
    const log = guardLogPath(env);
    mkdirSync(path.dirname(log), { recursive: true });
    appendFileSync(log, `${msg}\n`);
  }
  return res;
}

/** Files whose change should re-trigger the guard. */
export function watchedFiles(env = process.env) {
  const p = allPaths(env);
  const omo = locateOmo(env);
  return [
    omo.pkgRoot && path.join(omo.pkgRoot, 'package.json'),
    omo.senpiRoot && path.join(omo.senpiRoot, 'package.json'),
    path.join(p.extension, 'package.json'),
    path.join(p.vendor, 'package-lock.json'),
    path.join(ROOT, 'compat.json'),
  ].filter(Boolean);
}

function cliInvocation() {
  return [process.execPath, path.resolve(new URL('../bin/magic-omo.js', import.meta.url).pathname)];
}

const q = (s) => (/[\s"'\\]/.test(s) ? `"${s.replace(/(["\\])/g, '\\$1')}"` : s);

export function systemdUnits(env = process.env) {
  const [node, cli] = cliInvocation();
  const watch = watchedFiles(env);
  const envLines = ['HOME', 'OMO_CODING_AGENT_DIR', 'SENPI_CODING_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'MAGIC_CONTEXT_STORAGE_DIR', 'MAGIC_OMO_HOME', 'PATH']
    .filter((k) => env[k])
    .map((k) => `Environment=${q(`${k}=${env[k]}`)}`);
  return {
    [`${UNIT}.service`]: [
      '[Unit]',
      'Description=magic-omo guard (re-verify Magic Context <-> OMO Native bridge; auto-disable on hard failure)',
      '',
      '[Service]',
      'Type=oneshot',
      ...envLines,
      `ExecStart=${q(node)} ${q(cli)} guard run`,
      'Nice=10',
      '',
    ].join('\n'),
    [`${UNIT}.path`]: [
      '[Unit]',
      'Description=magic-omo guard: watch OMO, Senpi and the pinned extension for changes',
      '',
      '[Path]',
      ...watch.map((w) => `PathChanged=${w}`),
      `Unit=${UNIT}.service`,
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'),
    [`${UNIT}.timer`]: [
      '[Unit]',
      'Description=magic-omo guard daily backstop',
      '',
      '[Timer]',
      'OnCalendar=daily',
      'RandomizedDelaySec=1h',
      'Persistent=true',
      `Unit=${UNIT}.service`,
      '',
      '[Install]',
      'WantedBy=timers.target',
      '',
    ].join('\n'),
  };
}

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function launchdPlist(env = process.env) {
  const [node, cli] = cliInvocation();
  const watch = watchedFiles(env);
  const log = guardLogPath(env);
  const envKeys = ['HOME', 'OMO_CODING_AGENT_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'MAGIC_CONTEXT_STORAGE_DIR', 'MAGIC_OMO_HOME', 'PATH'].filter((k) => env[k]);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(cli)}</string>
    <string>guard</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envKeys.map((k) => `    <key>${k}</key><string>${xml(env[k])}</string>`).join('\n')}
  </dict>
  <key>WatchPaths</key>
  <array>
${watch.map((w) => `    <string>${xml(w)}</string>`).join('\n')}
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>17</integer></dict>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
`;
}

export function guardTargets(env = process.env, platform = process.platform) {
  if (platform === 'darwin') {
    return { kind: 'launchd', files: { [path.join(runtimeHome(env), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)]: launchdPlist(env) } };
  }
  if (platform === 'linux') {
    const dir = path.join(configHome(env), 'systemd', 'user');
    const units = systemdUnits(env);
    return { kind: 'systemd', files: Object.fromEntries(Object.entries(units).map(([n, c]) => [path.join(dir, n), c])) };
  }
  return { kind: 'unsupported', files: {} };
}

function run(cmd, args, env) {
  const bin = which(cmd, env);
  if (!bin) return { ok: false, out: `${cmd} not found` };
  const r = spawnSync(bin, args, { encoding: 'utf8', env, timeout: 30_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

export function guardInstall(env = process.env, { dryRun = false, activate = true, platform = process.platform, log = () => {} } = {}) {
  const t = guardTargets(env, platform);
  if (t.kind === 'unsupported') throw new Error(`guard install supports Linux (systemd --user) and macOS (launchd); not ${platform}`);
  for (const [f, c] of Object.entries(t.files)) {
    log(`${dryRun ? 'would write' : 'write'} ${f}`);
    if (!dryRun) atomicWrite(f, c, { defaultMode: 0o644 });
  }
  if (dryRun || !activate) return t;
  if (t.kind === 'systemd') {
    for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', '--now', `${UNIT}.path`, `${UNIT}.timer`]]) {
      const r = run('systemctl', args, env);
      log(`systemctl ${args.join(' ')}: ${r.ok ? 'ok' : r.out}`);
    }
  } else {
    const r = run('launchctl', ['load', '-w', Object.keys(t.files)[0]], env);
    log(`launchctl load: ${r.ok ? 'ok' : r.out}`);
  }
  return t;
}

export function guardUninstall(env = process.env, { dryRun = false, activate = true, platform = process.platform, log = () => {} } = {}) {
  const t = guardTargets(env, platform);
  if (!dryRun && activate) {
    if (t.kind === 'systemd') run('systemctl', ['--user', 'disable', '--now', `${UNIT}.path`, `${UNIT}.timer`], env);
    if (t.kind === 'launchd') run('launchctl', ['unload', '-w', Object.keys(t.files)[0]], env);
  }
  for (const f of Object.keys(t.files)) {
    if (!existsSync(f)) continue;
    log(`${dryRun ? 'would remove' : 'remove'} ${f}`);
    if (!dryRun) rmSync(f);
  }
  if (!dryRun && activate && t.kind === 'systemd') run('systemctl', ['--user', 'daemon-reload'], env);
  return t;
}
