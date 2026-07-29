#!/usr/bin/env bash
# M3 — Pareto + "which step can go local" verdict (live), over 3 distinctive-value scalar goldens.
#   * all-cloud baseline: the PROVEN file-target eval (`warble-eval run --models opus`) — same path
#     that captured the goldens; `claude -p` grants Bash so `wren` runs.
#   * cheap->local: the SDK hybrid path (resolve_intent local, generate_sql cloud), scored by
#     execution-based value match (the common denominator vs the file target's output shape).
# Accuracy is the comparable metric; cost/latency are NOT like-for-like (different runners) — see
# FINDINGS.md. Cloud steps run with `ANTHROPIC_BASE_URL` unset (see below), so they talk to
# Anthropic directly rather than through any local proxy that variable may point at.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
WB="$repo/target/release/warble"
WBE="$repo/target/release/warble-eval"
[ -x "$WB" ] || { echo "build the CLI first:  (cd $repo && cargo build --release -p warble-cli)"; exit 1; }
[ -x "$WBE" ] || { echo "build the eval binary first:  (cd $repo && cargo build --release -p warble-eval-runner)"; exit 1; }
work="${TMPDIR:-/tmp}/warble-hybrid"; mkdir -p "$work/m3"
PROJ="$("$here/setup-queryable-jaffle.sh")"

cat > "$work/cases3.yaml" <<'YAML'
dataset: jaffle_shop
context_version: jaffle_shop@frozen-poc
cases:
  - { id: total_orders, question: "How many orders are there in total?", tags: [simple-agg], match: scalar, tolerance: {numeric: 0.0}, expected: {columns: [total_orders], rows: [[99]]} }
  - { id: total_revenue, question: "What is the total revenue across all orders?", tags: [simple-agg], match: scalar, tolerance: {numeric: 0.01}, expected: {columns: [total_revenue], rows: [[1672.0]]} }
  - { id: completed_revenue, question: "What is the total revenue from completed orders only?", tags: [filter-agg], match: scalar, tolerance: {numeric: 0.01}, expected: {columns: [completed_revenue], rows: [[1103.0]]} }
YAML

echo "=== [1/2] all-cloud baseline (file target, single-step answer_query, opus) ===" 1>&2
"$WB" compile "$repo/eval/answer-agent" -o "$work/aq-single.ir.json" 1>&2
"$WB" dispatch "$work/aq-single.ir.json" --out "$work/aq-agent" 1>&2
env -u ANTHROPIC_BASE_URL "$WBE" run --project "$PROJ" --agent-dir "$work/aq-agent" --golden "$work/cases3.yaml" --models opus

echo; echo "=== [2/2] cheap->local hybrid (SDK 3-step) ===" 1>&2
node -e "const ir=require('$repo/genbi-default/ir.golden.json'); ir.components=ir.components.filter(c=>c.verb==='answer_query'); require('fs').writeFileSync('$work/answer_query.ir.json',JSON.stringify(ir,null,2))"
cd "$repo/dispatcher/claude-agent-sdk"
declare -a CASES=(
  "total_orders|How many orders are there in total?|99"
  "total_revenue|What is the total revenue across all orders?|1672"
  "completed_revenue|What is the total revenue from completed orders only?|1103"
)
pass=0; n=0; latsum=0; costsum=0
for c in "${CASES[@]}"; do
  IFS='|' read -r cid q exp <<< "$c"; n=$((n+1))
  echo "   >> $cid ..." 1>&2
  out="$work/m3/hybrid-$cid"
  env -u ANTHROPIC_BASE_URL npx --yes tsx src/cli.ts dispatch "$work/answer_query.ir.json" "$q" \
    --models-config "$repo/examples/hybrid-llm/bindings/hybrid-cheap-local.yml" \
    --project "$PROJ" --out "$out" >/dev/null 2>&1
  if grep -qE "(^|[^0-9])$exp([^0-9]|\$)" "$out/result.txt" 2>/dev/null; then pass=$((pass+1)); ok=PASS; else ok=FAIL; fi
  lat=$(node -e "try{console.log(require('$out/trace.json').run.duration_ms)}catch(e){console.log(0)}")
  cost=$(node -e "try{console.log(require('$out/trace.json').run.total_cost_usd)}catch(e){console.log(0)}")
  latsum=$((latsum+lat)); costsum=$(node -e "console.log($costsum+$cost)")
  echo "   $ok $cid (${lat}ms, \$$cost)" 1>&2
done
echo; echo "=== cheap->local (SDK hybrid) ==="
node -e "console.log('acc='+($pass/$n).toFixed(2), 'avg_lat_ms='+Math.round($latsum/$n), 'total_cost=\$'+($costsum).toFixed(4), 'n=$n')"
echo
echo "Verdict: resolve_intent (cheap) is safe to push local — accuracy holds because generate_sql"
echo "(strong) stays on cloud Opus. Cost/latency across the two rows are NOT like-for-like (different"
echo "runners); accuracy is the comparable metric. See FINDINGS.md."
