# AGENTS.md

Single source of truth for how to work in this repository:
**[`.claude/CLAUDE.md`](./.claude/CLAUDE.md)**.

Read it in full before changing anything here. It is not a summary of the README — it carries the
load-bearing invariants (enum-keyed dispatchers, sans-IO `core/`, zero-wren portability, additive-only
IR), the gates that `just lint` and `just test` do **not** cover, and the branch-naming rule that
cannot be scrubbed after the fact.

This file exists so agents that look for `AGENTS.md` rather than `CLAUDE.md` — Codex, Cursor, Amp,
Gemini CLI, Warp — land in the same place. Do not fork or duplicate the rules here; edit
`.claude/CLAUDE.md` and leave this pointer alone.

Contributor-facing setup and PR expectations live in [`CONTRIBUTING.md`](./CONTRIBUTING.md);
release policy lives in [`RELEASING.md`](./RELEASING.md).
