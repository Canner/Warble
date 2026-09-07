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
pub mod overlay;

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use warble::{
    read_raw_dir, BindingFile, ComponentFile, ContextLoader, PreparedContext, ProfileFile,
    RawSourceContext,
};
use warble_claude_code::ir::SUPPORTED_IR_VERSION;
use warble_mdl_context::{read_project_dir, MdlContext};

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
    compile_project_to_ir_with_overlay(project_dir, sources, resolver, None)
}

/// As [`compile_project_to_ir_with`], additionally applying an overlay document to the parsed
/// profile before compiling — see [`crate::overlay`] for what a patch may touch and why.
///
/// The overlay is applied here, between parsing `profile.yml` and resolving the mounted
/// components, for two reasons that are easy to get wrong: a patch may add a mount, whose
/// `component.yml` must therefore still be read; and every compile-time check then runs against
/// the patched profile without any of them having to know a patch happened. The capability
/// ceiling is the case that matters — it is enforced per mount, so a patch mounting a behavior
/// the profile does not permit is refused with no ordering rule arranged for it.
///
/// `None` is exactly the previous behavior, which is why the three entry points above delegate
/// here rather than duplicating the body.
pub fn compile_project_to_ir_with_overlay(
    project_dir: &Path,
    sources: &[ComponentSource],
    resolver: &dyn ContextResolver,
    overlay_path: Option<&Path>,
) -> Result<serde_json::Value, String> {
    compile_project_to_ir_with_assets(project_dir, sources, resolver, overlay_path)
        .map(|(ir, _)| ir)
}

/// A component's asset content, keyed by component id, each entry the authored relative path and
/// the file's bytes.
///
/// Exists because compile is the only place that holds this: the compiler is sans-IO, and a
/// dispatch has no component directory to re-read. See [`write_assets`].
pub type CompiledAssets = std::collections::BTreeMap<String, Vec<(String, Vec<u8>)>>;

