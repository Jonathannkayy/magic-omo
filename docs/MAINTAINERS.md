# Maintainer runbook

Apply these once, **after** creating `Jonathannkayy/magic-omo` on GitHub. Each command requires an admin token (`gh auth status`).

```bash
R=Jonathannkayy/magic-omo

# Repository settings: squash-only, delete branch on merge, Discussions on
gh api -X PATCH repos/$R \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true -F has_discussions=true \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY

# Branch protection on main. Required check names = CI job names (ci.yml + codeql.yml).
gh api -X PUT repos/$R/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "test (node 20, ubuntu-latest)", "test (node 22, ubuntu-latest)", "test (node 24, ubuntu-latest)",
      "test (node 20, macos-latest)",  "test (node 22, macos-latest)",  "test (node 24, macos-latest)",
      "lint", "analyze (javascript)"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON

# Private vulnerability reporting
gh api -X PUT repos/$R/private-vulnerability-reporting

# Secret scanning + push protection
gh api -X PATCH repos/$R --input - <<'JSON'
{ "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" } } }
JSON

# Dependabot alerts + security updates
gh api -X PUT repos/$R/vulnerability-alerts
gh api -X PUT repos/$R/automated-security-fixes

# Protected environment for npm publishing (manual approval by the owner)
OWNER_ID=$(gh api users/Jonathannkayy --jq .id)
gh api -X PUT repos/$R/environments/npm --input - <<JSON
{ "reviewers": [ { "type": "User", "id": $OWNER_ID } ], "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
gh api -X POST repos/$R/environments/npm/deployment-branch-policies -f name='v*' -f type=tag
# then: gh secret set NPM_TOKEN --env npm
```

Verify:

```bash
gh api repos/$R/branches/main/protection --jq '{checks:.required_status_checks.contexts, reviews:.required_pull_request_reviews, linear:.required_linear_history.enabled}'
gh api repos/$R --jq '{squash:.allow_squash_merge, merge:.allow_merge_commit, rebase:.allow_rebase_merge, del:.delete_branch_on_merge, discussions:.has_discussions, sa:.security_and_analysis}'
```

`enforce_admins` is deliberately `false` so the owner can recover from a broken protection rule.

## Releasing

1. Bump `version` in `package.json`, then update `compat.json` if needed and run `npm run compat:gen`.
2. Merge the PR, then `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `release.yml` tests the code, packs it, and creates a GitHub release. The npm publish waits for approval on the `npm` environment and is skipped when `NPM_TOKEN` is unset.

## Re-verifying a new OMO / Magic Context version

First run the cheap static check: `node scripts/contract-check.js --omo-ai <version> --mc <version>` (no secrets, no model calls; the `upstream-compat` workflow runs it daily for every verified pin). Then run `test/e2e/sandbox.sh` against the exact versions.

A new Magic Context version is ADDED to `compat.json` `pins[]` (newest first), never swapped in: generate `vendor/<version>/{package.json,package-lock.json}` with `npm install --ignore-scripts --package-lock-only --save-exact @cortexkit/pi-magic-context@<version>`, check the lockfile `integrity` equals npm's `dist.integrity` (`npm view @cortexkit/pi-magic-context@<version> dist.integrity`), then get `schema_fence`. `--package-lock-only` installs nothing, so there is no `dist/` to read yet: either run `node scripts/contract-check.js --omo-ai <omo version> --mc <version>` and take `schema_fence` from its JSON output, or install the locked tree with `(cd vendor/<version> && npm ci --ignore-scripts)` and read `LATEST_SUPPORTED_VERSION` with `grep -rhoE 'LATEST_SUPPORTED_VERSION *= *[0-9]+' vendor/<version>/node_modules/@cortexkit/pi-magic-context/dist | head -1` (then `rm -rf vendor/<version>/node_modules`; it is gitignored and must not be committed). Finally add `matrix` rows with `status: "unverified"`. Only after the sandbox run: flip the row to `verified`, fill `evidence` and `verified_on`, and move `default_pin` to that version. Finally `npm run compat:gen` and open a PR.
