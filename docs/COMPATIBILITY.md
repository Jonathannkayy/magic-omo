# Compatibility

> Generated from [`compat.json`](../compat.json) by `npm run compat:gen`. Do not edit by hand; CI fails on drift.

## Supported pins

magic-omo ships **every** Magic Context version in this table side by side and installs the one that
matches the hosts already running on your machine (`magic-omo pins` lists them, `magic-omo setup --mc <version>` overrides).

| Magic Context | Schema fence | Lockfile | npm integrity | Verified combinations |
|---|---|---|---|---|
| `0.44.4` | `v91` | [`vendor/0.44.4/package-lock.json`](../vendor/0.44.4/package-lock.json) | `sha512-MHCWA3xDgSqxSbR7QJzgJT23LmlznOCmYg0miDGfnmxGE7nqq1TYoOif1KGDF9LXPfvOYf9fcXg1goB6o2I83g==` | — (not yet) |
| `0.43.2` **(default)** | `v90` | [`vendor/0.43.2/package-lock.json`](../vendor/0.43.2/package-lock.json) | `sha512-9l/OpJXgj/Uavz3JQXhJEE4BMxgg/iv96JWCjW8jeP2MxuPJgfVggdmgEHBD1m3aV22nxYaYbMaAvy8HqYhrDw==` | omo-ai 5.1.7 / senpi 2026.9.30 |

Package: `@cortexkit/pi-magic-context`. Each pin's exact dependency tree lives in its own lockfile and is
installed into `~/.local/share/magic-omo/vendor/<version>/`, integrity-checked and frozen with `SHA256SUMS`.

## Matrix

| Magic Context | Schema fence | OMO Native (`omo-ai`) | Senpi | Status | Verified | Notes |
|---|---|---|---|---|---|---|
| **0.44.4** | v91 | `5.1.9` | `2026.10.1-3` | ⚠️ unverified | — | Pinned; lockfile integrity matches npm. Awaiting the end-to-end sandbox run. |
|  |  | `5.1.8` | `2026.10.1-2` | ⚠️ unverified | — | Pinned; lockfile integrity matches npm. Awaiting the end-to-end sandbox run. |
|  |  | `5.1.7` | `2026.9.30` | ⚠️ unverified | — | Pinned; lockfile integrity matches npm. Awaiting the end-to-end sandbox run. |
| **0.43.2** **(default)** | v90 | `5.1.8` | `2026.10.1-2` | ⚠️ unverified | — | Released after the last verification. Doctor reports WARN (FAIL with --strict) until re-verified. |
|  |  | `5.1.7` | `2026.9.30` | ✅ verified | 2026-10-01 | Sandbox-verified: extension loads (harness=pi), ctx_* tools registered, writes land in the configured store, historian published a compartment, [native].memory policy suppresses OMO automatic memory while explicit `memory` still commits. |

## Rules

- Every process sharing one context.db (OMO Native via magic-omo, OpenCode, Hermes via magic-hermes, Pi) must run the same Magic Context major.minor series.
- A context.db whose schema is newer than a build's fence makes that build fail closed; doctor reports FAIL.
- A newer build migrates an older context.db forward and locks out older hosts, so setup never selects a newer series than the other hosts already run.
- Setup selects the pin in this order: `--mc` / `MAGIC_OMO_MC_VERSION`; the recorded pin while peers still agree; the series the other hosts and the shared database already run; then `default_pin`.
- A row is marked verified only after the end-to-end sandbox run against that exact combination.

`magic-omo doctor` reports an OMO/Senpi version that is not in a `verified` row as **WARN** (or **FAIL** with `--strict`).
