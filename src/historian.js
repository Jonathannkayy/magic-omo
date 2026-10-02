// Static classification of the historian/dreamer model lines Magic Context will
// hand to OMO Native when it spawns subagents.
//
// OMO Native runs the Pi runtime of Magic Context with harness id `pi`, so the
// `historian.pi` / `dreamer.pi` blocks are the ones that matter. Before spawning,
// Magic Context rewrites canonical providers for Pi (harness-provider-map.ts):
//   google/<m>  -> google-antigravity/<m>
//   openai/<m>  -> openai-codex/<m>
// OMO Native ships neither provider, so those lines can never resolve.

export const PI_PROVIDER_REWRITE = Object.freeze({ google: 'google-antigravity', openai: 'openai-codex' });
const PI_ONLY_PROVIDERS = new Set(Object.values(PI_PROVIDER_REWRITE));

/** Exact equivalent of resolveModelRefForPi() for the providers that matter here. */
export function resolveForPi(ref) {
  if (typeof ref !== 'string') return ref;
  const slash = ref.indexOf('/');
  if (slash <= 0) return ref;
  const prov = ref.slice(0, slash);
  if (Object.hasOwn(PI_PROVIDER_REWRITE, prov)) return PI_PROVIDER_REWRITE[prov] + ref.slice(slash);
  return ref;
}

function entryModel(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && typeof entry.model === 'string') return entry.model;
  return undefined;
}

/** Collect every pi model line from a parsed Magic Context config. */
export function collectPiModels(cfg) {
  const out = [];
  const push = (where, entry) => {
    const m = entryModel(entry);
    if (m) out.push({ where, model: m });
  };
  const h = cfg?.historian?.pi;
  if (h) {
    push('historian.pi.model', h.model);
    (Array.isArray(h.fallback_models) ? h.fallback_models : []).forEach((e, i) => push(`historian.pi.fallback_models[${i}]`, e));
  }
  const d = cfg?.dreamer?.pi;
  if (d) {
    push('dreamer.pi.model', d.model);
    (Array.isArray(d.fallback_models) ? d.fallback_models : []).forEach((e, i) => push(`dreamer.pi.fallback_models[${i}]`, e));
    for (const [task, t] of Object.entries(d.tasks ?? {})) {
      push(`dreamer.pi.tasks.${task}.model`, t?.model);
      (Array.isArray(t?.fallback_models) ? t.fallback_models : []).forEach((e, i) => push(`dreamer.pi.tasks.${task}.fallback_models[${i}]`, e));
    }
  }
  return out;
}

/**
 * Classify one model line.
 * Returns { status: 'PASS'|'WARN'|'FAIL'|'INFO', code, spawned, message }.
 */
export function classifyModel(model) {
  const spawned = resolveForPi(model);
  const slash = model.indexOf('/');
  if (slash <= 0) {
    return {
      status: 'INFO',
      code: 'bare',
      spawned,
      message:
        `bare id "${model}": OMO resolves it only if exactly ONE authenticated provider offers it; otherwise Senpi refuses with ` +
        `'Model "${model}" is ambiguous across providers'. Verify with --probe-models.`,
    };
  }
  const prov = model.slice(0, slash);
  if (spawned !== model) {
    return {
      status: 'FAIL',
      code: 'pi-rewrite',
      spawned,
      message:
        `"${model}" is rewritten by Magic Context to "${spawned}" for Pi-runtime subagents; OMO Native has no ` +
        `"${spawned.slice(0, spawned.indexOf('/'))}" provider, so the subagent fails with 'Model "${spawned}" not found'. ` +
        'Use a bare id that exactly one authenticated OMO provider offers, or an OMO-native provider prefix.',
    };
  }
  if (PI_ONLY_PROVIDERS.has(prov)) {
    return {
      status: 'FAIL',
      code: 'pi-only-provider',
      spawned,
      message: `"${model}" names a Pi-only provider "${prov}" that OMO Native does not ship.`,
    };
  }
  return {
    status: 'PASS',
    code: 'prefixed',
    spawned,
    message:
      `explicit provider "${prov}". This line is SHARED: other hosts reading historian.pi (e.g. Hermes via magic-hermes, ` +
      'plain Pi) must accept the same provider prefix.',
  };
}
