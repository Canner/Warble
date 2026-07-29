//! Warble back-end for the vercel bundle target.
//!
//! Consumes a compiled Warble IR (JSON) and emits a file-based JSON **bundle** — not a running
//! agent. The bundle is consumed by a separate, LLM-agnostic tool-loop harness (Vercel AI SDK)
//! that this crate does not implement; this crate's job ends at `bundle.json`.
//!
//! Dispatch is keyed on IR enums (`realization_kind`, `trigger.kind`, `effect.outcome.kind`),
//! never on a component's id/verb. Enum arms not yet realized fail loudly (a "wall-hit"), and
//! emission is all-or-nothing — see [`emit`] for the atomicity guarantee.
//!
//! This crate is not a standalone tool — you install `warble-cli` (the `warble` binary), which
//! links this crate in directly, and `warble dispatch --target vercel` (or `vercel:headless` /
//! `vercel:interactive`) selects it at dispatch time.

pub mod bundle;
pub mod classify;
pub mod emit;
pub mod error;
pub mod guardrails;
pub mod ir;
pub mod provider;
pub mod resolve;
pub mod schema;
pub mod targets;
pub mod tools;

pub use bundle::{
    AgentBundle, CompatibilityPolicy, StepBundle, VercelBundle, WhenGuardOut, VERCEL_BUNDLE_VERSION,
};
pub use classify::{StepRealization, DEFAULT_MAX_ATTEMPTS};
pub use emit::{emit_vercel, validate_ir_version, SUPPORTED_IR_VERSION};
pub use error::DispatchError;
pub use provider::{compose_target, parse_provider_fragments, ComposedTarget, ProviderFragment};
pub use resolve::{resolve_capabilities, ResolutionReport, ResolvedCapability};
pub use targets::{is_known_target, known_target_names, TargetId, DEFAULT_TARGET};
pub use tools::ToolRef;
