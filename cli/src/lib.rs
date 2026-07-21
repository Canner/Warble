//! `warble_cli` — the native host library behind the `warble` binary.
//!
//! Holds the pieces the binary and the golden integration tests share. The headline is
//! [`compile_project_to_ir`]: the real front-end host path — read a Warble project's files, build
//! the MDL [`ContextLoader`] over the bound wren project, and run the sans-IO core compiler with it
//! injected. (The binary's `dispatch`/`render`/`manifest`/`eval` subcommands stay in `main.rs`.)
//!
//! [`blast_radius_for_project`] reuses the same project-resolution path to answer a `blast_radius`
//! query without running a full compile — the host side of the `warble blast-radius` subcommand.
//!
//! Component *resolution* — turning a profile's `use: <id>` mount into a directory to read
//! `component.yml`/steps from — is entirely a host concern (see [`ComponentSource`] /
//! [`resolve_component_dir`]): the core compiler never touches a filesystem, it only ever sees the
//! already-resolved `HashMap<String, ComponentFile>` this module builds.

pub mod gate;

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};

use warble::{BindingFile, ComponentFile, ContextLoader, ProfileFile};
use warble_mdl_context::{read_project_dir, read_raw_dir, MdlContext, RawSourceContext};

/// The precedence class a [`ComponentSource`] belongs to. Precedence is a fixed rule *between*
/// kinds — `Local` always outranks `Hub` — not derived from the order sources happen to be listed
/// in. There is deliberately no rule *within* a kind: if the same component id is found in two
/// sources of the same kind, [`resolve_component_dir`] treats that as ambiguous rather than
/// guessing (e.g. "first in the list wins"), because nothing declares which of two equally-ranked
/// sources should win.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    /// A host- or product-specific component directory — e.g. a profile's own `components/`
    /// override, or an external component library a consumer mounts alongside the Hub. Wins over
    /// `Hub` whenever both define the same id.
    Local,
    /// The shared, generic Warble component library (this checkout's `hub/components`, or an
    /// externally-supplied equivalent). The fallback tier: consulted only for ids no `Local`
    /// source defines.
    Hub,
}

impl fmt::Display for SourceKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            SourceKind::Local => "local",
            SourceKind::Hub => "hub",
        })
    }
}

/// One explicitly-configured place a mounted component's files may live: `components_dir` is a
/// directory whose immediate children are `<id>/component.yml` (+ its `steps/*`). The host builds
/// the full ordered/kinded list up front (see [`compile_project_to_ir_with_sources`]) — resolution
/// never discovers sources on its own (no ancestor/filesystem-root walk).
#[derive(Debug, Clone)]
pub struct ComponentSource {
    pub kind: SourceKind,
    pub components_dir: PathBuf,
}

impl ComponentSource {
    pub fn local(components_dir: impl Into<PathBuf>) -> Self {
        ComponentSource {
            kind: SourceKind::Local,
            components_dir: components_dir.into(),
        }
    }

    pub fn hub(components_dir: impl Into<PathBuf>) -> Self {
        ComponentSource {
            kind: SourceKind::Hub,
            components_dir: components_dir.into(),
        }
    }

    fn candidate(&self, id: &str) -> PathBuf {
        self.components_dir.join(id)
    }
}

/// This checkout's own Hub component library — a fixed sibling of the `cli` crate's manifest dir,
/// known at compile time (`CARGO_MANIFEST_DIR`), never discovered by walking the filesystem at
/// runtime. This is what backs [`compile_project_to_ir`]'s default source list, so every in-repo
/// example/eval profile keeps resolving its Hub-mounted components exactly as before.
fn in_repo_hub_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("hub")
        .join("components")
}

/// The default two-source list used by [`compile_project_to_ir`]: the project's own `components/`
/// (`Local`, highest precedence — lets a profile deliberately diverge from the Hub, e.g. an
/// eval/demo substrate with intentionally different anatomy) plus this checkout's Hub (`Hub`,
/// fallback). A host mounting an *additional* local component library (e.g. a product-specific
/// one, alongside the Hub) extends this list — see [`compile_project_to_ir_with_sources`].
pub fn default_component_sources(project_dir: &Path) -> Vec<ComponentSource> {
    vec![
        ComponentSource::local(project_dir.join("components")),
        ComponentSource::hub(in_repo_hub_dir()),
    ]
}

