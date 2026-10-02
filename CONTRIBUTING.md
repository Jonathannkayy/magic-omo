# Contributing to magic-omo

Thanks for helping! Day-to-day maintenance (reviews, issue triage, merges, releases) is done by an AI maintainer, Dante, under rules you can read in [MAINTAINER_BOT.md](MAINTAINER_BOT.md). Ground rules:

1. **Fork + pull request only.** No direct pushes to `main`; branch protection requires green CI, lint and the `magic-omo/review` check (plus CodeQL once the repo is public).
2. **Tests required.** Every behavior change comes with a `node:test` test in `test/`. Run `npm test` (and `npm run lint`, `npm run compat:check`) before opening the PR. Tests must never touch a real `~/.omo`, the real Magic Context store, or run the real `omo`; use the fixtures in `test/helpers.js`.
3. **Conventional commits** (`feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:` …). PRs are squash-merged; the PR title becomes the commit.
4. **Compatibility changes** edit `compat.json`, then `npm run compat:gen` (`docs/COMPATIBILITY.md` and the README block are generated; CI fails on drift).
   - `pins[]` is newest first. Adding a Magic Context version means: a new `vendor/<version>/{package.json,package-lock.json}` generated with `npm install --ignore-scripts --package-lock-only --save-exact @cortexkit/pi-magic-context@<version>`, a `pins[]` entry whose `integrity` equals the lockfile's (and npm's `dist.integrity`), a `schema_fence` read from `LATEST_SUPPORTED_VERSION` in that build's `dist/`, and `matrix` rows with `status: "unverified"`.
   - `default_pin` is the newest pin with a verified row. Do not move it ahead of verification: setup falls back to it only when a machine has no other Magic Context host and no shared database.
   - Only mark a row `verified` after running `test/e2e/sandbox.sh` against that exact OMO/Senpi/Magic Context combination; put the evidence in the row's `evidence` field and say so in the PR.
   - `node scripts/contract-check.js --omo-ai <version> --mc <version>` is the cheap pre-flight (static, no model calls); the `upstream-compat` workflow runs it daily for every verified pin.
5. **Upstream bugs** in Magic Context or OMO belong in their trackers, not here.
6. **License: inbound = outbound.** By contributing you agree your contribution is licensed under the MIT License of this repository.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).
