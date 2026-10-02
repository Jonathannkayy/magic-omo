# Changelog

All notable changes to magic-omo are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release notes published on GitHub come from `RELEASE_NOTES.md` when that file exists at
the tag; otherwise GitHub generates them from the merged pull requests.

## [Unreleased]

### Added

- Multiple Magic Context pins side by side (`compat.json` `pins[]`, one vendor lockfile
  per version under `vendor/<version>/`). `magic-omo setup` selects the pin matching the
  Magic Context series your other hosts already run instead of always taking the newest.
- `magic-omo pins [--json]` lists every supported Magic Context version and its verified
  OMO/Senpi combinations; `magic-omo setup --mc <version>` (or `MAGIC_OMO_MC_VERSION`)
  overrides the selection, `--prune` removes the vendored runtimes that are no longer used.
- `scripts/contract-check.js` plus a daily `upstream-compat` workflow: a static, secret-free
  check that upstream still dispatches `session_before_compact`, still skips local/pinned
  sources, still honours the agent-dir environment variables, still accepts the
  `[native].memory` sub-keys, and still ships a loadable Pi extension with a schema fence.

### Changed

- `doctor` reports which pin was selected and why, lists every supported pin, and runs the
  vendor, fence, series and host-version checks against the selected pin.
- Re-running `setup` after the other hosts move swaps the `extensions[]` entry in place as a
  recorded edit, so `uninstall` still restores the original settings file exactly.

## [0.1.0] - 2026-10-01

### Added

- First release: install the pinned `@cortexkit/pi-magic-context` Pi runtime into OMO Native,
  switch off OMO's automatic memory subsystems, and keep every change recorded and revertible.
- `doctor` health checks (host versions, Senpi contract, vendored-tree integrity, DB schema
  fence, same-series rule across OpenCode and magic-hermes, historian model resolution).
- Opt-in `guard`: re-runs doctor when upstream changes and auto-uninstalls on a hard failure.
