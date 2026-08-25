//! Warble ContextLoader adapter #1 — the MDL adapter.
//!
//! Implements [`warble::ContextLoader`] over a wren MDL project by introspecting it through
//! `wren-core-base` (the canonical MDL manifest types). This is the *binding layer*: the wren
//! dependency is internalized here so that `warble` core and the component library stay zero-wren
//! (dependency firewall). A future OSI (or other) adapter implements the same trait
//! without touching core.
//!
//! Pipeline: read project files (host I/O) → [`project::assemble`] into a `Manifest` →
//! [`MdlContext::from_manifest`] projects to Warble Info types + builds the semantic
//! [`warble::LineageGraph`]. Parse/introspection is pure and WASM-friendly (no DB, no async);
//! query execution never enters this layer.
//!
//! Like the two dispatcher back-ends, this crate is not a standalone tool — you install
//! `warble-cli` (the `warble` binary), which links this crate in directly as the
//! [`warble::ContextLoader`] implementation the host builds before calling [`warble::compile`].

mod consumers;
mod introspect;
mod lineage;
mod project;
mod raw_source;

pub use introspect::{infer_additivity, MdlContext};
pub use lineage::{cube_id, dashboard_id, dim_id, metric_id, model_id, query_id, rel_id, view_id};
pub use project::{assemble, KnowledgeRules, LoadError, LoadedProject, ProjectSources};
#[cfg(not(target_arch = "wasm32"))]
pub use project::{read_knowledge_rules, read_project_dir};
#[cfg(not(target_arch = "wasm32"))]
pub use raw_source::read_raw_dir;
pub use raw_source::{RawSourceContext, RawSources};
