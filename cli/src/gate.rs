//! Gate-decision policy over an already-computed [`warble::BlastRadius`] (Phase 4a — the mutating
//! guardrail described in `docs/spec/blast-radius.md` §6). Pure, no I/O: the host computes the
//! radius (via [`crate::blast_radius_for_project`]), then this module turns it plus a threshold into
//! a decision the host can act on (allow the apply, escalate to human approval, or hard-block it).

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
/// `max_severity`/`max_downstream` simply never triggers that branch of the policy.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GateThreshold {
    /// Escalate when the radius's severity is strictly above this ceiling.
    pub max_severity: Option<warble::Severity>,
    /// Escalate when the radius's downstream count is strictly above this ceiling.
    pub max_downstream: Option<usize>,
    /// Node ids that force a hard block if they are the seed or anywhere in the downstream set.
    pub protected: Vec<String>,
}

/// Human-readable name for a [`warble::Severity`] (the inverse of [`parse_severity`]).
pub fn severity_str(severity: warble::Severity) -> &'static str {
    match severity {
        warble::Severity::None => "none",
        warble::Severity::Compatibility => "compatibility",
        warble::Severity::Structural => "structural",
        warble::Severity::Semantic => "semantic",
    }
}

/// Parse a [`warble::Severity`] from its human-readable name (the inverse of [`severity_str`]).
/// Case-insensitive; returns `None` for anything else (the caller should reject an unknown flag
/// value rather than silently defaulting).
pub fn parse_severity(s: &str) -> Option<warble::Severity> {
    match s.to_ascii_lowercase().as_str() {
        "none" => Some(warble::Severity::None),
        "compatibility" => Some(warble::Severity::Compatibility),
        "structural" => Some(warble::Severity::Structural),
        "semantic" => Some(warble::Severity::Semantic),
        _ => None,
    }
}

