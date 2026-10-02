// Isolation guard for sandboxes and tests: refuse when any resolved target would
// land on the REAL account's OMO state or the real shared Magic Context store.
import path from 'node:path';
import { accountHome, agentDir, mcConfigPath, mcStorage, omoConfigPath, realish } from './paths.js';

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Returns a list of violations (empty = isolated). `realHome` defaults to the
 * account home from the passwd database, which $HOME cannot spoof.
 */
export function isolationViolations(env = process.env, realHome = accountHome()) {
  const rh = realish(realHome);
  const liveOmo = path.join(rh, '.omo');
  const liveStore = path.join(rh, '.local', 'share', 'cortexkit', 'magic-context');
  const liveCfg = path.join(rh, '.config', 'cortexkit');
  const targets = {
    agentDir: realish(agentDir(env).path),
    omoConfig: realish(omoConfigPath(env)),
    store: realish(mcStorage(env).dir),
    mcConfig: realish(mcConfigPath(env)),
  };
  const out = [];
  for (const [k, p] of Object.entries(targets)) {
    if (inside(p, liveOmo)) out.push(`${k} resolves into the real ${liveOmo}: ${p}`);
    if (inside(p, liveStore)) out.push(`${k} resolves into the real Magic Context store ${liveStore}: ${p}`);
    if (inside(p, liveCfg)) out.push(`${k} resolves into the real CortexKit config ${liveCfg}: ${p}`);
  }
  return out;
}

export function assertIsolated(env = process.env, realHome = accountHome()) {
  const v = isolationViolations(env, realHome);
  if (v.length) {
    const e = new Error(`REFUSING: environment is not isolated from live state:\n  ${v.join('\n  ')}`);
    e.code = 'E_NOT_ISOLATED';
    throw e;
  }
}
