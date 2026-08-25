//! Capstone e2e for Phase 4b (Constitutive): the gated context-write lifecycle, end to end,
//! deterministic and CI-runnable (no live LLM).
//!
//! It reuses the +Mutating machinery — the same `emit_claude_code_with_models` path, the same
//! headless-loud-fail / interactive-dispatch honesty, the same fail-closed `WARBLE_APPROVAL` mock
//! channel — differentiated only by `outcome.target: context`. What is NEW and proven here is the
//! THIRD enforcement point: `context_write_authz` is path-SCOPED, so `bootstrap_mdl` may write only
//! `models/`, `enrich_knowledge` only `knowledge/`, and neither may cross into the other's scope or
//! into production data. The scope values are read from the compiled IR (not hard-coded), and the
//! scope check IS the borrowed context-write authorization a real host wires around the gate.

use std::path::{Path, PathBuf};
use std::process::Command;

use warble_claude_code::{emit_claude_code_with_models, ir::WarbleIr, ModelConfig, RenderFlavor};
use warble_cli::compile_project_to_ir;

fn bootstrap_agent_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("examples/bootstrap-agent")
}

fn compiled_ir() -> WarbleIr {
    let value =
        compile_project_to_ir(&bootstrap_agent_dir()).expect("bootstrap-agent compiles to IR");
    serde_json::from_value(value).expect("compiled IR deserializes")
}

/// The `context_write_authz` scope declared by a component in the compiled IR (e.g. `models/`).
fn context_scope(ir: &WarbleIr, verb: &str) -> String {
    ir.components
        .iter()
        .find(|c| c.verb == verb)
        .unwrap_or_else(|| panic!("component '{verb}' present"))
        .guardrails
        .iter()
        .find(|g| g.name == "context_write_authz")
        .unwrap_or_else(|| panic!("{verb} has a context_write_authz guardrail"))
        .scope
        .clone()
        .unwrap_or_else(|| panic!("{verb}'s context_write_authz carries a scope"))
}

// --- Test 1: bootstrap_mdl is gated-tool with divergent step tiers (introspect_source: cheap,
// draft_mdl: strong), so per-step splitting would grant every subagent the mutation guardrail's
// write/edit authority alongside the approval-gated driver -- duplicating write access outside the
// two-phase approval lifecycle. Dispatch must loud-fail on BOTH targets rather than either silently
// collapsing the tiers (the pre-fix bug) or unsafely splitting write authority (unsafe even though
// technically possible). This subsumes the pre-existing headless `human_approval` wall-hit: the new
// guard runs before capability resolution, so it is what a caller now observes on headless too.

#[test]
fn bootstrap_mdl_loud_fails_on_both_targets_rather_than_splitting_the_approval_gate() {
    let ir = compiled_ir();

    for target in ["claude-code:headless", "claude-code:interactive"] {
        let out_dir = tempfile::tempdir().expect("tempdir");
        let err = emit_claude_code_with_models(
            &ir,
            out_dir.path(),
            target,
            RenderFlavor::Programmatic,
            &ModelConfig::default(),
        )
        .expect_err(&format!(
            "bootstrap_mdl ({target}) must loud-fail, not silently collapse its tiers nor \
             unsafely split write authority to subagents"
        ));
        let message = err.to_string();
        assert!(message.contains("llm:per_step_tier"), "{message}");
        assert!(message.contains("gated-tool"), "{message}");
        assert!(message.contains("bootstrap_mdl"), "{message}");

        // Nothing must be written before the wall-hit -- no partial/inconsistent agent files.
        assert!(
            !out_dir.path().join(".claude/agents").exists(),
            "a loud-fail on {target} must abort before writing any agent file"
        );
    }
}

// --- the borrowed, path-SCOPED context-write authorization (the 3rd enforcement point) -------------

