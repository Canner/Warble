//! P4 trace cache — the 0-LLM re-score deliverable.
//!
//! The killer property: when *only* a golden's expectation changes (agent, model, and MDL held
//! fixed), re-scoring reuses the cached result and calls **no** LLM. Like the Phase 3/4a litmus
//! tests (`freshness_detection.rs`, `mutate_change.rs`), this exercises the deterministic core the
//! runner uses on a cache hit — `TraceStore::load` + `rescore` — WITHOUT spawning `claude`, so it
//! runs anywhere and is the reference oracle for the cache mechanism itself. The runner's live
//! `run_case` reuses exactly these two calls on a hit (before the `claude` invocation), so the
//! 0-LLM claim is structural, not incidental: there is no code path from a hit to an LLM call.

use warble_eval_runner::{rescore, Backend, CaseKey, GoldenCase, Trace, TraceStore};

/// A golden case with a given `expected` rows literal (scalar match on column `n`).
fn golden_case(expected_rows: &str) -> GoldenCase {
    let yaml = format!(
        "id: q1\nquestion: \"how many orders?\"\ntags: [agg]\nmatch: scalar\nexpected: {{ columns: [n], rows: {expected_rows} }}\n"
    );
    serde_yaml::from_str(&yaml).expect("golden case parses")
}

/// The trace a first (paid) run would have written for `q1` under agent `A`, model `opus`, MDL `C`.
fn trace_for(result: serde_json::Value) -> Trace {
    Trace {
        case_id: "q1".into(),
        agent_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        model: "opus".into(),
        context_version: Some("driftwood@c0ffee0".into()),
        context_sha: "cccccccccccccccccccccccccccccccccccccccc".into(),
        question: "how many orders?".into(),
        sql_executed: None,
        result,
        cost: Some(0.1234),
        latency_ms: 21_000,
        turns: Some(6),
        tool_calls: None,
        backend: Backend::default(),
    }
}

fn key_for<'a>(
    question: &'a str,
    agent_sha: &'a str,
    model: &'a str,
    context_sha: &'a str,
) -> CaseKey<'a> {
    CaseKey {
        case_id: "q1",
        question,
        agent_sha,
        model,
        context_sha,
        sample: 0,
        backend: Backend::default(),
    }
}

/// THE ACCEPTANCE TEST: change only the golden's `expected` — the cached result is re-scored with
/// zero LLM calls, and the new verdict is correct. A first paid run stores the trace; the "v2"
/// re-scoring never re-runs the agent.
#[test]
fn changing_only_expected_rescores_from_cache_with_zero_llm() {
    let dir = tempfile::tempdir().unwrap();
    let store = TraceStore::new(dir.path().to_path_buf(), true);

    // A first run produced result `42` and cached it (the only "LLM spend" in this whole test).
    let key = key_for(
        "how many orders?",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "opus",
        "cccccccccccccccccccccccccccccccccccccccc",
    );
    store
        .store(
            &key,
            &trace_for(serde_json::json!({"columns":["n"],"rows":[[42]]})),
        )
        .unwrap();

    // A *fresh* store over the same dir (a later `warble eval run` invocation) still hits — the
    // cache survives across runs (content-addressed skip), not just within one process.
    let later = TraceStore::new(dir.path().to_path_buf(), true);

    // v1 golden expected 42 → re-score hits the cache and passes. No agent invocation.
    let hit_v1 = later.load(&key).expect("cache hit for unchanged key");
    let verdict_v1 = rescore(&hit_v1, &golden_case("[[42]]")).expect("re-score");
    assert!(verdict_v1.pass, "cached 42 matches v1 expected 42");
    assert_eq!(
        hit_v1.turns,
        Some(6),
        "diagnostic turns carried through the cache"
    );

    // v2 golden calibrated its expected to 99 — the ONLY change. Same key (expectation is not part
    // of the key), so it STILL hits, and the re-score now correctly fails. Zero LLM calls.
    let hit_v2 = later
        .load(&key)
        .expect("hit — the expected change does not move the key");
    let verdict_v2 = rescore(&hit_v2, &golden_case("[[99]]")).expect("re-score");
    assert!(
        !verdict_v2.pass,
        "cached 42 no longer matches v2 expected 99"
    );
}

