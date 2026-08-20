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
    ComponentFile, Guardrail, Outcome, Param, Precondition, ProfileComponentMount, ProfileFile,
    RenderBlock, WhenGuard,
};
use std::collections::HashMap;

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
/// `prompt_ref` file. `project_as_authored` is the as-authored path read from
/// `context/binding.yml`'s `project:` field. `context` is the host-injected [`ContextLoader`] —
/// the fine-grained successor to the old `project_precondition_ok: bool` — that the compiler
/// probes to evaluate each `context_precondition` against the bound semantic layer.
pub fn compile(
    profile: &ProfileFile,
    components: &HashMap<String, ComponentFile>,
    project_as_authored: &str,
    context: &dyn ContextLoader,
    step_contents: &HashMap<String, HashMap<String, String>>,
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
        check_param_sources(component)?;
        check_selector_fields(component)?;
        check_required_binds(component, mount)?;
        check_when_guards(component)?;
        let binds = resolve_binds(component, mount);
        let (precondition_checks, resolved_precondition_args) =
            evaluate_preconditions(component, context, &binds)?;
        let guardrails = resolve_guardrails(component, mount)?;

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
        if let Some(brief) = render_brief(component, mount, project_as_authored) {
            node["brief"] = serde_json::json!(brief);
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

    Ok(serde_json::json!({
        "warble_ir_version": "0.6",
        "profile": profile.profile,
        "context_binding": context_binding,
        "config": {},
        "components": component_nodes,
    }))
}

/// Evaluates every `context_precondition` on a component against the injected [`ContextLoader`],
/// returning the per-predicate `{predicate, outcome}` check list for the IR, plus the resolved
/// `args` for each precondition (for `precondition_json` to emit into the IR — see D5: the IR
/// carries the RESOLVED value, never an unresolved `$param:` template) — or a loud-fail. Two
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
/// required` / `bind: optional`), used both for the IR's additive `binds` facet (D1) and for
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
/// effective value (D3): the caller turns this into [`PredicateOutcome::Unanswerable`].
enum ArgResolution {
    Resolved(Option<HashMap<String, serde_yaml::Value>>),
    Unresolvable(String),
}

/// Substitutes `$param:<name>` references inside a precondition's `args` with the component's
/// effective bind values. A literal (non-`$param:`) value passes through unchanged. Two failure
/// modes, matching D3/D4:
/// - `$param:<name>` naming a param this component does not declare → structural [`CompileError`]
///   (D4), same discipline as the closed-vocabulary checks: a typo in the reference is an authoring
///   bug, not a runtime unanswerable.
/// - `$param:<name>` naming a real param with no effective value (unsupplied `bind: optional`, no
///   default) → [`ArgResolution::Unresolvable`] (D3): not an authoring bug, a legitimate "this
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

/// The three-way result of evaluating one predicate — the machinery behind D2's two loud-fail
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
    // that this Context does not know. That is the wrong half of the D2 distinction, and it is the
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
        // MDL-only adapter) ⇒ unanswerable loud-fail (the D2 "format can't carry the answer" fail,
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

/// `model_has_timestamp` — mirrors `metric_additive`'s pinned-vs-existential shape (D6). Two modes:
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
/// same length): the IR always carries the RESOLVED value (D5) — e.g. `"model": "orders"` — never
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
            Ok(serde_json::json!({
                "name": step.name,
                "tier": tier,
                "consumes": step.consumes,
                "produces": step.produces,
                "conditional": step.conditional,
                "when": when,
                "prompt": prompt,
            }))
        })
        .collect()
}

/// Substitutes the `{{project}}`/`{{project_name}}` placeholders into a raw authored string and
/// trims trailing whitespace — the one substitution rule shared by step bodies and `brief`, so
/// both go through this instead of two parallel implementations that could drift.
fn render_placeholders(raw: &str, project_as_authored: &str) -> String {
    let project_name = project_basename(project_as_authored);
    raw.trim_end()
        .replace("{{project}}", project_as_authored)
        .replace("{{project_name}}", &project_name)
        .trim_end()
        .to_string()
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
    Ok(render_placeholders(raw, project_as_authored))
}

/// Resolves the effective `brief` for a mounted component — a profile mount's `brief` replaces
/// the component's own wholesale (never merged); absent on both, there is no brief at all — and
/// renders it through the same placeholder substitution as step bodies.
fn render_brief(
    component: &ComponentFile,
    mount: &ProfileComponentMount,
    project_as_authored: &str,
) -> Option<String> {
    let raw = mount.brief.as_ref().or(component.brief.as_ref())?;
    Some(render_placeholders(raw, project_as_authored))
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