/// Whether `target_rel` lies inside the component's `context_write_authz` scope directory. This is the
/// borrowed scoped-fs authorization a real host enforces around the gate; a write outside the scope
/// (another component's scope, or a production-data path) is refused before approval is ever sought.
fn write_authorized(scope: &str, target_rel: &str) -> bool {
    let scope = Path::new(scope);
    Path::new(target_rel).starts_with(scope)
}

/// The outcome of one run of the gated context-write lifecycle.
#[derive(Debug, PartialEq, Eq)]
enum LifecycleOutcome {
    /// The write is outside the component's context_write_authz scope — refused before approval.
    OutOfScope,
    /// In scope, but human approval was withheld (fail-closed) — refused.
    RefusedUnapproved,
    /// In scope and approved — applied.
    Applied,
}

/// The mock approval channel (`WARBLE_APPROVAL`): fail-closed. Only the literal `"approve"` counts.
fn approval_granted() -> bool {
    std::env::var("WARBLE_APPROVAL").as_deref() == Ok("approve")
}

/// The borrowed gated context-write lifecycle: scope-gate -> human approval -> apply (write the
/// Context file + git commit). Warble ships neither the writer nor git; this is the shape a host
/// wires, and it proves the scope really blocks a cross-scope write before anything is applied.
fn run_context_lifecycle(
    scope: &str,
    target_rel: &str,
    repo_dir: &Path,
) -> Result<LifecycleOutcome, String> {
    // 1. scope gate: a write outside the component's scope is refused outright (no approval path).
    if !write_authorized(scope, target_rel) {
        return Ok(LifecycleOutcome::OutOfScope);
    }
    // 2. approval: fail-closed — an unset/denied channel is NOT approval.
    if !approval_granted() {
        return Ok(LifecycleOutcome::RefusedUnapproved);
    }
    // 3. apply: write the proposed Context file and commit it as the new checkpoint.
    let target = repo_dir.join(target_rel);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    std::fs::write(&target, "# bootstrapped by warble\n")
        .map_err(|e| format!("write {}: {e}", target.display()))?;
    git(repo_dir, &["add", "-A"]);
    git(repo_dir, &["commit", "-q", "-m", "apply context write"]);
    Ok(LifecycleOutcome::Applied)
}

