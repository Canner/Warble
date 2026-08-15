#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="$repo_root/examples/jaffle-wren"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/warble-jaffle-wren.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

# Build from a disposable project copy. Wren may normalize wren_project.yml by attaching a
# machine-local named connection profile; that state must never flow back into the shared fixture.
tar -C "$project" --exclude='./target' --exclude='./.env' -cf - . |
  tar -C "$scratch" -xf -

mkdir -p "$project/target"
wren context build --path "$scratch" --output "$project/target/mdl.json"
