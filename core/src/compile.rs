//! The resolve/validate/emit-IR pass — pure, sans-IO.
//!
//! Given parsed authoring types plus the raw step markdown (all injected by the host), this
//! merges component defaults ⊕ profile overrides, runs the loud-fail compile checks, and emits
//! the language-neutral IR JSON that any back-end dispatcher consumes. See
//! [`ir-schema.md`][spec-ir].
//!
//! [spec-ir]: https://github.com/Canner/Warble/blob/main/docs/spec/ir-schema.md

use crate::context::{Additivity, ContextLoader};
use crate::error::CompileError;
use crate::model::{
    AssetDecl, ComponentFile, Guardrail, Outcome, Param, Precondition, ProfileComponentMount,
    ProfileFile, RenderBlock, SlotContents, SlotDecl, WhenGuard,
};
use std::collections::{HashMap, HashSet};

/// The closed vocabulary of `context_precondition` predicates a component may declare. Any other
/// predicate name is a loud-fail compile error (see `check_precondition_vocabulary`).
const PRECONDITION_VOCABULARY: &[&str] = &[
    "mdl_parseable",
    "has_metric",
    "has_queryable_dimension",
    "has_time_dimension",
    "has_groupable_dimension",
    "metric_additive",
    "model_has_timestamp",
    "lineage_resolvable",
    "wren_project_exists",
    // Constitutive raw-shape family (Phase 4b): these read the *raw* input shape, not an existing
    // MDL — the precondition inversion for components whose output *is* the Context. Kept small on
    // purpose — the vocabulary should grow deliberately, not all at once.
    "source_introspectable",
    "raw_docs_readable",
];

/// The closed vocabulary of `llm_steps[].when.guard` names a conditional step may declare. Any
/// other guard name is a loud-fail compile error (see `check_when_guards`). Deliberately small —
/// no boolean algebra, no expressions, no imperative logic: grown only when a real case demands
/// it, same discipline as [`PRECONDITION_VOCABULARY`] (invariant #3: no DSL in the composition
/// layer).
const GUARD_VOCABULARY: &[&str] = &["on_failure", "on_flag", "on_missing"];

/// Resolves a Warble project into its IR JSON document.
///
/// `components` maps a component id to its parsed `component.yml`. `step_contents` maps a
/// component id to a map of step name to the raw (untrimmed) markdown content of that step's
/// `prompt_ref` file. `slot_contents` carries the same thing for slot variants (see
/// [`SlotContents`]) — both exist because core is sans-IO and never opens a file itself. `project_as_authored` is the as-authored path read from
/// `context/binding.yml`'s `project:` field. `context` is the host-injected [`ContextLoader`] —
/// the fine-grained successor to the old `project_precondition_ok: bool` — that the compiler
/// probes to evaluate each `context_precondition` against the bound semantic layer.
pub fn compile(
    profile: &ProfileFile,
    components: &HashMap<String, ComponentFile>,
    project_as_authored: &str,
    context: &dyn ContextLoader,
    step_contents: &HashMap<String, HashMap<String, String>>,
    slot_contents: &SlotContents,
) -> Result<serde_json::Value, CompileError> {
    // Coarse floor (the analog of the old bool gate): the bound semantic layer must at least
    // assemble + parse. `mdl_parseable` / `wren_project_exists` anchor here; finer predicates are
    // evaluated per component below.
    if !context.is_parseable() {
        // Message-only enrichment: when the adapter kept the real assembly failure around
        // (`ContextLoader::parse_error`), append it so a future parse bug shows its actual cause
        // instead of only this generic floor message. Purely cosmetic — the precondition still
        // fails the same way whether or not a detail is available.
        let detail = context
            .parse_error()
            .map(|e| format!(" — {e}"))
            .unwrap_or_default();
        return Err(CompileError(format!(
            "context precondition failed: bound project '{project_as_authored}' is not a parseable \
             wren project (mdl_parseable / wren_project_exists){detail}"
        )));
    }

    // Profile-level slots are checked before any component is resolved: a name collision between
    // the two layers is a defect in the project as a whole, and reporting it per-component would
    // name an arbitrary one of the colliding pair.
    check_profile_slots(profile, components, &slot_contents.profile)?;

    let mut component_nodes = Vec::with_capacity(profile.components.len());
    let mut first_binding_mode: Option<String> = None;

    for mount in &profile.components {
        let component = components.get(&mount.use_id).ok_or_else(|| {
            CompileError(format!(
                "component '{}' referenced by profile is not mounted",
                mount.use_id
            ))
        })?;

        if first_binding_mode.is_none() {
            first_binding_mode = Some(component.binding_mode.clone());
        }

        check_precondition_vocabulary(component)?;
        check_capability_ceiling(component, profile)?;
        check_param_sources(component)?;
        check_selector_fields(component)?;
        check_required_binds(component, mount)?;
        check_when_guards(component)?;
        let binds = resolve_binds(component, mount);
        let (precondition_checks, resolved_precondition_args) =
            evaluate_preconditions(component, context, &binds)?;
        let guardrails = resolve_guardrails(component, mount)?;
        // Runs after `evaluate_preconditions` so a component that fails an earlier context
        // precondition is refused for that reason, not this one — see
        // `cli/tests/freshness_precondition.rs`, whose fixture deliberately still carries a
        // dangling `on_flag` target that stays inert only because the precondition failure
        // above fires first.
        check_step_dataflow(component)?;
        check_step_capabilities(component)?;
        let component_slot_contents = slot_contents.components.get(&component.id);
        check_component_slots(
            component,
            mount,
            step_contents.get(&component.id),
            component_slot_contents,
        )?;

        let empty_steps: HashMap<String, String> = HashMap::new();
        let steps_for_component = step_contents.get(&component.id).unwrap_or(&empty_steps);
        let llm_calls =
            resolve_llm_calls(component, mount, project_as_authored, steps_for_component)?;
        let realization_kind = mount
            .realization_kind
            .clone()
            .unwrap_or_else(|| component.realization_kind.clone());

        let prompt_fragment =
            render_prompt_fragment(component, project_as_authored, steps_for_component)?;

        let context_binding = serde_json::json!({
            "project": project_as_authored,
            "binding_mode": component.binding_mode,
        });

        let mut node = serde_json::json!({
            "id": component.id,
            "verb": component.verb,
            "type": component.component_type,
            "realization_kind": realization_kind,
            "context_binding": context_binding,
            "context_requirements": component.context_requirements,
            "context_precondition": precondition_json(&component.context_precondition, &resolved_precondition_args),
            "params": params_json(&component.params),
            "precondition_result": {
                "status": "pass",
                "checks": precondition_checks,
            },
            "prompt_fragment": prompt_fragment,
            "llm_calls": llm_calls,
            "guardrails": guardrails,
            "trigger": { "kind": component.trigger.kind },
            "required_capabilities": component.required_capabilities,
            "borrowed_actions": component.borrowed_actions,
            "eval_ref": format!("{}.eval", component.id),
            "effect": {
                "render_blocks": render_blocks_json(&component.effect.render_blocks),
                "outcome": outcome_json(&component.effect.outcome),
            },
        });
        if let Some(eval) = &component.eval {
            node["eval"] = serde_json::json!({
                "template_ref": eval.template_ref,
                "metrics": eval.metrics,
            });
        }
        if !binds.is_empty() {
            node["binds"] = serde_json::json!(binds);
        }
        if let Some(brief) = render_brief(
            component,
            mount,
            profile.system_prompt.as_deref(),
            project_as_authored,
        )? {
            node["brief"] = serde_json::json!(brief);
        }
        // Additive: a component with no `slots:` emits no key at all, which is what keeps every
        // pre-existing golden byte-identical.
        if !component.slots.is_empty() {
            node["slots"] = render_slots(
                &component.slots,
                component_slot_contents,
                project_as_authored,
            )?;
        }
        // Additive: a component with no `assets:` emits no key at all, which is what keeps every
        // pre-existing golden byte-identical.
        if !component.assets.is_empty() {
            node["assets"] = render_assets(&component.assets)?;
        }
        // Emitted only when authored, so a component without one compiles to exactly the IR it did
        // before these fields existed. Unlike `brief` these take no placeholder substitution: they
        // describe the component to whoever is choosing between components, and a description that
        // only makes sense once a project is bound cannot serve a published skill list.
        if let Some(description) = component.description.as_deref().map(str::trim) {
            if !description.is_empty() {
                node["description"] = serde_json::json!(description);
            }
        }
        let examples = component
            .examples
            .iter()
            .map(|example| example.trim())
            .filter(|example| !example.is_empty())
            .collect::<Vec<_>>();
        if !examples.is_empty() {
            node["examples"] = serde_json::json!(examples);
        }
        component_nodes.push(node);
    }

    // A single coarse context binding is shared by every mounted component, so the fine-grained
    // resolved block (metrics/dimensions/grains/lineage summary) lives at the top level, alongside
    // the coarse project path + binding_mode that back-end runtimes still need.
    let top_binding_mode = first_binding_mode.unwrap_or_default();

    // Absent, not empty, when nothing was introspected. A binding whose layer is elsewhere yields
    // the same empty collections as a genuinely empty project, and a consumer cannot tell those
    // apart from the values alone — so `resolved: {metrics: [], ...}` would read as the confident
    // claim "this layer has no metrics" about a layer no one looked at. Omitting the key says
    // "unknown", which is the true thing, and mirrors how the lineage facet already omits
    // consumers/diagnostics rather than emitting empties.
    let mut context_binding = serde_json::json!({
        "project": project_as_authored,
        "binding_mode": top_binding_mode,
    });
    if was_introspected(context) {
        context_binding["resolved"] = resolved_binding(context);
    }

    // A profile without a declared ceiling emits exactly `{}`, byte-identical to every IR
    // compiled before this field existed (see `check_capability_ceiling`) — the ceiling only
    // appears once a profile opts in.
    let mut config = serde_json::json!({});
    if let Some(ceiling) = &profile.config.capability_ceiling {
        config["capability_ceiling"] = serde_json::json!(ceiling);
    }

    let mut ir = serde_json::json!({
        "warble_ir_version": "0.7",
        "profile": profile.profile,
        "context_binding": context_binding,
        "config": config,
        "components": component_nodes,
    });
    // Additive, and separate from a component's own `slots`: these belong to the profile's own
    // prompt text (its `system_prompt`), so they are addressed at the layer that declares them
    // rather than copied onto every component node.
    if !profile.slots.is_empty() {
        ir["slots"] = render_slots(
            &profile.slots,
            Some(&slot_contents.profile),
            project_as_authored,
        )?;
    }
    Ok(ir)
}