/// Compile, and also hand back the asset content the manifest names.
///
/// The extra return value is what makes an IR's assets transportable. Callers that do not need it
/// use [`compile_project_to_ir_with_overlay`], which drops it.
pub fn compile_project_to_ir_with_assets(
    project_dir: &Path,
    sources: &[ComponentSource],
    resolver: &dyn ContextResolver,
    overlay_path: Option<&Path>,
) -> Result<(serde_json::Value, CompiledAssets), String> {
    let mut collected_assets: CompiledAssets = CompiledAssets::new();
    let profile_path = project_dir.join("profile.yml");
    let mut profile: ProfileFile = serde_yaml::from_str(&read_file(&profile_path)?)
        .map_err(|e| format!("failed to parse {}: {e}", profile_path.display()))?;

    if let Some(path) = overlay_path {
        let overlay = overlay::read_overlay(path)?;
        overlay::apply_overlay(&mut profile, &overlay)?;
    }

    let binding_path = project_dir.join(&profile.context.project);
    let binding: BindingFile = serde_yaml::from_str(&read_file(&binding_path)?)
        .map_err(|e| format!("failed to parse {}: {e}", binding_path.display()))?;

    let context = resolver.resolve(&binding, project_dir)?;

    let mut components: HashMap<String, ComponentFile> = HashMap::new();
    let mut step_contents: HashMap<String, HashMap<String, String>> = HashMap::new();
    // A profile-level slot's variants resolve against the profile's own directory, which is the
    // project dir — the same shared rule component-level references follow, with the base dir
    // being whatever owns the declaration.
    let mut profile_slots: HashMap<String, HashMap<String, String>> = HashMap::new();
    for slot in &profile.slots {
        let mut variants: HashMap<String, String> = HashMap::new();
        for (key, reference) in &slot.variants {
            let label = format!("profile slot '{}' variant '{}'", slot.name, key);
            let variant_path = resolve_file_ref(project_dir, reference, &label)?;
            variants.insert(key.clone(), read_file(&variant_path)?);
        }
        profile_slots.insert(slot.name.clone(), variants);
    }
    let mut slot_contents = warble::SlotContents {
        profile: profile_slots,
        ..Default::default()
    };

    for mount in &profile.components {
        let component_dir = resolve_component_dir(sources, &mount.use_id)?;
        let component_path = component_dir.join("component.yml");
        let mut component: ComponentFile = serde_yaml::from_str(&read_file(&component_path)?)
            .map_err(|e| format!("failed to parse {}: {e}", component_path.display()))?;

        let mut steps: HashMap<String, String> = HashMap::new();
        for step in &component.llm_steps {
            let step_path = resolve_file_ref(&component_dir, &step.prompt_ref, "prompt_ref")?;
            steps.insert(step.name.clone(), read_file(&step_path)?);
        }
        step_contents.insert(component.id.clone(), steps);

        // Slot variants are prompt text, so they are read here and travel into the IR — the same
        // treatment `prompt_ref` gets, through the same resolution rule, because core never opens
        // a file itself.
        let mut slots: HashMap<String, HashMap<String, String>> = HashMap::new();
        for slot in &component.slots {
            let mut variants: HashMap<String, String> = HashMap::new();
            for (key, reference) in &slot.variants {
                let label = format!("slot '{}' variant '{}'", slot.name, key);
                let variant_path = resolve_file_ref(&component_dir, reference, &label)?;
                variants.insert(key.clone(), read_file(&variant_path)?);
            }
            slots.insert(slot.name.clone(), variants);
        }
        if !slots.is_empty() {
            slot_contents.components.insert(component.id.clone(), slots);
        }

        // Assets are never read into the IR — only their identity (hash + size) is, and core never
        // opens a file itself, so both are computed here before the declaration reaches `compile`.
        //
        // The bytes are kept rather than dropped. This is the only place that has them: `core` is
        // sans-IO, and by dispatch there is no component directory at all — a Hub component was
        // resolved over the network here, possibly on another machine. So the content has to leave
        // compile alongside the IR or it cannot reach a runtime. See decision-101.
        for asset in &mut component.assets {
            let asset_path = resolve_file_ref(&component_dir, &asset.path, "asset")?;
            let data = read_file_bytes(&asset_path)?;
            asset.bytes = Some(data.len() as u64);
            asset.hash = Some(format!("sha256:{:x}", Sha256::digest(&data)));
            collected_assets
                .entry(component.id.clone())
                .or_default()
                .push((asset.path.clone(), data));
        }

        components.insert(component.id.clone(), component);
    }

    let ir = warble::compile(
        &profile,
        &components,
        &binding.project,
        context.as_ref(),
        &step_contents,
        &slot_contents,
    )
    .map_err(|e| e.to_string())?;
    Ok((ir, collected_assets))
}

/// The directory an IR's assets live in, derived from the IR's own path.
///
/// A sibling rather than a path recorded inside the IR: the IR is a portable document and should not
/// carry a filesystem location that stops being true the moment it is copied. Both dispatch surfaces
/// already receive the IR path, so both can derive this.
pub fn asset_dir_for_ir(ir_path: &Path) -> PathBuf {
    let name = ir_path
        .file_stem()
        .map(|stem| format!("{}.assets", stem.to_string_lossy()))
        .unwrap_or_else(|| "ir.assets".to_string());
    ir_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(name)
}

/// Write compiled asset content under `root`, as `<root>/<component-id>/<authored path>`.
///
/// Nothing is created when no component declares an asset, so a project without assets emits exactly
/// what it emitted before this existed.
pub fn write_assets(root: &Path, assets: &CompiledAssets) -> Result<(), String> {
    if assets.is_empty() {
        return Ok(());
    }
    // The root is this function's own output directory, created here rather than incidentally by
    // the first file's parent. It has to exist before any containment check, since resolving a
    // location is relative to a real root — and creating the directory it was told to write into is
    // not the same as following a symlink out of it.
    //
    // `root` itself is a **caller-trusted anchor**, not something the containment check can validate:
    // if it is already a symlink to somewhere else, `create_dir_all` is a no-op, canonicalization
    // resolves through it, and every per-file check then measures containment against that resolved
    // location. `out_dir`/`cwd` in `land_assets` have the identical property. Reaching it needs write
    // access to the exact path before this runs, which is a weaker threat model than the "an IR
    // arrives from anywhere" one governing the manifest — stated here so the question is not
    // rediscovered as a surprise.
    std::fs::create_dir_all(root)
        .map_err(|e| format!("failed to create {}: {e}", root.display()))?;
    for (component_id, files) in assets {
        for (relative, data) in files {
            assert_contained_relative_path(relative, component_id)?;
            let target = root.join(component_id).join(relative);
            // Checked before ANY filesystem effect. An earlier version created the parent first so
            // canonicalization had something to resolve, which meant a symlinked component
            // directory got a directory created through it before the check refused the write —
            // "refused rather than followed" has to include not creating anything either.
            // `assert_resolves_inside` walks to the nearest existing ancestor, so it needs nothing
            // to have been created.
            assert_resolves_inside(root, &target, "asset target")?;
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
            }
            std::fs::write(&target, data)
                .map_err(|e| format!("failed to write {}: {e}", target.display()))?;
        }
    }
    Ok(())
}

