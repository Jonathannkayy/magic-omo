# Compatibility

> Generated from [`compat.json`](../compat.json) by `npm run compat:gen`. Do not edit by hand; CI fails on drift.

## Current pin

| Field | Value |
|---|---|
| Package | `@cortexkit/pi-magic-context` |
| Version | `0.43.2` |
| npm integrity | `sha512-9l/OpJXgj/Uavz3JQXhJEE4BMxgg/iv96JWCjW8jeP2MxuPJgfVggdmgEHBD1m3aV22nxYaYbMaAvy8HqYhrDw==` |
| DB schema fence | `v90` (`LATEST_SUPPORTED_VERSION` in the build) |
| Verified OMO Native | `omo-ai 5.1.7` |
| Verified Senpi | `@code-yeongyu/senpi 2026.9.30` |

## Matrix

| Magic Context (`@cortexkit/pi-magic-context`) | Schema fence | OMO Native (`omo-ai`) | Senpi | Status | Verified | Notes |
|---|---|---|---|---|---|---|
| 0.43.2 | v90 | 5.1.7 | 2026.9.30 | ✅ verified | 2026-10-01 | Sandbox-verified: extension loads (harness=pi), ctx_* tools registered, writes land in the configured store, historian published a compartment, [native].memory policy suppresses OMO automatic memory while explicit `memory` still commits. |
| 0.43.2 | v90 | 5.1.8 | unknown | ⚠️ unverified | — | Released after the last verification. Doctor reports WARN (FAIL with --strict) until re-verified. |

## Rules

- Every process sharing one context.db (OMO Native via magic-omo, OpenCode, Hermes via magic-hermes, Pi) must run the same Magic Context major.minor series.
- A context.db whose schema is newer than the pinned build's fence makes the pinned extension fail closed; doctor reports FAIL.
- Magic Context 0.44.x introduces schema v91; magic-omo will pin it only after re-verification.

`magic-omo doctor` reports an OMO/Senpi version that is not in a `verified` row as **WARN** (or **FAIL** with `--strict`).
