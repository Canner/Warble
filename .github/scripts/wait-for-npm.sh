#!/usr/bin/env bash
# Polls the public npm registry until <package>@<version> is resolvable, or fails after a
# bounded number of attempts. Mirrors wait-for-crate.sh's reasoning for the crates.io side: a
# successful `npm publish` exit code is not propagation evidence either, and this repo's
# ordering guarantees (a dispatcher must never publish while naming a peer version that isn't
# resolvable yet) depend on an explicit check, not on hoping the registry is already consistent.
#
# Usage: wait-for-npm.sh <package-name> <version> [max-attempts] [sleep-seconds]
#
# With max-attempts=1, this becomes a single non-fatal presence check (used to decide whether a
# package/version is already published and can be skipped on a re-run).
set -euo pipefail

pkg="${1:?package name required}"
version="${2:?version required}"
max_attempts="${3:-60}"
sleep_seconds="${4:-10}"

for attempt in $(seq 1 "$max_attempts"); do
  if npm view "${pkg}@${version}" version --registry https://registry.npmjs.org >/dev/null 2>&1; then
    echo "${pkg}@${version} is resolvable on the npm registry (checked attempt ${attempt}/${max_attempts})."
    exit 0
  fi

  if [ "$attempt" -lt "$max_attempts" ]; then
    echo "${pkg}@${version} not yet visible on the npm registry (attempt ${attempt}/${max_attempts}), retrying in ${sleep_seconds}s..."
    sleep "$sleep_seconds"
  fi
done

echo "::error::${pkg}@${version} did not become resolvable on the npm registry after ${max_attempts} attempts (~$((max_attempts * sleep_seconds))s). This is a genuine registry-visibility timeout -- do not paper over it with a longer fixed sleep; re-run this job once the registry has caught up, or investigate whether the publish actually succeeded." >&2
exit 1
