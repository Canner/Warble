//! Golden case selection for stratified eval runs (roadmap "eval speed" P3).
//!
//! Smoke / full / matrix runs differ only in *which* golden cases they replay:
//! - **full**   = every case, no filter — one config, the `eval gate` input (< 10 min).
//! - **smoke**  = a representative subset — `--sample per-tag:1` (± `--tags`) — the inner loop
//!   (< 2 min once parallel). One case per trap tag keeps coverage while collapsing driftwood's
//!   19 tags to ~8 cases.
//! - **matrix** = full cases × every config — scheduled/manual (no filter here; the config axis
//!   lives in `--models` / ablation).
//!
//! This is the pure, host-agnostic selector that `--tags` / `--sample` drive. It never silently
//! drops cases: [`select_cases`] returns a human-readable [`Selection::note`] recording how many
//! it kept out of the total (the no-silent-caps invariant, eval-speed-and-direction §3).

use crate::GoldenCase;

/// How to sub-select from the (tag-filtered) golden cases. Parsed from `--sample`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Sample {
    /// At most `N` cases total, spread evenly across the list in file order (`--sample 8`).
    Count(usize),
    /// A fraction `0 < f < 1` of the cases, spread evenly (ceil, at least 1) (`--sample 0.2`, `--sample 20%`).
    Ratio(f64),
    /// At most `K` cases per distinct tag — the smoke selector (`--sample per-tag:1`). Greedy in
    /// file order: a case is kept iff one of its tags is still under the `K` quota, and keeping it
    /// counts toward *all* its tags — so a multi-tag case covers several tags at once.
    PerTag(usize),
}

impl Sample {
    /// Parse a `--sample` value: `N` (count), a fraction `0.2` / `20%` (ratio), or `per-tag[:K]`.
    pub fn parse(s: &str) -> Result<Self, String> {
        let s = s.trim();
        if let Some(rest) = s.strip_prefix("per-tag") {
            let k = match rest.strip_prefix(':') {
                Some(n) => n.trim().parse::<usize>().map_err(|_| {
                    format!("invalid --sample count in '{s}' (expected per-tag:<N>)")
                })?,
                None if rest.is_empty() => 1,
                None => {
                    return Err(format!(
                        "invalid --sample '{s}' (expected `per-tag` or `per-tag:<N>`)"
                    ))
                }
            };
            if k == 0 {
                return Err("--sample per-tag:0 selects nothing".to_string());
            }
            return Ok(Sample::PerTag(k));
        }
        if let Some(pct) = s.strip_suffix('%') {
            let p: f64 = pct
                .trim()
                .parse()
                .map_err(|_| format!("invalid --sample percent '{s}'"))?;
            if !(p > 0.0 && p <= 100.0) {
                return Err(format!("--sample percent must be in (0, 100], got '{s}'"));
            }
            return Ok(Sample::Ratio(p / 100.0));
        }
        // A bare integer is a count; a bare fraction in (0,1) is a ratio.
        if let Ok(n) = s.parse::<usize>() {
            if n == 0 {
                return Err("--sample 0 selects nothing".to_string());
            }
            return Ok(Sample::Count(n));
        }
        if let Ok(f) = s.parse::<f64>() {
            if f > 0.0 && f < 1.0 {
                return Ok(Sample::Ratio(f));
            }
            return Err(format!(
                "--sample fraction must be in (0, 1), got '{s}' (use an integer for a count)"
            ));
        }
        Err(format!(
            "invalid --sample '{s}' (expected a count `8`, a fraction `0.2` / `20%`, or `per-tag[:K]`)"
        ))
    }
}

/// A `--tags` + `--sample` selection over a golden file's cases.
#[derive(Debug, Clone, Default)]
pub struct CaseFilter {
    /// Keep only cases carrying at least one of these tags (union). Empty = keep every tag.
    pub tags: Vec<String>,
    /// Sub-select from the tag-filtered cases. `None` = keep all (a full run).
    pub sample: Option<Sample>,
}

