//! The resolve/validate/emit-IR pass — pure, sans-IO.
//!
//! Given parsed authoring types plus the raw step markdown (all injected by the host), this
//! merges component defaults ⊕ profile overrides, runs the loud-fail compile checks, and emits
//! the language-neutral IR JSON that any back-end dispatcher consumes. See `docs/spec/ir-schema.md`.

use crate::error::CompileError;
use crate::model::{ComponentFile, ProfileComponentMount, ProfileFile, RenderBlock};
use std::collections::HashMap;

/// Resolves a Warble project into its IR JSON document.
///
/// `components` maps a component id to its parsed `component.yml`. `step_contents` maps a
/// component id to a map of step name to the raw (untrimmed) markdown content of that step's
/// `prompt_ref` file. `project_as_authored` is the as-authored path read from
/// `context/binding.yml`'s `project:` field. `project_precondition_ok` is the result of the
/// caller's own filesystem check that this path (resolved against the project-dir) exists and
/// contains `wren_project.yml`.
pub fn compile(
    profile: &ProfileFile,
    components: &HashMap<String, ComponentFile>,
    project_as_authored: &str,
    project_precondition_ok: bool,
    step_contents: &HashMap<String, HashMap<String, String>>,
) -> Result<serde_json::Value, CompileError> {
    if !project_precondition_ok {
        return Err(CompileError(format!(
            "context precondition failed: {project_as_authored} is not a wren project"
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

        check_required_binds(component, mount)?;
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

        let node = serde_json::json!({
            "id": component.id,
            "verb": component.verb,
            "type": component.component_type,
            "realization_kind": realization_kind,
            "context_binding": context_binding,
            "precondition_result": {
                "status": "pass",
                "checks": ["project path exists and contains wren_project.yml"],
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
                "outcome": { "kind": component.effect.outcome.kind },
            },
        });
        component_nodes.push(node);
    }

    // POC scope: a single coarse context binding is shared by every mounted component, so the
    // top-level context_binding just mirrors the (first) component's binding_mode.
    let top_binding_mode = first_binding_mode.unwrap_or_default();

    Ok(serde_json::json!({
        "warble_ir_version": "0.2",
        "profile": profile.profile,
        "context_binding": {
            "project": project_as_authored,
            "binding_mode": top_binding_mode,
        },
        "config": {
            "tier_policy": profile.config.tier_policy,
        },
        "components": component_nodes,
    }))
}

fn check_required_binds(
    component: &ComponentFile,
    mount: &ProfileComponentMount,
) -> Result<(), CompileError> {
    for param in &component.params {
        if param.bind == "required" {
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

fn resolve_guardrails(
    component: &ComponentFile,
    mount: &ProfileComponentMount,
) -> Result<Vec<serde_json::Value>, CompileError> {
    let patches = mount.guardrails.as_ref();
    component
        .guardrails
        .iter()
        .map(|guardrail| {
            let patch = patches.and_then(|p| p.get(&guardrail.name));
            let mut locked = guardrail.locked;
            if let Some(patch) = patch {
                if guardrail.locked {
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
            Ok(node)
        })
        .collect()
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
            Ok(serde_json::json!({
                "name": step.name,
                "tier": tier,
                "consumes": step.consumes,
                "produces": step.produces,
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
