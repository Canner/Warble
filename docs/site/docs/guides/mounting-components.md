---
title: Mounting components
description: "How a profile's own components/ dir and --component-dir sources resolve ahead of the shared Hub, why two Local sources defining the same id is a loud fail, and how the Hub itself resolves — in-repo, cached, or fetched — outside a Warble checkout."
---

A profile mounts components by `id` — `{ use: generate_dashboard }` — without saying *where* that
id resolves from. This guide covers component **resolution**: which directories `warble compile`
searches, in what order, and what happens when more than one of them claims the same id. For the
mount syntax itself (`config`, `tier_overrides`, `bind`), see
[Authoring a profile](/guides/authoring-a-profile) and [Components](/concepts/components); for the
exact flags, see the [CLI reference](/reference/cli).

## Two source kinds: Local and Hub

Every mounted `id` resolves against one of two kinds of source:

- **Local** — a component directory you (or your host) control directly: the profile's own
  `components/` dir, and any directory passed via `--component-dir`. Local sources are the
  standard way to author your own components alongside a profile, or to have a host mount a
  product-specific library on top of the Hub.
- **Hub** — the shared component library, meant to be a stable set of reusable, portable
  components. A profile that mounts an id with no matching Local directory falls through to the
  Hub. Inside this checkout, the Hub is `hub/components/` on disk; outside a checkout — a released
  `warble` binary with no `hub/` directory next to it — the Hub is resolved from a per-user cache,
  fetched over the network on first use. See
  [Hub resolution outside a checkout](#hub-resolution-outside-a-checkout) below.

**1. Mount an id with no local components/ dir — it resolves from the Hub**

```yaml
# profile.yml — no components/ directory alongside this file
components:
  - use: answer_query
  - use: generate_dashboard
```

```bash
warble compile . -o ir.json
```

With nothing local defining `answer_query` or `generate_dashboard`, both resolve from
`hub/components/answer_query` and `hub/components/generate_dashboard`.

**2. Add a components/ dir to override or extend the Hub locally**

```
my-profile/
  profile.yml
  components/
    generate_dashboard/     # a Local id — outranks the Hub's generate_dashboard
      component.yml
      steps/
```

A component under the profile's own `components/` dir is a Local source. If its `id` matches one
the Hub also defines, the Local one wins — no flag needed.

**3. Mount an additional Local source with --component-dir**

```bash
warble compile my-profile -o ir.json \
    --component-dir ../shared-components
```

`--component-dir <path>` is repeatable, and points at a directory whose immediate children are
`<id>/component.yml` — the same shape as the profile's own `components/`. This is how a host
mounts its own component library (a product-specific set, say) alongside the Hub without checking
those components into every profile that uses them.

**4. Override the Hub root itself**

```bash
warble compile my-profile -o ir.json --hub-dir /path/to/other-hub
```

`--hub-dir` swaps which Hub library backs the fallback tier — for a host that ships its own Hub
distribution outside this checkout. Passing it always bypasses default resolution entirely,
including the network fetch described below, so it keeps working even when default resolution
would fail (no network, no published asset, and so on). `--hub-version <version>` is the other
override: it doesn't point at a directory, it just changes *which* published Hub version gets
fetched during default resolution — see the next section.

## Precedence, and the one ambiguous case

All Local sources — the profile's own `components/` plus every `--component-dir` — outrank the
Hub. Within the Local tier, though, there is **no priority order**: if two Local sources both
define the same `id`, that's an ambiguous configuration and `warble compile` refuses rather than
guessing which one you meant.

:::warning
Two Local sources defining the same component `id` is a loud, compile-time fail — not "first one
wins" or "last flag wins." If you need to override a Hub component locally, define it in exactly
one Local source (either the profile's own `components/`, or one `--component-dir`, never both).
:::

## Hub resolution outside a checkout

The Hub is a shared distribution, not something the CLI ships embedded in its binary. How
`warble compile` finds it depends on where it's running:

1. **In-repo `hub/components/`** — if this checkout has a `hub/components/` directory on disk, it
   wins outright. No network call is ever attempted in this case, whether or not one would
   otherwise succeed.
2. **Cache** — otherwise, `warble` looks in a per-user cache for a copy of the Hub version it needs
   (the CLI's own version by default; see `--hub-version` below). The cache is not just a marker
   file to trust: on every reuse, the cached archive's contents are re-hashed with SHA-256 and
   checked against its checksum sidecar. A cache entry that's missing, corrupted, or doesn't match
   its sidecar is treated as a miss and re-fetched, never trusted as-is.
3. **Fetch** — on a cache miss, `warble` downloads one `hub-<version>.tar.gz` archive plus its
   `hub-<version>.tar.gz.sha256` sidecar from the GitHub Release tagged for that version, verifies
   the archive against the sidecar, and only then extracts and uses it.

The version resolved in steps 2–3 is the CLI's own build version (`CARGO_PKG_VERSION`) unless
overridden with `--hub-version <version>` — see [`compile`](/reference/cli#compile). Only a fixed
`MAJOR.MINOR.PATCH` release version is accepted; a mutable ref like `main` has nothing to
checksum-verify against, so it's rejected rather than silently trusted.

Each failure mode says what to do about it, and `--hub-dir <path>` (pointing at a local Hub
checkout) is the escape hatch for all of them:

- **Unreachable network** — the fetch can't reach GitHub at all. Use `--hub-dir` to point at a Hub
  library that doesn't require network access.
- **No published asset for this version (HTTP 404)** — the resolved version has no
  `hub-<version>.tar.gz` release asset yet. Either fetch a version that does have one via
  `--hub-version`, or use `--hub-dir`.
- **Checksum mismatch** — the downloaded archive doesn't match its sidecar. The download or the
  published pair may be corrupt; `warble` refuses to extract it rather than trust unverified bytes.
  Retry, or fall back to `--hub-dir`.
- **Unwritable cache directory** — the per-user cache directory can't be created or permissioned
  correctly. Fix the cache location's permissions, or use `--hub-dir` to bypass the cache
  entirely.

## Gotchas

- A component missing from every Local source *and* the Hub is a plain "unknown component id"
  compile error — resolution doesn't fall back any further than the two tiers above.
- `--component-dir` and the profile's own `components/` are peers, not layered — there's no way to
  make one Local source take priority over another; keep an id defined in only one place.
- Swapping `--hub-dir` changes the fallback library for the whole compile, not per component — you
  can't mix Hub roots within a single `warble compile` invocation.
- `--hub-version` only changes *which* Hub version gets fetched during default resolution — it
  doesn't change which `warble` build is running, and it has no effect once `--hub-dir` or an
  in-repo `hub/components/` is already in play.

- **[Components](/concepts/components)** — What a component is and the flagship Hub library.
- **[CLI reference](/reference/cli)** — The full `compile` flag list, including `--component-dir` and `--hub-dir`.