fn read_file(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("failed to read {}: {e}", path.display()))
}

/// Reads a file as raw bytes, for content that is fingerprinted rather than rendered. An asset may
/// be a binary (an image, a font, an archive), so it cannot go through [`read_file`]'s UTF-8
/// decode — and it never needs to, since only its hash and size reach the IR.
fn read_file_bytes(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("failed to read {}: {e}", path.display()))
}

/// Resolves a file reference the same way `prompt_ref` does today (and, by convention,
/// `eval.template_ref`): relative to the directory that owns it — a component directory for
/// `prompt_ref`, and, for a future profile-level slot, the profile directory. This is the one
/// shared rule every resolved-file-reference field should follow, loudly, at compile time:
///
/// - the reference must stay inside `base_dir` — an absolute path, or one containing a `..`
///   segment, is rejected rather than silently escaping `base_dir` (`PathBuf::join` alone allows
///   both: joining an absolute path replaces the base entirely, and `..` segments are never
///   normalized away);
/// - the resolved path must name a file that exists on disk — a missing file is a compile-time
///   error, never a silent skip.
///
/// `label` names the kind of reference in the error message (e.g. `"prompt_ref"`), so this
/// function stays generic: it never needs to know about `LlmStep`, `EvalSpec`, or any future
/// slot/asset field.
///
/// Two different kinds of future callers are expected to reuse this function unchanged, and they
/// differ only in what they do with the `Ok(PathBuf)` it returns:
///
/// - a **slot variant** reads the resolved file's *content* into the IR, exactly like `prompt_ref`
///   does today (see the call site in [`compile_project_to_ir_with`]);
/// - an **asset** only needs the existence check this function already performs — the resolved
///   path becomes a manifest entry (a file that must exist on disk at render/dispatch time), and
///   its content is never read into the IR.
fn resolve_file_ref(base_dir: &Path, reference: &str, label: &str) -> Result<PathBuf, String> {
    let ref_path = Path::new(reference);
    if ref_path.is_absolute()
        || ref_path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!(
            "{label} '{reference}' must be a relative path inside its own directory (no '..' or absolute paths)"
        ));
    }
    let resolved = base_dir.join(ref_path);
    if !resolved.is_file() {
        return Err(format!(
            "{label} '{reference}' does not exist: {}",
            resolved.display()
        ));
    }
    Ok(resolved)
}

#[cfg(test)]
mod resolve_file_ref_tests {
    use super::resolve_file_ref;

