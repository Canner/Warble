//! Gate-decision policy over an already-computed [`warble::BlastRadius`] (Phase 4a — the mutating
//! guardrail described in [`blast-radius.md`][spec-blast] §6). Pure, no I/O: the host computes the
//! radius (via [`crate::blast_radius_for_project`]), then this module turns it plus a threshold
//! into a decision the host can act on (allow the apply, escalate to human approval, or hard-block
//! it).
//!
//! [spec-blast]: https://github.com/Canner/Warble/blob/main/docs/spec/blast-radius.md

/// The outcome of a gate decision — what the host should do with the pending mutating apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateDecision {
    /// No downstream impact worth gating on — proceed.
    Allow,
    /// Impact exceeds a soft threshold — route to human approval rather than auto-apply.
    Escalate,
    /// The change touches a protected asset — refuse outright, no escalation path.
    Block,
}

impl GateDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            GateDecision::Allow => "allow",
            GateDecision::Escalate => "escalate",
            GateDecision::Block => "block",
        }
    }
}

/// The thresholds a gate decision is evaluated against. All fields are optional: an absent
/// `max_severity_rank`/`max_downstream` simply never triggers that branch of the policy.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GateThreshold {
    /// Escalate when the radius's severity is strictly above this ceiling.
    /// A severity **rank** from the bound layer's own scale — higher is worse. Warble compares
    /// ranks and never reads the name beside them: what makes one impact worse than another is a
    /// judgement about the layer's objects, which belongs to whoever owns the semantic format.
    pub max_severity_rank: Option<u32>,
    /// Escalate when the radius's downstream count is strictly above this ceiling.
    pub max_downstream: Option<usize>,
    /// Node ids that force a hard block if they are the seed or anywhere in the downstream set.
    pub protected: Vec<String>,
}

