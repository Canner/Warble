//! The `ContextLoader` trait and its narrow Info projections — the host I/O interface for
//! semantic-layer access.
//!
//! **Sans-IO, by design.** The trait lives in core and performs no filesystem or network access:
//! a host (the CLI, or a WASM/py/napi binding) reads the bound semantic layer, builds an adapter
//! that implements this trait, and injects it into [`crate::compile`]. This is the fine-grained
//! successor to the old `project_precondition_ok: bool` — instead of "the host already decided
//! pass/fail", the host now hands in an object the compiler can *probe*.
//!
//! **Warble's own narrow projection.** The Info types here are deliberately Warble's own shapes,
//! not re-exports of any semantic-format's structs (e.g. `wren-core-base`'s `Model`/`Measure`).
//! That is what keeps `context_precondition` evaluation format-agnostic: the MDL adapter is
//! adapter #1, and a future OSI (or any other) adapter implements the same trait without touching
//! core (vision §13 #14; architecture invariant #5).

/// Whether a metric's aggregation is additive across the dimensions a decomposition would drill
/// along. Inferred by an adapter from the metric's underlying aggregation; it is *not* a field any
/// current MDL carries.
///
/// - `Additive` — a sum-of-parts equals the whole (`SUM`, non-distinct `COUNT`).
/// - `NonAdditive` — parts do not sum to the whole (`AVG`, `MIN`, `MAX`, ratios, `COUNT(DISTINCT …)`).
/// - `SemiAdditive` — additive across some dimensions but not others (classically, not across
///   time — balances, inventory levels). Forward-declared: the expression heuristic in adapter #1
///   only distinguishes additive vs non-additive; producing `SemiAdditive` needs knowledge-layer
///   input (a later vocabulary batch), so it is defined but not yet emitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Additivity {
    Additive,
    SemiAdditive,
    NonAdditive,
}

/// A queryable metric — either a *declared* cube measure (whose additivity is determinable) or an
/// *implicit* numeric column projected as a metric so that `has_metric` holds on cube-less
/// projects. `declared` is the line between the two; `additivity` is `Some` only when `declared`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetricInfo {
    pub name: String,
    /// The model or cube this metric is anchored to (used to seed lineage).
    pub owner: String,
    /// `true` for a declared cube measure (a known aggregation ⇒ additivity is expressible);
    /// `false` for an implicit numeric column surfaced as a queryable quantity.
    pub declared: bool,
    /// Inferred additivity. `Some` only when `declared` (an aggregation is known); `None` means
    /// additivity is not expressible for this metric — the source of a `can_answer = false`
    /// loud-fail for `metric_additive`, as distinct from evaluating it `false`.
    pub additivity: Option<Additivity>,
}

/// A dimension the semantic layer can group/slice by — a cube dimension or a selectable model
/// column. `is_temporal` marks a DATE/TIMESTAMP-typed dimension (satisfies `has_time_dimension`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DimensionInfo {
    pub name: String,
    /// The model or cube this dimension belongs to.
    pub owner: String,
    /// Whether this dimension is time-typed (DATE / TIMESTAMP / DATETIME).
    pub is_temporal: bool,
}

/// A model in the semantic layer, narrowed to what the precondition vocabulary needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelInfo {
    pub name: String,
    /// Whether the model has at least one DATE/TIMESTAMP column (satisfies `model_has_timestamp`).
    pub has_timestamp: bool,
    /// Column names, for discoverability and lineage anchoring.
    pub columns: Vec<String>,
}

// --- lineage ------------------------------------------------------------------------------------

/// The kind of a node in the semantic lineage DAG. Ordered coarse→fine along the dependency flow
/// `raw → models → relationships → metrics/dimensions → views` (capability-model §7.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineageKind {
    Model,
    Column,
    Relationship,
    Cube,
    Metric,
    Dimension,
    View,
}

/// A node in the lineage DAG. `id` is a stable, adapter-assigned identifier (e.g. `model:orders`,
/// `column:orders.amount`, `metric:revenue.total_revenue`); it is what `blast_radius` is queried by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineageNode {
    pub id: String,
    pub kind: LineageKind,
}

/// A directed dependency edge, oriented **upstream → downstream**: `from` is the thing depended on,
/// `to` is the dependent that would break if `from` changed. `blast_radius` follows edges forward.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineageEdge {
    pub from: String,
    pub to: String,
}

/// The worst class of downstream impact in a blast radius (capability-model §7.1). Ordered least →
/// most dangerous so the overall severity of an impact set is the max over its members.
/// - `Compatibility` — a type/grain mismatch downstream.
/// - `Structural` — a downstream model/view/column breaks (loud: queries error).
/// - `Semantic` — a downstream **metric** silently shifts its numbers for every consumer (the most
///   dangerous, because it does not error).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    None,
    Compatibility,
    Structural,
    Semantic,
}

