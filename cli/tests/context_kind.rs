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

/// Write a wren project into `dir` that parses and carries one metric-bearing model.
fn write_wren_project(dir: &Path) {
    fs::create_dir_all(dir.join("models/widgets")).unwrap();
    fs::write(
        dir.join("wren_project.yml"),
        "schema_version: 2\ndata_source: duckdb\ncatalog: wren\nschema: public\n",
    )
    .unwrap();
    fs::write(
        dir.join("models/widgets/metadata.yml"),
        "name: widgets\ncolumns:\n  - name: id\n    type: INT\n  - name: amount\n    type: DOUBLE\n",
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

/// The prepared-context document describing exactly what [`write_wren_project`] contains. Written
/// by hand here precisely because the equivalence test below is what proves it right: if the
/// native adapter's projection and this document ever disagree, the assertion prints both.
const PREPARED_EQUIVALENT: &str = r#"{
  "context_version": 1,
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
fn a_prepared_context_resolves_to_the_same_binding_as_the_native_adapter() {
    // The load-bearing claim of the whole seam: a host that resolved the layer itself and a
    // natively-read one are indistinguishable to the compiler. If the exchange format were missing
    // a field the compiler probes, the two `resolved` blocks would differ here.
    let native = tempfile::tempdir().unwrap();
    write_project(
        native.path(),
        "kind: wren_project\nproject: ./wren\n",
        "  - { predicate: mdl_parseable }",
    );
    write_wren_project(&native.path().join("wren"));
    let ir_native =
        compile_project_to_ir(native.path()).expect("the native adapter compiles the fixture");

    let prepared = tempfile::tempdir().unwrap();
    write_project(
        prepared.path(),
        "kind: prepared\nproject: ./context.json\n",
        "  - { predicate: mdl_parseable }",
    );
    fs::write(prepared.path().join("context.json"), PREPARED_EQUIVALENT).unwrap();
    let ir_prepared = compile_project_to_ir(prepared.path())
        .expect("a prepared context compiles with no adapter in the process");

    assert_eq!(
        ir_native["context_binding"]["resolved"], ir_prepared["context_binding"]["resolved"],
        "a host-resolved context must be indistinguishable from a natively-read one"
    );
}

#[test]
fn a_prepared_context_that_declares_itself_unparseable_fails_the_coarse_floor() {
    // The floor still applies: `prepared` is a different *source* of the answer, never a way to
    // skip the check.
    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        "kind: prepared\nproject: ./context.json\n",
        "  - { predicate: mdl_parseable }",
    );
    fs::write(
        project.path().join("context.json"),
        r#"{"context_version": 1, "parseable": false,
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
fn a_missing_prepared_document_is_a_broken_pipeline_not_an_empty_context() {
    // The binding named a file the host was supposed to write. Treating its absence as "a project
    // with no semantic layer" would silently compile a profile against nothing.
    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        "kind: prepared\nproject: ./context.json\n",
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

#[test]
fn a_binding_without_a_kind_still_resolves_as_a_wren_project() {
    let wren = tempfile::tempdir().unwrap();
    write_wren_project(wren.path());
    let wren_abs = wren.path().canonicalize().unwrap();

    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        &format!("project: {}\n", wren_abs.to_string_lossy()),
        "  - { predicate: mdl_parseable }",
    );

    compile_project_to_ir(project.path())
        .expect("every binding authored before `kind` existed must keep working");
}

#[test]
fn a_wren_project_kind_over_a_raw_source_says_which_kind_to_declare() {
    let raw = tempfile::tempdir().unwrap();
    fs::write(raw.path().join("schema.json"), "{\"tables\":[]}").unwrap();
    let raw_abs = raw.path().canonicalize().unwrap();

    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        &format!("project: {}\n", raw_abs.to_string_lossy()),
        "  []",
    );

    let err = compile_project_to_ir(project.path()).expect_err(
        "silently accepting a raw source as a wren project is the guess `kind` removes",
    );
    assert!(
        err.contains("raw source") && err.contains("kind: raw_source"),
        "the error must name the kind to declare, not just refuse: {err}"
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
        err.contains("wren_project") && err.contains("raw_source"),
        "the error must list what this build does resolve: {err}"
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