/// Pure policy over an already-computed radius. Returns the decision plus a human-readable reason
/// (surfaced to the operator / logged, not machine-parsed).
///
/// Policy, evaluated in order (first match wins):
/// 1. Empty blast radius → `Allow`.
/// 2. The seed or any downstream node is in `t.protected` → `Block` (names the first hit: seed
///    checked before downstream, downstream in its existing sorted order).
/// 3. `t.max_severity_rank` is set and the impact's severity rank exceeds it → `Escalate`.
/// 4. `t.max_downstream` is set and the downstream count exceeds it → `Escalate`.
/// 5. Otherwise → `Allow`.
pub fn decide(
    seed: &str,
    impact: Option<&warble::HostImpact>,
    t: &GateThreshold,
) -> (GateDecision, String) {
    let downstream: &[String] = impact.map(|i| i.downstream.as_slice()).unwrap_or(&[]);
    if downstream.is_empty() {
        return (
            GateDecision::Allow,
            "empty blast radius — no downstream impact".to_string(),
        );
    }

    if let Some(hit) = std::iter::once(&seed.to_string())
        .chain(downstream.iter())
        .find(|id| t.protected.contains(id))
    {
        return (
            GateDecision::Block,
            format!("touches protected asset '{hit}'"),
        );
    }

    if let (Some(max), Some(sev)) = (t.max_severity_rank, impact.map(|i| &i.severity)) {
        if sev.rank > max {
            return (
                GateDecision::Escalate,
                format!(
                    "radius severity '{}' (rank {}) exceeds max rank {max}",
                    sev.name, sev.rank
                ),
            );
        }
    }

    if let Some(max) = t.max_downstream {
        if downstream.len() > max {
            return (
                GateDecision::Escalate,
                format!(
                    "blast radius of {} nodes exceeds max {max}",
                    downstream.len()
                ),
            );
        }
    }

    (
        GateDecision::Allow,
        "within blast-radius limits".to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An impact as a layer would report it: a downstream set and a severity the layer ranked and
    /// named. `name` is deliberately not a value this module knows — it is carried, never matched.
    fn impact(downstream: &[&str], rank: u32, name: &str) -> warble::HostImpact {
        warble::HostImpact {
            downstream: downstream.iter().map(|s| s.to_string()).collect(),
            severity: warble::RankedSeverity {
                rank,
                name: name.to_string(),
            },
        }
    }

    #[test]
    fn empty_radius_allows() {
        let r = impact(&[], 0, "none");
        let (decision, reason) = decide("model:orders", Some(&r), &GateThreshold::default());
        assert_eq!(decision, GateDecision::Allow);
        assert!(reason.contains("no downstream impact"));
    }

    #[test]
    fn protected_seed_blocks() {
        let r = impact(&["cube:revenue"], 1, "compatibility");
        let t = GateThreshold {
            protected: vec!["model:orders".to_string()],
            ..Default::default()
        };
        let (decision, reason) = decide("model:orders", Some(&r), &t);
        assert_eq!(decision, GateDecision::Block);
        assert!(reason.contains("model:orders"), "reason was: {reason}");
    }

    #[test]
    fn protected_downstream_blocks_and_names_first_sorted_hit() {
        let r = impact(
            &["cube:revenue", "metric:revenue.total_revenue"],
            3,
            "semantic",
        );
        let t = GateThreshold {
            protected: vec!["metric:revenue.total_revenue".to_string()],
            ..Default::default()
        };
        let (decision, reason) = decide("model:orders", Some(&r), &t);
        assert_eq!(decision, GateDecision::Block);
        assert!(
            reason.contains("metric:revenue.total_revenue"),
            "reason was: {reason}"
        );
    }

    #[test]
    fn severity_above_max_escalates() {
        let r = impact(&["metric:revenue.total"], 3, "semantic");
        let t = GateThreshold {
            max_severity_rank: Some(2),
            ..Default::default()
        };
        let (decision, reason) = decide("model:orders", Some(&r), &t);
        assert_eq!(decision, GateDecision::Escalate);
        // The layer's own label is carried into the message; the threshold is reported as the rank
        // it is, because warble has no name for rank 2 in this layer's scale.
        assert!(reason.contains("semantic"), "reason was: {reason}");
        assert!(reason.contains("rank 3"), "reason was: {reason}");
        assert!(reason.contains("max rank 2"), "reason was: {reason}");
    }

    #[test]
    fn a_severity_name_this_module_has_never_heard_of_still_gates_on_its_rank() {
        // The point of the rank: a layer may call its worst impact anything. If this module were
        // matching on names, a vocabulary it does not share would slip past the gate.
        let r = impact(&["metric:revenue.total"], 7, "catastrophic");
        let t = GateThreshold {
            max_severity_rank: Some(2),
            ..Default::default()
        };
        let (decision, reason) = decide("model:orders", Some(&r), &t);

        assert_eq!(decision, GateDecision::Escalate);
        assert!(reason.contains("catastrophic"), "reason was: {reason}");
        assert!(reason.contains("rank 7"), "reason was: {reason}");
    }

    #[test]
    fn severity_at_or_below_max_does_not_escalate() {
        let r = impact(&["dim:revenue.status"], 1, "compatibility");
        let t = GateThreshold {
            max_severity_rank: Some(1),
            ..Default::default()
        };
        let (decision, _) = decide("model:orders", Some(&r), &t);
        assert_eq!(decision, GateDecision::Allow);
    }

    #[test]
    fn downstream_count_above_max_escalates() {
        let r = impact(&["a", "b", "c"], 1, "compatibility");
        let t = GateThreshold {
            max_downstream: Some(2),
            ..Default::default()
        };
        let (decision, reason) = decide("model:orders", Some(&r), &t);
        assert_eq!(decision, GateDecision::Escalate);
        assert!(
            reason.contains('3') && reason.contains('2'),
            "reason was: {reason}"
        );
    }

    #[test]
    fn downstream_count_at_or_below_max_allows() {
        let r = impact(&["a", "b"], 1, "compatibility");
        let t = GateThreshold {
            max_downstream: Some(2),
            ..Default::default()
        };
        let (decision, reason) = decide("model:orders", Some(&r), &t);
        assert_eq!(decision, GateDecision::Allow);
        assert!(reason.contains("within blast-radius limits"));
    }

    #[test]
    fn no_thresholds_set_always_allows_when_not_protected_and_nonempty() {
        let r = impact(&["a", "b", "c", "d"], 3, "semantic");
        let (decision, _) = decide("model:orders", Some(&r), &GateThreshold::default());
        assert_eq!(decision, GateDecision::Allow);
    }

    #[test]
    fn decision_as_str() {
        assert_eq!(GateDecision::Allow.as_str(), "allow");
        assert_eq!(GateDecision::Escalate.as_str(), "escalate");
        assert_eq!(GateDecision::Block.as_str(), "block");
    }
}
