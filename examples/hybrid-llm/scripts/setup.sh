#!/usr/bin/env bash
# Bring up the local infra for the LIVE hybrid runs (M0–M3): ollama + a model + the LiteLLM proxy.
# Idempotent-ish; safe to re-run. Cloud steps still need a Claude subscription/API key in the ambient env.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL="${OLLAMA_MODEL:-qwen2.5}"   # override with a smaller tag to just prove the channel, e.g. qwen2.5:0.5b

if ! command -v ollama >/dev/null 2>&1; then
  echo "ollama not found. Install it (https://ollama.com), e.g.: brew install ollama"; exit 1
fi
echo "==> starting ollama (if not already serving) ..."
curl -sf http://localhost:11434/api/tags >/dev/null 2>&1 || { ollama serve >/tmp/ollama.log 2>&1 & sleep 2; }
echo "==> pulling $MODEL ..."
ollama pull "$MODEL"

if ! command -v litellm >/dev/null 2>&1; then
  echo "==> installing litellm[proxy] ..."; pip install 'litellm[proxy]'
fi
echo
echo "Now start the proxy in a separate shell:"
echo "  litellm --config $here/../litellm-config.yaml --port 4000"
echo "and point the Claude runtime at it for M1/M3 whole-session runs:"
echo "  export ANTHROPIC_BASE_URL=http://localhost:4000"
echo
echo "M0 channel check once the proxy is up:"
echo "  ANTHROPIC_BASE_URL=http://localhost:4000 claude -p 'say hello in five words'"
