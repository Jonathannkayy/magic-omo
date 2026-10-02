// Which Magic Context pin this machine should run.
//
// magic-omo ships several pins side by side (compat.json `pins`). The right one
// is not "the newest": every process sharing one context.db must run the same
// Magic Context major.minor, and a NEWER build silently migrates the database
// forward and locks the older hosts out. So the selection is driven by what the
// other hosts on this machine already run.
//
// Order:
//   1. explicit override (`--mc` / MAGIC_OMO_MC_VERSION)
//   2. the pin recorded by a previous setup, while it is still valid and peers agree
//   3. the peers: OpenCode's Magic Context plugin, magic-hermes' supported series,
//      and the schema version of the shared database
//   4. default_pin
//
// selectPin() is pure: it takes the environment and an already-collected peer
// snapshot, and returns { pin, reason } or { error, detail, peers }.
import { COMPAT, defaultPin, pinFor, series } from './compat.js';
import { hermesCompat, openCodeMagicContext } from './peers.js';

/** Collect everything selectPin() needs. `dbSchema` is awaited by the caller. */
export function collectPeers(env = process.env, { dbSchema } = {}) {
  const openCode = openCodeMagicContext(env).map((o) => ({ ...o, series: series(o.version) }));
  const hermes = hermesCompat(env);
  return { openCode, hermes, dbSchema: typeof dbSchema === 'number' ? dbSchema : undefined };
}

/** Peer series claims, as [{ who, series, detail }]; entries without a version are skipped. */
export function peerSeries(peers = {}) {
  const out = [];
  for (const o of peers.openCode ?? []) {
    if (o.series) out.push({ who: 'OpenCode', series: o.series, detail: `${o.version} via ${o.via}` });
  }
  if (peers.hermes?.series) out.push({ who: 'magic-hermes', series: peers.hermes.series, detail: peers.hermes.file });
  return out;
}

const bySeries = (compat, s) => compat.pins.filter((p) => series(p.magic_context) === s);

function withDbCheck(pin, reason, peers, compat) {
  if (typeof peers.dbSchema === 'number' && peers.dbSchema > pin.schema_fence) {
    return {
      error: 'db-newer-than-pin',
      detail: `the shared context.db is at schema v${peers.dbSchema}, newer than Magic Context ${pin.magic_context} (fence v${pin.schema_fence}). `
        + `Another host upgraded Magic Context; use a pin whose series matches it${listPins(compat)}.`,
      peers,
    };
  }
  return { pin, reason };
}

function listPins(compat) {
  return ` (available: ${compat.pins.map((p) => p.magic_context).join(', ')})`;
}

/**
 * Decide the pin. `peers` comes from collectPeers(); `record` is the install record
 * (or undefined). Returns { pin, reason } or { error, detail, peers }.
 */
export function selectPin(env = process.env, peers = {}, { record, compat = COMPAT, override } = {}) {
  // 1. explicit override
  const forced = (override ?? env.MAGIC_OMO_MC_VERSION)?.toString().trim();
  if (forced) {
    const pin = pinFor(forced, compat);
    if (!pin) return { error: 'unknown-pin', detail: `Magic Context ${forced} is not one of magic-omo's pins${listPins(compat)}`, peers };
    return { pin, reason: `explicitly requested (${override ? '--mc' : 'MAGIC_OMO_MC_VERSION'})` };
  }

  const claims = peerSeries(peers);
  const distinct = [...new Set(claims.map((c) => c.series))];

  // Peers that contradict each other are a human decision, not ours.
  if (distinct.length > 1) {
    return {
      error: 'peers-disagree',
      detail: `the Magic Context hosts on this machine do not agree on a series: ${claims.map((c) => `${c.who} runs ${c.series} (${c.detail})`).join('; ')}. `
        + 'Bring them to one series first — they share one context.db and the newest one migrates it forward.',
      peers,
    };
  }

  // 2. the pin a previous setup recorded, if nothing contradicts it
  const recorded = record?.magic_context ? pinFor(record.magic_context, compat) : undefined;
  if (recorded && (distinct.length === 0 || distinct[0] === series(recorded.magic_context))
      && !(typeof peers.dbSchema === 'number' && peers.dbSchema > recorded.schema_fence)) {
    return { pin: recorded, reason: `already installed as ${recorded.magic_context}${distinct.length ? ` and peers agree (series ${distinct[0]})` : ''}` };
  }

  // 3. follow the peers
  if (distinct.length === 1) {
    const s = distinct[0];
    const candidates = bySeries(compat, s);
    if (!candidates.length) {
      return {
        error: 'no-pin-for-peers',
        detail: `the other hosts run Magic Context series ${s} (${claims.map((c) => `${c.who}: ${c.detail}`).join('; ')}), which magic-omo does not pin${listPins(compat)}. `
          + 'Upgrade magic-omo, or move the other hosts to a pinned series.',
        peers,
      };
    }
    const who = claims.map((c) => c.who).join(' + ');
    return withDbCheck(candidates[0], `matches ${who} (series ${s})`, peers, compat);
  }

  // No peers: let the database decide when there is one.
  if (typeof peers.dbSchema === 'number') {
    const exact = compat.pins.find((p) => p.schema_fence === peers.dbSchema);
    if (exact) return { pin: exact, reason: `shared context.db is at schema v${peers.dbSchema}, which is exactly ${exact.magic_context}'s fence` };
    const fits = [...compat.pins].filter((p) => p.schema_fence >= peers.dbSchema).sort((a, b) => a.schema_fence - b.schema_fence)[0];
    if (!fits) {
      return {
        error: 'db-newer-than-every-pin',
        detail: `the shared context.db is at schema v${peers.dbSchema}, newer than every pin magic-omo ships${listPins(compat)}. Upgrade magic-omo.`,
        peers,
      };
    }
    return { pin: fits, reason: `oldest pin that can open a schema v${peers.dbSchema} database` };
  }

  // 4. nothing to follow
  const d = defaultPin(compat);
  return withDbCheck(d, 'no other Magic Context host and no shared database yet: compat.json default_pin', peers, compat);
}

/** One-line explanation for doctor/CLI. */
export function describeSelection(sel) {
  return sel.error ? `pin selection failed (${sel.error}): ${sel.detail}` : `Magic Context ${sel.pin.magic_context} — ${sel.reason}`;
}