impl CaseFilter {
    /// Build from CLI strings: a comma-separated `--tags` and an optional `--sample`.
    pub fn from_flags(tags: &str, sample: Option<&str>) -> Result<Self, String> {
        let tags = tags
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        let sample = match sample {
            Some(s) => Some(Sample::parse(s)?),
            None => None,
        };
        Ok(CaseFilter { tags, sample })
    }

    /// True when the filter can select a strict subset (any `--tags` or `--sample` given).
    pub fn is_active(&self) -> bool {
        !self.tags.is_empty() || self.sample.is_some()
    }
}

/// The result of applying a [`CaseFilter`]: indices into the original slice (ascending), plus a
/// note recording `selected/total` so a partial (smoke) run is always visible.
#[derive(Debug, Clone)]
pub struct Selection {
    /// Indices into the input `cases` slice, ascending (file order preserved).
    pub indices: Vec<usize>,
    /// Cases before filtering.
    pub total: usize,
    /// One-line, no-silent-caps summary of what was kept and why.
    pub note: String,
}

impl Selection {
    /// Number of cases kept.
    pub fn selected(&self) -> usize {
        self.indices.len()
    }
}

/// Apply `filter` to `cases`: tag-filter first (union over `--tags`), then `--sample`. Deterministic
/// and order-preserving so re-runs are comparable.
pub fn select_cases(cases: &[GoldenCase], filter: &CaseFilter) -> Selection {
    let total = cases.len();

    // 1. Tag filter: keep cases carrying at least one requested tag.
    let pool: Vec<usize> = if filter.tags.is_empty() {
        (0..total).collect()
    } else {
        (0..total)
            .filter(|&i| {
                cases[i]
                    .tags
                    .iter()
                    .any(|t| filter.tags.iter().any(|w| w == t))
            })
            .collect()
    };

    // 2. Sample within the tag-filtered pool.
    let indices = match filter.sample {
        None => pool.clone(),
        Some(Sample::Count(n)) => even_pick(&pool, n),
        Some(Sample::Ratio(f)) => {
            let k = ((pool.len() as f64 * f).ceil() as usize).clamp(1.min(pool.len()), pool.len());
            even_pick(&pool, k)
        }
        Some(Sample::PerTag(k)) => per_tag_pick(cases, &pool, k),
    };

    let note = describe(filter, indices.len(), total);
    Selection {
        indices,
        total,
        note,
    }
}

/// Pick `k` indices spread evenly across `pool`, preserving order. `k >= len` keeps everything.
fn even_pick(pool: &[usize], k: usize) -> Vec<usize> {
    let n = pool.len();
    if k >= n {
        return pool.to_vec();
    }
    if k == 0 {
        return Vec::new();
    }
    // pos = i*n/k is strictly increasing for k <= n (step >= floor(n/k) >= 1), so indices are
    // distinct; the `last` guard is a defensive dedup.
    let mut picked = Vec::with_capacity(k);
    let mut last: Option<usize> = None;
    for i in 0..k {
        let pos = i * n / k;
        if last != Some(pos) {
            picked.push(pool[pos]);
            last = Some(pos);
        }
    }
    picked
}

/// Greedy per-tag selection: keep a case iff one of its tags is still under the `K` quota; keeping
/// it counts toward every tag it carries. Untagged cases share a single `""` bucket so they are
/// not silently dropped by a per-tag smoke.
fn per_tag_pick(cases: &[GoldenCase], pool: &[usize], k: usize) -> Vec<usize> {
    use std::collections::HashMap;
    let mut count: HashMap<&str, usize> = HashMap::new();
    let mut picked = Vec::new();
    for &i in pool {
        let tags = &cases[i].tags;
        let buckets: Vec<&str> = if tags.is_empty() {
            vec![""]
        } else {
            tags.iter().map(String::as_str).collect()
        };
        let covers_new = buckets.iter().any(|b| *count.get(b).unwrap_or(&0) < k);
        if covers_new {
            for b in buckets {
                *count.entry(b).or_insert(0) += 1;
            }
            picked.push(i);
        }
    }
    picked
}

