# Contributing to magic-omo

Thanks for helping! Ground rules:

1. **Fork + pull request only.** No direct pushes to `main`; branch protection requires review from a code owner and green CI.
2. **Tests required.** Every behavior change comes with a `node:test` test in `test/`. Run `npm test` (and `npm run lint`, `npm run compat:check`) before opening the PR. Tests must never touch a real `~/.omo`, the real Magic Context store, or run the real `omo`; use the fixtures in `test/helpers.js`.
3. **Conventional commits** (`feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:` …). PRs are squash-merged; the PR title becomes the commit.
4. **Compatibility changes** edit `compat.json`, then `npm run compat:gen`. Only mark a row `verified` after running `test/e2e/sandbox.sh` against that exact OMO/Senpi/Magic Context combination, and say so in the PR.
5. **Upstream bugs** in Magic Context or OMO belong in their trackers, not here.
6. **License: inbound = outbound.** By contributing you agree your contribution is licensed under the MIT License of this repository.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).
