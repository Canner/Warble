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
//! `resolve_component_dir`): the core compiler never touches a filesystem, it only ever sees the
//! already-resolved `HashMap<String, ComponentFile>` this module builds.
//!
//! This is the crate that becomes the `warble` binary itself — end users install just this one.
//! It links in both dispatcher back-ends (`warble-claude-code`, `warble-vercel`) and the
//! `warble-mdl-context` binding directly; none of those three crates is a standalone tool, and
//! `warble dispatch --target ...` simply selects which linked-in back-end handles the compiled
//! IR.

pub mod gate;
pub mod hub_fetch;

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};

use warble::{BindingFile, ComponentFile, ContextLoader, PreparedContext, ProfileFile};
use warble_claude_code::ir::SUPPORTED_IR_VERSION;
use warble_mdl_context::{read_project_dir, read_raw_dir, MdlContext, RawSourceContext};

/// The precedence class a [`ComponentSource`] belongs to. Precedence is a fixed rule *between*
/// kinds — `Local` always outranks `Hub` — not derived from the order sources happen to be listed
/// in. There is deliberately no rule *within* a kind: if the same component id is found in two
/// sources of the same kind, `resolve_component_dir` treats that as ambiguous rather than
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

/// The Hub source used when no `--hub-dir` override is given: this checkout's own
/// `hub/components/` if it exists on disk, otherwise the per-user cache of the Hub release
/// matching `hub_version` (or this binary's own version, when `hub_version` is `None`), fetching
/// it over the network first if the cache doesn't already hold a verified copy.
///
/// The in-repo check comes first and is unconditional: an in-repo Hub directory always wins and
/// never triggers a fetch, even when `hub_version` names a different version than this binary's
/// own — "there is a Hub checked out right here" is decisive, not one input among several. This is also what keeps every in-repo example/eval profile (and the CLI's own
/// integration tests) resolving offline, with no network access, when run from within this
/// checkout.
fn default_hub_source(hub_version: Option<&str>) -> Result<ComponentSource, String> {
    let in_repo = in_repo_hub_dir();
    if in_repo.is_dir() {
        return Ok(ComponentSource::hub(in_repo));
    }
    let version = hub_version.unwrap_or(env!("CARGO_PKG_VERSION"));
    let cached_dir = hub_fetch::ensure_cached_hub(version)?;
    Ok(ComponentSource::hub(cached_dir))
}

/// The default two-source list used by [`compile_project_to_ir`]: the project's own `components/`
/// (`Local`, highest precedence — lets a profile deliberately diverge from the Hub, e.g. an
/// eval/demo substrate with intentionally different anatomy) plus the Hub (`Hub`, fallback) — see
/// the crate's private `default_hub_source` helper for how the Hub source itself is resolved. A
/// host mounting an *additional* local component library (e.g. a product-specific one, alongside
/// the Hub) extends this list — see [`compile_project_to_ir_with_sources`].
///
/// Fallible since v0.7.0: resolving the Hub source can now require a network fetch (via that same
/// `default_hub_source` helper), which can fail. Callers that previously relied on this being
/// infallible need a `?` or `.expect(...)`.
pub fn default_component_sources(project_dir: &Path) -> Result<Vec<ComponentSource>, String> {
    default_component_sources_with_hub_version(project_dir, None)
}

