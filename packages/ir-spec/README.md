# `@warble/ir-spec`

The Warble IR (`warble_ir_version`) as a resolvable npm package.

**This package's version *is* the payload.** `warble_ir_version 0.6` publishes as npm version
`0.6.0` — IR `x.y` maps to npm `x.y.0`, with the patch component always zero. Everything else in
the package — the bundled [`ir-schema.md`](./ir-schema.md) (a copy of
[`docs/spec/ir-schema.md`](https://github.com/Canner/Warble/blob/main/docs/spec/ir-schema.md)) and
the `IR_VERSION` constant exported from `index.js` — is documentation, not enforcement.

## Why this package exists

Before this package, the IR version a published dispatcher (`@warble/claude-agent-sdk`,
`@warble/codex-local`) accepts was discoverable only by reading its source. Both dispatchers now
declare `@warble/ir-spec` as a `peerDependencies` range (`0.6.x` today) plus an advisory
`"warble": { "irVersion": "0.6" }` field, so a consumer — or npm's own resolver — can see which IR a
dispatcher speaks without opening it.

**This package is not meant to be imported.** A `peerDependency` is a declaration, not a dependency
edge: each dispatcher keeps its own independently declared `SUPPORTED_IR_VERSION` (or
`SUPPORTED_IR_VERSIONS`) constant rather than importing this package's `IR_VERSION`. See
[`ir-schema.md`](./ir-schema.md#ir-version-compatibility) for why independent copies are what make
the core-owned lockstep test a real check rather than a formality.

## What this package does *not* do

- It does not ship a machine-readable IR JSON Schema — `ir-schema.md` is prose. See
  `docs/spec/ir-schema.md` in the main repository for the rationale.
- It does not, by itself, reject a mismatched dispatcher/IR pair at install time. A missing peer
  (this package absent from the registry at the named version) fails installation under every
  package manager's default configuration; a *mismatched* peer range across two npm packages is
  enforced only once a second party (e.g. a future `@warble/cli`) also declares the peer.
- It is not locked to the Warble workspace/crate version (`0.4.0` and friends). It moves only when
  the IR moves, on its own release line.