/// Resolve where a mounted component's directory lives, against an explicit, ordered set of
/// sources — never by walking the filesystem. Within the highest-precedence [`SourceKind`] that
/// contains a match, exactly one source must define `id`; more than one is **ambiguous** (loud
/// fail — no rule picks between equally-ranked sources) and zero across every source is
/// **unresolved** (loud fail, listing everywhere it looked).
fn resolve_component_dir(sources: &[ComponentSource], id: &str) -> Result<PathBuf, String> {
    for kind in [SourceKind::Local, SourceKind::Hub] {
        let matches: Vec<&ComponentSource> = sources
            .iter()
            .filter(|source| source.kind == kind)
            .filter(|source| source.candidate(id).join("component.yml").is_file())
            .collect();

        match matches.as_slice() {
            [] => continue,
            [only] => return Ok(only.candidate(id)),
            many => {
                let dirs: Vec<String> = many
                    .iter()
                    .map(|s| s.candidate(id).display().to_string())
                    .collect();
                return Err(format!(
                    "component '{id}' is ambiguous: found in {} '{kind}' sources ({}) — no \
                     precedence rule distinguishes sources of the same kind",
                    many.len(),
                    dirs.join(", ")
                ));
            }
        }
    }

    let searched: Vec<String> = sources
        .iter()
        .map(|s| format!("{} ({})", s.kind, s.candidate(id).display()))
        .collect();
    Err(format!(
        "component '{id}' not found in any configured source: {}",
        searched.join("; ")
    ))
}

/// Resolve the `ContextLoader` for a bound project path by directory *shape*: an MDL wren project
/// (`wren_project.yml`) wins first; else a raw source (`schema.json`) — the constitutive family's
/// pre-MDL input; else an unparseable MDL context (existing fallback, loud-fails at compile).
fn resolve_context(resolved_project_path: &Path) -> Result<Box<dyn ContextLoader>, String> {
    if let Some(sources) = read_project_dir(resolved_project_path)
        .map_err(|e| format!("failed to read {}: {e}", resolved_project_path.display()))?
    {
        // Use the error-preserving `try_from_sources` (not `from_sources`) so a real assembly
        // failure's text survives into the `mdl_parseable` precondition message instead of being
        // silently dropped in favor of only the generic floor message.
        let context = match MdlContext::try_from_sources(&sources) {
            Ok(ctx) => ctx,
            Err(e) => MdlContext::unparseable_with_error(Some(e.to_string())),
        };
        return Ok(Box::new(context));
    }
    if let Some(raw) = read_raw_dir(resolved_project_path)
        .map_err(|e| format!("failed to read {}: {e}", resolved_project_path.display()))?
    {
        return Ok(Box::new(RawSourceContext::from_sources(&raw)));
    }
    Ok(Box::new(MdlContext::unparseable()))
}

/// Compile a Warble project directory into its IR JSON, using the real MDL `ContextLoader` over the
/// bound wren project and the default component source list (project-local `components/` + this
/// checkout's Hub — see [`default_component_sources`]). This is what every in-repo example/eval
/// profile and integration test compiles through.
pub fn compile_project_to_ir(project_dir: &Path) -> Result<serde_json::Value, String> {
    compile_project_to_ir_with_sources(project_dir, &default_component_sources(project_dir))
}

/// Compile a Warble project directory into its IR JSON, resolving mounted components against an
/// explicit, caller-supplied source list instead of the in-repo default (see [`ComponentSource`]).
/// This is the seam a host outside this checkout uses to mount its own local component library
/// alongside (or instead of) the Hub — e.g. `[ComponentSource::local(my_components),
/// ComponentSource::hub(path_to_warble_hub)]`. All filesystem reads happen here; the core compiler
/// stays sans-IO — it only ever receives the resolved `HashMap<String, ComponentFile>` built below.
pub fn compile_project_to_ir_with_sources(
    project_dir: &Path,
    sources: &[ComponentSource],
) -> Result<serde_json::Value, String> {
    let profile_path = project_dir.join("profile.yml");
    let profile: ProfileFile = serde_yaml::from_str(&read_file(&profile_path)?)
        .map_err(|e| format!("failed to parse {}: {e}", profile_path.display()))?;

    let binding_path = project_dir.join(&profile.context.project);
    let binding: BindingFile = serde_yaml::from_str(&read_file(&binding_path)?)
        .map_err(|e| format!("failed to parse {}: {e}", binding_path.display()))?;

    // Build the ContextLoader over the bound path, by shape: an MDL wren project, else a raw source
    // (constitutive family), else an unparseable context — which the compiler turns into a loud
    // precondition failure.
    let resolved_project_path = project_dir.join(&binding.project);
    let context = resolve_context(&resolved_project_path)?;

    let mut components: HashMap<String, ComponentFile> = HashMap::new();
    let mut step_contents: HashMap<String, HashMap<String, String>> = HashMap::new();

    for mount in &profile.components {
        let component_dir = resolve_component_dir(sources, &mount.use_id)?;
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
        context.as_ref(),
        &step_contents,
    )
    .map_err(|e| e.to_string())
}

fn read_file(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("failed to read {}: {e}", path.display()))
}