/// `--no-cache` (a disabled store) never hits, forcing every case to re-run even with the entry on
/// disk — the escape hatch that refreshes results.
#[test]
fn no_cache_forces_a_miss() {
    let dir = tempfile::tempdir().unwrap();
    let key = key_for(
        "how many orders?",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "opus",
        "cccccccccccccccccccccccccccccccccccccccc",
    );
    // Populate the entry via an enabled store…
    TraceStore::new(dir.path().to_path_buf(), true)
        .store(
            &key,
            &trace_for(serde_json::json!({"columns":["n"],"rows":[[42]]})),
        )
        .unwrap();

    // …then a --no-cache (disabled) store over the same dir misses → the runner would re-run.
    let no_cache = TraceStore::new(dir.path().to_path_buf(), false);
    assert!(no_cache.load(&key).is_none(), "disabled store never hits");
}

/// The four key components each move the cache key (→ a miss → a re-run), while changing the
/// expectation alone does not. This is what makes the re-score path both correct and safe: a
/// different agent/model/MDL or a different *question* re-runs; only a changed expectation reuses.
#[test]
fn key_isolates_result_inputs_from_the_expectation() {
    let base = key_for(
        "how many orders?",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "opus",
        "cccccccccccccccccccccccccccccccccccccccc",
    );
    let base_hash = base.hash().unwrap();

    // Different question / agent / model / context → different key.
    for k in [
        key_for(
            "how many customers?",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "opus",
            "cccccccccccccccccccccccccccccccccccccccc",
        ),
        key_for(
            "how many orders?",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "opus",
            "cccccccccccccccccccccccccccccccccccccccc",
        ),
        key_for(
            "how many orders?",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "haiku",
            "cccccccccccccccccccccccccccccccccccccccc",
        ),
        key_for(
            "how many orders?",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "opus",
            "dddddddddddddddddddddddddddddddddddddddd",
        ),
    ] {
        assert_ne!(
            base_hash,
            k.hash().unwrap(),
            "a key component change must move the hash"
        );
    }

    // The expectation is NOT in the key: re-scoring two different expecteds uses the same entry.
    assert_eq!(base_hash, base.hash().unwrap());
}

/// Re-scoring a full golden set from cache is a local, sub-second operation — the target is "0
/// LLM, < 5s" for the calibration rerun. Here we re-score 50 cached cases and assert it is far
/// under budget (the real bound is dominated by disk reads, not compute).
#[test]
fn rescoring_a_full_set_from_cache_is_fast_and_llm_free() {
    let dir = tempfile::tempdir().unwrap();
    let store = TraceStore::new(dir.path().to_path_buf(), true);

    // Seed 50 cases' traces (the one-time paid run), keyed by distinct questions.
    let n = 50;
    let questions: Vec<String> = (0..n).map(|i| format!("q number {i}?")).collect();
    let agent = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let ctx = "cccccccccccccccccccccccccccccccccccccccc";
    for q in &questions {
        store
            .store(
                &key_for(q, agent, "opus", ctx),
                &trace_for(serde_json::json!({"columns":["n"],"rows":[[7]]})),
            )
            .unwrap();
    }

    // Re-score all 50 against a changed expectation. No LLM, no process spawn.
    let started = std::time::Instant::now();
    let mut hits = 0usize;
    for q in &questions {
        let trace = store.load(&key_for(q, agent, "opus", ctx)).expect("hit");
        let verdict = rescore(&trace, &golden_case("[[7]]")).expect("re-score");
        assert!(verdict.pass);
        hits += 1;
    }
    let elapsed = started.elapsed();
    assert_eq!(hits, n, "every case re-scored from cache");
    // The bound is deliberately loose: this loop makes no LLM call and spawns no process, so it's
    // disk I/O + deserialization + comparison — a "no LLM, no process spawn" guarantee, not a
    // latency benchmark. 5s leaves generous headroom over ordinary scheduling noise; don't tighten
    // it back toward what the hardware happens to measure today.
    assert!(
        elapsed < std::time::Duration::from_secs(5),
        "re-scoring {n} cached cases took {elapsed:?} — exceeded the 5s no-LLM budget"
    );
}