fn git(dir: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap_or_else(|e| panic!("failed to spawn git {args:?}: {e}"));
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn git_output(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap_or_else(|e| panic!("failed to spawn git {args:?}: {e}"));
    assert!(output.status.success(), "git {args:?} failed");
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

// --- Test 2: the scopes do not cross (models/ ↔ knowledge/ ↔ data) --------------------------------

#[test]
fn context_write_authz_scopes_do_not_cross() {
    let ir = compiled_ir();
    let bootstrap_scope = context_scope(&ir, "bootstrap_mdl");
    let enrich_scope = context_scope(&ir, "enrich_knowledge");

    // The IR itself carries two DISTINCT scopes — not one blanket "context is writable" flag.
    assert_eq!(bootstrap_scope, "models/");
    assert_eq!(enrich_scope, "knowledge/");
    assert_ne!(bootstrap_scope, enrich_scope, "the two scopes must differ");

    // bootstrap_mdl (models/) may write models/, but NOT knowledge/ and NOT a production-data path.
    assert!(write_authorized(&bootstrap_scope, "models/orders.yml"));
    assert!(
        !write_authorized(&bootstrap_scope, "knowledge/orders.md"),
        "bootstrap_mdl must not write into enrich_knowledge's scope"
    );
    assert!(
        !write_authorized(&bootstrap_scope, "warehouse/orders.csv"),
        "context-write must not bleed into a production-data (data_write) path"
    );

    // enrich_knowledge (knowledge/) is the mirror: knowledge/ yes, models/ + data no.
    assert!(write_authorized(&enrich_scope, "knowledge/orders.md"));
    assert!(
        !write_authorized(&enrich_scope, "models/orders.yml"),
        "enrich_knowledge must not write into bootstrap_mdl's scope"
    );
    assert!(
        !write_authorized(&enrich_scope, "warehouse/orders.csv"),
        "context-write must not bleed into a production-data (data_write) path"
    );
}

// --- Test 3: full lifecycle — approved in-scope write applies; cross-scope + unapproved refused -----

#[test]
fn full_lifecycle_scoped_write_applies_and_cross_scope_or_unapproved_is_refused() {
    let ir = compiled_ir();
    let scope = context_scope(&ir, "bootstrap_mdl"); // models/

    let repo = tempfile::tempdir().expect("tempdir");
    let repo_dir = repo.path();
    git(repo_dir, &["init", "-q"]);
    git(
        repo_dir,
        &["config", "user.email", "warble-e2e@example.com"],
    );
    git(repo_dir, &["config", "user.name", "Warble E2E"]);
    // Seed both scoped dirs so a stray cross-scope write would be observable if the gate let it through.
    std::fs::create_dir_all(repo_dir.join("models")).unwrap();
    std::fs::create_dir_all(repo_dir.join("knowledge")).unwrap();
    std::fs::write(repo_dir.join(".gitkeep"), "").unwrap();
    git(repo_dir, &["add", "-A"]);
    git(repo_dir, &["commit", "-q", "-m", "checkpoint"]);
    let checkpoint_sha = git_output(repo_dir, &["rev-parse", "HEAD"]);

    // Fail-closed: with WARBLE_APPROVAL unset, nothing is approved.
    std::env::remove_var("WARBLE_APPROVAL");
    assert!(
        !approval_granted(),
        "unset WARBLE_APPROVAL must fail closed"
    );

    // --- Cross-scope: bootstrap_mdl (models/) trying to write knowledge/ is blocked BEFORE approval.
    let outcome = run_context_lifecycle(&scope, "knowledge/glossary.md", repo_dir)
        .expect("lifecycle runs without error");
    assert_eq!(
        outcome,
        LifecycleOutcome::OutOfScope,
        "a cross-scope write must be refused by the scope gate, not applied"
    );
    // --- Data path: writing production data is likewise out of the context-write scope.
    assert_eq!(
        run_context_lifecycle(&scope, "warehouse/orders.csv", repo_dir).unwrap(),
        LifecycleOutcome::OutOfScope
    );

    // --- In-scope but approval denied -> refused (human_approval holds).
    std::env::set_var("WARBLE_APPROVAL", "deny");
    assert_eq!(
        run_context_lifecycle(&scope, "models/orders.yml", repo_dir).unwrap(),
        LifecycleOutcome::RefusedUnapproved,
        "an in-scope write with approval denied must be refused, not applied"
    );

    // Nothing has been written or committed through any of the refused paths.
    assert_eq!(
        git_output(repo_dir, &["rev-parse", "HEAD"]),
        checkpoint_sha,
        "no refused write may create a commit"
    );
    assert!(!repo_dir.join("models/orders.yml").exists());
    assert!(!repo_dir.join("knowledge/glossary.md").exists());
    assert!(!repo_dir.join("warehouse/orders.csv").exists());

    // --- In-scope and approved -> applied, and ONLY the scoped dir is touched.
    std::env::set_var("WARBLE_APPROVAL", "approve");
    assert_eq!(
        run_context_lifecycle(&scope, "models/orders.yml", repo_dir).unwrap(),
        LifecycleOutcome::Applied
    );
    assert!(
        repo_dir.join("models/orders.yml").exists(),
        "an approved in-scope write must land the file under models/"
    );
    assert!(
        !repo_dir.join("knowledge/orders.yml").exists()
            && std::fs::read_dir(repo_dir.join("knowledge"))
                .unwrap()
                .next()
                .is_none(),
        "the approved write must NOT touch the knowledge/ scope"
    );
    assert_ne!(
        git_output(repo_dir, &["rev-parse", "HEAD"]),
        checkpoint_sha,
        "the approved write must create a new commit"
    );

    std::env::remove_var("WARBLE_APPROVAL");
}
