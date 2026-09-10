//! The declared context `kind` and the host-injectable [`ContextResolver`] seam.
//!
//! Before `kind`, which adapter a binding wanted was *inferred* from the bound directory's shape,
//! which cannot express a context that is not a directory — a semantic layer held by a service, for
//! instance. These tests pin both halves of the fix: that a host kind resolves through a supplied
//! resolver with no filesystem involvement at all, and that a loader which declines the schema
//! probes reports "cannot be evaluated" rather than the flatly wrong "not satisfied".
//!
//! The offline guarantee is load-bearing, not incidental: `warble compile` must stay runnable
//! without network access or credentials, so the seam never obliges a resolver to fetch anything.

use std::fs;
use std::path::Path;

use warble::{BindingFile, ContextLoader, DimensionInfo, LineageGraph, MetricInfo, ModelInfo};
use warble_cli::{
    compile_project_to_ir, compile_project_to_ir_with, default_component_sources,
    BuiltinContextResolver, ContextResolver,
};

// --- fixtures -------------------------------------------------------------------------------

/// A one-component Warble project whose binding body and component preconditions are the variables.
/// `binding_body` is written verbatim so a test can omit `kind:` entirely (the backward-compat case).
fn write_project(dir: &Path, binding_body: &str, preconditions: &str) {
    fs::create_dir_all(dir.join("context")).unwrap();
    fs::create_dir_all(dir.join("components/asker/steps")).unwrap();
    fs::write(
        dir.join("profile.yml"),
        "profile: fixture\ncontext:\n  project: ./context/binding.yml\ncomponents:\n  - use: asker\n",
    )
    .unwrap();
    fs::write(dir.join("context/binding.yml"), binding_body).unwrap();
    fs::write(
        dir.join("components/asker/component.yml"),
        format!(
            r#"
id: asker
verb: asker
type: analytical
realization_kind: skill
binding_mode: runtime_selected
context_precondition:
{preconditions}
params: []
llm_steps:
  - {{ name: ask, tier: cheap, prompt_ref: steps/ask.md }}
trigger: {{ kind: one_shot }}
guardrails:
  - {{ name: read_only_execution, locked: true }}
required_capabilities: [llm:cheap]
borrowed_actions: []
effect:
  render_blocks: []
  outcome:
    kind: none
"#
        ),
    )
    .unwrap();
    fs::write(
        dir.join("components/asker/steps/ask.md"),
        "Ask something.\n",
    )
    .unwrap();
}

/// A loader standing in for a semantic layer this host cannot introspect. It is well-formed — the
/// binding resolved — but it declines every schema probe, which is the honest position for a context
/// bound to a service that compile deliberately does not contact.
#[derive(Default)]
struct AnswersNothing {
    lineage: LineageGraph,
}

impl ContextLoader for AnswersNothing {
    fn is_parseable(&self) -> bool {
        true
    }
    fn metrics(&self) -> &[MetricInfo] {
        &[]
    }
    fn dimensions(&self) -> &[DimensionInfo] {
        &[]
    }
    fn time_dimensions(&self) -> &[DimensionInfo] {
        &[]
    }
    fn models(&self) -> &[ModelInfo] {
        &[]
    }
    fn lineage(&self) -> &LineageGraph {
        &self.lineage
    }
    fn can_answer(&self, predicate: &str) -> bool {
        // Parseability is the one thing it does know: the binding itself resolved.
        matches!(predicate, "mdl_parseable" | "wren_project_exists")
    }
}

/// A host resolver for a kind warble knows nothing about. It touches no filesystem — the point of
/// the seam — and records what the binding handed it.
struct RemoteResolver {
    expect_project: &'static str,
}

impl ContextResolver for RemoteResolver {
    fn resolve(
        &self,
        binding: &BindingFile,
        _project_dir: &Path,
    ) -> Result<Box<dyn ContextLoader>, String> {
        assert_eq!(binding.kind, "remote_service");
        assert_eq!(
            binding.project, self.expect_project,
            "the locator reaches the resolver as authored, uninterpreted"
        );
        assert_eq!(
            binding.extra.get("project_id").and_then(|v| v.as_u64()),
            Some(42),
            "a host kind's own fields survive parsing"
        );
        Ok(Box::new(AnswersNothing::default()))
    }
}

// --- prepared context -------------------------------------------------------------------------

