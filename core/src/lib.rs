//! Warble front-end compiler (`warble`).
//!
//! Parses a Warble project (profile + components + context binding), merges component defaults
//! with profile overrides, runs the loud-fail compile checks, and emits the language-neutral IR
//! JSON that any back-end dispatcher consumes.
//!
//! **Sans-IO by design.** This crate performs no filesystem or network access: callers read the
//! `profile.yml` / `context/binding.yml` / `component.yml` / step-markdown files, deserialize
//! them into the [`model`] types, and pass the contents to [`compile`]. Keeping the core pure is
//! what lets the same crate target native, WASM, and language bindings unchanged (see the repo
//! README). The native host adapter lives in the `warble-cli` crate.

mod compile;
mod context;
mod error;
mod model;

pub use compile::compile;
pub use context::{
    Additivity, ContextLoader, DimensionInfo, LineageEdge, LineageGraph, LineageKind, LineageNode,
    MetricInfo, ModelInfo,
};
pub use error::CompileError;
pub use model::{
    BindingFile, ComponentFile, Effect, Guardrail, GuardrailPatch, LlmStep, Outcome, Param,
    ProfileComponentMount, ProfileConfig, ProfileContext, ProfileFile, RenderBlock, Trigger,
};
