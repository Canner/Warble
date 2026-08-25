//! Capstone e2e for Phase 4a (+Mutating): the gated two-phase mutation lifecycle, end to end,
//! deterministic and CI-runnable (no live LLM).
//!
//! Three pieces, all real:
//! - the real jaffle-wren lineage, queried through the built `warble` gate (`blast_radius_for_project`
//!   / the `warble blast-radius` subcommand) over `examples/mutate-agent`;
//! - a real throwaway git repo as the BORROWED version-control checkpoint/rollback mechanism;
//! - a file/env mock approval channel (`WARBLE_APPROVAL`), fail-closed: unset or anything other than
//!   `"approve"` means "not approved".
//!
//! The lifecycle scripting in `run_gated_lifecycle` below IS the borrowed "gated-tool code" a real
//! host would write around Warble's one native primitive: the blast-radius gate
//! (`blast_radius_for_project` + `gate::decide`). Warble does not ship an orchestrator; this test
//! demonstrates the shape a caller wires around the gate, and proves the gate really blocks a
//! dangerous change rather than just classifying it on paper.

use std::path::{Path, PathBuf};
use std::process::Command;

use warble::Severity;
use warble_claude_code::{emit_claude_code_with_models, ir::WarbleIr, ModelConfig, RenderFlavor};
use warble_cli::gate::{self, GateDecision, GateThreshold};
use warble_cli::{blast_radius_for_project, compile_project_to_ir};

fn mutate_agent_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("examples/mutate-agent")
}

/// The `edit_pipeline` component's `blast_radius_limit` guardrail threshold (component.yml:
/// `{max_severity: structural, max_downstream: 5, protected: []}`), reconstructed here rather than
/// parsed out of the IR since the gate policy itself is what this test exercises.
fn edit_pipeline_threshold() -> GateThreshold {
    GateThreshold {
        max_severity: Some(Severity::Structural),
        max_downstream: Some(5),
        protected: vec![],
    }
}

// --- Test 1: edit_pipeline is gated-tool with divergent step tiers (assess_blast_radius: cheap,
// generate_edit: strong), so per-step splitting would grant every subagent the mutation guardrail's
// write/edit authority alongside the approval-gated driver -- duplicating write access outside the
// two-phase approval lifecycle. Dispatch must loud-fail on BOTH targets rather than either silently
// collapsing the tiers (the pre-fix bug) or unsafely splitting write authority. This subsumes the
// pre-existing headless `human_approval` wall-hit: the new guard runs before capability resolution,
// so it is what a caller now observes on headless too.

#[test]
fn edit_pipeline_loud_fails_on_both_targets_rather_than_splitting_the_approval_gate() {
    let ir_value = compile_project_to_ir(&mutate_agent_dir()).expect("mutate-agent compiles to IR");
    // The RAW compiled IR — no fabrication. The compiler shares one coarse `context_binding` across
    // every mounted component and emits the fine-grained resolved lineage summary once at the IR top
    // level; the dispatcher mirrors that shared binding onto each node during resolution, so
    // `blast_radius` resolves natively on the real `warble dispatch` path with no caller-side bridging.
    let ir: WarbleIr = serde_json::from_value(ir_value).expect("compiled IR deserializes");

    for target in ["claude-code:headless", "claude-code:interactive"] {
        let out_dir = tempfile::tempdir().expect("tempdir");
        let result = emit_claude_code_with_models(
            &ir,
            out_dir.path(),
            target,
            RenderFlavor::Programmatic,
            &ModelConfig::default(),
        );
        let err = result.expect_err(&format!(
            "edit_pipeline ({target}) must loud-fail, not silently collapse its tiers nor \
             unsafely split write authority to subagents"
        ));
        let message = err.to_string();
        assert!(message.contains("llm:per_step_tier"), "{message}");
        assert!(message.contains("gated-tool"), "{message}");
        assert!(message.contains("edit_pipeline"), "{message}");

        // Nothing must be written before the wall-hit -- no partial/inconsistent agent files.
        assert!(
            !out_dir.path().join(".claude/agents").exists(),
            "a loud-fail on {target} must abort before writing any agent file"
        );
    }
}

// --- Test 2: the blast gate really BLOCKS a dangerous change (THE MOAT PAYOFF) ---------------------