/// Same as [`default_component_sources`], but lets the caller pick which Hub version to fetch
/// when default resolution needs the network (i.e. no in-repo `hub/components` on disk). This is
/// the seam the CLI's `--hub-version` flag threads through; `None` means "this binary's own
/// version", the ordinary default.
pub fn default_component_sources_with_hub_version(
    project_dir: &Path,
    hub_version: Option<&str>,
) -> Result<Vec<ComponentSource>, String> {
    Ok(vec![
        ComponentSource::local(project_dir.join("components")),
        default_hub_source(hub_version)?,
    ])
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

/// Turns a parsed `context/binding.yml` into the [`ContextLoader`] the compiler probes.
///
/// The counterpart of [`ComponentSource`] for context: components could already be supplied by a
/// host, context could not. A host implements this to bind a semantic layer this checkout cannot
/// read itself — one held by a service, for instance — without warble learning anything about it.
///
/// **A resolver is free to do no I/O at all, and `warble compile` must stay runnable offline and
/// without credentials.** A host binding a remote layer is expected to resolve from a snapshot it
/// pulled earlier, or to return a loader that declines the schema probes
/// (`ContextLoader::can_answer`) rather than reaching for the network mid-compile.
pub trait ContextResolver {
    /// Build the loader for `binding`. `project_dir` is the Warble project directory, so a resolver
    /// reading from disk can resolve a relative `binding.project` against it.
    fn resolve(
        &self,
        binding: &BindingFile,
        project_dir: &Path,
    ) -> Result<Box<dyn ContextLoader>, String>;
}

/// The context kinds this checkout resolves without help: `wren_project` and `raw_source` (read
/// natively), `external` (read nothing) and `prepared` (read a projection the host already
/// resolved). A host that needs another kind wraps this — delegating the ones it knows and
/// handling its own.
///
/// `prepared` is the kind that does not require warble to speak the semantic format at all, so a
/// host whose format has no adapter here binds through it rather than through a linked resolver —
/// which is the only option open to a host that drives `warble` as a subprocess.
pub struct BuiltinContextResolver;

impl ContextResolver for BuiltinContextResolver {
    fn resolve(
        &self,
        binding: &BindingFile,
        project_dir: &Path,
    ) -> Result<Box<dyn ContextLoader>, String> {
        // `external` names a layer that is not on this machine, so it must be resolved before any
        // path is built — joining a locator like `remote-service://analytics` onto a directory would produce
        // nonsense, and reading anything at all would break the offline guarantee.
        if binding.kind == BindingFile::EXTERNAL {
            return Ok(Box::new(warble::ExternalContext::new()));
        }
        // The remaining built-in kinds read a directory, so `project` is a path for them. A host
        // kind's `project` may be anything at all, which is why this resolution lives per-kind
        // rather than in the caller.
        let path = project_dir.join(&binding.project);
        match binding.kind.as_str() {
            BindingFile::WREN_PROJECT => {
                if let Some(sources) = read_project_dir(&path)
                    .map_err(|e| format!("failed to read {}: {e}", path.display()))?
                {
                    // Use the error-preserving `try_from_sources` (not `from_sources`) so a real
                    // assembly failure's text survives into the `mdl_parseable` precondition message
                    // instead of being silently dropped in favor of only the generic floor message.
                    return Ok(Box::new(match MdlContext::try_from_sources(&sources) {
                        Ok(ctx) => ctx,
                        Err(e) => MdlContext::unparseable_with_error(Some(e.to_string())),
                    }));
                }
                // Before kinds were declared, this directory would have been silently accepted as a
                // raw source. Guessing across kinds is exactly what declaring one is meant to stop,
                // so say what to write instead.
                if path.join("schema.json").is_file() {
                    return Err(format!(
                        "{} holds a raw source (schema.json), not a wren project — declare \
                         `kind: {}` in the binding to bind it",
                        path.display(),
                        BindingFile::RAW_SOURCE
                    ));
                }
                // No wren project and no raw source: an unparseable context, so the failure surfaces
                // as the `mdl_parseable` precondition rather than as an I/O error here.
                Ok(Box::new(MdlContext::unparseable()))
            }
            BindingFile::RAW_SOURCE => {
                let raw = read_raw_dir(&path)
                    .map_err(|e| format!("failed to read {}: {e}", path.display()))?
                    .ok_or_else(|| {
                        format!(
                            "binding declares `kind: {}` but {} has no schema.json",
                            BindingFile::RAW_SOURCE,
                            path.display()
                        )
                    })?;
                Ok(Box::new(RawSourceContext::from_sources(&raw)))
            }
            BindingFile::PREPARED => {
                // `project` stays what it is for every other kind: the bound layer's identity,
                // echoed into the IR and the `{{project}}` placeholder. The document is a separate
                // field, because pointing `project` at the file would put the file's name into
                // every prompt — telling the agent it works on a project called "context.json".
                let document_ref = binding
                    .extra
                    .get("document")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        format!(
                            "binding declares `kind: {}` but no `document:` — add the path to the \
                             prepared-context document the host wrote, and keep `project:` as the \
                             bound layer's name",
                            BindingFile::PREPARED
                        )
                    })?;
                let document_path = project_dir.join(document_ref);
                // A missing or malformed document is an error rather than an unparseable context:
                // the binding named a file the host was supposed to write, so its absence is a
                // broken pipeline, not a project without a semantic layer.
                let document = std::fs::read_to_string(&document_path)
                    .map_err(|e| format!("failed to read {}: {e}", document_path.display()))?;
                let context = PreparedContext::from_json(&document)
                    .map_err(|e| format!("{}: {e}", document_path.display()))?;
                Ok(Box::new(context))
            }
            other => Err(format!(
                "unknown context kind '{other}' (this build resolves '{}', '{}', '{}' and '{}'). A \
                 host that defines '{other}' must supply a ContextResolver for it — see \
                 `compile_project_to_ir_with`.",
                BindingFile::WREN_PROJECT,
                BindingFile::RAW_SOURCE,
                BindingFile::EXTERNAL,
                BindingFile::PREPARED
            )),
        }
    }
}