    #[test]
    fn accepts_a_relative_path_to_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("ask.md"), "Ask something.\n").unwrap();

        let resolved = resolve_file_ref(dir.path(), "ask.md", "prompt_ref").unwrap();

        assert_eq!(resolved, dir.path().join("ask.md"));
    }

    #[test]
    fn accepts_a_relative_path_in_a_subdirectory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("steps")).unwrap();
        std::fs::write(dir.path().join("steps/ask.md"), "Ask something.\n").unwrap();

        let resolved = resolve_file_ref(dir.path(), "steps/ask.md", "prompt_ref").unwrap();

        assert_eq!(resolved, dir.path().join("steps/ask.md"));
    }

    #[test]
    fn rejects_a_dotdot_escape() {
        let dir = tempfile::tempdir().unwrap();

        let err = resolve_file_ref(dir.path(), "../secrets.md", "prompt_ref").unwrap_err();

        assert!(err.contains("prompt_ref"));
        assert!(err.contains("../secrets.md"));
        assert!(err.contains(".."));
    }

    #[test]
    fn rejects_a_dotdot_segment_in_the_middle_of_the_path() {
        let dir = tempfile::tempdir().unwrap();

        let err = resolve_file_ref(dir.path(), "steps/../../escape.md", "prompt_ref").unwrap_err();

        assert!(err.contains("steps/../../escape.md"));
    }

    #[test]
    fn rejects_an_absolute_path() {
        let dir = tempfile::tempdir().unwrap();

        let err = resolve_file_ref(dir.path(), "/etc/passwd", "prompt_ref").unwrap_err();

        assert!(err.contains("prompt_ref"));
        assert!(err.contains("/etc/passwd"));
    }

    #[test]
    fn rejects_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();

        let err = resolve_file_ref(dir.path(), "steps/missing.md", "prompt_ref").unwrap_err();

        assert!(err.contains("prompt_ref"));
        assert!(err.contains("steps/missing.md"));
        assert!(err.contains("does not exist"));
    }
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

/// Land the assets an IR's components declare into `out_dir`, verifying each against its manifest.
///
/// **Why this exists.** IR 0.7 lets a component declare the files it needs and compile records their
/// identity, but nothing consumed that manifest: a component declared its files and the agent then
/// ran in a directory that did not contain them, with no error at all. Landing them is what makes
/// the declaration mean something.
///
/// Content comes from the directory compile wrote beside the IR ([`asset_dir_for_ir`]) — compile is
/// the only place that has it, since the compiler is sans-IO and a Hub component was resolved over
/// the network there. See decision-101.
///
/// **Both failure modes are loud.** A manifest entry with no file in the asset directory, and one
/// whose content does not hash to the recorded value, each stop the dispatch. Silence is the bug
/// being fixed, and a half-landed asset set is harder to diagnose than a refusal.
pub fn land_assets(
    ir: &serde_json::Value,
    ir_path: &Path,
    out_dir: &Path,
) -> Result<Vec<PathBuf>, String> {
    let source_root = asset_dir_for_ir(ir_path);
    // Read and verify EVERY asset before writing any of them. Writing as each one verifies would
    // leave a component's earlier files on disk when a later one fails — a half-landed set, which
    // this function's contract and `docs/spec/ir-schema.md` both promise not to produce. That
    // promise was prose before it was code: a fixture declaring one asset per component cannot tell
    // the two apart.
    let mut pending: Vec<(PathBuf, Vec<u8>)> = Vec::new();
    let Some(components) = ir.get("components").and_then(|c| c.as_array()) else {
        return Ok(Vec::new());
    };
    for node in components {
        let component_id = node
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("<unnamed>");
        let Some(assets) = node.get("assets").and_then(|a| a.as_array()) else {
            continue;
        };
        for asset in assets {
            let relative = asset.get("path").and_then(|v| v.as_str()).ok_or_else(|| {
                format!("component '{component_id}' has an asset with no path in the manifest")
            })?;
            let expected = asset.get("hash").and_then(|v| v.as_str()).ok_or_else(|| {
                format!(
                    "asset '{relative}' of component '{component_id}' has no hash in the manifest"
                )
            })?;
            // The manifest is re-validated here, not trusted. Compile checks the *authored*
            // reference against the component directory, but an IR is a document that can arrive
            // from anywhere, and by this point nothing has looked at the path again. Without this,
            // a manifest entry of `../../../etc/whatever` is an arbitrary file write.
            assert_contained_relative_path(relative, component_id)?;
            let source = source_root.join(component_id).join(relative);
            // Everything about the source is decided before it is opened. Ordering here has bitten
            // twice: checking containment first masked an absent travelling directory with a
            // resolution error, and reading first let a FIFO planted at a declared path hang the
            // read forever — before any check could refuse it, and for an in-root path the symlink
            // check cannot help with. So: existence, then location, then file kind, then read.
            let metadata = std::fs::symlink_metadata(&source).map_err(|e| {
                format!(
                    "asset '{relative}' of component '{component_id}' is declared in the IR but \
                     missing from {}: {e}. An IR's assets travel in that directory; copying the IR \
                     without it leaves a component without the files it declared.",
                    source_root.display()
                )
            })?;
            assert_resolves_inside(&source_root, &source, "asset source")?;
            if !source
                .metadata()
                .map_err(|e| format!("failed to inspect {}: {e}", source.display()))?
                .is_file()
            {
                let message = [
                    format!("asset '{relative}' of component '{component_id}' is not a regular"),
                    format!("file (found {:?}).", metadata.file_type()),
                    "Reading a pipe or device would block the dispatch indefinitely instead of"
                        .to_string(),
                    "failing, so anything that is not a plain file is refused.".to_string(),
                ]
                .join(" ");
                return Err(message);
            }
            let data = std::fs::read(&source)
                .map_err(|e| format!("failed to read {}: {e}", source.display()))?;
            let actual = format!("sha256:{:x}", Sha256::digest(&data));
            if actual != expected {
                return Err(format!(
                    "asset '{relative}' of component '{component_id}' does not match its manifest \
                     (expected {expected}, found {actual}). The file changed after the IR was \
                     compiled; recompile rather than dispatching content the manifest does not name."
                ));
            }
            let target = out_dir.join(relative);
            assert_resolves_inside(out_dir, &target, "asset target")?;
            pending.push((target, data));
        }
    }

    let mut landed = Vec::with_capacity(pending.len());
    for (target, data) in pending {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
        }
        std::fs::write(&target, &data)
            .map_err(|e| format!("failed to write {}: {e}", target.display()))?;
        landed.push(target);
    }
    Ok(landed)
}

