//! Warble front-end compiler (`warble`): parses a Warble project (profile + components + context
//! binding), merges component defaults with profile overrides, runs the loud-fail compile checks,
//! and emits the language-neutral IR JSON that any back-end dispatcher consumes.
//!
//! # Architecture
//!
//! ```text
//! profile + components + context  ──►  warble compile  ──►  IR JSON  ──►  warble dispatch  ──►  native agent
//!    (declarative YAML + prompts)       (front-end, Rust)   (the seam)    (per-target back-end)
//! ```
//!
//! This crate is the first arrow: it owns the authoring types ([`ProfileFile`], [`ComponentFile`],
//! and friends), [`ContextLoader`] (the host's semantic-layer probe), and [`compile`], which
//! resolves a parsed project into IR. Everything downstream of the IR — the `claude-code-cli` and
//! `vercel` back-ends (both fold into the `warble` binary), plus the separate TS
//! `claude-agent-sdk` back-end — depends only on the IR schema, never on this crate's Rust types.
//! See [`authoring.md`][spec-authoring] for the authoring-side contract and
//! [`ir-schema.md`][spec-ir] for the emitted shape.
//!
//! # Sans-IO
//!
//! This crate performs **no filesystem or network access**. [`compile`] takes already-parsed
//! authoring values, the raw step markdown, and a [`ContextLoader`] the caller has already built
//! from the bound semantic layer — it never reads a path itself. The example below is exactly
//! this: it deserializes YAML strings in-memory and calls [`compile`] directly, no disk involved.
//! Keeping the core pure is what lets the same crate target native, WASM, and language bindings
//! unchanged; the native host adapter lives in the `warble-cli` crate.
//!
//! # Invariants
//!
//! These hold across the whole workspace, not just this crate — breaking one is a design
//! regression even if tests still pass:
//!
//! 1. **Dispatchers are enum-keyed** on the three IR enums `(realization_kind, outcome.kind,
//!    trigger.kind)` — never on a component's id/verb (`if verb == "…"`). An enum arm a target
//!    doesn't support must loud-fail ("wall-hit"), never silently emit something wrong. New
//!    component families are added by realizing an enum arm, not by special-casing a component.
//! 2. **This crate is sans-IO, and it plus every component stay transitively zero-`wren`** — only
//!    the `warble-mdl-context` binding may depend on `wren-core-base`. This portability is the
//!    moat; verify with `cargo tree`.
//! 3. **No DSL in the composition layer** — conditionals/loops live in step prompts/hooks, not in
//!    profile/IR structure. IR growth must be additive (a new optional facet), never a mechanism.
//! 4. **IR is runtime-agnostic** — no mechanism names (cron, subagent, Slack, …) leak into it.
//!    Those resolve at the capability layer via `realize-via` (see
//!    [`capability-model.md`][spec-cap]).
//! 5. **Borrow generic capabilities; build only data-native ones.** The single `provided_by:
//!    warble` capability is `blast_radius` (semantic lineage — see
//!    [`blast-radius.md`][spec-blast]). Approval, VCS/rollback, scheduling, subagent dispatch, and
//!    schema introspection are all borrowed (realize-via runtime/MCP), never built here.
//!
//! # Example
//!
//! A minimal project — one component, one step — compiled against an empty in-memory
//! [`ContextLoader`]. Both the profile and the component are parsed from YAML exactly as a host
//! would read them off disk; only the reading itself is out of scope for this sans-IO crate.
//!
//! ```
//! # use std::collections::HashMap;
//! # use warble::{ContextLoader, DimensionInfo, LineageGraph, MetricInfo, ModelInfo};
//! # struct EmptyContext(LineageGraph);
//! # impl ContextLoader for EmptyContext {
//! #     fn is_parseable(&self) -> bool { true }
//! #     fn metrics(&self) -> &[MetricInfo] { &[] }
//! #     fn dimensions(&self) -> &[DimensionInfo] { &[] }
//! #     fn time_dimensions(&self) -> &[DimensionInfo] { &[] }
//! #     fn models(&self) -> &[ModelInfo] { &[] }
//! #     fn lineage(&self) -> &LineageGraph { &self.0 }
//! # }
//! use warble::{compile, BindingFile, ComponentFile, ProfileFile};
//!
//! let profile: ProfileFile = serde_yaml::from_str(concat!(
//!     "profile: demo\n",
//!     "context:\n",
//!     "  project: ./context/binding.yml\n",
//!     "components:\n",
//!     "  - use: hello\n",
//! ))?;
//! let binding: BindingFile = serde_yaml::from_str("project: ./warehouse\n")?;
//! let component: ComponentFile = serde_yaml::from_str(concat!(
//!     "id: hello\n",
//!     "verb: greet\n",
//!     "type: analytical\n",
//!     "realization_kind: skill\n",
//!     "binding_mode: runtime_selected\n",
//!     "llm_steps:\n",
//!     "  - name: say_hello\n",
//!     "    tier: cheap\n",
//!     "    prompt_ref: steps/say_hello.md\n",
//!     "trigger:\n",
//!     "  kind: one_shot\n",
//!     "guardrails:\n",
//!     "  - name: read_only_execution\n",
//!     "    locked: true\n",
//!     "effect:\n",
//!     "  render_blocks: []\n",
//!     "  outcome:\n",
//!     "    kind: none\n",
//! ))?;
//!
//! let mut components = HashMap::new();
//! components.insert(component.id.clone(), component);
//! let mut steps = HashMap::new();
//! steps.insert("say_hello".to_string(), "Say hello to {{project_name}}.".to_string());
//! let mut step_contents = HashMap::new();
//! step_contents.insert("hello".to_string(), steps);
//!
//! let ir = compile(
//!     &profile,
//!     &components,
//!     &binding.project,
//!     &EmptyContext(LineageGraph::default()),
//!     &step_contents,
//! )?;
//! assert_eq!(ir["warble_ir_version"], "0.3");
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! [spec-authoring]: https://github.com/Canner/Warble/blob/v0.1.0/docs/spec/authoring.md
//! [spec-ir]: https://github.com/Canner/Warble/blob/v0.1.0/docs/spec/ir-schema.md
//! [spec-cap]: https://github.com/Canner/Warble/blob/v0.1.0/docs/spec/capability-model.md
//! [spec-blast]: https://github.com/Canner/Warble/blob/v0.1.0/docs/spec/blast-radius.md

mod compile;
mod context;
mod error;
mod model;

pub use compile::compile;
pub use context::{
    Additivity, BlastRadius, ContextLoader, DimensionInfo, LineageEdge, LineageGraph, LineageKind,
    LineageNode, MetricInfo, ModelInfo, Severity,
};
pub use error::CompileError;
pub use model::{
    BindingFile, ComponentFile, Effect, Guardrail, GuardrailPatch, LlmStep, Outcome, Param,
    ProfileComponentMount, ProfileConfig, ProfileContext, ProfileFile, RenderBlock, Trigger,
};
