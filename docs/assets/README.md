# Screenshots

All three images are real captures; nothing is mocked up or edited by hand. Each one comes from a
throwaway environment that contains **no real user data**:

- its own `HOME`, `OMO_CODING_AGENT_DIR`, XDG dirs and `TMPDIR`
- a **fresh, empty** Magic Context store (`MAGIC_CONTEXT_STORAGE_DIR` pointing at a new directory, so
  Magic Context creates a brand-new `context.db`; only the embedding model cache was copied in)
- a fictional demo project, `orbit-notes` (a small zero-dependency TypeScript notes API with a few commits)

| File | What it shows | How it was produced |
|---|---|---|
| `hero.png` | OMO Native 5.1.7 mid-session in `orbit-notes`: todo plan, applied patch diffs, a Magic Context compaction notice, and the status line with the model and the `mc:` segment (`mc: 57K (12%) · historian`) | Real multi-turn TUI session (add a `/notes/search` endpoint with tests, then a tag filter; OMO ran `npm test` and committed). The demo copy of `magic-context.jsonc` used a low `execute_threshold_tokens` (45000) so the historian fires in a short session. |
| `ctx-search.png` | OMO's `ctx_search` tool returning memories `id=4` and `id=5` | Those two memories were written **by the Hermes runtime** (`magic_hermes` bridge, `ctx_memory` over JSON-RPC) into the same demo store while the OMO session was running, then found by OMO. Memories 1–3 (also written from Hermes) were already in OMO's injected memory block, which is why they show as "suppressed … already visible". |
| `doctor.png` | `magic-omo doctor` after `magic-omo setup --yes`: `14 pass, 0 warn, 0 fail, 6 info — OK` | Run in a clean throwaway `HOME` (empty `settings.json`, minimal `omo.jsonc`). `MAGIC_CONTEXT_STORAGE_DIR` pointed at the demo store so the shared `context.db` check has a database to read. Captured through a pty (`script`) to keep colors. |

## Pipeline

1. TUI captures: `tmux capture-pane -e -p` (keeps the ANSI colors) from a detached tmux session that ran
   OMO with the isolated environment above. Doctor capture: `script -qec "magic-omo doctor" /dev/null`.
2. [`scripts/ansi2png.py`](../../scripts/ansi2png.py) turns the SGR escapes into HTML spans, **redacts
   before rendering** (home prefixes become `~`, e-mail addresses, token-like strings and account names
   are replaced, and a final leak check prints `LEAK` if anything is left), and screenshots the page with
   headless Chrome at 1.6x. The result is then cropped to the window with Pillow.
3. Each PNG was then checked by eye for clipping and leaked data.

Example:

```bash
SHOT_HOME_PREFIXES="$DEMO/home:$DEMO/data=~/.local/share" \
  python3 scripts/ansi2png.py hero.ans docs/assets/hero.png --cols 174 --first 14 \
  --strip-blank-runs --scale 1.6 --title "omo — ~/projects/orbit-notes"
```
