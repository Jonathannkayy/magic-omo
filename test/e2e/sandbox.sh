#!/usr/bin/env bash
# End-to-end sandbox: run REAL OMO Native with magic-omo installed, fully isolated.
#
# Isolation: own HOME, OMO_CODING_AGENT_DIR/SENPI_/PI_, XDG_{CONFIG,DATA,STATE,CACHE,RUNTIME}
# dirs, TMPDIR, MAGIC_OMO_HOME, and MAGIC_CONTEXT_STORAGE_DIR on a `sqlite3 -readonly .backup`
# SNAPSHOT of your live DB (or an empty store with --fresh). Refuses to run if any resolved
# path lands in the real home's .omo, the real Magic Context store, or the real cortexkit config.
#
# This EXECUTES `omo` and makes real model calls on whatever auth you copy in. Not run in CI.
#
#   test/e2e/sandbox.sh [--fresh] [--auth <auth.json to copy>] [--model <id>] [--keep]
#
# Asserts: extension loads at the pinned version against the SANDBOX db; ctx tools registered;
# a ctx_memory canary lands in the sandbox db and NOT in the live db.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
REAL_HOME=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6 || true)
REAL_HOME=${REAL_HOME:-$HOME}
LIVE_STORE=${LIVE_STORE:-$REAL_HOME/.local/share/cortexkit/magic-context}
FRESH=0 AUTH="" MODEL=${SANDBOX_MODEL:-} KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --fresh) FRESH=1 ;;
    --auth) AUTH=$2; shift ;;
    --model) MODEL=$2; shift ;;
    --keep) KEEP=1 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v omo >/dev/null || { echo "omo not on PATH" >&2; exit 3; }
command -v sqlite3 >/dev/null || { echo "sqlite3 required" >&2; exit 3; }

SB=$(mktemp -d "${SANDBOX_PARENT:-${TMPDIR:-/tmp}}/magic-omo-e2e.XXXXXX")
cleanup() { if [ "$KEEP" = 1 ]; then echo "kept $SB"; else rm -rf "$SB"; fi; }
trap cleanup EXIT

export HOME="$SB/home"
export OMO_CODING_AGENT_DIR="$SB/home/.omo/agent"
export SENPI_CODING_AGENT_DIR="$OMO_CODING_AGENT_DIR" PI_CODING_AGENT_DIR="$OMO_CODING_AGENT_DIR"
export XDG_CONFIG_HOME="$SB/home/.config" XDG_DATA_HOME="$SB/data" XDG_STATE_HOME="$SB/state"
export XDG_CACHE_HOME="$SB/cache" XDG_RUNTIME_DIR="$SB/runtime" TMPDIR="$SB/tmp"
export MAGIC_OMO_HOME="$SB/magic-omo"
export MAGIC_CONTEXT_STORAGE_DIR="$SB/data/cortexkit/magic-context"
export MAGIC_CONTEXT_LOG_PATH="$SB/magic-context.log"
export OMO_DISABLE_POSTHOG=1 OMO_SENPI_DISABLE_POSTHOG=1
unset ANTHROPIC_BASE_URL
mkdir -p "$OMO_CODING_AGENT_DIR" "$XDG_CONFIG_HOME/cortexkit" "$MAGIC_CONTEXT_STORAGE_DIR" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" "$TMPDIR" "$SB/project"
mkdir -m 700 "$XDG_RUNTIME_DIR"

# Hard refusal, enforced by magic-omo's own isolation check AND a shell-level check.
for p in "$OMO_CODING_AGENT_DIR" "$MAGIC_CONTEXT_STORAGE_DIR" "$XDG_CONFIG_HOME/cortexkit"; do
  rp=$(readlink -f "$p")
  for live in "$REAL_HOME/.omo" "$LIVE_STORE" "$REAL_HOME/.config/cortexkit"; do
    case "$rp/" in "$(readlink -f "$live" 2>/dev/null || echo "$live")/"*) echo "REFUSING: $p resolves into live $live" >&2; exit 90 ;; esac
  done
done
node --input-type=module -e "import('$REPO/src/isolation.js').then(m=>m.assertIsolated(process.env,'$REAL_HOME'))" || exit 90

if [ "$FRESH" = 0 ] && [ -f "$LIVE_STORE/context.db" ]; then
  sqlite3 -readonly "$LIVE_STORE/context.db" ".backup '$MAGIC_CONTEXT_STORAGE_DIR/context.db'"
  [ "$(sqlite3 "$MAGIC_CONTEXT_STORAGE_DIR/context.db" 'pragma quick_check;')" = ok ] || { echo "snapshot quick_check failed" >&2; exit 1; }
fi
[ -n "$AUTH" ] && install -m 600 "$AUTH" "$OMO_CODING_AGENT_DIR/auth.json"
[ -n "${SANDBOX_MC_CONFIG:-}" ] && cp "$SANDBOX_MC_CONFIG" "$XDG_CONFIG_HOME/cortexkit/magic-context.jsonc"

node "$REPO/bin/magic-omo.js" setup --yes --no-todowrite
TOKEN="E2E-$(date +%s)-$RANDOM"
cd "$SB/project"
timeout "${SANDBOX_TIMEOUT:-300}" omo ${MODEL:+--model "$MODEL"} -p \
  "Call ctx_memory with action write, category CONFIG_VALUES, content '$TOKEN canary'. Then reply DONE." || true

fail() { echo "E2E FAIL: $*" >&2; exit 1; }
# The version setup actually selected in this sandbox (see `magic-omo status --json`).
PIN=$(node "$REPO/bin/magic-omo.js" status --json | node -p "JSON.parse(require('node:fs').readFileSync(0,'utf8')).magic_context")
grep -q "loaded v$PIN" "$MAGIC_CONTEXT_LOG_PATH" || fail "extension did not load at v$PIN"
grep -q "registered tools: ctx_search, ctx_memory" "$MAGIC_CONTEXT_LOG_PATH" || fail "ctx tools not registered"
n_sb=$(sqlite3 -readonly "$MAGIC_CONTEXT_STORAGE_DIR/context.db" "select count(*) from memories where content like '$TOKEN%'")
[ "$n_sb" -ge 1 ] || fail "canary not in sandbox db"
if [ -f "$LIVE_STORE/context.db" ]; then
  n_live=$(sqlite3 -readonly "$LIVE_STORE/context.db" "select count(*) from memories where content like '$TOKEN%'")
  [ "$n_live" -eq 0 ] || fail "CANARY LEAKED INTO LIVE DB"
fi
node "$REPO/bin/magic-omo.js" uninstall --yes
echo "E2E PASS ($TOKEN)"