/// Compile a Warble project directory into its IR JSON, using the real MDL `ContextLoader` over the
/// bound wren project and the default component source list (project-local `components/` + this
/// checkout's Hub — see [`default_component_sources`]). This is what every in-repo example/eval
/// profile and integration test compiles through.
pub fn compile_project_to_ir(project_dir: &Path) -> Result<serde_json::Value, String> {
    compile_project_to_ir_with_sources(project_dir, &default_component_sources(project_dir)?)
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
    compile_project_to_ir_with(project_dir, sources, &BuiltinContextResolver)
}

/// As [`compile_project_to_ir_with_sources`], resolving the context binding through a
/// caller-supplied [`ContextResolver`] instead of [`BuiltinContextResolver`]. This is the seam a
/// host uses to bind a context kind this checkout cannot read — the context-side counterpart of
/// passing your own [`ComponentSource`] list.
pub fn compile_project_to_ir_with(
    project_dir: &Path,
    sources: &[ComponentSource],
    resolver: &dyn ContextResolver,
) -> Result<serde_json::Value, String> {
    let profile_path = project_dir.join("profile.yml");
    let profile: ProfileFile = serde_yaml::from_str(&read_file(&profile_path)?)
        .map_err(|e| format!("failed to parse {}: {e}", profile_path.display()))?;

    let binding_path = project_dir.join(&profile.context.project);
    let binding: BindingFile = serde_yaml::from_str(&read_file(&binding_path)?)
        .map_err(|e| format!("failed to parse {}: {e}", binding_path.display()))?;

    let context = resolver.resolve(&binding, project_dir)?;

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
    blast_radius_for_project_with(project_dir, node, &BuiltinContextResolver)
}

