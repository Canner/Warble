#!/usr/bin/env bash
# CLI (file) target hybrid — the skill-shell realization of llm:per_step_provider (live).
# `warble dispatch` emits a driver agent + a local-inference script; the driver (run via `claude -p
# --agent`) runs the script for the LOCAL step (resolve_intent → ollama) and does the SQL step itself
# on cloud Opus. Contrast with live-m2.sh, which exercises the Agent SDK back-end.
#
# Prereqs: ollama serving qwen2.5 (scripts/setup.sh); a jaffle DuckDB profile (setup-queryable-jaffle.sh);
# a Claude login. The cloud step runs under `env -u ANTHROPIC_BASE_URL` (direct login), so Opus is used
# regardless of any local proxy.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
WB="$repo/target/release/warble"
[ -x "$WB" ] || { echo "build the CLI first:  (cd $repo && cargo build --release -p warble-cli)"; exit 1; }
Q="${1:-How many orders are there in total?}"
work="${TMPDIR:-/tmp}/warble-hybrid"; mkdir -p "$work"

PROJ="$("$here/setup-queryable-jaffle.sh")"

# Slice answer_query out of the committed genbi-default IR (its other components include a
# realize-render one, out of the hybrid POC scope).
node -e "const ir=require('$repo/genbi-default/ir.golden.json'); ir.components=ir.components.filter(c=>c.verb==='answer_query'); require('fs').writeFileSync('$work/answer_query.ir.json',JSON.stringify(ir,null,2))"

echo ">> dispatching (file target, skill-shell hybrid) ..." 1>&2
"$WB" dispatch "$work/answer_query.ir.json" --target claude-code:headless \
  --models-config "$repo/examples/hybrid-llm/bindings/hybrid-cheap-local.yml" \
  --out "$work/cli-hybrid" 1>&2
echo "   emitted:" 1>&2
find "$work/cli-hybrid" -type f | sed "s#$work/cli-hybrid/#     #" 1>&2

# Install the driver agent into the queryable project (the local-inference scripts are referenced by
# absolute path in the driver, so they resolve regardless of cwd — no need to copy them).
mkdir -p "$PROJ/.claude/agents"
cp "$work/cli-hybrid/.claude/agents/answer_query.md" "$PROJ/.claude/agents/answer_query.md"
cleanup() { rm -f "$PROJ/.claude/agents/answer_query.md"; }
trap cleanup EXIT

echo ">> running driver via claude -p (local intent script + cloud SQL) ..." 1>&2
cd "$PROJ"
out=$(PATH="$PROJ/.venv/bin:$PATH" env -u ANTHROPIC_BASE_URL claude -p "$Q" \
  --agent answer_query --allowedTools Read "Bash(wren:*)" "Bash(bash:*)" --output-format json 2>/dev/null)
echo
echo "=== answer (file-target skill-shell hybrid) ==="
node -e "const d=JSON.parse(process.argv[1]); console.log('result:', d.result); console.log('cost_usd:', d.total_cost_usd)" "$out" 2>/dev/null || echo "$out"
echo
echo "resolve_intent ran on LOCAL qwen2.5 (via the emitted script); generate_sql ran on CLOUD Opus (the driver's own wren work)."