/// Evaluates every `context_precondition` on a component against the injected [`ContextLoader`],
/// returning the per-predicate `{predicate, outcome}` check list for the IR, plus the resolved
/// `args` for each precondition (for `precondition_json` to emit into the IR, which carries the
/// RESOLVED value, never an unresolved `$param:` template) — or a loud-fail. Two
/// distinct failures can occur here: a predicate the format **cannot answer** (e.g. `metric_additive`
/// with no declared metric, or a `$param:` reference with no effective bind value) fails
/// differently from one that is **answerable but not satisfied**.
/// Per-precondition resolved `args`, in declaration order — `None` when the precondition has no
/// `args` at all, `Some` (possibly empty) once `$param:<name>` references have been substituted.
type ResolvedArgsList = Vec<Option<HashMap<String, serde_yaml::Value>>>;

fn evaluate_preconditions(
    component: &ComponentFile,
    context: &dyn ContextLoader,
    binds: &HashMap<String, serde_yaml::Value>,
) -> Result<(Vec<serde_json::Value>, ResolvedArgsList), CompileError> {
    let mut checks = Vec::with_capacity(component.context_precondition.len());
    let mut resolved_args_list = Vec::with_capacity(component.context_precondition.len());
    for precondition in &component.context_precondition {
        let predicate = precondition.predicate.as_str();
        let resolved_args =
            match resolve_precondition_args(precondition.args.as_ref(), component, binds)? {
                ArgResolution::Unresolvable(reason) => {
                    return Err(CompileError(format!(
                        "context precondition '{predicate}' on component '{}' cannot be evaluated \
                         against the bound semantic layer: {reason}. Refusing rather than \
                         answering wrongly.",
                        component.id
                    )));
                }
                ArgResolution::Resolved(args) => args,
            };
        match eval_predicate(predicate, resolved_args.as_ref(), context) {
            PredicateOutcome::Unanswerable(reason) => {
                return Err(CompileError(format!(
                    "context precondition '{predicate}' on component '{}' cannot be evaluated \
                     against the bound semantic layer: {reason}. Refusing rather than answering \
                     wrongly.",
                    component.id
                )));
            }
            PredicateOutcome::Fail => {
                return Err(CompileError(format!(
                    "context precondition '{predicate}' not satisfied by the bound semantic layer \
                     for component '{}'",
                    component.id
                )));
            }
            PredicateOutcome::Pass => {
                checks.push(serde_json::json!({ "predicate": predicate, "outcome": "pass" }));
            }
        }
        resolved_args_list.push(resolved_args);
    }
    Ok((checks, resolved_args_list))
}

/// Resolves a mount's effective `bind` values for a component's `bind`-family params (`bind:
/// required` / `bind: optional`), used both for the IR's additive `binds` facet and for
/// substituting `$param:<name>` references in `context_precondition` args. A param's effective
/// value is the mount-supplied bind, else the param's declared `default`, else absent. Params
/// declaring `source` (runtime-injected) are never binds and are excluded — their value is
/// supplied by the runtime at dispatch time, not by the profile at compile time.
fn resolve_binds(
    component: &ComponentFile,
    mount: &ProfileComponentMount,
) -> HashMap<String, serde_yaml::Value> {
    let mut binds = HashMap::new();
    for param in &component.params {
        if param.source.is_some() {
            continue;
        }
        let supplied = mount.bind.as_ref().and_then(|b| b.get(&param.name));
        if let Some(value) = supplied {
            binds.insert(param.name.clone(), value.clone());
        } else if let Some(default) = &param.default {
            binds.insert(param.name.clone(), default.clone());
        }
    }
    binds
}

/// The result of resolving a `context_precondition` entry's `args` against a component's effective
/// binds. `Resolved` carries the args with every `$param:<name>` reference replaced by its
/// effective value (or `None` if the precondition declared no `args` at all). `Unresolvable` means
/// every `$param:` name referenced a *declared* param (so it's not a [`CompileError`] — see
/// [`ArgResolution::Resolved`] vs. a hard structural error below), but that param currently has no
/// effective value: the caller turns this into [`PredicateOutcome::Unanswerable`].
enum ArgResolution {
    Resolved(Option<HashMap<String, serde_yaml::Value>>),
    Unresolvable(String),
}

/// Substitutes `$param:<name>` references inside a precondition's `args` with the component's
/// effective bind values. A literal (non-`$param:`) value passes through unchanged. Two failure
/// modes:
/// - `$param:<name>` naming a param this component does not declare → structural [`CompileError`],
///   same discipline as the closed-vocabulary checks: a typo in the reference is an authoring
///   bug, not a runtime unanswerable.
/// - `$param:<name>` naming a real param with no effective value (unsupplied `bind: optional`, no
///   default) → [`ArgResolution::Unresolvable`]: not an authoring bug, a legitimate "this
///   Context can't answer" case the caller reports the same way as any other unanswerable predicate.
fn resolve_precondition_args(
    args: Option<&HashMap<String, serde_yaml::Value>>,
    component: &ComponentFile,
    binds: &HashMap<String, serde_yaml::Value>,
) -> Result<ArgResolution, CompileError> {
    let Some(args) = args else {
        return Ok(ArgResolution::Resolved(None));
    };
    let mut resolved = HashMap::with_capacity(args.len());
    for (key, value) in args {
        let Some(param_name) = value.as_str().and_then(|s| s.strip_prefix("$param:")) else {
            resolved.insert(key.clone(), value.clone());
            continue;
        };
        if !component.params.iter().any(|p| p.name == param_name) {
            return Err(CompileError(format!(
                "precondition arg '{key}' on component '{}' references '$param:{param_name}', but \
                 '{param_name}' is not a declared param of this component",
                component.id
            )));
        }
        match binds.get(param_name) {
            Some(resolved_value) => {
                resolved.insert(key.clone(), resolved_value.clone());
            }
            None => {
                return Ok(ArgResolution::Unresolvable(format!(
                    "arg '{key}' references '$param:{param_name}', which has no bound value and \
                     no declared default"
                )));
            }
        }
    }
    Ok(ArgResolution::Resolved(Some(resolved)))
}

/// The three-way result of evaluating one predicate — the machinery behind the two loud-fail
/// kinds. `Unanswerable` carries a human reason (the "format can't carry it" fail); `Fail` is the
/// answerable-but-false fail; `Pass` contributes a check to the IR.
enum PredicateOutcome {
    Pass,
    Fail,
    Unanswerable(String),
}

