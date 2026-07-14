#!/usr/bin/env bash
# Boundary-hygiene guard.
#
# Warble is a private repo today but is slated to go public / merge into the public WrenAI
# monorepo. This script fails if the tracked repo contains any reference that must never leak
# into a public artifact:
#
#   1. paths into the private `agent-workspace` planning-doc tree (`plans/warble-framework`), or a
#      bare private planning-doc filename (runtime-ux.md, spike-hybrid-llm.md) — these have no
#      in-repo counterpart, so a citation by basename alone is still a broken private reference
#   2. the name of any other private Canner repo (wren-agent-stack, WrenAI-saas,
#      wren-engine-saas, wren-ai-service-saas, WrenAI-self-hosted, docs.getwren.ai)
#   3. personal/local issue-tracker IDs (TASK-<n>, NIM-<n>) that are meaningless outside the
#      author's local tooling and must never land in a shared/public codebase
#
# Replace a hit with neutral in-repo phrasing (state the rationale inline, or point to an
# in-repo docs/spec/ or docs/design-notes.md section) — never re-import the private doc or name
# its external path/filename.
#
# Run locally:
#   ./scripts/check-private-refs.sh
# Run in CI:
#   .github/workflows/private-ref-guard.yml invokes this same script on every push/PR.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Paths allowed to contain these patterns as *literal text*, because their entire job is to
# define/detect them — nothing else in the tracked tree may match. Keep this list exact; adding
# a path here should always come with a reason in the PR that adds it.
ALLOWLIST_PATHSPECS=(
  ':(exclude)scripts/check-private-refs.sh'
)

# Parallel arrays (label / pattern), not an associative array — keeps this script portable to
# bash 3.2 (macOS's stock /bin/bash has no `declare -A`), since it's meant to be run locally too.
LABELS=(
  "private-planning-doc-path"
  "private-planning-doc-basename-runtime-ux"
  "private-planning-doc-basename-spike-hybrid-llm"
  "private-repo-wren-agent-stack"
  "private-repo-WrenAI-saas"
  "private-repo-wren-engine-saas"
  "private-repo-wren-ai-service-saas"
  "private-repo-WrenAI-self-hosted"
  "private-repo-docs.getwren.ai"
  "local-ticket-id-TASK"
  "local-ticket-id-NIM"
)
PATTERNS=(
  'plans/warble-framework'
  'runtime-ux\.md'
  'spike-hybrid-llm\.md'
  'wren-agent-stack'
  'WrenAI-saas'
  'wren-engine-saas'
  'wren-ai-service-saas'
  'WrenAI-self-hosted'
  'docs\.getwren\.ai'
  'TASK-[0-9]'
  'NIM-'
)

found=0
for i in "${!LABELS[@]}"; do
  label="${LABELS[$i]}"
  pattern="${PATTERNS[$i]}"
  matches="$(git grep -In -E "$pattern" -- . "${ALLOWLIST_PATHSPECS[@]}" || true)"
  if [[ -n "$matches" ]]; then
    found=1
    echo "FORBIDDEN [$label] pattern /${pattern}/ found:"
    echo "$matches"
    echo
  fi
done

if [[ "$found" -ne 0 ]]; then
  echo "check-private-refs: FAILED — forbidden reference(s) above must be removed before this repo goes public." >&2
  exit 1
fi

echo "check-private-refs: OK — no forbidden references found."