/// A minimal prepared-context document: one model with two implicit numeric metrics and no
/// dimensions.
///
/// It is hand-written, which used to be safe because an equivalence test compared it against the
/// MDL adapter's own projection of the same fixture. That adapter has left this repo, so nothing
/// here can still check the shape against a producer — these tests now exercise how warble *reads*
/// a document, never whether some host would emit this one. Note the two numeric columns are
/// metrics rather than dimensions; that is the writer's convention, and getting it backwards is
/// the mistake the departed comparison used to catch.
const PREPARED_EQUIVALENT: &str = r#"{
  "context_version": 2,
  "parseable": true,
  "metrics": [
    {"name": "id", "owner": "widgets", "declared": false},
    {"name": "amount", "owner": "widgets", "declared": false}
  ],
  "dimensions": [],
  "models": [
    {"name": "widgets", "has_timestamp": false, "columns": ["id", "amount"]}
  ],
  "lineage": {"nodes": [{"id": "model:widgets", "kind": "model"}], "edges": []}
}"#;

#[test]
fn a_prepared_context_that_declares_itself_unparseable_fails_the_coarse_floor() {
    // The floor still applies: `prepared` is a different *source* of the answer, never a way to
    // skip the check.
    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        "kind: prepared\nproject: widgets-layer\ndocument: ./context.json\n",
        "  - { predicate: mdl_parseable }",
    );
    fs::write(
        project.path().join("context.json"),
        r#"{"context_version": 2, "parseable": false,
            "parse_error": "models/widgets/metadata.yml: missing `columns`"}"#,
    )
    .unwrap();

    let err = compile_project_to_ir(project.path())
        .expect_err("an unparseable prepared context must not compile");

    let text = err.to_string();
    assert!(
        text.contains("missing `columns`"),
        "the host's own parse error must survive into the failure, got: {text}"
    );
}

#[test]
fn a_prepared_binding_keeps_project_as_identity_not_as_the_document_path() {
    // `project` is echoed into the IR and the `{{project}}` placeholder for every kind. Pointing
    // it at the document would put the file's name into every prompt — telling the agent it works
    // on a project called "context.json" — so the document is a field of its own.
    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        "kind: prepared\nproject: widgets-layer\ndocument: ./context.json\n",
        "  []",
    );
    fs::write(project.path().join("context.json"), PREPARED_EQUIVALENT).unwrap();

    let ir = compile_project_to_ir(project.path()).expect("the binding resolves");

    assert_eq!(
        ir["context_binding"]["project"], "widgets-layer",
        "the IR must carry the layer's identity, never the document's filename"
    );
}

#[test]
fn a_prepared_binding_without_a_document_says_what_to_add() {
    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        "kind: prepared\nproject: widgets-layer\n",
        "  []",
    );

    let err = compile_project_to_ir(project.path()).expect_err("a document is required");

    let text = err.to_string();
    assert!(
        text.contains("document"),
        "the failure must name the missing field, got: {text}"
    );
}

#[test]
fn a_missing_prepared_document_is_a_broken_pipeline_not_an_empty_context() {
    // The binding named a file the host was supposed to write. Treating its absence as "a project
    // with no semantic layer" would silently compile a profile against nothing.
    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        "kind: prepared\nproject: widgets-layer\ndocument: ./context.json\n",
        "  []",
    );

    let err = compile_project_to_ir(project.path())
        .expect_err("a missing prepared document must be loud");

    assert!(
        err.to_string().contains("context.json"),
        "the failure must name the document that was not there, got: {err}"
    );
}

// --- the seam -------------------------------------------------------------------------------

#[test]
fn a_host_kind_resolves_through_a_supplied_resolver_with_a_non_path_locator() {
    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        "kind: remote_service\nproject: remote-service://analytics\nproject_id: 42\n",
        "  []",
    );

    let ir = compile_project_to_ir_with(
        project.path(),
        &default_component_sources(project.path()).expect("in-repo hub resolves offline"),
        &RemoteResolver {
            expect_project: "remote-service://analytics",
        },
    )
    .expect("a host kind must compile through its own resolver");

    assert_eq!(
        ir["context_binding"]["project"], "remote-service://analytics",
        "the IR records the locator verbatim, so a self-describing one carries its own provenance"
    );
}

#[test]
fn a_context_that_answers_nothing_is_unanswerable_not_unsatisfied() {
    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        "kind: remote_service\nproject: remote-service://analytics\nproject_id: 42\n",
        "  - { predicate: has_metric }",
    );

    let err = compile_project_to_ir_with(
        project.path(),
        &default_component_sources(project.path()).expect("in-repo hub resolves offline"),
        &RemoteResolver {
            expect_project: "remote-service://analytics",
        },
    )
    .expect_err("a declined probe must refuse rather than answer wrongly");

    assert!(
        err.contains("cannot be evaluated"),
        "expected the unanswerable loud-fail, got: {err}"
    );
    assert!(
        !err.contains("not satisfied"),
        "a context that does not know must not report the precondition as false: {err}"
    );
}

#[test]
fn a_component_declaring_no_preconditions_compiles_against_a_context_that_answers_nothing() {
    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        "kind: remote_service\nproject: remote-service://analytics\nproject_id: 42\n",
        "  []",
    );

    compile_project_to_ir_with(
        project.path(),
        &default_component_sources(project.path()).expect("in-repo hub resolves offline"),
        &RemoteResolver {
            expect_project: "remote-service://analytics",
        },
    )
    .expect("declaring no schema preconditions is what makes a delegating profile legal");
}