fn eval_predicate(
    predicate: &str,
    args: Option<&HashMap<String, serde_yaml::Value>>,
    context: &dyn ContextLoader,
) -> PredicateOutcome {
    // The adapter's own answerable set gates the result: [`ContextLoader::can_answer`] is the
    // documented override for "a non-MDL adapter with a different answerable set", and without
    // consulting it an adapter that declines a probe is still run through the evaluators below —
    // reporting an existence predicate as an answerable `Fail` ("not satisfied") when the truth is
    // that this Context does not know. That is the wrong half of the distinction, and it is the
    // case a context bound to a semantic layer the host cannot read offline lands in.
    //
    // Applied AFTER evaluation rather than before, so an evaluator that has its own, more specific
    // `Unanswerable` keeps it (`metric_additive` explains *why* additivity is not expressible; this
    // gate could only say "not answered"). Evaluation is pure inspection of already-loaded data, so
    // running it first costs nothing. For both adapters shipped here `can_answer` is true exactly
    // where the evaluators already succeed, so no existing outcome changes.
    match eval_predicate_uncensored(predicate, args, context) {
        already @ PredicateOutcome::Unanswerable(_) => already,
        answered if context.can_answer(predicate) => answered,
        _ => PredicateOutcome::Unanswerable(format!(
            "the bound Context does not answer '{predicate}'"
        )),
    }
}

/// The predicate evaluators themselves, before [`ContextLoader::can_answer`] has a say — split out
/// only so `eval_predicate` can apply that gate around one expression.
fn eval_predicate_uncensored(
    predicate: &str,
    args: Option<&HashMap<String, serde_yaml::Value>>,
    context: &dyn ContextLoader,
) -> PredicateOutcome {
    let boolean = boolean_outcome;
    match predicate {
        "mdl_parseable" | "wren_project_exists" => boolean(context.is_parseable()),
        "has_metric" => boolean(!context.metrics().is_empty()),
        "has_queryable_dimension" | "has_groupable_dimension" => {
            boolean(!context.dimensions().is_empty())
        }
        "has_time_dimension" => boolean(!context.time_dimensions().is_empty()),
        "model_has_timestamp" => eval_model_has_timestamp(args, context),
        "lineage_resolvable" => boolean(context.lineage().is_resolvable()),
        "metric_additive" => eval_metric_additive(args, context),
        // Constitutive raw-shape (Phase 4b). `None` = this Context cannot probe a raw source (an
        // MDL-only adapter) ⇒ unanswerable loud-fail (the "format can't carry the answer" fail,
        // not an answerable-false); `Some(false)` = a raw source is bound but not introspectable ⇒
        // ordinary fail; `Some(true)` ⇒ pass. Raw-shape probing itself is borrowed (dlt/wren).
        "source_introspectable" => {
            raw_shape(context.source_introspectable(), "source_introspectable")
        }
        "raw_docs_readable" => raw_shape(context.raw_docs_readable(), "raw_docs_readable"),
        // Unknown predicates are rejected upstream by the closed-vocabulary check.
        other => PredicateOutcome::Unanswerable(format!("unknown predicate '{other}'")),
    }
}

/// Maps a plain boolean predicate result into a [`PredicateOutcome`]: `true` ⇒ pass, `false` ⇒ fail.
/// The shared shape behind every existence-style predicate that has no unanswerable case.
fn boolean_outcome(b: bool) -> PredicateOutcome {
    if b {
        PredicateOutcome::Pass
    } else {
        PredicateOutcome::Fail
    }
}

/// `model_has_timestamp` — mirrors `metric_additive`'s pinned-vs-existential shape. Two modes:
/// - **pinned** (`args.model` given, via a mount's `$param:` bind): the named model must be a
///   *declared* model — has a timestamp column → pass, doesn't → fail, model not declared →
///   unanswerable (naming the model, so the author can see exactly what's missing).
/// - **existential** (no args — the historical, pre-bind-resolution shape other profiles still use
///   unmodified): pass iff at least one declared model has a timestamp.
fn eval_model_has_timestamp(
    args: Option<&HashMap<String, serde_yaml::Value>>,
    context: &dyn ContextLoader,
) -> PredicateOutcome {
    if let Some(name) = args.and_then(|a| a.get("model")).and_then(|v| v.as_str()) {
        return match context.model(name) {
            Some(model) => boolean_outcome(model.has_timestamp),
            None => PredicateOutcome::Unanswerable(format!(
                "model '{name}' is not a declared model, so its timestamp presence is undefined"
            )),
        };
    }
    boolean_outcome(context.models().iter().any(|m| m.has_timestamp))
}

/// Map a raw-shape probe's `Option<bool>` into a [`PredicateOutcome`]: `None` ⇒ unanswerable (this
/// Context is not a raw-source adapter — refuse rather than guess), `Some(false)` ⇒ fail, `Some(true)`
/// ⇒ pass. The shared shape behind every constitutive raw-shape predicate.
fn raw_shape(probe: Option<bool>, predicate: &str) -> PredicateOutcome {
    match probe {
        Some(true) => PredicateOutcome::Pass,
        Some(false) => PredicateOutcome::Fail,
        None => PredicateOutcome::Unanswerable(format!(
            "the bound Context does not probe a raw source, so '{predicate}' (a constitutive \
             raw-shape predicate) is not expressible against it"
        )),
    }
}

/// `metric_additive` — the only semantic (non-existence) predicate. Two modes:
/// - **pinned** (`args.metric` given): the named metric must be a *declared* measure; additive →
///   pass, non-additive → fail, not declared → unanswerable.
/// - **existential** (no args): pass iff at least one declared metric is additive; fail if declared
///   metrics exist but none are additive; unanswerable if no declared metric exists at all
///   (additivity is not expressible — the cube-less case).
fn eval_metric_additive(
    args: Option<&HashMap<String, serde_yaml::Value>>,
    context: &dyn ContextLoader,
) -> PredicateOutcome {
    if let Some(name) = args.and_then(|a| a.get("metric")).and_then(|v| v.as_str()) {
        return match context.metric_additivity(name) {
            Some(Additivity::Additive) | Some(Additivity::SemiAdditive) => PredicateOutcome::Pass,
            Some(Additivity::NonAdditive) => PredicateOutcome::Fail,
            None => PredicateOutcome::Unanswerable(format!(
                "metric '{name}' is not a declared metric, so its additivity is undefined"
            )),
        };
    }
    // Existential: additivity is expressible only over declared metrics.
    if !context.metrics().iter().any(|m| m.declared) {
        return PredicateOutcome::Unanswerable(
            "no declared metric exists, so additivity is not expressible".to_string(),
        );
    }
    let any_additive = context.metrics().iter().any(|m| {
        matches!(
            m.additivity,
            Some(Additivity::Additive) | Some(Additivity::SemiAdditive)
        )
    });
    if any_additive {
        PredicateOutcome::Pass
    } else {
        PredicateOutcome::Fail
    }
}

/// The fine-grained resolved binding block: what the compiler learned about the bound semantic
/// layer. Metric/dimension/grain-level detail plus a lineage summary (counts + resolvable), the
/// evidence that this IR carries fine-grained binding rather than a coarse project path alone.
/// Whether the bound context was actually probed, as opposed to merely resolved. An adapter that
/// answers no predicate in the vocabulary has told us it cannot describe its layer, so there is
/// nothing to report about it — see the call site for why absent beats empty here.
fn was_introspected(context: &dyn ContextLoader) -> bool {
    PRECONDITION_VOCABULARY
        .iter()
        .any(|predicate| context.can_answer(predicate))
}

