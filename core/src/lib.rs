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
//! use warble::{compile, BindingFile, ComponentFile, ProfileFile, SlotContents};
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
//!     &SlotContents::default(),
//! )?;
//! assert_eq!(ir["warble_ir_version"], "0.7");
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! # Invariants
//!
//! These hold across the whole workspace, not just this crate — they matter to you as an API
//! consumer too, not only to contributors:
//!
//! 1. **If you write your own back-end that consumes the IR `compile` returns, drive it off the
//!    three enum fields** — `realization_kind`, `outcome.kind`, `trigger.kind` — never off a
//!    component's `id` or `verb` string. Any enum value your back-end can't handle must be a hard
//!    error, not a best-effort guess or a silent no-op.
//! 2. **Depending on `warble` alone pulls in no I/O and no `wren` dependency.** `compile` never
//!    touches a filesystem or network — you build the [`ContextLoader`] yourself and hand it in —
//!    and this crate has no dependency on `wren-core-base`. That's what lets you embed it in a
//!    native binary, WASM, or another language's bindings without inheriting a dependency graph
//!    you didn't ask for. (Only the separate `warble-mdl-context` crate depends on
//!    `wren-core-base`, and only if you choose to use it.)
//! 3. **No DSL in the composition layer** — there's no boolean algebra, expression language, or
//!    imperative logic in the profile/IR schema. The one form of conditionality that does exist
//!    is a closed vocabulary: a step can set `conditional: true` with a `when` guard whose
//!    `guard` is one of `on_failure` / `on_flag` / `on_missing` and whose `target` names what
//!    it's checking — never an arbitrary predicate. If you're writing a dispatcher, that means
//!    you must either realize `when` or loud-fail on it, not silently treat it as a no-op. IR
//!    growth is additive (a new optional field), never a new mechanism.
//! 4. **The IR `compile` emits never names a specific mechanism** (no `cron`, `slack`,
//!    `subagent`, …). If you're writing a dispatcher, those names only show up later, at the
//!    capability layer via `realize-via` — so the same IR is valid input to any runtime's
//!    back-end, including ones this crate has never heard of. See
//!    [`capability-model.md`][spec-cap].
//! 5. **This crate builds exactly one native capability: `blast_radius`** (semantic lineage — see
//!    [`blast-radius.md`][spec-blast]). If you're checking what a target back-end can support
//!    natively versus needs to borrow from its runtime, know that everything else — human
//!    approval, VCS/rollback, scheduling, subagent dispatch, schema introspection — is expected
//!    to come from the runtime (realize-via), not from `core`.
//!
//! [spec-authoring]: https://github.com/Canner/Warble/blob/main/docs/spec/authoring.md
//! [spec-ir]: https://github.com/Canner/Warble/blob/main/docs/spec/ir-schema.md
//! [spec-cap]: https://github.com/Canner/Warble/blob/main/docs/spec/capability-model.md
//! [spec-blast]: https://github.com/Canner/Warble/blob/main/docs/spec/blast-radius.md

mod compile;
mod context;
mod error;
mod model;

pub use compile::compile;
pub use context::{
    prepared_document_from, Additivity, BlastRadius, ContextLoader, DimensionInfo, ExternalContext,
    LineageEdge, LineageGraph, LineageKind, LineageNode, MetricInfo, ModelInfo, PreparedContext,
    PreparedContextError, Severity, PREPARED_CONTEXT_VERSION,
};
pub use error::CompileError;
pub use model::{
    AssetDecl, BindingFile, ComponentFile, Effect, Guardrail, GuardrailPatch, LlmStep, Outcome,
    Param, ProfileComponentMount, ProfileConfig, ProfileContext, ProfileFile, RenderBlock,
    SlotContents, SlotDecl, Trigger,
};