/// Compute the [`warble::BlastRadius`] of `node` in a Warble project's bound wren project. Resolves
/// the project the same way [`compile_project_to_ir`] does (profile.yml → context binding →
/// wren project → `MdlContext`), but stops short of a full compile — just the lineage query.
pub fn blast_radius_for_project(
    project_dir: &Path,
    node: &str,
) -> Result<warble::BlastRadius, String> {
    let profile_path = project_dir.join("profile.yml");
    let profile: ProfileFile = serde_yaml::from_str(&read_file(&profile_path)?)
        .map_err(|e| format!("failed to parse {}: {e}", profile_path.display()))?;

    let binding_path = project_dir.join(&profile.context.project);
    let binding: BindingFile = serde_yaml::from_str(&read_file(&binding_path)?)
        .map_err(|e| format!("failed to parse {}: {e}", binding_path.display()))?;

    let resolved_project_path = project_dir.join(&binding.project);
    let context = resolve_context(&resolved_project_path)?;

    if !context.is_parseable() {
        return Err(format!(
            "wren project at {} is not parseable — cannot compute blast radius",
            resolved_project_path.display()
        ));
    }

    Ok(context.lineage().blast_radius(node))
}

#[cfg(test)]
mod component_source_tests {
    use super::{resolve_component_dir, ComponentSource};
    use std::fs;
    use std::path::Path;

    /// Create `<dir>/<id>/component.yml` (contents are irrelevant — resolution only checks the
    /// file exists) so a source directory "defines" `id`.
    fn stub_component(dir: &Path, id: &str) {
        let component_dir = dir.join(id);
        fs::create_dir_all(&component_dir).unwrap();
        fs::write(component_dir.join("component.yml"), "id: placeholder\n").unwrap();
    }

    #[test]
    fn resolves_from_the_only_source_that_defines_it() {
        let hub = tempfile::tempdir().unwrap();
        stub_component(hub.path(), "answer_query");

        let sources = vec![ComponentSource::hub(hub.path())];
        let resolved = resolve_component_dir(&sources, "answer_query").unwrap();
        assert_eq!(resolved, hub.path().join("answer_query"));
    }

    #[test]
    fn local_overrides_hub_when_both_define_the_same_id() {
        let local = tempfile::tempdir().unwrap();
        let hub = tempfile::tempdir().unwrap();
        stub_component(local.path(), "answer_query");
        stub_component(hub.path(), "answer_query");

        let sources = vec![
            ComponentSource::local(local.path()),
            ComponentSource::hub(hub.path()),
        ];
        let resolved = resolve_component_dir(&sources, "answer_query").unwrap();
        assert_eq!(
            resolved,
            local.path().join("answer_query"),
            "a Local source must win over a Hub source defining the same id"
        );
    }

    #[test]
    fn falls_back_to_hub_when_local_does_not_define_the_id() {
        let local = tempfile::tempdir().unwrap();
        let hub = tempfile::tempdir().unwrap();
        stub_component(hub.path(), "answer_query");

        let sources = vec![
            ComponentSource::local(local.path()),
            ComponentSource::hub(hub.path()),
        ];
        let resolved = resolve_component_dir(&sources, "answer_query").unwrap();
        assert_eq!(resolved, hub.path().join("answer_query"));
    }

    #[test]
    fn unresolved_id_is_a_loud_fail_naming_every_source_searched() {
        let local = tempfile::tempdir().unwrap();
        let hub = tempfile::tempdir().unwrap();

        let sources = vec![
            ComponentSource::local(local.path()),
            ComponentSource::hub(hub.path()),
        ];
        let err = resolve_component_dir(&sources, "missing").unwrap_err();
        assert!(err.contains("missing"));
        assert!(err.contains(&local.path().display().to_string()));
        assert!(err.contains(&hub.path().display().to_string()));
    }

    #[test]
    fn same_id_in_two_same_kind_sources_is_ambiguous_not_first_match_wins() {
        let local_a = tempfile::tempdir().unwrap();
        let local_b = tempfile::tempdir().unwrap();
        stub_component(local_a.path(), "answer_query");
        stub_component(local_b.path(), "answer_query");

        let sources = vec![
            ComponentSource::local(local_a.path()),
            ComponentSource::local(local_b.path()),
        ];
        let err = resolve_component_dir(&sources, "answer_query").unwrap_err();
        assert!(err.contains("ambiguous"));
        assert!(err.contains(&local_a.path().display().to_string()));
        assert!(err.contains(&local_b.path().display().to_string()));
    }

    #[test]
    fn ambiguous_same_kind_sources_do_not_fall_through_to_a_lower_kind() {
        // Even though `hub` alone would resolve `answer_query` unambiguously, an ambiguous match
        // at the higher-precedence `Local` kind must fail loud rather than silently falling back.
        let local_a = tempfile::tempdir().unwrap();
        let local_b = tempfile::tempdir().unwrap();
        let hub = tempfile::tempdir().unwrap();
        stub_component(local_a.path(), "answer_query");
        stub_component(local_b.path(), "answer_query");
        stub_component(hub.path(), "answer_query");

        let sources = vec![
            ComponentSource::local(local_a.path()),
            ComponentSource::local(local_b.path()),
            ComponentSource::hub(hub.path()),
        ];
        let err = resolve_component_dir(&sources, "answer_query").unwrap_err();
        assert!(err.contains("ambiguous"));
    }
}