fn resolved_binding(context: &dyn ContextLoader) -> serde_json::Value {
    let metrics: Vec<serde_json::Value> = context
        .metrics()
        .iter()
        .map(|m| {
            let mut node = serde_json::json!({ "name": m.name, "declared": m.declared });
            if let Some(additivity) = m.additivity {
                node["additivity"] = serde_json::json!(additivity_str(additivity));
            }
            node
        })
        .collect();
    let dimensions: Vec<serde_json::Value> = context
        .dimensions()
        .iter()
        .map(|d| serde_json::json!({ "name": d.name, "temporal": d.is_temporal }))
        .collect();
    let time_dimensions: Vec<&str> = context
        .time_dimensions()
        .iter()
        .map(|d| d.name.as_str())
        .collect();
    let models: Vec<&str> = context.models().iter().map(|m| m.name.as_str()).collect();
    let lineage = context.lineage();
    let mut lineage_json = serde_json::json!({
        "nodes": lineage.nodes.len(),
        "edges": lineage.edges.len(),
        "resolvable": lineage.is_resolvable(),
    });
    // Consumer stats and degradation diagnostics appear only when present, so a project without
    // consumer artifacts emits the exact same resolved block as before consumers existed.
    let count_kind =
        |kind: crate::context::LineageKind| lineage.nodes.iter().filter(|n| n.kind == kind).count();
    let queries = count_kind(crate::context::LineageKind::Query);
    let dashboards = count_kind(crate::context::LineageKind::Dashboard);
    if queries + dashboards > 0 {
        lineage_json["consumers"] =
            serde_json::json!({ "queries": queries, "dashboards": dashboards });
    }
    let diagnostics = context.lineage_diagnostics();
    if !diagnostics.is_empty() {
        lineage_json["diagnostics"] = serde_json::json!(diagnostics);
    }
    serde_json::json!({
        "metrics": metrics,
        "dimensions": dimensions,
        "time_dimensions": time_dimensions,
        "models": models,
        "lineage": lineage_json,
    })
}

fn additivity_str(additivity: Additivity) -> &'static str {
    match additivity {
        Additivity::Additive => "additive",
        Additivity::SemiAdditive => "semi_additive",
        Additivity::NonAdditive => "non_additive",
    }
}

fn check_required_binds(
    component: &ComponentFile,
    mount: &ProfileComponentMount,
) -> Result<(), CompileError> {
    for param in &component.params {
        if param.bind.as_deref() == Some("required") {
            let supplied = mount
                .bind
                .as_ref()
                .map(|binds| binds.contains_key(&param.name))
                .unwrap_or(false);
            if !supplied {
                return Err(CompileError(format!(
                    "missing required bind '{}' for component '{}'",
                    param.name, component.id
                )));
            }
        }
    }
    Ok(())
}

/// Rejects any `context_precondition` predicate outside the closed [`PRECONDITION_VOCABULARY`].
fn check_precondition_vocabulary(component: &ComponentFile) -> Result<(), CompileError> {
    for precondition in &component.context_precondition {
        if !PRECONDITION_VOCABULARY.contains(&precondition.predicate.as_str()) {
            return Err(CompileError(format!(
                "unknown context_precondition predicate '{}' on component '{}' (known: {})",
                precondition.predicate,
                component.id,
                PRECONDITION_VOCABULARY.join(", ")
            )));
        }
    }
    Ok(())
}

/// Rejects a component whose `required_capabilities` reaches outside the profile's declared
/// `config.capability_ceiling`, if one is declared.
///
/// This is a compile-time *authorization* gate ("may this profile's components require this"),
/// distinct from the dispatch-time capability *resolution* every `required_capabilities` entry
/// still goes through against a target's profile ("can the target honor it") — the two are not
/// the same check and neither substitutes for the other.
///
/// A profile with no ceiling (the default) skips this check entirely: every component's
/// `required_capabilities` is accepted as-is, exactly as before this field existed.
///
/// Containment is exact string-set membership only — no hierarchy or prefix inference on the `:`
/// qualifier some capability names use. A ceiling of `sql_execution` does not admit a requirement
/// of `sql_execution:read_only`; a profile that means to allow both must list both.
fn check_capability_ceiling(
    component: &ComponentFile,
    profile: &ProfileFile,
) -> Result<(), CompileError> {
    let Some(ceiling) = &profile.config.capability_ceiling else {
        return Ok(());
    };
    let ceiling_set: HashSet<&str> = ceiling.iter().map(String::as_str).collect();
    for capability in &component.required_capabilities {
        if !ceiling_set.contains(capability.as_str()) {
            return Err(CompileError(format!(
                "component '{}' requires capability '{}', which is outside the profile's \
                 capability_ceiling ({})",
                component.id,
                capability,
                ceiling.join(", ")
            )));
        }
    }
    Ok(())
}

/// Enforces the `conditional`/`when` relationship on every `llm_step` of a component:
/// - `conditional: true` with no `when` is a loud-fail — bare `conditional` no longer expresses a
///   condition on its own; compile refuses to guess it.
/// - `when` declared without `conditional: true` is also a loud-fail (a guard with nothing to
///   guard is very likely an authoring mistake, not an intentional no-op).
/// - When both are present, `when.guard` must be a member of [`GUARD_VOCABULARY`] and
///   `when.target` must be non-empty; `on_flag` additionally requires a dotted
///   `artifact.field` target (the guard reads a structured field off a produced artifact).
fn check_when_guards(component: &ComponentFile) -> Result<(), CompileError> {
    for step in &component.llm_steps {
        match (&step.conditional, &step.when) {
            (true, None) => {
                return Err(CompileError(format!(
                    "conditional step '{}' on component '{}' has no 'when' guard — bare \
                     'conditional: true' no longer implies a condition; declare 'when: {{ guard: \
                     ..., target: ... }}' (known guards: {})",
                    step.name,
                    component.id,
                    GUARD_VOCABULARY.join(", ")
                )));
            }
            (false, Some(_)) => {
                return Err(CompileError(format!(
                    "step '{}' on component '{}' declares a 'when' guard but is not \
                     'conditional: true' — a guard with nothing to guard is refused rather than \
                     silently ignored",
                    step.name, component.id
                )));
            }
            (true, Some(when)) => validate_when_guard(when, step, component)?,
            (false, None) => {}
        }
    }
    Ok(())
}

/// Validates a single `when` guard against [`GUARD_VOCABULARY`] plus the guard-specific target
/// shape (see `WhenGuard` docs for what `target` means per guard).
fn validate_when_guard(
    when: &WhenGuard,
    step: &crate::model::LlmStep,
    component: &ComponentFile,
) -> Result<(), CompileError> {
    if !GUARD_VOCABULARY.contains(&when.guard.as_str()) {
        return Err(CompileError(format!(
            "unknown guard '{}' in step '{}' of component '{}' (known: {})",
            when.guard,
            step.name,
            component.id,
            GUARD_VOCABULARY.join(", ")
        )));
    }
    if when.target.trim().is_empty() {
        return Err(CompileError(format!(
            "guard '{}' in step '{}' of component '{}' has an empty target",
            when.guard, step.name, component.id
        )));
    }
    if when.guard == "on_flag" && !when.target.contains('.') {
        return Err(CompileError(format!(
            "guard 'on_flag' in step '{}' of component '{}' expects a dotted \
             'artifact.field' target, got '{}'",
            step.name, component.id, when.target
        )));
    }
    Ok(())
}

