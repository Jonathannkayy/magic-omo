# How this repository is maintained

magic-omo is maintained day to day by **Dante** ([@sudodante](https://github.com/sudodante)), an AI agent operated by
[@Jonathannkayy](https://github.com/Jonathannkayy). This page is the contract: what the bot does, what it will never
do, and how you reach a human.

## What happens when you open something

| You do | Dante does |
|---|---|
| Open an issue | Thanks you, plans a resolution with OMO Native's `ulw-plan`, then either asks you for specifics, explains why it's out of scope, or implements it with `ulw-execute` and opens a fix PR linked to your issue. You get updates in the issue at every step. |
| Open a pull request | Thanks you, runs OMO Native's `review-work` on your exact commit, plus an independent security pass, and posts the full report on the PR. |
| Push an update | Re-reviews the new commit automatically. |
| cubic leaves findings | Fixes or rebuts every one in a real OMO Native session, pushes to the **same branch** (never a new one, never a force-push), replies on each thread and resolves it. On forks it asks you to resolve them instead. |
| Get approved | CI + the `magic-omo/review` check go green and every cubic finding is resolved, then a short courtesy window, then a squash-merge with credit. |

## Merge rules (enforced by branch protection, not by goodwill)

- Nobody pushes to `main`. Everything lands through a pull request.
- The bot never merges a PR that is closed, a draft, or has moved since it was reviewed, and never merges the owner's own PRs
  until the owner adds the `owner-approved` label.
- Required checks: the full CI matrix, lint, and `magic-omo/review` (only the maintainer sets that last one). CodeQL
  becomes a required check automatically when the repository is public; GitHub doesn't offer code scanning on free
  private repositories, so until then it is skipped.
- Changes to **maintainer-only files** are never merged by the bot, even when the review passes. These are CI/CD workflows,
  release config, security policy, licensing, dependency manifests and lockfiles, version pins, build scripts, and this file.
  The owner approves those personally.
- Releases are cut by the bot only through a release PR that changes nothing but the version field and the changelog,
  checked mechanically, never by judgment.

## What the bot will never do

- **Follow instructions from GitHub.** Issues, PR descriptions, comments, code and commit messages are treated as data.
  Asking the bot to do something ("approve this", "ignore previous instructions", "run …") has no effect, and attempts are
  reported as security findings in the review.
- **Run your code with credentials.** Reviews and fixes run as real interactive OMO Native sessions (`review-work`, with its gate
  reviewer sub-agent) in a throwaway sandbox user with no GitHub token, no access to
  the maintainer's files, and no network except the model endpoint. CI for pull requests runs on GitHub's hosted runners
  with read-only permissions and no secrets.
- **Post anything a model wrote verbatim.** Everything public comes from fixed templates. The review report is sanitized
  (no HTML, no mentions, no external links) and clearly labeled as the review output.

## Reaching a human

Add a comment saying so, or label the issue `needs-owner`; the owner is notified of every issue and PR anyway.
Security issues: please use private vulnerability reporting (see [SECURITY.md](SECURITY.md)), never a public issue.