/// As [`blast_radius_for_project`], resolving the context binding through a caller-supplied
/// [`ContextResolver`]. Kept in step with [`compile_project_to_ir_with`] so a host kind is bindable
/// on both paths — a lineage query over a context only the host can load is no less valid than a
/// compile over it.
pub fn blast_radius_for_project_with(
    project_dir: &Path,
    node: &str,
    resolver: &dyn ContextResolver,
) -> Result<warble::BlastRadius, String> {
    let profile_path = project_dir.join("profile.yml");
    let profile: ProfileFile = serde_yaml::from_str(&read_file(&profile_path)?)
        .map_err(|e| format!("failed to parse {}: {e}", profile_path.display()))?;

    let binding_path = project_dir.join(&profile.context.project);
    let binding: BindingFile = serde_yaml::from_str(&read_file(&binding_path)?)
        .map_err(|e| format!("failed to parse {}: {e}", binding_path.display()))?;

    let context = resolver.resolve(&binding, project_dir)?;

    if !context.is_parseable() {
        return Err(format!(
            "bound context '{}' is not parseable — cannot compute blast radius",
            binding.project
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

/// `warble_eval_runner::ComplianceIr` (the type `eval compliance` deserializes into) is
/// *deliberately* narrower than `WarbleIr` — its own doc comment says so, so a compiled-in
/// `warble_ir_version` field never belongs on that type. But `eval compliance` is not fed an
/// arbitrary subset: every real caller hands it the same complete `ir.json` `dispatch`/`manifest`
/// consume (confirmed by `eval/golden/compliance/ground_truth.yaml`'s own comment — its two golden
/// IRs, `examples/mutate-agent/ir.golden.json` and `examples/analysis-agent/ir.golden.json`, are "reused
/// as-is, not new fixtures"). So the version gate belongs here, at the CLI boundary, checked on the
/// raw JSON before `ComplianceIr` ever sees it — against the same
/// `warble_claude_code::ir::SUPPORTED_IR_VERSION` that the binary's own `load_ir` already gates
/// `dispatch`/`manifest` against, so every CLI-level IR consumer rejects an out-of-range version
/// the same way.
pub fn check_compliance_ir_version(raw: &str, path: &Path) -> Result<(), String> {
    let parsed: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
        format!(
            "failed to parse IR {} for version check: {e}",
            path.display()
        )
    })?;
    // Absent and present-but-not-a-string are reported separately on purpose: collapsing them sends
    // someone whose IR *does* carry the field looking for a missing key that is right there.
    match parsed.get("warble_ir_version") {
        None => Err(format!(
            "IR {} has no warble_ir_version field — eval compliance requires a complete compiled \
             IR, not a hand-written subset",
            path.display()
        )),
        Some(serde_json::Value::String(v)) if v == SUPPORTED_IR_VERSION => Ok(()),
        Some(serde_json::Value::String(v)) => Err(format!(
            "unsupported warble_ir_version '{v}' in {} (eval compliance understands: {SUPPORTED_IR_VERSION})",
            path.display()
        )),
        Some(other) => Err(format!(
            "warble_ir_version in {} is {}, not a string — eval compliance understands: \
             {SUPPORTED_IR_VERSION}",
            path.display(),
            match other {
                serde_json::Value::Null => "null",
                serde_json::Value::Bool(_) => "a boolean",
                serde_json::Value::Number(_) => "a number",
                serde_json::Value::Array(_) => "an array",
                _ => "an object",
            }
        )),
    }
}

#[cfg(test)]
mod compliance_ir_version_tests {
    use super::{check_compliance_ir_version, SUPPORTED_IR_VERSION};
    use std::path::Path;

    fn check(raw: &str) -> Result<(), String> {
        check_compliance_ir_version(raw, Path::new("ir.json"))
    }

    #[test]
    fn the_supported_version_passes() {
        let raw = format!(r#"{{"warble_ir_version": "{SUPPORTED_IR_VERSION}", "components": []}}"#);
        assert!(check(&raw).is_ok(), "got: {:?}", check(&raw));
    }

    #[test]
    fn a_missing_field_is_reported_as_missing() {
        let err = check(r#"{"components": []}"#).expect_err("must reject");
        assert!(err.contains("has no warble_ir_version"), "got: {err}");
    }

    #[test]
    fn an_out_of_range_version_is_reported_as_unsupported() {
        let err = check(r#"{"warble_ir_version": "0.2", "components": []}"#).expect_err("reject");
        assert!(
            err.contains("unsupported warble_ir_version '0.2'"),
            "got: {err}"
        );
        assert!(
            err.contains(SUPPORTED_IR_VERSION),
            "must name what it does accept: {err}"
        );
    }

    #[test]
    fn a_version_that_merely_starts_with_the_supported_one_is_rejected() {
        // Guards against a `starts_with` regression: "0.30" is not "0.3".
        let raw = format!(r#"{{"warble_ir_version": "{SUPPORTED_IR_VERSION}0"}}"#);
        let err = check(&raw).expect_err("a superstring is a different version");
        assert!(err.contains("unsupported warble_ir_version"), "got: {err}");
    }

    /// The matrix this module exists for: every non-string JSON type must be reported as a *type*
    /// error naming what it actually is — never as "the field is missing", which would send someone
    /// looking for a key that is sitting right there. `null` is the one that regressed before.
    #[test]
    fn every_non_string_type_is_reported_as_a_type_error() {
        for (literal, expected) in [
            ("null", "is null"),
            ("true", "is a boolean"),
            ("3", "is a number"),
            ("[]", "is an array"),
            ("{}", "is an object"),
        ] {
            let raw = format!(r#"{{"warble_ir_version": {literal}}}"#);
            let err = check(&raw).expect_err(&format!("{literal} must be rejected"));
            assert!(
                err.contains(expected),
                "for {literal} expected '{expected}', got: {err}"
            );
            assert!(
                !err.contains("has no warble_ir_version"),
                "for {literal} the field is present, not missing: {err}"
            );
        }
    }

    #[test]
    fn unparseable_json_is_reported_as_a_parse_failure() {
        let err = check("not json at all").expect_err("must reject");
        assert!(err.contains("failed to parse IR"), "got: {err}");
    }
}