// --- the built-in kinds ---------------------------------------------------------------------

/// `kind` used to default to `wren_project`, which is what every binding authored before the field
/// existed meant. Nothing reads a wren project here any more, and no other kind is the obvious
/// meaning of silence — `prepared` needs a `document:` and `external` reads nothing — so the field
/// is required and its absence must be refused rather than guessed at.
#[test]
fn a_binding_without_a_kind_is_refused_rather_than_guessed_at() {
    let project = tempfile::tempdir().unwrap();
    write_project(project.path(), "project: ./somewhere\n", "  []");

    let err = compile_project_to_ir(project.path())
        .expect_err("a binding that declares no kind must not resolve as some assumed default");
    // Deliberately asserts the *parse* failure, not merely that the message mentions `kind`.
    // Restoring a `wren_project` default would still produce an error here — the retired-kind
    // migration one — whose text also contains "kind", so a looser assertion would pass with the
    // default back in place and prove nothing about the field being required.
    assert!(
        err.contains("missing field") && err.contains("kind"),
        "the binding must fail to parse for want of `kind`, not fail later for some other reason: \
         {err}"
    );
}

/// A binding authored against an older warble names a kind this build cannot read, not one it has
/// never heard of. Falling through to the generic unknown-kind error would leave the author to
/// work out which of the remaining kinds replaced it, so the retired name is matched by name and
/// answered with the migration.
#[test]
fn a_retired_wren_project_kind_says_what_to_write_instead() {
    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        "kind: wren_project\nproject: ./wren\n",
        "  []",
    );

    let err = compile_project_to_ir(project.path())
        .expect_err("warble reads no semantic format, so it cannot resolve a wren project");
    assert!(
        err.contains("no longer resolved"),
        "the error must say the kind is retired, not merely unknown: {err}"
    );
    assert!(
        err.contains("kind: prepared") && err.contains("document:"),
        "and must name the replacement and the field it needs: {err}"
    );
}

#[test]
fn a_raw_source_kind_without_a_schema_json_fails_loudly() {
    let empty = tempfile::tempdir().unwrap();
    let empty_abs = empty.path().canonicalize().unwrap();

    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        &format!(
            "kind: raw_source\nproject: {}\n",
            empty_abs.to_string_lossy()
        ),
        "  []",
    );

    let err = compile_project_to_ir(project.path()).expect_err(
        "a declared raw source that is not one must not fall through to another adapter",
    );
    assert!(
        err.contains("schema.json"),
        "the error must name what is missing: {err}"
    );
}

#[test]
fn an_unknown_kind_names_the_builtins_and_the_seam() {
    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        "kind: remote_service\nproject: remote-service://analytics\n",
        "  []",
    );

    let binding = BindingFile {
        kind: "remote_service".to_string(),
        project: "remote-service://analytics".to_string(),
        extra: Default::default(),
    };
    let err = BuiltinContextResolver
        .resolve(&binding, project.path())
        .err()
        .expect("the built-in resolver must not guess at a kind it does not implement");
    assert!(
        err.contains("raw_source") && err.contains("prepared"),
        "the error must list what this build does resolve: {err}"
    );
    assert!(
        !err.contains("wren_project"),
        "and must not advertise the retired kind as resolvable: {err}"
    );
    assert!(
        err.contains("ContextResolver"),
        "and must point at the seam that fixes it: {err}"
    );
}

/// `external` is the kind for a layer that is not on this machine at all. It resolves with no I/O —
/// `project` is a locator, not a path — and binds a context that answers nothing, so a component
/// that gates on schema facts is refused rather than judged against a layer nobody read.
#[test]
fn the_external_kind_resolves_with_no_io_and_answers_nothing() {
    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        "kind: external\nproject: remote-service://analytics\n",
        "  []",
    );

    let ir = compile_project_to_ir(project.path())
        .expect("`external` is a built-in kind; binding a layer held elsewhere needs no host code");

    assert_eq!(
        ir["context_binding"]["project"],
        "remote-service://analytics"
    );
    assert!(
        ir["context_binding"].get("resolved").is_none(),
        "nothing was introspected, so the IR must not carry a resolved block: {}",
        ir["context_binding"]
    );

    let gated = tempfile::tempdir().unwrap();
    write_project(
        gated.path(),
        "kind: external\nproject: remote-service://analytics\n",
        "  - { predicate: has_metric }",
    );
    let err = compile_project_to_ir(gated.path())
        .expect_err("a schema gate over a layer that was never read must be refused");
    assert!(
        err.contains("cannot be evaluated") && !err.contains("not satisfied"),
        "expected unanswerable, not an answerable false: {err}"
    );
}