/// The read-only result of a blast-radius query: the transitive downstream closure of a node plus
/// the worst severity across it. Computed at dry-run in Phase 2 (analysis only); Phase 4 uses it to
/// gate a mutating apply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlastRadius {
    /// The node whose downstream impact was computed.
    pub seed: String,
    /// Every node transitively downstream of `seed` (sorted, excludes `seed`).
    pub downstream: Vec<String>,
    /// The worst impact class over `downstream` (`None` when nothing is downstream).
    pub severity: Severity,
}

/// The semantic lineage DAG. Built by an adapter from the bound semantic layer (structural refs:
/// relationships, cube base objects, column expressions, view statements); traversed by core.
/// `blast_radius` is a pure query over this Warble-owned type, reusable by any adapter.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LineageGraph {
    pub nodes: Vec<LineageNode>,
    pub edges: Vec<LineageEdge>,
}

impl LineageGraph {
    /// Whether every edge endpoint refers to a declared node — the structural condition behind the
    /// `lineage_resolvable` predicate (no dangling relationship/base-object/view reference).
    pub fn is_resolvable(&self) -> bool {
        self.edges
            .iter()
            .all(|e| self.contains(&e.from) && self.contains(&e.to))
    }

    /// Whether a node with the given id exists in the graph.
    pub fn contains(&self, id: &str) -> bool {
        self.nodes.iter().any(|n| n.id == id)
    }

    /// Look up a node by id.
    pub fn node(&self, id: &str) -> Option<&LineageNode> {
        self.nodes.iter().find(|n| n.id == id)
    }

    /// The blast radius of `seed`: its transitive downstream closure (forward along `from → to`
    /// edges) plus the worst downstream [`Severity`]. Read-only; cycle-safe (a visited set bounds
    /// the walk even on a malformed cyclic graph). An unknown or leaf `seed` yields an empty radius.
    pub fn blast_radius(&self, seed: &str) -> BlastRadius {
        let mut downstream: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        let mut stack = vec![seed.to_string()];
        while let Some(current) = stack.pop() {
            for edge in self.edges.iter().filter(|e| e.from == current) {
                if edge.to != seed && downstream.insert(edge.to.clone()) {
                    stack.push(edge.to.clone());
                }
            }
        }
        let severity = downstream
            .iter()
            .map(|id| self.node_severity(id))
            .max()
            .unwrap_or(Severity::None);
        BlastRadius {
            seed: seed.to_string(),
            downstream: downstream.into_iter().collect(),
            severity,
        }
    }

    /// The impact class of a single downstream node, by kind. A metric is semantic (silent number
    /// shift); a model/view/column is structural (breaks queries); relationship/cube/dimension is a
    /// compatibility concern.
    fn node_severity(&self, id: &str) -> Severity {
        match self.node(id).map(|n| n.kind) {
            Some(LineageKind::Metric) => Severity::Semantic,
            Some(LineageKind::Model | LineageKind::View | LineageKind::Column) => {
                Severity::Structural
            }
            Some(LineageKind::Relationship | LineageKind::Cube | LineageKind::Dimension) => {
                Severity::Compatibility
            }
            None => Severity::None,
        }
    }
}

// --- the trait ----------------------------------------------------------------------------------

/// Host-injected semantic-layer access. Pure on the core side (operates over an already-loaded
/// adapter); the host owns all I/O. One accessor per capability the compiler needs to *probe* the
/// bound Context for, plus `lineage` for `blast_radius`.
///
/// The two lookup methods (`metric_additivity`, `can_answer`) are provided defaults derived from
/// the Info data + the closed predicate vocabulary, so an adapter only has to fill the data; a
/// non-MDL adapter with a different answerable set may still override them.
pub trait ContextLoader {
    /// Whether the bound semantic layer assembled and parsed. Backs `mdl_parseable` /
    /// `wren_project_exists`.
    fn is_parseable(&self) -> bool;

    /// All queryable metrics (declared cube measures + implicit numeric columns).
    fn metrics(&self) -> &[MetricInfo];

    /// All groupable / queryable dimensions (cube dimensions + selectable columns).
    fn dimensions(&self) -> &[DimensionInfo];

    /// Time dimensions — the temporal subset that satisfies `has_time_dimension`.
    fn time_dimensions(&self) -> &[DimensionInfo];

    /// All models in the layer.
    fn models(&self) -> &[ModelInfo];

