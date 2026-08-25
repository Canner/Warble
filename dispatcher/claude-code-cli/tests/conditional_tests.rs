//! Cross-back-end conformance: this back-end's conditional guard/repair decision layer
//! (`conditional.rs`, conformance-only — see its module doc) is exercised against the SAME shared
//! fixture the `claude-agent-sdk` back-end's `conditional.ts` equivalent is tested against
//! (`dispatcher/conformance-fixtures/conditional.json`). A decision or repair-loop divergence
//! between the two back-ends fails HERE, in this crate, and in the TS suite — whichever moved.

use serde::Deserialize;
use std::collections::HashMap;
use warble_claude_code::conditional::{
    classify_conditional_step, run_repair_loop, ConditionalDecision, GuardState, StepIdentity,
    StepOutcome,
};
use warble_claude_code::ir::WhenGuard;

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../conformance-fixtures/conditional.json"
);

#[derive(Deserialize)]
struct GuardScenario {
    name: String,
    when: WhenGuard,
    consumes: Vec<String>,
    preceding_step: Option<StepIdentity>,
    slots: HashMap<String, String>,
    outcomes: HashMap<String, StepOutcome>,
    expected_decision: ConditionalDecision,
}

#[derive(Deserialize)]
struct ExpectedRepair {
    recovered: bool,
    attempts: usize,
}

#[derive(Deserialize)]
struct RepairLoopScenario {
    name: String,
    max_attempts: usize,
    attempt_outcomes: Vec<String>,
    expected: ExpectedRepair,
}

#[derive(Deserialize)]
struct Fixture {
    guard_scenarios: Vec<GuardScenario>,
    repair_loop_scenarios: Vec<RepairLoopScenario>,
}

fn load_fixture() -> Fixture {
    let raw = std::fs::read_to_string(FIXTURE).expect("read shared conformance fixture");
    serde_json::from_str(&raw).expect("fixture deserializes")
}

#[test]
fn guard_scenarios_match_expected_decision() {
    let fixture = load_fixture();
    assert!(
        !fixture.guard_scenarios.is_empty(),
        "fixture must carry guard scenarios"
    );
    for scenario in &fixture.guard_scenarios {
        let state = GuardState {
            slots: scenario.slots.clone(),
            outcomes: scenario.outcomes.clone(),
        };
        let decision = classify_conditional_step(
            &scenario.when,
            &scenario.consumes,
            scenario.preceding_step.as_ref(),
            &state,
        )
        .unwrap_or_else(|e| panic!("scenario '{}': {e}", scenario.name));
        assert_eq!(
            decision, scenario.expected_decision,
            "scenario '{}': decision mismatch",
            scenario.name
        );
    }
}

#[test]
fn repair_loop_scenarios_match_expected_recovery() {
    let fixture = load_fixture();
    assert!(
        !fixture.repair_loop_scenarios.is_empty(),
        "fixture must carry repair-loop scenarios"
    );
    for scenario in &fixture.repair_loop_scenarios {
        let mut idx = 0usize;
        let (recovered, attempts) = run_repair_loop(scenario.max_attempts, |_attempt| {
            let failed = scenario
                .attempt_outcomes
                .get(idx)
                .map(|s| s == "failure")
                .unwrap_or(true);
            idx += 1;
            failed
        });
        assert_eq!(
            recovered, scenario.expected.recovered,
            "scenario '{}': recovered mismatch",
            scenario.name
        );
        assert_eq!(
            attempts, scenario.expected.attempts,
            "scenario '{}': attempts mismatch",
            scenario.name
        );
    }
}