/// Enforces the artifact-flow contract across a component's `llm_steps`, in declaration order:
///
/// 1. **Uniqueness** — no two steps share a name; no two steps declare the same `produces`
///    artifact.
/// 2. **Artifact flow** — every `consumes` entry must be produced by a step strictly earlier in
///    declaration order. A step consuming its own `produces` value, or an artifact no earlier
///    step produces (including one only a *later* step produces), is refused. This is the
///    authoring mistake that has shipped three times as silently-wrong IR (a `consumes` entry
///    with no real producer): `resolve_llm_calls` used to pass `consumes`/`produces` straight
///    through with no validation at all.
/// 3. **Guard targets** — cross-references each `when.target` against what the component
///    actually declares, in the guard's own namespace (guard name/shape were already validated by
///    [`check_when_guards`]):
///    - `on_failure` names a step, and (like `consumes`) must be strictly earlier — the runtime
///      dispatcher (`dispatcher/claude-agent-sdk/src/conditional.ts`) records `state.outcomes`
///      incrementally as steps run, so a target that hasn't run yet can never be observed as
///      `"failure"` and the guard would be permanently dead.
///    - `on_missing` names a produced artifact, which (per the same incremental-execution
///      argument) must be produced by a strictly-earlier step.
///    - `on_flag`'s target is `artifact.field`; the artifact segment (before the first `.`) must
///      be a produced artifact, strictly earlier.
///
/// Runs after `evaluate_preconditions` in `compile()` — see the call site for why.
fn check_step_dataflow(component: &ComponentFile) -> Result<(), CompileError> {
    let mut all_step_names: HashSet<&str> = HashSet::new();
    let mut all_produces: HashSet<&str> = HashSet::new();
    // Accumulate *before* the current step is folded in, so "earlier" never includes the step
    // being checked — a step can never satisfy its own `consumes`/`when.target` reference.
    let mut earlier_step_names: HashSet<&str> = HashSet::new();
    let mut produced_so_far: HashSet<&str> = HashSet::new();

    for step in &component.llm_steps {
        if !all_step_names.insert(step.name.as_str()) {
            return Err(CompileError(format!(
                "duplicate step name '{}' on component '{}' — step names must be unique within a \
                 component",
                step.name, component.id
            )));
        }
        if let Some(produces) = &step.produces {
            if !all_produces.insert(produces.as_str()) {
                return Err(CompileError(format!(
                    "duplicate 'produces' artifact '{}' on component '{}' — more than one step \
                     declares it, most recently '{}'; each artifact must have exactly one \
                     producer",
                    produces, component.id, step.name
                )));
            }
        }

        for consumed in &step.consumes {
            if step.produces.as_deref() == Some(consumed.as_str()) {
                return Err(CompileError(format!(
                    "step '{}' on component '{}' consumes '{}', its own 'produces' artifact — a \
                     step cannot consume what it produces; 'consumes' must name an earlier step's \
                     output",
                    step.name, component.id, consumed
                )));
            }
            if !produced_so_far.contains(consumed.as_str()) {
                return Err(CompileError(format!(
                    "step '{}' on component '{}' consumes '{}', which no earlier step produces — \
                     add a preceding step with 'produces: {}', or remove it from 'consumes'",
                    step.name, component.id, consumed, consumed
                )));
            }
        }

        if let Some(when) = &step.when {
            match when.guard.as_str() {
                "on_failure" => {
                    if !earlier_step_names.contains(when.target.as_str()) {
                        return Err(CompileError(format!(
                            "guard 'on_failure' in step '{}' of component '{}' targets step \
                             '{}', which is not a strictly-earlier step of this component — \
                             'on_failure' can only observe the outcome of a step that has already \
                             run",
                            step.name, component.id, when.target
                        )));
                    }
                }
                "on_missing" => {
                    if !produced_so_far.contains(when.target.as_str()) {
                        return Err(CompileError(format!(
                            "guard 'on_missing' in step '{}' of component '{}' targets artifact \
                             '{}', which no earlier step produces",
                            step.name, component.id, when.target
                        )));
                    }
                }
                "on_flag" => {
                    // Shape (dotted target) already validated by `validate_when_guard`; the
                    // artifact segment is everything before the first '.'.
                    let artifact = when
                        .target
                        .split('.')
                        .next()
                        .unwrap_or(when.target.as_str());
                    if !produced_so_far.contains(artifact) {
                        return Err(CompileError(format!(
                            "guard 'on_flag' in step '{}' of component '{}' targets '{}', but \
                             artifact '{}' is not produced by any earlier step",
                            step.name, component.id, when.target, artifact
                        )));
                    }
                }
                _ => {} // unreachable: check_when_guards already rejects unknown guard names
            }
        }

        earlier_step_names.insert(step.name.as_str());
        if let Some(produces) = &step.produces {
            produced_so_far.insert(produces.as_str());
        }
    }
    Ok(())
}

/// Enforces that every step-level `capabilities` entry is drawn from the component's own
/// `required_capabilities` — exact string containment only, no hierarchy or inference. A step
/// that names a capability the component never declared is a compile-time loud-fail: capability
/// names, like `required_capabilities` itself, name capabilities, not tools — the mapping from a
/// capability to the tools that satisfy it is a dispatch-time concern, not this check's.
///
/// A step that declares no `capabilities` at all is unaffected — it keeps sharing the whole
/// `required_capabilities` set, matching behavior from before this field existed.
fn check_step_capabilities(component: &ComponentFile) -> Result<(), CompileError> {
    let allowed: HashSet<&str> = component
        .required_capabilities
        .iter()
        .map(String::as_str)
        .collect();
    for step in &component.llm_steps {
        for capability in &step.capabilities {
            if !allowed.contains(capability.as_str()) {
                return Err(CompileError(format!(
                    "step '{}' on component '{}' declares capability '{}', which is not in the \
                     component's 'required_capabilities' — a step's capabilities must be a subset \
                     of the component's; known: {:?}",
                    step.name, component.id, capability, component.required_capabilities
                )));
            }
        }
    }
    Ok(())
}

/// Enforces that every param declares exactly one of `bind`/`source`, and that a `source` value
/// is drawn from the supported set (`runtime-injected` only, for now).
/// Authoring checks for the two selector-facing fields, both of which fail loudly rather than
/// producing a description no one can act on.
///
/// `examples` with no `description`: every consumer reaches the examples *through* the description
/// (they are appended to it, or projected beside it), so examples alone are silently discarded — and
/// silent discard is the failure mode this project rejects everywhere else.
///
/// A `{{…}}` placeholder in either field: unlike `brief` and step prompts these take no
/// substitution, deliberately, because they are published to readers with no bound project. A
/// placeholder here is therefore never rendered — it would ship verbatim into an agent's frontmatter
/// and into any skill list projected from it.
fn check_selector_fields(component: &ComponentFile) -> Result<(), CompileError> {
    let described = component
        .description
        .as_deref()
        .map(str::trim)
        .is_some_and(|description| !description.is_empty());
    let has_examples = component
        .examples
        .iter()
        .any(|example| !example.trim().is_empty());
    if has_examples && !described {
        return Err(CompileError(format!(
            "component '{}' authors 'examples' without a 'description'; every consumer reaches the \
             examples through the description, so they would be silently dropped",
            component.id
        )));
    }
    let fields = component
        .description
        .as_deref()
        .map(|description| ("description", description))
        .into_iter()
        .chain(component.examples.iter().map(|e| ("examples", e.as_str())));
    for (field, value) in fields {
        if value.contains("{{") {
            return Err(CompileError(format!(
                "component '{}' uses a '{{{{...}}}}' placeholder in '{field}', which takes no \
                 substitution — it describes the component to readers with no bound project, so the \
                 placeholder would never be rendered",
                component.id
            )));
        }
    }
    Ok(())
}

fn check_param_sources(component: &ComponentFile) -> Result<(), CompileError> {
    for param in &component.params {
        match (&param.bind, &param.source) {
            (Some(_), Some(_)) => {
                return Err(CompileError(format!(
                    "param '{}' on component '{}' declares both 'bind' and 'source' (exactly one required)",
                    param.name, component.id
                )));
            }
            (None, None) => {
                return Err(CompileError(format!(
                    "param '{}' on component '{}' declares neither 'bind' nor 'source' (exactly one required)",
                    param.name, component.id
                )));
            }
            (None, Some(source)) if source != "runtime-injected" => {
                return Err(CompileError(format!(
                    "param '{}' on component '{}' has unknown source '{}' (only 'runtime-injected' is supported)",
                    param.name, component.id, source
                )));
            }
            _ => {}
        }
    }
    Ok(())
}

fn resolve_guardrails(
    component: &ComponentFile,
    mount: &ProfileComponentMount,
) -> Result<Vec<serde_json::Value>, CompileError> {
    let patches = mount.guardrails.as_ref();
    component
        .guardrails
        .iter()
        .map(|guardrail| {
            let mut locked = resolve_guardrail_locked(guardrail, component)?;
            let patch = patches.and_then(|p| p.get(&guardrail.name));
            if let Some(patch) = patch {
                if locked {
                    return Err(CompileError(format!(
                        "cannot override locked guardrail '{}' on component '{}'",
                        guardrail.name, component.id
                    )));
                }
                if let Some(new_locked) = patch.locked {
                    locked = new_locked;
                }
            }
            let mut node = serde_json::json!({ "name": guardrail.name, "locked": locked });
            if let Some(scope) = &guardrail.scope {
                node["scope"] = serde_json::json!(scope);
            }
            if let Some(threshold) = &guardrail.threshold {
                node["threshold"] = serde_json::json!(threshold);
            }
            Ok(node)
        })
        .collect()
}

/// Resolves a guardrail's authored `(locked, overridable)` pair to a single effective `locked`
/// bool. Exactly one of the two must be declared, or both agreeing on the same effective value.
fn resolve_guardrail_locked(
    guardrail: &Guardrail,
    component: &ComponentFile,
) -> Result<bool, CompileError> {
    match (guardrail.locked, guardrail.overridable) {
        (Some(locked), None) => Ok(locked),
        (None, Some(overridable)) => Ok(!overridable),
        (Some(locked), Some(overridable)) => {
            if locked != overridable {
                Ok(locked)
            } else {
                Err(CompileError(format!(
                    "guardrail '{}' on component '{}' declares contradictory locked/overridable",
                    guardrail.name, component.id
                )))
            }
        }
        (None, None) => Err(CompileError(format!(
            "guardrail '{}' on component '{}' must declare 'locked' or 'overridable'",
            guardrail.name, component.id
        ))),
    }
}

