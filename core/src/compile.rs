//! The resolve/validate/emit-IR pass — pure, sans-IO.
//!
//! Given parsed authoring types plus the raw step markdown (all injected by the host), this
//! merges component defaults ⊕ profile overrides, runs the loud-fail compile checks, and emits
//! the language-neutral IR JSON that any back-end dispatcher consumes. See `docs/spec/ir-schema.md`.

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
    // purpose (plan §7.4: don't grow the closed vocabulary all at once).
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
        return Err(CompileError(format!(
            "context precondition failed: bound project '{project_as_authored}' is not a parseable \
             wren project (mdl_parseable / wren_project_exists)"
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
        check_required_binds(component, mount)?;
        check_when_guards(component)?;
        let precondition_checks = evaluate_preconditions(component, context)?;
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
            "context_precondition": precondition_json(&component.context_precondition),
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
        component_nodes.push(node);
    }

    // A single coarse context binding is shared by every mounted component, so the fine-grained
    // resolved block (metrics/dimensions/grains/lineage summary) lives at the top level, alongside
    // the coarse project path + binding_mode that back-end runtimes still need.
    let top_binding_mode = first_binding_mode.unwrap_or_default();

    Ok(serde_json::json!({
        "warble_ir_version": "0.3",
        "profile": profile.profile,
        "context_binding": {
            "project": project_as_authored,
            "binding_mode": top_binding_mode,
            "resolved": resolved_binding(context),
        },
        "config": {
            "tier_policy": profile.config.tier_policy,
        },
        "components": component_nodes,
    }))
}

/// Evaluates every `context_precondition` on a component against the injected [`ContextLoader`],
/// returning the per-predicate `{predicate, outcome}` check list for the IR — or a loud-fail. Two
/// distinct failures (plan §5 D2): a predicate the format **cannot answer** (e.g. `metric_additive`
/// with no declared metric) fails differently from one that is **answerable but not satisfied**.
fn evaluate_preconditions(
    component: &ComponentFile,
    context: &dyn ContextLoader,
) -> Result<Vec<serde_json::Value>, CompileError> {
    let mut checks = Vec::with_capacity(component.context_precondition.len());
    for precondition in &component.context_precondition {
        let predicate = precondition.predicate.as_str();
        match eval_predicate(predicate, precondition.args.as_ref(), context) {
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
    }
    Ok(checks)
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
    let boolean = |b: bool| {
        if b {
            PredicateOutcome::Pass
        } else {
            PredicateOutcome::Fail
        }
    };
    match predicate {
        "mdl_parseable" | "wren_project_exists" => boolean(context.is_parseable()),
        "has_metric" => boolean(!context.metrics().is_empty()),
        "has_queryable_dimension" | "has_groupable_dimension" => {
            boolean(!context.dimensions().is_empty())
        }
        "has_time_dimension" => boolean(!context.time_dimensions().is_empty()),
        "model_has_timestamp" => boolean(context.models().iter().any(|m| m.has_timestamp)),
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
/// authored.
fn precondition_json(preconditions: &[Precondition]) -> Vec<serde_json::Value> {
    preconditions
        .iter()
        .map(|precondition| {
            let mut node = serde_json::json!({ "predicate": precondition.predicate });
            if let Some(args) = &precondition.args {
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

/// Renders a single step's `prompt_ref` markdown with placeholder substitution, trimmed of
/// trailing whitespace, without the `## <name>` header used in the joined `prompt_fragment`.
fn render_step_body(
    component: &ComponentFile,
    step: &crate::model::LlmStep,
    project_as_authored: &str,
    step_contents: &HashMap<String, String>,
) -> Result<String, CompileError> {
    let project_name = project_basename(project_as_authored);
    let raw = step_contents.get(&step.name).ok_or_else(|| {
        CompileError(format!(
            "missing prompt content for step '{}' of component '{}'",
            step.name, component.id
        ))
    })?;
    let rendered = raw
        .trim_end()
        .replace("{{project}}", project_as_authored)
        .replace("{{project_name}}", &project_name);
    Ok(rendered.trim_end().to_string())
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