    /// A single model by name.
    fn model(&self, name: &str) -> Option<&ModelInfo> {
        self.models().iter().find(|m| m.name == name)
    }

    /// The semantic lineage DAG (for `lineage_resolvable` + `blast_radius`).
    fn lineage(&self) -> &LineageGraph;

    /// Additivity of a *declared* metric, or `None` when the metric is not declared or its
    /// additivity is not expressible (⇒ `can_answer("metric_additive")` is `false` for it).
    fn metric_additivity(&self, metric: &str) -> Option<Additivity> {
        self.metrics()
            .iter()
            .find(|m| m.name == metric)
            .and_then(|m| m.additivity)
    }

    /// Capability probe: can this Context answer `predicate` *at all*? A `false` here is a
    /// different loud-fail from evaluating the predicate `false` — it means the semantic format
    /// cannot carry the answer, so the compiler must refuse rather than guess (D2 / impl-notes §6).
    ///
    /// In the current vocabulary only `metric_additive` can be unanswerable: additivity is
    /// expressible only over declared metrics, so a project with no declared metric cannot answer
    /// it. Every other predicate is answerable by inspection (it evaluates true or false).
    fn can_answer(&self, predicate: &str) -> bool {
        match predicate {
            "metric_additive" => self.metrics().iter().any(|m| m.declared),
            "mdl_parseable"
            | "wren_project_exists"
            | "has_metric"
            | "has_queryable_dimension"
            | "has_time_dimension"
            | "has_groupable_dimension"
            | "model_has_timestamp"
            | "lineage_resolvable" => true,
            // Unknown predicates are rejected earlier by the closed-vocabulary check; treating an
            // unknown here as unanswerable is defense-in-depth.
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal in-test adapter so the trait's provided methods can be exercised without the MDL
    /// adapter crate (which lives in the binding layer).
    struct FakeContext {
        metrics: Vec<MetricInfo>,
        dimensions: Vec<DimensionInfo>,
        models: Vec<ModelInfo>,
        lineage: LineageGraph,
        parseable: bool,
    }

    impl ContextLoader for FakeContext {
        fn is_parseable(&self) -> bool {
            self.parseable
        }
        fn metrics(&self) -> &[MetricInfo] {
            &self.metrics
        }
        fn dimensions(&self) -> &[DimensionInfo] {
            &self.dimensions
        }
        fn time_dimensions(&self) -> &[DimensionInfo] {
            // The temporal subset; adapters cache this, but deriving it here keeps the fake small.
            // (Provided methods don't call this, so an empty slice would also do.)
            &self.dimensions
        }
        fn models(&self) -> &[ModelInfo] {
            &self.models
        }
        fn lineage(&self) -> &LineageGraph {
            &self.lineage
        }
    }

    fn metric(name: &str, declared: bool, additivity: Option<Additivity>) -> MetricInfo {
        MetricInfo {
            name: name.to_string(),
            owner: "m".to_string(),
            declared,
            additivity,
        }
    }

    #[test]
    fn metric_additivity_looks_up_declared_metric() {
        let ctx = FakeContext {
            metrics: vec![
                metric("total_revenue", true, Some(Additivity::Additive)),
                metric("avg_order", true, Some(Additivity::NonAdditive)),
                metric("amount", false, None),
            ],
            dimensions: vec![],
            models: vec![],
            lineage: LineageGraph::default(),
            parseable: true,
        };
        assert_eq!(
            ctx.metric_additivity("total_revenue"),
            Some(Additivity::Additive)
        );
        assert_eq!(
            ctx.metric_additivity("avg_order"),
            Some(Additivity::NonAdditive)
        );
        // implicit column: not expressible
        assert_eq!(ctx.metric_additivity("amount"), None);
        // absent metric
        assert_eq!(ctx.metric_additivity("nope"), None);
    }

    #[test]
    fn can_answer_metric_additive_needs_a_declared_metric() {
        // No declared metric (cube-less project) → metric_additive is unanswerable.
        let cubeless = FakeContext {
            metrics: vec![metric("amount", false, None)],
            dimensions: vec![],
            models: vec![],
            lineage: LineageGraph::default(),
            parseable: true,
        };
        assert!(!cubeless.can_answer("metric_additive"));
        // A declared metric exists → answerable (then it evaluates true/false separately).
        let with_cube = FakeContext {
            metrics: vec![metric("total_revenue", true, Some(Additivity::Additive))],
            dimensions: vec![],
            models: vec![],
            lineage: LineageGraph::default(),
            parseable: true,
        };
        assert!(with_cube.can_answer("metric_additive"));
    }

    #[test]
    fn can_answer_existence_predicates_always_true() {
        let ctx = FakeContext {
            metrics: vec![],
            dimensions: vec![],
            models: vec![],
            lineage: LineageGraph::default(),
            parseable: false,
        };
        for p in [
            "mdl_parseable",
            "wren_project_exists",
            "has_metric",
            "has_queryable_dimension",
            "has_time_dimension",
            "has_groupable_dimension",
            "model_has_timestamp",
            "lineage_resolvable",
        ] {
            assert!(ctx.can_answer(p), "{p} should be answerable");
        }
        assert!(!ctx.can_answer("some_future_unknown_predicate"));
    }

    #[test]
    fn lineage_resolvable_detects_dangling_edges() {
        let good = LineageGraph {
            nodes: vec![
                LineageNode {
                    id: "model:orders".into(),
                    kind: LineageKind::Model,
                },
                LineageNode {
                    id: "metric:revenue".into(),
                    kind: LineageKind::Metric,
                },
            ],
            edges: vec![LineageEdge {
                from: "model:orders".into(),
                to: "metric:revenue".into(),
            }],
        };
        assert!(good.is_resolvable());

        let dangling = LineageGraph {
            nodes: vec![LineageNode {
                id: "model:orders".into(),
                kind: LineageKind::Model,
            }],
            edges: vec![LineageEdge {
                from: "model:orders".into(),
                to: "metric:missing".into(),
            }],
        };
        assert!(!dangling.is_resolvable());
    }

    fn node(id: &str, kind: LineageKind) -> LineageNode {
        LineageNode {
            id: id.into(),
            kind,
        }
    }
    fn edge(from: &str, to: &str) -> LineageEdge {
        LineageEdge {
            from: from.into(),
            to: to.into(),
        }
    }

    /// `model → cube → {metric, dim}`, plus a view off the model — the jaffle-shaped chain.
    fn sample_graph() -> LineageGraph {
        LineageGraph {
            nodes: vec![
                node("model:orders", LineageKind::Model),
                node("cube:revenue", LineageKind::Cube),
                node("metric:revenue.total", LineageKind::Metric),
                node("dim:revenue.status", LineageKind::Dimension),
                node("view:orders_view", LineageKind::View),
            ],
            edges: vec![
                edge("model:orders", "cube:revenue"),
                edge("cube:revenue", "metric:revenue.total"),
                edge("cube:revenue", "dim:revenue.status"),
                edge("model:orders", "view:orders_view"),
            ],
        }
    }

    #[test]
    fn blast_radius_is_the_transitive_downstream_closure() {
        let graph = sample_graph();
        let radius = graph.blast_radius("model:orders");
        assert_eq!(
            radius.downstream,
            vec![
                "cube:revenue".to_string(),
                "dim:revenue.status".to_string(),
                "metric:revenue.total".to_string(),
                "view:orders_view".to_string(),
            ],
            "changing the base model reaches the cube, its members, and the view"
        );
        // A downstream metric makes the worst impact semantic (silent number shift).
        assert_eq!(radius.severity, Severity::Semantic);
    }

    #[test]
    fn blast_radius_of_a_leaf_is_empty() {
        let graph = sample_graph();
        let radius = graph.blast_radius("metric:revenue.total");
        assert!(radius.downstream.is_empty());
        assert_eq!(radius.severity, Severity::None);
    }

    #[test]
    fn blast_radius_severity_is_the_max_over_downstream() {
        let graph = sample_graph();
        // The cube's downstream is a metric (semantic) + a dimension (compatibility) → semantic.
        assert_eq!(
            graph.blast_radius("cube:revenue").severity,
            Severity::Semantic
        );
        // A model whose only downstream is a view → structural (no metric reached).
        let structural = LineageGraph {
            nodes: vec![
                node("model:m", LineageKind::Model),
                node("view:v", LineageKind::View),
            ],
            edges: vec![edge("model:m", "view:v")],
        };
        assert_eq!(
            structural.blast_radius("model:m").severity,
            Severity::Structural
        );
    }

    #[test]
    fn blast_radius_is_cycle_safe() {
        // A pathological cyclic graph must still terminate.
        let cyclic = LineageGraph {
            nodes: vec![node("a", LineageKind::Model), node("b", LineageKind::Model)],
            edges: vec![edge("a", "b"), edge("b", "a")],
        };
        let radius = cyclic.blast_radius("a");
        assert_eq!(radius.downstream, vec!["b".to_string()]);
    }

    #[test]
    fn severity_ordering() {
        assert!(Severity::Semantic > Severity::Structural);
        assert!(Severity::Structural > Severity::Compatibility);
        assert!(Severity::Compatibility > Severity::None);
    }
}