/// Normalizes `context_precondition` into its always-array IR shape, carrying `args` only when
/// authored. `resolved_args` is `evaluate_preconditions`'s per-precondition resolution (same order,
/// same length): the IR always carries the RESOLVED value — e.g. `"model": "orders"` — never
/// an unresolved `$param:` template, even though the source `component.yml` authors the template.
fn precondition_json(
    preconditions: &[Precondition],
    resolved_args: &[Option<HashMap<String, serde_yaml::Value>>],
) -> Vec<serde_json::Value> {
    preconditions
        .iter()
        .zip(resolved_args)
        .map(|(precondition, args)| {
            let mut node = serde_json::json!({ "predicate": precondition.predicate });
            if let Some(args) = args {
                node["args"] = serde_json::json!(args);
            }
            node
        })
        .collect()
}

/// Normalizes `params` into its always-array IR shape: a `source` param carries its source
/// verbatim; a `bind` param carries its bind plus an optional default.
fn params_json(params: &[Param]) -> Vec<serde_json::Value> {
    params
        .iter()
        .map(|param| {
            if let Some(source) = &param.source {
                serde_json::json!({ "name": param.name, "source": source })
            } else {
                let mut node = serde_json::json!({ "name": param.name, "bind": param.bind });
                if let Some(default) = &param.default {
                    node["default"] = serde_json::json!(default);
                }
                node
            }
        })
        .collect()
}

/// Carries the outcome's optional assertive/mutating/orchestrating fields only when authored.
fn outcome_json(outcome: &Outcome) -> serde_json::Value {
    let mut node = serde_json::json!({ "kind": outcome.kind });
    if let Some(verdict_type) = &outcome.verdict_type {
        node["verdict_type"] = serde_json::json!(verdict_type);
    }
    if let Some(emits) = &outcome.emits {
        node["emits"] = serde_json::json!(emits);
    }
    if let Some(target) = &outcome.target {
        node["target"] = serde_json::json!(target);
    }
    if let Some(change_type) = &outcome.change_type {
        node["change_type"] = serde_json::json!(change_type);
    }
    if let Some(routable_scope) = &outcome.routable_scope {
        node["routable_scope"] = serde_json::json!(routable_scope);
    }
    node
}

/// Normalizes `render_blocks` (authored as bare strings or typed mappings) into the IR's
/// always-typed `{type, fields}` shape.
fn render_blocks_json(render_blocks: &[RenderBlock]) -> Vec<serde_json::Value> {
    render_blocks
        .iter()
        .map(|block| {
            serde_json::json!({
                "type": block.block_type,
                "fields": block.fields,
            })
        })
        .collect()
}

fn resolve_llm_calls(
    component: &ComponentFile,
    mount: &ProfileComponentMount,
    project_as_authored: &str,
    step_contents: &HashMap<String, String>,
) -> Result<Vec<serde_json::Value>, CompileError> {
    component
        .llm_steps
        .iter()
        .map(|step| {
            let tier = mount
                .tier_overrides
                .as_ref()
                .and_then(|overrides| overrides.get(&step.name))
                .cloned()
                .unwrap_or_else(|| step.tier.clone());
            let prompt = render_step_body(component, step, project_as_authored, step_contents)?;
            let when = step
                .when
                .as_ref()
                .map(|w| serde_json::json!({ "guard": w.guard, "target": w.target }));
            let mut call = serde_json::json!({
                "name": step.name,
                "tier": tier,
                "consumes": step.consumes,
                "produces": step.produces,
                "conditional": step.conditional,
                "when": when,
                "prompt": prompt,
            });
            // Additive: omitted entirely (not `null`) when the step doesn't narrow its
            // capabilities, so a step authored before this field existed compiles to exactly the
            // IR it did before.
            if !step.capabilities.is_empty() {
                call["capabilities"] = serde_json::json!(step.capabilities);
            }
            // Additive: omitted entirely when `false`, since only `true` carries meaning — a step
            // authored before this field existed, or one that simply never sets it, compiles to
            // exactly the IR it did before.
            if step.produces_exclusive {
                call["produces_exclusive"] = serde_json::json!(true);
            }
            Ok(call)
        })
        .collect()
}

/// Collects the slot names referenced as `{{ slot.<name> }}` in a piece of prompt text.
///
/// Hand-scanned rather than done with a regex so core keeps its four dependencies. Only the exact
/// shape `{{`, optional whitespace, `slot.`, a `[a-z_][a-z0-9_]*` name, optional whitespace, `}}`
/// counts as a reference. Anything else — including a malformed `{{ slot.Foo }}` — is left alone
/// here and survives into the prompt exactly as it does today; turning unrecognised template
/// syntax into a compile error is a separate, deliberately separate, change.
fn slot_references(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut cursor = 0;
    while let Some(offset) = text[cursor..].find("{{") {
        // Every index below only ever advances over ASCII bytes, so each stays on a char
        // boundary and the `text[i..]` slices cannot split a multi-byte character.
        let after_open = cursor + offset + 2;
        let mut i = after_open;
        while i < bytes.len() && (bytes[i] as char).is_ascii_whitespace() {
            i += 1;
        }
        if let Some(rest) = text[i..].strip_prefix("slot.") {
            let name_len = rest
                .bytes()
                .take_while(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
                .count();
            let name = &rest[..name_len];
            let starts_valid = name
                .bytes()
                .next()
                .is_some_and(|b| b.is_ascii_lowercase() || b == b'_');
            let mut j = i + "slot.".len() + name_len;
            while j < bytes.len() && (bytes[j] as char).is_ascii_whitespace() {
                j += 1;
            }
            if starts_valid && text[j..].starts_with("}}") {
                found.push(name.to_string());
            }
        }
        cursor = after_open;
    }
    found
}

/// Loud-fails any prompt text carrying template syntax this compiler does not recognise.
///
/// Three forms are accepted inside `{{ }}`: `project`, `project_name`, and `slot.<name>`.
/// Everything else is refused, as is any `{%` or `{#`.
///
/// **Why refuse rather than pass through.** Today an unknown `{{foo}}` survives verbatim into the
/// prompt. A real template engine would instead treat it as an undefined variable and render it
/// empty or raise — so the incompatibility already exists, independent of what syntax slots use,
/// and swapping the renderer later would silently blank out prompt content at run time. Refusing
/// these forms now is what makes that swap a genuine no-migration change; the escaping burden it
/// puts on authors is the point of the ticket, not a side effect of it.
///
/// `owner` names the surface in the error message (a step, a brief, the profile's system prompt,
/// a slot variant) so an author knows which file to open.
fn check_template_syntax(raw: &str, owner: &str) -> Result<(), CompileError> {
    if let Some(offset) = raw.find("{%").or_else(|| raw.find("{#")) {
        let delimiter = &raw[offset..offset + 2];
        return Err(CompileError(format!(
            "unrecognised template syntax in {owner}: '{delimiter}' is a template statement or \
             comment delimiter, which Warble does not support. A single brace needs no escaping — \
             write '{{' if you meant a literal one."
        )));
    }
    for reference in double_brace_bodies(raw) {
        let body = reference.trim();
        let recognised = body == "project"
            || body == "project_name"
            || body.strip_prefix("slot.").is_some_and(is_slot_name);
        if !recognised {
            return Err(CompileError(format!(
                "unrecognised template syntax in {owner}: '{{{{{reference}}}}}' is not a known \
                 placeholder ('{{{{project}}}}', '{{{{project_name}}}}') or a slot reference \
                 ('{{{{ slot.<name> }}}}'). A single brace needs no escaping — write '{{' if you \
                 meant a literal one."
            )));
        }
    }
    Ok(())
}

/// The raw body of every `{{ … }}` in `raw`, in order, without the braces. An unterminated `{{`
/// yields nothing — it cannot be read as a reference, and reporting it as one would guess at what
/// the author meant.
fn double_brace_bodies(raw: &str) -> Vec<&str> {
    let mut bodies = Vec::new();
    let mut cursor = 0;
    while let Some(open) = raw[cursor..].find("{{") {
        let body_start = cursor + open + 2;
        match raw[body_start..].find("}}") {
            Some(close) => {
                bodies.push(&raw[body_start..body_start + close]);
                cursor = body_start + close + 2;
            }
            None => break,
        }
    }
    bodies
}

/// Whether `name` is a well-formed slot name: `[a-z_][a-z0-9_]*`. Shared by the syntax check and
/// [`slot_references`] so the two cannot disagree about what counts as a reference — if they did,
/// a name one accepted and the other did not would either be checked twice or not at all.
fn is_slot_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c == '_')
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Loud-fails a component whose `slots:` declarations and `{{ slot.<name> }}` references do not
/// line up.
///
/// Both directions are errors, and for the same reason: a slot is a position an author chose, so
/// a reference with no declaration has no wording to receive and a declaration nothing references
/// is wording that will never be shown. Silently tolerating either is how a mistyped slot name
/// reaches a model as literal text.
///
/// Scope is this component's own text — its step bodies, its effective `brief`, and its own
/// variants. The profile's `system_prompt` is deliberately *not* scanned here even though it is
/// prepended to every `brief`: its slots belong to the profile layer and are checked there, and
/// mixing the two would let a component appear to "use" a slot it never mentions.
fn check_component_slots(
    component: &ComponentFile,
    mount: &ProfileComponentMount,
    step_contents: Option<&HashMap<String, String>>,
    slot_contents: Option<&HashMap<String, HashMap<String, String>>>,
) -> Result<(), CompileError> {
    if component.slots.is_empty() {
        // Still an error to reference a slot when none are declared — otherwise the typo case
        // this check exists for goes unnoticed on exactly the components most likely to have it.
        let referenced = component_slot_reference_names(component, mount, step_contents, None);
        if let Some(name) = referenced.first() {
            return Err(CompileError(format!(
                "component '{}' references slot '{name}' in its prompt text but declares no slots",
                component.id
            )));
        }
        return Ok(());
    }

    // Two passes, structure before content: a duplicate or malformed declaration is a defect in
    // the component itself, and reporting it first means the author is not sent chasing a missing
    // variant file that is only missing because the duplicate shadowed it.
    let mut declared: Vec<&str> = Vec::with_capacity(component.slots.len());
    for slot in &component.slots {
        if declared.contains(&slot.name.as_str()) {
            return Err(CompileError(format!(
                "component '{}' declares slot '{}' more than once",
                component.id, slot.name
            )));
        }
        declared.push(&slot.name);
        check_slot_shape(slot, &format!("component '{}'", component.id))?;
    }
    for slot in &component.slots {
        let variants = slot_contents.and_then(|all| all.get(&slot.name));
        for key in slot.variants.keys() {
            if variants.and_then(|v| v.get(key)).is_none() {
                return Err(CompileError(format!(
                    "missing content for variant '{key}' of slot '{}' in component '{}'",
                    slot.name, component.id
                )));
            }
        }
    }

    let referenced = component_slot_reference_names(component, mount, step_contents, slot_contents);
    for name in &referenced {
        if !declared.contains(&name.as_str()) {
            return Err(CompileError(format!(
                "component '{}' references slot '{name}' in its prompt text, which it does not \
                 declare (declared: {})",
                component.id,
                declared.join(", ")
            )));
        }
    }
    for slot in &component.slots {
        if !referenced.contains(&slot.name) {
            return Err(CompileError(format!(
                "component '{}' declares slot '{}' but no prompt text references \
                 '{{{{ slot.{} }}}}'",
                component.id, slot.name, slot.name
            )));
        }
    }
    Ok(())
}

