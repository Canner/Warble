#!/usr/bin/env bash
# Offline proof of per-step provider routing (spike D2/D3/D4). NO ollama, NO Claude, NO network.
#
# Slices the committed answer_query node out of genbi-default/ir.golden.json and dry-runs the Agent SDK
# back-end under two bindings — all-cloud vs hybrid (cheap→local) — printing the per-step routing. The
# ONLY thing that differs between the two runs is the injected --models-config; the IR is identical.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
sdk="$repo/dispatcher/claude-agent-sdk"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Slice answer_query into a standalone IR (the full genbi-default IR also carries a realize-render
# component that is out of the hybrid-staged POC scope).
node -e "const ir=require('$repo/genbi-default/ir.golden.json'); ir.components=ir.components.filter(c=>c.verb==='answer_query'); require('fs').writeFileSync('$work/aq.ir.json',JSON.stringify(ir,null,2))"

show() { # $1 = binding label, $2 = plan.json
  node -e '
    const p=require(process.argv[1]);
    console.log("  mode        :", p.meta.mode);
    console.log("  providers   :", JSON.stringify(p.meta.providers));
    console.log("  SDK agents? :", !!p.options.agents);
    if (p.options.agents) for (const [k,v] of Object.entries(p.options.agents)) console.log("    subagent", k, "-> model", v.model);
    for (const s of p.meta.stagedSteps) console.log("    step", s.name.padEnd(14), "tier="+s.tier.padEnd(7), s.provider==="openai_compat" ? ("=> LOCAL "+s.model+" @ "+s.endpoint) : ("=> CLOUD "+s.model));
  ' "$2"
}

cd "$sdk"
echo "===== ALL-CLOUD (bindings/all-cloud.yml) ====="
npx --yes tsx src/cli.ts dispatch "$work/aq.ir.json" --dry-run \
  --models-config "$repo/examples/hybrid-llm/bindings/all-cloud.yml" --out "$work/cloud" 2>/dev/null
show all-cloud "$work/cloud/answer_query.plan.json"

echo
echo "===== HYBRID cheap->local (bindings/hybrid-cheap-local.yml) — SAME IR ====="
npx --yes tsx src/cli.ts dispatch "$work/aq.ir.json" --dry-run \
  --models-config "$repo/examples/hybrid-llm/bindings/hybrid-cheap-local.yml" --out "$work/hybrid" 2>/dev/null
show hybrid "$work/hybrid/answer_query.plan.json"

echo
echo "Same compiled IR; only --models-config differed. resolve_intent went local, the SQL steps stayed cloud."