/// Refuse a manifest path that is absolute or that climbs out of the directory it is joined to.
///
/// Mirrors the compile-time rule in [`resolve_file_ref`], and for the same reason: `PathBuf::join`
/// alone allows both escapes — joining an absolute path replaces the base entirely, and `..`
/// segments are never normalized away. The check has to exist on both sides because compile validates
/// what an author wrote while this validates what a manifest says, and those are different documents.
fn assert_contained_relative_path(relative: &str, component_id: &str) -> Result<(), String> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        let message = [
            format!("asset path '{relative}' of component '{component_id}' must be a relative"),
            "path with no '..' segments. A manifest naming a path outside the directory it"
                .to_string(),
            "lands in would be an arbitrary file write, so it is refused rather than".to_string(),
            "resolved.".to_string(),
        ]
        .join(" ");
        return Err(message);
    }
    Ok(())
}

/// Confirm a path still resolves inside `root` once the filesystem has had its say.
///
/// The string check above is not enough on its own, and this is the second half of the same lesson:
/// it inspects what the manifest *says*, and a syntactically clean relative path — no `..`, not
/// absolute — still escapes when a component of it is a symlink pointing elsewhere. That is
/// reachable: the Agent SDK back-end's working directory is the bound project, a real directory
/// somebody else may have written to, and a CLI `out_dir` may hold whatever a previous step left.
///
/// `target` need not exist yet: the nearest existing ancestor is canonicalized and checked, and the
/// segments below it cannot be a symlink because nothing has created them. `root` must exist.
fn assert_resolves_inside(root: &Path, target: &Path, what: &str) -> Result<(), String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("failed to resolve {}: {e}", root.display()))?;

    let mut existing = target;
    let anchor = loop {
        if existing.exists() {
            break existing
                .canonicalize()
                .map_err(|e| format!("failed to resolve {}: {e}", existing.display()))?;
        }
        match existing.parent() {
            Some(parent) => existing = parent,
            None => {
                return Err(format!(
                    "{what} '{}' has no resolvable ancestor",
                    target.display()
                ))
            }
        }
    };

    if !anchor.starts_with(&canonical_root) {
        let message = [
            format!(
                "{what} '{}' resolves outside {}",
                target.display(),
                canonical_root.display()
            ),
            "once symlinks are followed. A path that looks contained but is not is refused rather"
                .to_string(),
            "than followed, because the manifest is data and the filesystem is what decides where"
                .to_string(),
            "a write actually lands.".to_string(),
        ]
        .join(" ");
        return Err(message);
    }
    Ok(())
}