/// Pure policy over an already-computed radius. Returns the decision plus a human-readable reason
/// (surfaced to the operator / logged, not machine-parsed).
///
/// Policy, evaluated in order (first match wins):
/// 1. Empty blast radius → `Allow`.
/// 2. The seed or any downstream node is in `t.protected` → `Block` (names the first hit: seed
///    checked before downstream, downstream in its existing sorted order).
/// 3. `t.max_severity` is set and the radius severity exceeds it → `Escalate`.
/// 4. `t.max_downstream` is set and the downstream count exceeds it → `Escalate`.
/// 5. Otherwise → `Allow`.
pub fn decide(radius: &warble::BlastRadius, t: &GateThreshold) -> (GateDecision, String) {
    if radius.downstream.is_empty() {
        return (
            GateDecision::Allow,
            "empty blast radius — no downstream impact".to_string(),
        );
    }

    if let Some(hit) = std::iter::once(&radius.seed)
        .chain(radius.downstream.iter())
        .find(|id| t.protected.contains(id))
    {
        return (
            GateDecision::Block,
            format!("touches protected asset '{hit}'"),
        );
    }

    if let Some(max) = t.max_severity {
        if radius.severity > max {
            return (
                GateDecision::Escalate,
                format!(
                    "radius severity '{}' exceeds max '{}'",
                    severity_str(radius.severity),
                    severity_str(max)
                ),
            );
        }
    }

    if let Some(max) = t.max_downstream {
        if radius.downstream.len() > max {
            return (
                GateDecision::Escalate,
                format!(
                    "blast radius of {} nodes exceeds max {max}",
                    radius.downstream.len()
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
    use warble::Severity;

    fn radius(seed: &str, downstream: &[&str], severity: Severity) -> warble::BlastRadius {
        warble::BlastRadius {
            seed: seed.to_string(),
            downstream: downstream.iter().map(|s| s.to_string()).collect(),
            severity,
        }
    }

    #[test]
    fn empty_radius_allows() {
        let r = radius("model:x", &[], Severity::None);
        let (decision, reason) = decide(&r, &GateThreshold::default());
        assert_eq!(decision, GateDecision::Allow);
        assert!(reason.contains("no downstream impact"));
    }

    #[test]
    fn protected_seed_blocks() {
        let r = radius("model:orders", &["cube:revenue"], Severity::Compatibility);
        let t = GateThreshold {
            protected: vec!["model:orders".to_string()],
            ..Default::default()
        };
        let (decision, reason) = decide(&r, &t);
        assert_eq!(decision, GateDecision::Block);
        assert!(reason.contains("model:orders"), "reason was: {reason}");
    }

    #[test]
    fn protected_downstream_blocks_and_names_first_sorted_hit() {
        let r = radius(
            "model:orders",
            &["cube:revenue", "metric:revenue.total_revenue"],
            Severity::Semantic,
        );
        let t = GateThreshold {
            protected: vec!["metric:revenue.total_revenue".to_string()],
            ..Default::default()
        };
        let (decision, reason) = decide(&r, &t);
        assert_eq!(decision, GateDecision::Block);
        assert!(
            reason.contains("metric:revenue.total_revenue"),
            "reason was: {reason}"
        );
    }

    #[test]
    fn severity_above_max_escalates() {
        let r = radius(
            "model:orders",
            &["metric:revenue.total"],
            Severity::Semantic,
        );
        let t = GateThreshold {
            max_severity: Some(Severity::Structural),
            ..Default::default()
        };
        let (decision, reason) = decide(&r, &t);
        assert_eq!(decision, GateDecision::Escalate);
        assert!(reason.contains("semantic"), "reason was: {reason}");
        assert!(reason.contains("structural"), "reason was: {reason}");
    }

    #[test]
    fn severity_at_or_below_max_does_not_escalate() {
        let r = radius(
            "model:orders",
            &["dim:revenue.status"],
            Severity::Compatibility,
        );
        let t = GateThreshold {
            max_severity: Some(Severity::Compatibility),
            ..Default::default()
        };
        let (decision, _) = decide(&r, &t);
        assert_eq!(decision, GateDecision::Allow);
    }

    #[test]
    fn downstream_count_above_max_escalates() {
        let r = radius("model:orders", &["a", "b", "c"], Severity::Compatibility);
        let t = GateThreshold {
            max_downstream: Some(2),
            ..Default::default()
        };
        let (decision, reason) = decide(&r, &t);
        assert_eq!(decision, GateDecision::Escalate);
        assert!(
            reason.contains('3') && reason.contains('2'),
            "reason was: {reason}"
        );
    }

    #[test]
    fn downstream_count_at_or_below_max_allows() {
        let r = radius("model:orders", &["a", "b"], Severity::Compatibility);
        let t = GateThreshold {
            max_downstream: Some(2),
            ..Default::default()
        };
        let (decision, reason) = decide(&r, &t);
        assert_eq!(decision, GateDecision::Allow);
        assert!(reason.contains("within blast-radius limits"));
    }

    #[test]
    fn no_thresholds_set_always_allows_when_not_protected_and_nonempty() {
        let r = radius("model:orders", &["a", "b", "c", "d"], Severity::Semantic);
        let (decision, _) = decide(&r, &GateThreshold::default());
        assert_eq!(decision, GateDecision::Allow);
    }

    #[test]
    fn severity_str_and_parse_severity_round_trip() {
        for s in [
            Severity::None,
            Severity::Compatibility,
            Severity::Structural,
            Severity::Semantic,
        ] {
            let name = severity_str(s);
            assert_eq!(
                parse_severity(name),
                Some(s),
                "round-trip failed for {name}"
            );
        }
        assert_eq!(parse_severity("SEMANTIC"), Some(Severity::Semantic));
        assert_eq!(parse_severity("nonsense"), None);
    }

    #[test]
    fn decision_as_str() {
        assert_eq!(GateDecision::Allow.as_str(), "allow");
        assert_eq!(GateDecision::Escalate.as_str(), "escalate");
        assert_eq!(GateDecision::Block.as_str(), "block");
    }
}
