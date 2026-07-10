#!/usr/bin/env bash
# CLI (file) target hybrid — llm:per_step_provider on claude-code (live). `warble dispatch` emits a
# driver agent; the driver (run via `claude -p --agent`) runs the LOCAL step (resolve_intent → ollama)
# and does the SQL step itself on cloud Opus. Two realizations, pick with REALIZATION=:
#   skill-shell (default) — local step is an emitted Bash script (needs Bash(bash:*) in the allowlist)
#   mcp-server            — local step is an MCP tool (`warble mcp-serve` via .mcp.json; NO bash widening)
# Contrast with live-m2.sh, which exercises the Agent SDK back-end.
#
# Prereqs: ollama serving qwen2.5 (scripts/setup.sh); a jaffle DuckDB profile (setup-queryable-jaffle.sh);
# a Claude login. The cloud step runs under `env -u ANTHROPIC_BASE_URL` (direct login).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
WB="$repo/target/release/warble"
[ -x "$WB" ] || { echo "build the CLI first:  (cd $repo && cargo build --release -p warble-cli)"; exit 1; }
Q="${1:-How many orders are there in total?}"
REAL="${REALIZATION:-skill-shell}"
case "$REAL" in skill-shell|mcp-server) ;; *) echo "REALIZATION must be skill-shell or mcp-server"; exit 1;; esac
work="${TMPDIR:-/tmp}/warble-hybrid"; mkdir -p "$work"

PROJ="$("$here/setup-queryable-jaffle.sh")"
node -e "const ir=require('$repo/genbi-default/ir.golden.json'); ir.components=ir.components.filter(c=>c.verb==='answer_query'); require('fs').writeFileSync('$work/answer_query.ir.json',JSON.stringify(ir,null,2))"

echo ">> dispatching (file target, hybrid realization: $REAL) ..." 1>&2
"$WB" dispatch "$work/answer_query.ir.json" --target claude-code:headless \
  --models-config "$repo/examples/hybrid-llm/bindings/hybrid-cheap-local.yml" \
  --hybrid-realization "$REAL" --out "$work/cli-hybrid" 1>&2
echo "   emitted:" 1>&2
find "$work/cli-hybrid" -type f | sed "s#$work/cli-hybrid/#     #" 1>&2

mkdir -p "$PROJ/.claude/agents"
cp "$work/cli-hybrid/.claude/agents/answer_query.md" "$PROJ/.claude/agents/answer_query.md"
cleanup() { rm -f "$PROJ/.claude/agents/answer_query.md"; }
trap cleanup EXIT

TRACE="$work/cli-hybrid/hybrid-trace.jsonl"; rm -f "$TRACE"
cd "$PROJ"
echo ">> running driver via claude -p ..." 1>&2
if [ "$REAL" = "mcp-server" ]; then
  out=$(PATH="$PROJ/.venv/bin:$PATH" env -u ANTHROPIC_BASE_URL claude -p "$Q" \
    --agent answer_query --mcp-config "$work/cli-hybrid/.mcp.json" \
    --allowedTools Read "Bash(wren:*)" "mcp__warble__local_infer" --output-format json 2>/dev/null)
else
  out=$(PATH="$PROJ/.venv/bin:$PATH" env -u ANTHROPIC_BASE_URL claude -p "$Q" \
    --agent answer_query --allowedTools Read "Bash(wren:*)" "Bash(bash:*)" --output-format json 2>/dev/null)
fi

echo
echo "=== answer (file-target hybrid: $REAL) ==="
node -e "const d=JSON.parse(process.argv[1]); console.log('result:', d.result); console.log('cost_usd:', d.total_cost_usd)" "$out" 2>/dev/null || echo "$out"

echo
echo "=== local-step evidence ==="
if [ "$REAL" = "skill-shell" ] && [ -s "$TRACE" ]; then
  node -e "require('fs').readFileSync('$TRACE','utf8').trim().split('\n').forEach(l=>{const t=JSON.parse(l); console.log('  '+t.step.padEnd(16)+'-> LOCAL '+t.provider+':'+t.model+' @ '+t.endpoint+'  (in '+t.input_chars+'c / out '+t.output_chars+'c)')})"
elif [ "$REAL" = "skill-shell" ]; then
  echo "  !! empty trace — the driver did NOT run the local script; the local step did not fire."
else
  echo "  local step ran via the mcp__warble__local_infer tool → warble mcp-serve → ollama."
  echo "  (confirm in ollama's log: a POST /v1/chat/completions around now)"
fi
echo "  generate_sql/repair_sql -> CLOUD (driver's own turns inside claude; see cost_usd above)"
