#!/usr/bin/env bash
# Stand up a QUERYABLE jaffle wren project: the committed jaffle MDL + a DuckDB connection + a compiled
# target/mdl.json, so the answer_query SQL steps can actually run `wren`. Prints the project path as the
# LAST stdout line (everything else goes to stderr) so callers can: PROJ=$(setup-queryable-jaffle.sh).
#
# Prereq: a wren connection profile bound to the jaffle_shop DuckDB. Default profile name: `jaffle-shop`
# (override with JAFFLE_PROFILE=<name>). The DuckDB is now bundled in the example itself
# (examples/jaffle-wren/jaffle_shop.duckdb), so point the profile's `url` at that project dir — no
# external data setup needed. Create the profile once with e.g.:
#   wren context init  # or add to ~/.wren/profiles.yml:  <name>: {datasource: duckdb, url: <repo>/examples/jaffle-wren, format: duckdb}
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
PROFILE="${JAFFLE_PROFILE:-jaffle-shop}"
OUT="${1:-${TMPDIR:-/tmp}/warble-hybrid/jaffle-queryable}"

mkdir -p "$(dirname "$OUT")"
[ -e "$OUT" ] || cp -R "$repo/examples/jaffle-wren" "$OUT"
cd "$OUT"
wren context set-profile "$PROFILE" 1>&2
wren context build 1>&2
# The file-target eval (M3 all-cloud) spawns `claude` subagents whose PATH is prepended with
# <project>/.venv/bin — symlink wren there so those subagents can execute it.
mkdir -p .venv/bin && ln -sf "$(command -v wren)" .venv/bin/wren
echo "queryable jaffle project: $OUT (profile: $PROFILE)" 1>&2
echo "$OUT"