/// One-line summary of the selection (printed to stderr and, via the caller, recorded in the report).
fn describe(filter: &CaseFilter, selected: usize, total: usize) -> String {
    let mut parts = Vec::new();
    if !filter.tags.is_empty() {
        parts.push(format!("tags∈{{{}}}", filter.tags.join(",")));
    }
    match filter.sample {
        Some(Sample::Count(n)) => parts.push(format!("sample≤{n} (even stride)")),
        Some(Sample::Ratio(f)) => parts.push(format!("sample {:.0}% (even stride)", f * 100.0)),
        Some(Sample::PerTag(k)) => parts.push(format!("sample per-tag:{k}")),
        None => {}
    }
    let filt = if parts.is_empty() {
        "no filter".to_string()
    } else {
        parts.join("; ")
    };
    format!("golden selection: {selected}/{total} cases [{filt}]")
}

#[cfg(test)]
mod tests {
    use super::*;
    use warble_eval_compare::{MatchMode, Table, Tolerance};

    fn case(id: &str, tags: &[&str]) -> GoldenCase {
        GoldenCase {
            id: id.to_string(),
            question: format!("q {id}"),
            tags: tags.iter().map(|s| s.to_string()).collect(),
            match_mode: MatchMode::Scalar,
            tolerance: Tolerance::default(),
            expected: Table {
                columns: vec!["n".into()],
                rows: vec![vec![serde_json::json!(1)]],
            },
        }
    }

    fn ids(cases: &[GoldenCase], sel: &Selection) -> Vec<String> {
        sel.indices.iter().map(|&i| cases[i].id.clone()).collect()
    }

    // --- Sample::parse ---------------------------------------------------------------------------

    #[test]
    fn parse_count_ratio_pertag_and_percent() {
        assert_eq!(Sample::parse("8").unwrap(), Sample::Count(8));
        assert_eq!(Sample::parse("per-tag").unwrap(), Sample::PerTag(1));
        assert_eq!(Sample::parse("per-tag:2").unwrap(), Sample::PerTag(2));
        match Sample::parse("0.25").unwrap() {
            Sample::Ratio(f) => assert!((f - 0.25).abs() < 1e-9),
            other => panic!("expected ratio, got {other:?}"),
        }
        match Sample::parse("20%").unwrap() {
            Sample::Ratio(f) => assert!((f - 0.20).abs() < 1e-9),
            other => panic!("expected ratio, got {other:?}"),
        }
    }

    #[test]
    fn parse_rejects_nonsense_and_empty_selections() {
        assert!(Sample::parse("0").is_err());
        assert!(Sample::parse("per-tag:0").is_err());
        assert!(Sample::parse("1.0").is_err()); // not in (0,1) and not a count spelling
        assert!(Sample::parse("banana").is_err());
        assert!(Sample::parse("150%").is_err());
    }

    // --- tag filter ------------------------------------------------------------------------------

    #[test]
    fn tags_union_keeps_cases_carrying_any_requested_tag() {
        let cases = vec![
            case("a", &["easy"]),
            case("b", &["hard", "join"]),
            case("c", &["join"]),
            case("d", &["timezone"]),
        ];
        let f = CaseFilter::from_flags("easy,join", None).unwrap();
        let sel = select_cases(&cases, &f);
        assert_eq!(ids(&cases, &sel), vec!["a", "b", "c"]);
        assert_eq!(sel.total, 4);
        assert!(sel.note.contains("3/4"));
    }

    #[test]
    fn empty_filter_keeps_everything_in_order() {
        let cases = vec![case("a", &["x"]), case("b", &[]), case("c", &["y"])];
        let sel = select_cases(&cases, &CaseFilter::default());
        assert_eq!(sel.selected(), 3);
        assert!(!CaseFilter::default().is_active());
    }

    // --- even stride sampling --------------------------------------------------------------------

