//! Warble back-end for the **Claude Code CLI** target.
//!
//! Consumes a compiled Warble IR (JSON) and emits a Claude Code agent runtime (agent files under
//! `.claude/agents/`, settings, and `RUN.md`) — the static-file target, which needs no SDK, so it
//! lives natively in Rust alongside the compiler and is driven by the `warble` CLI. Also hosts the
//! deterministic reference renderer (`render`) and the capability-manifest projection (`manifest`).
//!
//! Dispatch is keyed on IR enums (`realization_kind`, `trigger.kind`, `effect.outcome.kind`),
//! never on a component's id/verb. Enum arms not yet realized fail loudly (a "wall-hit").
//!
//! This crate is not a standalone tool — you install `warble-cli` (the `warble` binary), which
//! links this crate in directly, and `warble dispatch --target claude-code` (or
//! `claude-code:headless` / `claude-code:interactive`, the default) selects it at dispatch time.

pub mod conditional;
pub mod ir;

mod emit;
mod error;
mod manifest;
mod models;
mod render;
mod resolve;
mod targets;

pub use emit::{
    emit_claude_code, emit_claude_code_with_models, emit_claude_code_with_realization,
    resolve_node_capabilities, HybridRealization, RenderFlavor, DEFAULT_RENDER_FLAVOR,
};
pub use error::DispatchError;
pub use manifest::{build_manifest, CapabilityManifest};
pub use models::{
    ModelConfig, Provider, TierBinding, ANTHROPIC_PROVIDER, BINDING_SPEC_VERSION,
    OPENAI_COMPAT_PROVIDER,
};
pub use render::{parse_envelope, render_envelope_to_html, Envelope, RenderOptions};
pub use resolve::{resolve_capabilities, ResolutionReport, ResolvedCapability};
pub use targets::DEFAULT_TARGET;
pub use targets::{is_known_target, known_target_names, TargetId};
