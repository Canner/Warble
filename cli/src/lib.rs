//! `warble_cli` — the native host library behind the `warble` binary.
//!
//! Holds the pieces the binary and the golden integration tests share. The headline is
//! [`compile_project_to_ir`]: the real front-end host path — read a Warble project's files, build
//! the MDL [`ContextLoader`] over the bound wren project, and run the sans-IO core compiler with it
//! injected. (The binary's `dispatch`/`render`/`manifest`/`eval` subcommands stay in `main.rs`.)

use std::collections::HashMap;
use std::path::Path;

use warble::{BindingFile, ComponentFile, ProfileFile};
use warble_mdl_context::{read_project_dir, MdlContext};

/// Compile a Warble project directory into its IR JSON, using the real MDL `ContextLoader` over the
/// bound wren project. This is the host side of the front-end: all filesystem reads happen here;
/// the core compiler stays sans-IO.
pub fn compile_project_to_ir(project_dir: &Path) -> Result<serde_json::Value, String> {
    let profile_path = project_dir.join("profile.yml");
    let profile: ProfileFile = serde_yaml::from_str(&read_file(&profile_path)?)
        .map_err(|e| format!("failed to parse {}: {e}", profile_path.display()))?;

    let binding_path = project_dir.join(&profile.context.project);
    let binding: BindingFile = serde_yaml::from_str(&read_file(&binding_path)?)
        .map_err(|e| format!("failed to parse {}: {e}", binding_path.display()))?;

    // Build the MDL ContextLoader over the bound wren project. A missing/unreadable project yields
    // an unparseable context, which the compiler turns into a loud precondition failure.
    let resolved_project_path = project_dir.join(&binding.project);
    let context = match read_project_dir(&resolved_project_path)
        .map_err(|e| format!("failed to read {}: {e}", resolved_project_path.display()))?
    {
        Some(sources) => MdlContext::from_sources(&sources),
        None => MdlContext::unparseable(),
    };

    let mut components: HashMap<String, ComponentFile> = HashMap::new();
    let mut step_contents: HashMap<String, HashMap<String, String>> = HashMap::new();

    for mount in &profile.components {
        let component_dir = project_dir.join("components").join(&mount.use_id);
        let component_path = component_dir.join("component.yml");
        let component: ComponentFile = serde_yaml::from_str(&read_file(&component_path)?)
            .map_err(|e| format!("failed to parse {}: {e}", component_path.display()))?;

        let mut steps: HashMap<String, String> = HashMap::new();
        for step in &component.llm_steps {
            let step_path = component_dir.join(&step.prompt_ref);
            steps.insert(step.name.clone(), read_file(&step_path)?);
        }
        step_contents.insert(component.id.clone(), steps);
        components.insert(component.id.clone(), component);
    }

    warble::compile(
        &profile,
        &components,
        &binding.project,
        &context,
        &step_contents,
    )
    .map_err(|e| e.to_string())
}

fn read_file(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("failed to read {}: {e}", path.display()))
}
