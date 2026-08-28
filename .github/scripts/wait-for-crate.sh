#!/usr/bin/env bash
# Polls crates.io until <crate>@<version> is visible in the crate's own version list, or fails
# after a bounded number of attempts.
#
# RELEASING.md is explicit that "a successful upload response alone is not propagation
# evidence": crates.io's CDN-backed index can lag an accepted `cargo publish` upload by anywhere
# from a couple of seconds to a couple of minutes. This checks the public crates.io API
# directly, on a genuine poll loop, rather than trusting `cargo publish`'s own return code or a
# fixed sleep -- a dependent crate's publish step must never start against an index that hasn't
# caught up yet.
#
# Usage: wait-for-crate.sh <crate-name> <version> [max-attempts] [sleep-seconds]
#
# With max-attempts=1, this becomes a single non-fatal presence check (used by the publish
# workflow to decide whether a crate/version is already on the registry and can be skipped on a
# re-run) rather than a genuine wait -- callers that want a real wait should leave the defaults
# or pass a value greater than 1.
set -euo pipefail

crate="${1:?crate name required}"
version="${2:?version required}"
max_attempts="${3:-60}"
sleep_seconds="${4:-10}"

# Sparse-index layout: 1-char names live under 1/, 2-char under 2/, 3-char under 3/<first>/, and
# everything longer under <first-two>/<next-two>/. See the cargo book's registry index chapter.
name_len="${#crate}"
if [ "$name_len" -eq 1 ]; then
  index_path="1/${crate}"
elif [ "$name_len" -eq 2 ]; then
  index_path="2/${crate}"
elif [ "$name_len" -eq 3 ]; then
  index_path="3/${crate:0:1}/${crate}"
else
  index_path="${crate:0:2}/${crate:2:2}/${crate}"
fi

for attempt in $(seq 1 "$max_attempts"); do
  # The sparse index, not the web API. The API is database-backed and turns visible first; the
  # index is CDN-cached and is what the *next* crate's `cargo publish` actually resolves its
  # dependencies against. Polling the API can therefore pass while the following publish still
  # fails to resolve -- the check has to read the same surface the consumer reads.
  response="$(curl -fsS --user-agent "warble-release-automation (+https://github.com/Canner/Warble)" \
    "https://index.crates.io/${index_path}" 2>/dev/null || true)"

  if [ -n "$response" ] && echo "$response" | jq -e --arg v "$version" \
      -s 'any(.[]; .vers == $v)' >/dev/null 2>&1; then
    echo "${crate}@${version} is resolvable in the crates.io sparse index (checked attempt ${attempt}/${max_attempts})."
    exit 0
  fi

  if [ "$attempt" -lt "$max_attempts" ]; then
    echo "${crate}@${version} not yet visible in the crates.io sparse index (attempt ${attempt}/${max_attempts}), retrying in ${sleep_seconds}s..."
    sleep "$sleep_seconds"
  fi
done

echo "::error::${crate}@${version} did not become resolvable in the crates.io sparse index after ${max_attempts} attempts (~$((max_attempts * sleep_seconds))s). This is a genuine registry-visibility timeout -- do not paper over it with a longer fixed sleep; re-run this job once crates.io has caught up, or investigate whether the publish actually succeeded." >&2
exit 1