/// Loud-fails a profile whose own `slots:` declarations are malformed, collide with a component's,
/// or do not line up with the references in its `system_prompt`.
///
/// The collision rule is the load-bearing one. Slot names are a single project-wide name space, so
/// a consumer resolves `{{ slot.x }}` against one flat table instead of first having to work out
/// which layer the surrounding text came from. Letting the layers shadow each other would need a
/// precedence rule, and there is already one wholesale-replacement rule in this area (a mount's
/// `brief` replacing a component's); a second one with different semantics is how authors end up
/// guessing. Refusing the collision keeps the resolution unambiguous.
fn check_profile_slots(
    profile: &ProfileFile,
    components: &HashMap<String, ComponentFile>,
    slot_contents: &HashMap<String, HashMap<String, String>>,
) -> Result<(), CompileError> {
    let mut declared: Vec<&str> = Vec::with_capacity(profile.slots.len());
    for slot in &profile.slots {
        if declared.contains(&slot.name.as_str()) {
            return Err(CompileError(format!(
                "profile '{}' declares slot '{}' more than once",
                profile.profile, slot.name
            )));
        }
        declared.push(&slot.name);
        check_slot_shape(slot, &format!("profile '{}'", profile.profile))?;

        // Iterated over the mounts rather than the map so the reported component is stable.
        for mount in &profile.components {
            let Some(component) = components.get(&mount.use_id) else {
                continue;
            };
            if component.slots.iter().any(|s| s.name == slot.name) {
                return Err(CompileError(format!(
                    "profile '{}' declares slot '{}', which component '{}' also declares — slot \
                     names are shared across the whole project, so rename one of them",
                    profile.profile, slot.name, component.id
                )));
            }
        }
    }
    for slot in &profile.slots {
        for key in slot.variants.keys() {
            if slot_contents
                .get(&slot.name)
                .and_then(|v| v.get(key))
                .is_none()
            {
                return Err(CompileError(format!(
                    "missing content for variant '{key}' of slot '{}' in profile '{}'",
                    slot.name, profile.profile
                )));
            }
        }
    }

    // Scope: the profile's own prompt text. `system_prompt` is prepended to every component's
    // brief, but a component's *own* text is checked against the component's declarations, so
    // each reference is validated exactly once, against the layer that owns the text it sits in.
    let mut referenced = Vec::new();
    if let Some(system_prompt) = profile.system_prompt.as_deref() {
        referenced.extend(slot_references(system_prompt));
    }
    for slot in &profile.slots {
        let mut keys: Vec<&String> = slot.variants.keys().collect();
        keys.sort_unstable();
        for key in keys {
            if let Some(content) = slot_contents.get(&slot.name).and_then(|v| v.get(key)) {
                referenced.extend(slot_references(content));
            }
        }
    }
    for name in &referenced {
        if !declared.contains(&name.as_str()) {
            return Err(CompileError(format!(
                "profile '{}' references slot '{name}' in its system_prompt, which it does not \
                 declare (declared: {})",
                profile.profile,
                declared.join(", ")
            )));
        }
    }
    for slot in &profile.slots {
        if !referenced.contains(&slot.name) {
            return Err(CompileError(format!(
                "profile '{}' declares slot '{}' but its system_prompt does not reference \
                 '{{{{ slot.{} }}}}'",
                profile.profile, slot.name, slot.name
            )));
        }
    }
    Ok(())
}

/// The shape checks shared by a component-level and a profile-level slot: a slot needs somewhere
/// to choose from, and its `default` must name one of those choices. `owner` names the declaring
/// side in the error message.
fn check_slot_shape(slot: &SlotDecl, owner: &str) -> Result<(), CompileError> {
    if slot.variants.is_empty() {
        return Err(CompileError(format!(
            "{owner} declares slot '{}' with no variants",
            slot.name
        )));
    }
    if !slot.variants.contains_key(&slot.default) {
        let mut keys: Vec<&str> = slot.variants.keys().map(String::as_str).collect();
        keys.sort_unstable();
        return Err(CompileError(format!(
            "{owner} declares slot '{}' with default '{}', which is not one of its variants ({})",
            slot.name,
            slot.default,
            keys.join(", ")
        )));
    }
    Ok(())
}

/// Every slot name this component's own prompt text mentions. `slot_contents` is optional so the
/// no-declarations path can ask the same question without variant content existing.
fn component_slot_reference_names(
    component: &ComponentFile,
    mount: &ProfileComponentMount,
    step_contents: Option<&HashMap<String, String>>,
    slot_contents: Option<&HashMap<String, HashMap<String, String>>>,
) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(steps) = step_contents {
        // Iterated in declaration order, not map order, so an error message names the same slot
        // every run.
        for step in &component.llm_steps {
            if let Some(body) = steps.get(&step.name) {
                names.extend(slot_references(body));
            }
        }
    }
    if let Some(brief) = mount.brief.as_deref().or(component.brief.as_deref()) {
        names.extend(slot_references(brief));
    }
    if let Some(all) = slot_contents {
        for slot in &component.slots {
            let mut keys: Vec<&String> = slot.variants.keys().collect();
            keys.sort_unstable();
            for key in keys {
                if let Some(content) = all.get(&slot.name).and_then(|v| v.get(key)) {
                    names.extend(slot_references(content));
                }
            }
        }
    }
    names
}

