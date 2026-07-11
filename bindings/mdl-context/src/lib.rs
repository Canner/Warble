//! Warble ContextLoader adapter #1 — the MDL adapter.
//!
//! Implements [`warble::ContextLoader`] over a wren MDL project by introspecting it through
//! `wren-core-base` (the canonical MDL manifest types). This is the *binding layer*: the wren
//! dependency is internalized here so that `warble` core and the component library stay zero-wren
//! (dependency firewall, plan §5 D5). A future OSI (or other) adapter implements the same trait
//! without touching core (vision §13 #14).
//!
//! Pipeline: read project files (host I/O) → [`project::assemble`] into a `Manifest` →
//! [`MdlContext::from_manifest`] projects to Warble Info types + builds the semantic
//! [`warble::LineageGraph`]. Parse/introspection is pure and WASM-friendly (no DB, no async);
//! query execution never enters this layer.

mod consumers;
mod introspect;
mod lineage;
mod project;
mod raw_source;

pub use introspect::{infer_additivity, MdlContext};
pub use lineage::{cube_id, dashboard_id, dim_id, metric_id, model_id, query_id, rel_id, view_id};
#[cfg(not(target_arch = "wasm32"))]
pub use project::read_project_dir;
pub use project::{assemble, LoadError, LoadedProject, ProjectSources};
#[cfg(not(target_arch = "wasm32"))]
pub use raw_source::read_raw_dir;
pub use raw_source::{RawSourceContext, RawSources};
