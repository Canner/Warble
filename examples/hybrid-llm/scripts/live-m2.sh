#!/usr/bin/env bash
# M2 — the full mixed hybrid run (live). One answer_query dispatch: resolve_intent → LOCAL ollama,
# generate_sql → CLOUD Claude, in a single run. Prints the per-step provider routing from the trace.
#
# Prereqs: ollama serving qwen2.5 (scripts/setup.sh); a jaffle DuckDB profile (see
# setup-queryable-jaffle.sh). The cloud step runs with `ANTHROPIC_BASE_URL` unset (see below), so it
# talks to Anthropic directly rather than through any local proxy that variable may point at.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
Q="${1:-How many orders are there in total?}"
work="${TMPDIR:-/tmp}/warble-hybrid"; mkdir -p "$work"

PROJ="$("$here/setup-queryable-jaffle.sh")"
# Slice answer_query out of the committed genbi-default IR (the full IR also has a realize-render
# component that is out of hybrid-staged POC scope).
node -e "const ir=require('$repo/genbi-default/ir.golden.json'); ir.components=ir.components.filter(c=>c.verb==='answer_query'); require('fs').writeFileSync('$work/answer_query.ir.json',JSON.stringify(ir,null,2))"

cd "$repo/dispatcher/claude-agent-sdk"
echo ">> dispatching (cloud step via direct login) ..." 1>&2
env -u ANTHROPIC_BASE_URL npx --yes tsx src/cli.ts dispatch "$work/answer_query.ir.json" "$Q" \
  --models-config "$repo/examples/hybrid-llm/bindings/hybrid-cheap-local.yml" \
  --project "$PROJ" --out "$work/m2-run" 1>&2

echo; echo "=== per-step provider routing (trace.json) ==="
node -e "const t=require('$work/m2-run/trace.json'); console.log('run label:', t.model); const seen=new Set(); for(const s of t.steps){ if(seen.has(s.parent_tool_use_id))continue; seen.add(s.parent_tool_use_id); console.log('  ', String(s.parent_tool_use_id).padEnd(16), '->', s.model); }"
echo "=== final answer ==="; tail -6 "$work/m2-run/result.txt"
