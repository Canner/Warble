# claude-agent-sdk (placeholder)

The second Warble back-end target: the **Claude Agent SDK** `query()` loop.

Unlike `claude-code-cli` (which emits static agent files and therefore needs no SDK, so it lives
in Rust), this target drives the SDK's in-loop `query({options})` at runtime and is therefore
bound to the SDK's language (TypeScript). It is **not built yet** — the v1 reference back-end is
`claude-code-cli`. See `docs/roadmap.md`.

When built, it consumes the same IR (`docs/spec/ir-schema.md`) as every other back-end.