#[test]
fn blast_gate_blocks_a_dangerous_change() {
    let project_dir = mutate_agent_dir();

    // Via the built binary: editing model:orders exceeds --max-severity structural (its worst
    // downstream impact is semantic, via metric:revenue.total_revenue) -> escalate, exit code 10.
    let output = Command::new(env!("CARGO_BIN_EXE_warble"))
        .arg("blast-radius")
        .arg(&project_dir)
        .args(["--node", "model:orders"])
        .args(["--max-severity", "structural"])
        .output()
        .expect("warble blast-radius runs");
    assert_eq!(
        output.status.code(),
        Some(10),
        "escalate must exit 10; stderr was: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("blast-radius prints JSON to stdout");
    assert_eq!(json["decision"], "escalate");
    assert_eq!(json["severity"], "semantic");
    let downstream: Vec<String> = json["downstream"]
        .as_array()
        .expect("downstream is an array")
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert!(
        downstream.contains(&"metric:revenue.total_revenue".to_string()),
        "downstream was: {downstream:?}"
    );

    // Protecting the downstream metric turns the same change into a hard block, exit code 11 — no
    // escalation path, no apply, ever.
    let output = Command::new(env!("CARGO_BIN_EXE_warble"))
        .arg("blast-radius")
        .arg(&project_dir)
        .args(["--node", "model:orders"])
        .args(["--protected", "metric:revenue.total_revenue"])
        .output()
        .expect("warble blast-radius runs");
    assert_eq!(
        output.status.code(),
        Some(11),
        "block must exit 11; stderr was: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("blast-radius prints JSON to stdout");
    assert_eq!(json["decision"], "block");

    // Via the library path (same policy, no subprocess): editing model:orders under the
    // edit_pipeline component's actual guardrail threshold is Escalate — the deterministic proof
    // that a dangerous change is caught by the blast gate before anything is ever applied.
    let radius = blast_radius_for_project(&project_dir, "model:orders")
        .expect("model:orders resolves against the bound jaffle-wren project");
    let (decision, reason) = gate::decide(&radius, &edit_pipeline_threshold());
    assert_eq!(decision, GateDecision::Escalate, "reason was: {reason}");
}

// --- Test 3: the borrowed two-phase lifecycle — safe change applies + rolls back; dangerous refused

/// The outcome of one run of the borrowed gated-tool lifecycle (dry-run -> gate -> approval -> apply).
#[derive(Debug, PartialEq, Eq)]
enum LifecycleOutcome {
    /// The gate hard-blocked the change; no approval was ever sought, nothing was applied.
    Blocked,
    /// The gate escalated the change to human approval, and approval was withheld — refused.
    RefusedUnapproved,
    /// The change was applied (either the gate allowed it outright, or it was escalated and
    /// approved).
    Applied,
}

/// The mock approval channel (`WARBLE_APPROVAL`): fail-closed. Only the literal value `"approve"`
/// counts as approved; an unset variable, or any other value (e.g. `"deny"`), is NOT approved. This
/// stands in for a real runtime's human-approval transport (Slack button, TTY prompt, …) — the
/// point being that the gate must never treat "we don't know" as "yes".
fn approval_granted_via_mock_channel() -> bool {
    std::env::var("WARBLE_APPROVAL").as_deref() == Ok("approve")
}

/// The borrowed gated-tool lifecycle: dry-run (compute blast radius) -> gate (`gate::decide`) ->
/// approval (mock channel) -> apply (edit `pipeline.sql` + git commit in `repo_dir`). This scripting
/// is exactly the orchestration a real host writes around Warble's one native primitive (the gate);
/// Warble does not ship it.
fn run_gated_lifecycle(
    seed: &str,
    pipeline_path: &Path,
    repo_dir: &Path,
    threshold: &GateThreshold,
) -> Result<LifecycleOutcome, String> {
    // 1. dry-run: compute the blast radius of the intended change over the real jaffle-wren lineage.
    let radius = blast_radius_for_project(&mutate_agent_dir(), seed)?;

    // 2. gate: a hard block never has an escalation path — refuse before ever consulting approval.
    let (decision, _reason) = gate::decide(&radius, threshold);
    if decision == GateDecision::Block {
        return Ok(LifecycleOutcome::Blocked);
    }

    // 3. approval: only an escalated change needs it; an allowed change applies directly.
    if decision == GateDecision::Escalate && !approval_granted_via_mock_channel() {
        return Ok(LifecycleOutcome::RefusedUnapproved);
    }

    // 4. apply: mutate the pipeline file and commit it as the new checkpoint.
    let mut contents = std::fs::read_to_string(pipeline_path)
        .map_err(|e| format!("failed to read {}: {e}", pipeline_path.display()))?;
    contents.push_str(&format!("-- edited seed {seed}\n"));
    std::fs::write(pipeline_path, &contents)
        .map_err(|e| format!("failed to write {}: {e}", pipeline_path.display()))?;
    git(repo_dir, &["add", "pipeline.sql"]);
    git(
        repo_dir,
        &["commit", "-q", "-m", &format!("apply edit of {seed}")],
    );

    Ok(LifecycleOutcome::Applied)
}

/// Run a git command in `dir`, panicking with its stderr on failure.
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

/// Run a git command in `dir` and return its trimmed stdout, panicking on failure.
fn git_output(dir: &Path, args: &[&str]) -> String {
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
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

#[test]
fn full_lifecycle_safe_change_applies_and_rolls_back_dangerous_change_is_refused() {
    let repo = tempfile::tempdir().expect("tempdir");
    let repo_dir = repo.path();

    git(repo_dir, &["init", "-q"]);
    git(
        repo_dir,
        &["config", "user.email", "warble-e2e@example.com"],
    );
    git(repo_dir, &["config", "user.name", "Warble E2E"]);

    let pipeline_path = repo_dir.join("pipeline.sql");
    let original_contents = "-- orders pipeline (checkpoint)\nselect * from orders;\n";
    std::fs::write(&pipeline_path, original_contents).expect("write pipeline.sql");
    git(repo_dir, &["add", "pipeline.sql"]);
    git(repo_dir, &["commit", "-q", "-m", "checkpoint"]);
    let checkpoint_sha = git_output(repo_dir, &["rev-parse", "HEAD"]);

    let threshold = edit_pipeline_threshold();

    // The mock approval channel is fail-closed: with WARBLE_APPROVAL unset, nothing is approved.
    std::env::remove_var("WARBLE_APPROVAL");
    assert!(
        !approval_granted_via_mock_channel(),
        "an unset WARBLE_APPROVAL must fail closed (not approved)"
    );

    // --- Dangerous path: model:orders escalates (its worst downstream impact is semantic, exceeding
    // the structural ceiling). Deny approval over the mock channel -> refused, nothing touched.
    std::env::set_var("WARBLE_APPROVAL", "deny");
    let outcome = run_gated_lifecycle("model:orders", &pipeline_path, repo_dir, &threshold)
        .expect("lifecycle runs without error");
    assert_eq!(
        outcome,
        LifecycleOutcome::RefusedUnapproved,
        "an escalated change with approval denied must be refused, not applied"
    );
    assert_eq!(
        std::fs::read(&pipeline_path).expect("read pipeline.sql"),
        original_contents.as_bytes(),
        "a refused dangerous change must leave pipeline.sql byte-for-byte unchanged"
    );
    assert_eq!(
        git_output(repo_dir, &["rev-parse", "HEAD"]),
        checkpoint_sha,
        "a refused dangerous change must not create any new commit"
    );

    // --- Safe path: metric:revenue.total_revenue is a leaf (empty blast radius) -> Allow. Approve
    // over the mock channel (though Allow does not require it) -> applied.
    std::env::set_var("WARBLE_APPROVAL", "approve");
    let outcome = run_gated_lifecycle(
        "metric:revenue.total_revenue",
        &pipeline_path,
        repo_dir,
        &threshold,
    )
    .expect("lifecycle runs without error");
    assert_eq!(
        outcome,
        LifecycleOutcome::Applied,
        "an allowed (empty-radius) change must be applied"
    );
    let changed_contents = std::fs::read(&pipeline_path).expect("read pipeline.sql after apply");
    assert_ne!(
        changed_contents,
        original_contents.as_bytes(),
        "an applied safe change must modify pipeline.sql"
    );
    let applied_sha = git_output(repo_dir, &["rev-parse", "HEAD"]);
    assert_ne!(
        applied_sha, checkpoint_sha,
        "an applied safe change must create a new commit beyond the checkpoint"
    );

    // --- Rollback: the borrowed VCS (git) restores the pre-checkpoint state on demand.
    git(repo_dir, &["reset", "--hard", &checkpoint_sha]);
    assert_eq!(
        std::fs::read(&pipeline_path).expect("read pipeline.sql after rollback"),
        original_contents.as_bytes(),
        "git reset --hard to the checkpoint must restore pipeline.sql exactly"
    );

    std::env::remove_var("WARBLE_APPROVAL");
}
