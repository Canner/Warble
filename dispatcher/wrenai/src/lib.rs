//! Warble back-end for the wrenai bundle target.
//!
//! Consumes a compiled Warble IR (JSON) and emits a file-based JSON **bundle** — not a running
//! agent. The bundle is consumed by a separate, LLM-agnostic tool-loop harness (Vercel AI SDK)
//! that this crate does not implement; this crate's job ends at `bundle.json`.
//!
//! Dispatch is keyed on IR enums (`realization_kind`, `trigger.kind`, `effect.outcome.kind`),
//! never on a component's id/verb. Enum arms not yet realized fail loudly (a "wall-hit"), and
//! emission is all-or-nothing — see [`emit`] for the atomicity guarantee.

pub mod bundle;
pub mod classify;
pub mod emit;
pub mod error;
pub mod guardrails;
pub mod ir;
pub mod resolve;
pub mod schema;
pub mod targets;
pub mod tools;

pub use bundle::{
    AgentBundle, CompatibilityPolicy, StepBundle, WhenGuardOut, WrenaiBundle, WRENAI_BUNDLE_VERSION,
};
pub use classify::{StepRealization, DEFAULT_MAX_ATTEMPTS};
pub use emit::emit_wrenai;
pub use error::DispatchError;
pub use resolve::{resolve_capabilities, ResolutionReport, ResolvedCapability};
pub use targets::{is_known_target, known_target_names, TargetId, DEFAULT_TARGET};
pub use tools::ToolRef;