/// Renders a slot list into its IR form: every variant's text, substituted the same way a step
/// body or a `brief` is, with `present_when` present only when authored.
///
/// All variants travel, and none is selected — that is the whole point of the mechanism. A reader
/// of the IR can still see every wording the model might be given, which a dispatch-time
/// substitution would have hidden.
fn render_slots(
    slots: &[SlotDecl],
    contents: Option<&HashMap<String, HashMap<String, String>>>,
    project_as_authored: &str,
) -> Result<serde_json::Value, CompileError> {
    let mut out = Vec::with_capacity(slots.len());
    for slot in slots {
        let mut rendered = serde_json::Map::new();
        for key in slot.variants.keys() {
            let raw = contents
                .and_then(|all| all.get(&slot.name))
                .and_then(|v| v.get(key))
                .ok_or_else(|| {
                    CompileError(format!(
                        "missing content for variant '{key}' of slot '{}'",
                        slot.name
                    ))
                })?;
            rendered.insert(
                key.clone(),
                serde_json::json!(render_placeholders(
                    raw,
                    project_as_authored,
                    &format!("variant '{key}' of slot '{}'", slot.name),
                )?),
            );
        }
        let mut node = serde_json::json!({
            "name": slot.name,
            "default": slot.default,
            "variants": serde_json::Value::Object(rendered),
        });
        if let Some(present_when) = slot.present_when.as_deref() {
            node["present_when"] = serde_json::json!(present_when);
        }
        out.push(node);
    }
    Ok(serde_json::Value::Array(out))
}

/// Renders a component's `assets:` declarations into their IR shape: `{path, hash, bytes}` per
/// entry, nothing more. Unlike [`render_slots`] there is no content to substitute — the host
/// already resolved and hashed each file before compile ever ran, so this only has to shape what
/// it was handed.
///
/// `hash`/`bytes` being `None` here means the host inserted an [`AssetDecl`] without populating
/// them — a bug in the caller, not something an author can trigger, so it is reported the same
/// way as any other internal contract violation: a [`CompileError`] naming the offending path.
fn render_assets(assets: &[AssetDecl]) -> Result<serde_json::Value, CompileError> {
    let mut out = Vec::with_capacity(assets.len());
    for asset in assets {
        let hash = asset.hash.as_deref().ok_or_else(|| {
            CompileError(format!(
                "asset '{}' reached compile without a computed hash",
                asset.path
            ))
        })?;
        let bytes = asset.bytes.ok_or_else(|| {
            CompileError(format!(
                "asset '{}' reached compile without a computed size",
                asset.path
            ))
        })?;
        out.push(serde_json::json!({
            "path": asset.path,
            "hash": hash,
            "bytes": bytes,
        }));
    }
    Ok(serde_json::Value::Array(out))
}

/// Substitutes the `{{project}}`/`{{project_name}}` placeholders into a raw authored string and
/// trims trailing whitespace — the one substitution rule shared by step bodies and `brief`, so
/// both go through this instead of two parallel implementations that could drift.
fn render_placeholders(
    raw: &str,
    project_as_authored: &str,
    owner: &str,
) -> Result<String, CompileError> {
    // Checked before substitution, so the check sees exactly what the author wrote rather than a
    // string in which the recognised placeholders have already vanished.
    check_template_syntax(raw, owner)?;
    let project_name = project_basename(project_as_authored);
    Ok(raw
        .trim_end()
        .replace("{{project}}", project_as_authored)
        .replace("{{project_name}}", &project_name)
        .trim_end()
        .to_string())
}

/// Renders a single step's `prompt_ref` markdown with placeholder substitution, trimmed of
/// trailing whitespace, without the `## <name>` header used in the joined `prompt_fragment`.
fn render_step_body(
    component: &ComponentFile,
    step: &crate::model::LlmStep,
    project_as_authored: &str,
    step_contents: &HashMap<String, String>,
) -> Result<String, CompileError> {
    let raw = step_contents.get(&step.name).ok_or_else(|| {
        CompileError(format!(
            "missing prompt content for step '{}' of component '{}'",
            step.name, component.id
        ))
    })?;
    render_placeholders(
        raw,
        project_as_authored,
        &format!("step '{}' of component '{}'", step.name, component.id),
    )
}

/// Resolves the effective `brief` for a mounted component: the profile's shared `system_prompt`
/// followed by the component's own brief, both rendered through the same placeholder substitution
/// as step bodies.
///
/// The two are separate layers. A profile mount's `brief` still replaces the component's own
/// wholesale (never merged), exactly as before; `system_prompt` does not participate in that
/// replacement, because it frames every mounted component rather than standing in for one
/// component's framing. Absent both, there is no brief at all — a profile that authors neither
/// compiles to exactly the IR it did before `system_prompt` existed.
///
/// An empty `system_prompt` contributes nothing, so it cannot conjure a `brief` onto a component
/// that has none. An empty *brief* is preserved as today: authoring `brief: ""` on a mount is the
/// documented way to blank a component's brief, and that stays true with a `system_prompt` above
/// it.
fn render_brief(
    component: &ComponentFile,
    mount: &ProfileComponentMount,
    profile_system_prompt: Option<&str>,
    project_as_authored: &str,
) -> Result<Option<String>, CompileError> {
    // The mount's brief and the component's are distinct files, so the error names whichever one
    // actually supplied the text rather than a generic "brief".
    let own = match (mount.brief.as_deref(), component.brief.as_deref()) {
        (Some(raw), _) => Some(render_placeholders(
            raw,
            project_as_authored,
            &format!("the mount brief for component '{}'", component.id),
        )?),
        (None, Some(raw)) => Some(render_placeholders(
            raw,
            project_as_authored,
            &format!("the brief of component '{}'", component.id),
        )?),
        (None, None) => None,
    };
    let shared = profile_system_prompt
        .map(|raw| render_placeholders(raw, project_as_authored, "the profile's system_prompt"))
        .transpose()?
        .filter(|rendered| !rendered.is_empty());

    Ok(match (shared, own) {
        (None, own) => own,
        (Some(shared), None) => Some(shared),
        (Some(shared), Some(own)) if own.is_empty() => Some(shared),
        (Some(shared), Some(own)) => Some(format!("{shared}\n\n{own}")),
    })
}

fn render_prompt_fragment(
    component: &ComponentFile,
    project_as_authored: &str,
    step_contents: &HashMap<String, String>,
) -> Result<String, CompileError> {
    let mut sections = Vec::with_capacity(component.llm_steps.len());
    for step in &component.llm_steps {
        let rendered = render_step_body(component, step, project_as_authored, step_contents)?;
        sections.push(format!("## {}\n\n{}", step.name, rendered));
    }
    Ok(sections.join("\n\n"))
}

fn project_basename(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

#[cfg(test)]
mod asset_render_tests {
    use super::*;

    fn decl(path: &str, hash: Option<&str>, bytes: Option<u64>) -> AssetDecl {
        AssetDecl {
            path: path.to_string(),
            hash: hash.map(str::to_string),
            bytes,
        }
    }

    /// Unreachable through the only host that exists today, which always populates both fields
    /// before compile — but it is the caller contract that makes it unreachable, not the type. A
    /// direct caller of `compile` (a future binding) can get this wrong, and the point of these
    /// two cases is that the failure is loud and names the asset rather than emitting a manifest
    /// entry with a missing or invented fingerprint.
    #[test]
    fn a_missing_hash_is_a_loud_error_naming_the_asset() {
        let err = render_assets(&[decl("themes/dark.css", None, Some(22))])
            .expect_err("an unpopulated hash must not reach the IR");
        assert!(err.0.contains("themes/dark.css"), "{}", err.0);
        assert!(err.0.contains("without a computed hash"), "{}", err.0);
    }

    #[test]
    fn a_missing_size_is_a_loud_error_naming_the_asset() {
        let err = render_assets(&[decl("themes/dark.css", Some("sha256:abc"), None)])
            .expect_err("an unpopulated size must not reach the IR");
        assert!(err.0.contains("themes/dark.css"), "{}", err.0);
        assert!(err.0.contains("without a computed size"), "{}", err.0);
    }

    #[test]
    fn a_populated_asset_renders_exactly_path_hash_and_bytes() {
        let rendered = render_assets(&[decl("themes/dark.css", Some("sha256:abc"), Some(22))])
            .expect("a populated asset must render");
        assert_eq!(
            rendered,
            serde_json::json!([
                { "path": "themes/dark.css", "hash": "sha256:abc", "bytes": 22 }
            ]),
            "the manifest entry must carry these three keys and nothing else"
        );
    }
}