    #[test]
    fn count_sample_is_evenly_spread_and_deterministic() {
        let cases: Vec<GoldenCase> = (0..10).map(|i| case(&format!("c{i}"), &["t"])).collect();
        let f = CaseFilter::from_flags("", Some("3")).unwrap();
        let sel = select_cases(&cases, &f);
        // 0, 3, 6 — spread across the range, not the first three.
        assert_eq!(ids(&cases, &sel), vec!["c0", "c3", "c6"]);
        // deterministic
        assert_eq!(ids(&cases, &select_cases(&cases, &f)), ids(&cases, &sel));
    }

    #[test]
    fn count_larger_than_pool_keeps_all() {
        let cases = vec![case("a", &["t"]), case("b", &["t"])];
        let f = CaseFilter::from_flags("", Some("9")).unwrap();
        assert_eq!(select_cases(&cases, &f).selected(), 2);
    }

    #[test]
    fn ratio_sample_ceils_to_at_least_one() {
        let cases: Vec<GoldenCase> = (0..10).map(|i| case(&format!("c{i}"), &["t"])).collect();
        let sel = select_cases(&cases, &CaseFilter::from_flags("", Some("0.2")).unwrap());
        assert_eq!(sel.selected(), 2); // ceil(10*0.2)
        let one = select_cases(&cases, &CaseFilter::from_flags("", Some("1%")).unwrap());
        assert_eq!(one.selected(), 1); // ceil(10*0.01)=1, never zero
    }

    // --- per-tag smoke selector ------------------------------------------------------------------

    #[test]
    fn per_tag_one_collapses_multi_tag_cases_to_a_covering_set() {
        // 5 cases, tags {easy, time, tld, join}. per-tag:1 should touch every tag with the
        // fewest cases, greedily in file order.
        let cases = vec![
            case("g1", &["easy"]),         // covers easy
            case("g2", &["easy", "time"]), // easy already covered, but time is new -> kept
            case("g3", &["time"]),         // time covered by g2 -> dropped
            case("g4", &["tld", "join"]),  // both new -> kept
            case("g5", &["join"]),         // join covered -> dropped
        ];
        let sel = select_cases(
            &cases,
            &CaseFilter::from_flags("", Some("per-tag:1")).unwrap(),
        );
        assert_eq!(ids(&cases, &sel), vec!["g1", "g2", "g4"]);
        assert!(sel.note.contains("per-tag:1"));
    }

    #[test]
    fn per_tag_k_allows_k_representatives_per_tag() {
        let cases = vec![
            case("g1", &["easy"]),
            case("g2", &["easy"]),
            case("g3", &["easy"]),
        ];
        let sel = select_cases(
            &cases,
            &CaseFilter::from_flags("", Some("per-tag:2")).unwrap(),
        );
        assert_eq!(ids(&cases, &sel), vec!["g1", "g2"]);
    }

    #[test]
    fn per_tag_keeps_untagged_cases_in_their_own_bucket() {
        let cases = vec![case("a", &[]), case("b", &[]), case("c", &["x"])];
        let sel = select_cases(
            &cases,
            &CaseFilter::from_flags("", Some("per-tag:1")).unwrap(),
        );
        // one untagged (a) + the tagged (c); b dropped as the 2nd untagged.
        assert_eq!(ids(&cases, &sel), vec!["a", "c"]);
    }

    #[test]
    fn tags_then_sample_compose() {
        let cases = vec![
            case("a", &["easy"]),
            case("b", &["easy", "join"]),
            case("c", &["join"]),
            case("d", &["timezone"]),
        ];
        // among {easy|join} cases (a,b,c), take 1 per tag: a(easy), b(join) -> c dropped.
        let f = CaseFilter::from_flags("easy,join", Some("per-tag:1")).unwrap();
        let sel = select_cases(&cases, &f);
        assert_eq!(ids(&cases, &sel), vec!["a", "b"]);
        assert!(sel.note.contains("tags∈{easy,join}"));
        assert!(sel.note.contains("per-tag:1"));
    }
}
