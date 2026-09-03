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
//! core (architecture invariant #2).

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
/// `raw → models → relationships → metrics/dimensions → views → consumers` (capability-model §7.1).
/// `Query` and `Dashboard` are *consumer* nodes — artifacts outside the semantic layer (a confirmed
/// saved query, a dashboard spec) that depend on it; they are always sinks, never upstream of a
/// semantic node.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineageKind {
    Model,
    Column,
    Relationship,
    Cube,
    Metric,
    Dimension,
    View,
    Query,
    Dashboard,
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
    /// shift); a consumer (query/dashboard) is likewise semantic — the end user sees silently
    /// shifted numbers, not an error; a model/view/column is structural (breaks queries);
    /// relationship/cube/dimension is a compatibility concern.
    fn node_severity(&self, id: &str) -> Severity {
        match self.node(id).map(|n| n.kind) {
            Some(LineageKind::Metric | LineageKind::Query | LineageKind::Dashboard) => {
                Severity::Semantic
            }
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

    /// The underlying parse/assembly failure text, when [`Self::is_parseable`] is `false` and the
    /// adapter has one to offer (e.g. a serde error from the bound project's manifest). Message-only
    /// enrichment for the `mdl_parseable` precondition failure — never used for control flow.
    /// Defaults to `None` (no detail beyond the generic floor message); an adapter that keeps the
    /// real error around overrides it.
    fn parse_error(&self) -> Option<&str> {
        None
    }

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

    /// Raw-shape probe (constitutive family): whether the bound **raw** source can have its schema
    /// introspected (the precondition `source_introspectable`). This *inverts* the consumer probes
    /// above: a constitutive component's input is a raw source that has no MDL yet — the component's
    /// output *is* the MDL. `Some(true)` = introspectable, `Some(false)` = a raw source is bound but
    /// not introspectable, `None` = this Context cannot answer raw-shape at all (an MDL-only adapter),
    /// which the compiler turns into an *unanswerable* loud-fail rather than guessing (the same
    /// distinction `metric_additive` draws). Defaults to `None` so existing MDL adapters are unaffected;
    /// a raw-source adapter overrides it (schema introspection is borrowed — dlt/wren — never built).
    fn source_introspectable(&self) -> Option<bool> {
        None
    }

    /// Raw-shape probe (constitutive family): whether readable raw business docs back a knowledge
    /// enrichment (the precondition `raw_docs_readable`). Same `Some`/`None` semantics as
    /// [`Self::source_introspectable`]; defaults to `None` (MDL-only adapters cannot answer it).
    fn raw_docs_readable(&self) -> Option<bool> {
        None
    }

    /// Human-readable notes about where lineage construction had to degrade (e.g. a consumer's SQL
    /// failed to parse and a cruder text scan was used, or a malformed consumer file was skipped).
    /// Surfaced into the IR's resolved binding so a thinner-than-authored graph is never silent
    /// (no silent caps). Defaults to empty: an adapter with nothing to confess reports nothing.
    fn lineage_diagnostics(&self) -> &[String] {
        &[]
    }

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
    /// cannot carry the answer, so the compiler must refuse rather than guess.
    ///
    /// In the current vocabulary `metric_additive` (needs a declared metric) and the constitutive
    /// raw-shape predicates (`source_introspectable` / `raw_docs_readable`, answerable only by a
    /// raw-source adapter) can be unanswerable. Every other predicate is answerable by inspection
    /// (it evaluates true or false).
    fn can_answer(&self, predicate: &str) -> bool {
        match predicate {
            "metric_additive" => self.metrics().iter().any(|m| m.declared),
            // Constitutive raw-shape: answerable iff this Context actually probes a raw source
            // (`Some(_)`); an MDL-only adapter returns `None` ⇒ unanswerable.
            "source_introspectable" => self.source_introspectable().is_some(),
            "raw_docs_readable" => self.raw_docs_readable().is_some(),
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

/// A binding whose semantic layer is **not reachable from here** — held by a service that answers
/// the questions itself, or simply not pulled onto this machine.
///
/// It is well-formed, so [`ContextLoader::is_parseable`] holds and the compiler's coarse floor
/// passes: the binding resolved, there is just no local MDL behind it. Beyond that it answers
/// nothing. Every precondition against it comes back *unanswerable* rather than false, which is the
/// point — a profile bound this way cannot quietly gate on schema facts nobody checked, and an
/// author who wants such a gate is told to bind a context that can answer it instead.
///
/// This is what makes an offline delegating profile honest. Reporting empty collections *without*
/// declining the probes would be worse than useless: `has_metric` would evaluate to a confident
/// `false` about a layer this process has never seen.
#[derive(Debug, Default)]
pub struct ExternalContext {
    lineage: LineageGraph,
}

impl ExternalContext {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ContextLoader for ExternalContext {
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
    fn can_answer(&self, _predicate: &str) -> bool {
        false
    }
}

// --- prepared context -----------------------------------------------------------------------

/// The wire-format version of a prepared-context document.
///
/// Deliberately **decoupled from the IR version**: this contract runs between a host's own context
/// adapter and `warble compile`, and it versions on its own schedule. A document declaring any
/// other version is a loud-fail, never a best-effort read.
pub const PREPARED_CONTEXT_VERSION: u32 = 1;

/// Why a prepared-context document could not be read.
#[derive(Debug, thiserror::Error)]
pub enum PreparedContextError {
    /// The document is not well-formed JSON, or does not match the expected shape. Unknown fields
    /// are rejected rather than ignored: a field this build does not understand means the producer
    /// is describing something this build would silently drop.
    #[error("prepared context is not a valid document: {0}")]
    Malformed(#[from] serde_json::Error),
    /// The document declares a wire version this build does not read.
    #[error(
        "prepared context declares context_version {found}, but this build reads {}",
        PREPARED_CONTEXT_VERSION
    )]
    Version {
        /// The version the document declared.
        found: u32,
    },
}

/// A [`ContextLoader`] built from a **host-supplied snapshot** rather than from a semantic layer
/// this process knows how to read.
///
/// This is the seam that keeps warble context-neutral. Reading a concrete semantic format (MDL,
/// OSI, dbt, …) means depending on that format's libraries; instead, a host resolves its own
/// format however it likes and hands warble the narrow projection the compiler actually probes —
/// the Info types and the lineage DAG, both Warble-owned shapes. The compiler's behaviour is then
/// identical to a natively-read context, because it is the *same* trait behind it.
///
/// It carries no I/O: the host reads the document, this parses the bytes. `blast_radius`, the
/// `context_precondition` vocabulary and the IR's resolved-binding summary all work unchanged.
///
/// Unanswerability round-trips. A document omitting `source_introspectable` leaves it `None`, and
/// the predicate stays *unanswerable* rather than becoming a confident `false` — the distinction
/// [`ContextLoader::can_answer`] exists to preserve.
#[derive(Debug, Default)]
pub struct PreparedContext {
    parseable: bool,
    parse_error: Option<String>,
    metrics: Vec<MetricInfo>,
    dimensions: Vec<DimensionInfo>,
    time_dimensions: Vec<DimensionInfo>,
    models: Vec<ModelInfo>,
    lineage: LineageGraph,
    lineage_diagnostics: Vec<String>,
    source_introspectable: Option<bool>,
    raw_docs_readable: Option<bool>,
}

impl PreparedContext {
    /// Parse a prepared-context document.
    ///
    /// `time_dimensions` is **derived** from the temporal subset of `dimensions` rather than being
    /// carried separately, so the two cannot disagree.
    pub fn from_json(document: &str) -> Result<Self, PreparedContextError> {
        let doc: PreparedDoc = serde_json::from_str(document)?;
        if doc.context_version != PREPARED_CONTEXT_VERSION {
            return Err(PreparedContextError::Version {
                found: doc.context_version,
            });
        }

        let dimensions: Vec<DimensionInfo> = doc
            .dimensions
            .into_iter()
            .map(|d| DimensionInfo {
                name: d.name,
                owner: d.owner,
                is_temporal: d.is_temporal,
            })
            .collect();
        let time_dimensions = dimensions
            .iter()
            .filter(|d| d.is_temporal)
            .cloned()
            .collect();

        let nodes = doc
            .lineage
            .nodes
            .into_iter()
            .map(|n| LineageNode {
                id: n.id,
                kind: n.kind.into(),
            })
            .collect();

        Ok(Self {
            parseable: doc.parseable,
            parse_error: doc.parse_error,
            metrics: doc
                .metrics
                .into_iter()
                .map(|m| MetricInfo {
                    name: m.name,
                    owner: m.owner,
                    declared: m.declared,
                    additivity: m.additivity.map(Into::into),
                })
                .collect(),
            dimensions,
            time_dimensions,
            models: doc
                .models
                .into_iter()
                .map(|m| ModelInfo {
                    name: m.name,
                    has_timestamp: m.has_timestamp,
                    columns: m.columns,
                })
                .collect(),
            lineage: LineageGraph {
                nodes,
                edges: doc
                    .lineage
                    .edges
                    .into_iter()
                    .map(|e| LineageEdge {
                        from: e.from,
                        to: e.to,
                    })
                    .collect(),
            },
            lineage_diagnostics: doc.lineage_diagnostics,
            source_introspectable: doc.source_introspectable,
            raw_docs_readable: doc.raw_docs_readable,
        })
    }
}

impl ContextLoader for PreparedContext {
    fn is_parseable(&self) -> bool {
        self.parseable
    }
    fn parse_error(&self) -> Option<&str> {
        self.parse_error.as_deref()
    }
    fn metrics(&self) -> &[MetricInfo] {
        &self.metrics
    }
    fn dimensions(&self) -> &[DimensionInfo] {
        &self.dimensions
    }
    fn time_dimensions(&self) -> &[DimensionInfo] {
        &self.time_dimensions
    }
    fn models(&self) -> &[ModelInfo] {
        &self.models
    }
    fn lineage(&self) -> &LineageGraph {
        &self.lineage
    }
    fn lineage_diagnostics(&self) -> &[String] {
        &self.lineage_diagnostics
    }
    fn source_introspectable(&self) -> Option<bool> {
        self.source_introspectable
    }
    fn raw_docs_readable(&self) -> Option<bool> {
        self.raw_docs_readable
    }
}

/// Render any [`ContextLoader`] as a prepared-context document.
///
/// This is the producer half of the seam, and it lives here so a host does not hand-roll the
/// format: an adapter that implements the trait — in this workspace or in a consuming one — gets a
/// correct document for free, and cannot drift from what [`PreparedContext::from_json`] reads.
///
/// `time_dimensions` is deliberately **not** written: it is derived on read from the temporal
/// subset of `dimensions`, so emitting it would create a second copy that could disagree.
pub fn prepared_document_from(loader: &dyn ContextLoader) -> Result<String, serde_json::Error> {
    let doc = PreparedDoc {
        context_version: PREPARED_CONTEXT_VERSION,
        parseable: loader.is_parseable(),
        parse_error: loader.parse_error().map(str::to_string),
        metrics: loader
            .metrics()
            .iter()
            .map(|m| PreparedMetric {
                name: m.name.clone(),
                owner: m.owner.clone(),
                declared: m.declared,
                additivity: m.additivity.map(Into::into),
            })
            .collect(),
        dimensions: loader
            .dimensions()
            .iter()
            .map(|d| PreparedDimension {
                name: d.name.clone(),
                owner: d.owner.clone(),
                is_temporal: d.is_temporal,
            })
            .collect(),
        models: loader
            .models()
            .iter()
            .map(|m| PreparedModel {
                name: m.name.clone(),
                has_timestamp: m.has_timestamp,
                columns: m.columns.clone(),
            })
            .collect(),
        lineage: PreparedLineage {
            nodes: loader
                .lineage()
                .nodes
                .iter()
                .map(|n| PreparedNode {
                    id: n.id.clone(),
                    kind: n.kind.into(),
                })
                .collect(),
            edges: loader
                .lineage()
                .edges
                .iter()
                .map(|e| PreparedEdge {
                    from: e.from.clone(),
                    to: e.to.clone(),
                })
                .collect(),
        },
        lineage_diagnostics: loader.lineage_diagnostics().to_vec(),
        source_introspectable: loader.source_introspectable(),
        raw_docs_readable: loader.raw_docs_readable(),
    };
    serde_json::to_string_pretty(&doc)
}

/// The on-the-wire shape. Separate from the Info types on purpose: those are the compiler's
/// internal projections and carry no serde attributes, so the exchange format can version
/// independently of them.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PreparedDoc {
    context_version: u32,
    parseable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parse_error: Option<String>,
    #[serde(default)]
    metrics: Vec<PreparedMetric>,
    #[serde(default)]
    dimensions: Vec<PreparedDimension>,
    #[serde(default)]
    models: Vec<PreparedModel>,
    #[serde(default)]
    lineage: PreparedLineage,
    #[serde(default)]
    lineage_diagnostics: Vec<String>,
    // Omitted rather than written as `null`: absence is what carries "this adapter cannot answer
    // the raw-shape probes at all", and a document that says nothing says exactly that.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_introspectable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    raw_docs_readable: Option<bool>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PreparedMetric {
    name: String,
    owner: String,
    declared: bool,
    #[serde(default)]
    additivity: Option<PreparedAdditivity>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PreparedDimension {
    name: String,
    owner: String,
    is_temporal: bool,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PreparedModel {
    name: String,
    has_timestamp: bool,
    #[serde(default)]
    columns: Vec<String>,
}

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PreparedLineage {
    #[serde(default)]
    nodes: Vec<PreparedNode>,
    #[serde(default)]
    edges: Vec<PreparedEdge>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PreparedNode {
    id: String,
    kind: PreparedLineageKind,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PreparedEdge {
    from: String,
    to: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum PreparedAdditivity {
    Additive,
    SemiAdditive,
    NonAdditive,
}

impl From<PreparedAdditivity> for Additivity {
    fn from(a: PreparedAdditivity) -> Self {
        match a {
            PreparedAdditivity::Additive => Additivity::Additive,
            PreparedAdditivity::SemiAdditive => Additivity::SemiAdditive,
            PreparedAdditivity::NonAdditive => Additivity::NonAdditive,
        }
    }
}

impl From<Additivity> for PreparedAdditivity {
    fn from(a: Additivity) -> Self {
        match a {
            Additivity::Additive => PreparedAdditivity::Additive,
            Additivity::SemiAdditive => PreparedAdditivity::SemiAdditive,
            Additivity::NonAdditive => PreparedAdditivity::NonAdditive,
        }
    }
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum PreparedLineageKind {
    Model,
    Column,
    Relationship,
    Cube,
    Metric,
    Dimension,
    View,
    Query,
    Dashboard,
}

impl From<PreparedLineageKind> for LineageKind {
    fn from(k: PreparedLineageKind) -> Self {
        match k {
            PreparedLineageKind::Model => LineageKind::Model,
            PreparedLineageKind::Column => LineageKind::Column,
            PreparedLineageKind::Relationship => LineageKind::Relationship,
            PreparedLineageKind::Cube => LineageKind::Cube,
            PreparedLineageKind::Metric => LineageKind::Metric,
            PreparedLineageKind::Dimension => LineageKind::Dimension,
            PreparedLineageKind::View => LineageKind::View,
            PreparedLineageKind::Query => LineageKind::Query,
            PreparedLineageKind::Dashboard => LineageKind::Dashboard,
        }
    }
}

impl From<LineageKind> for PreparedLineageKind {
    fn from(k: LineageKind) -> Self {
        match k {
            LineageKind::Model => PreparedLineageKind::Model,
            LineageKind::Column => PreparedLineageKind::Column,
            LineageKind::Relationship => PreparedLineageKind::Relationship,
            LineageKind::Cube => PreparedLineageKind::Cube,
            LineageKind::Metric => PreparedLineageKind::Metric,
            LineageKind::Dimension => PreparedLineageKind::Dimension,
            LineageKind::View => PreparedLineageKind::View,
            LineageKind::Query => PreparedLineageKind::Query,
            LineageKind::Dashboard => PreparedLineageKind::Dashboard,
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
    fn mdl_only_adapter_cannot_answer_constitutive_raw_shape() {
        // The default trait probes return `None` — an MDL-only adapter (FakeContext doesn't override
        // them) cannot answer the constitutive raw-shape predicates, so they are *unanswerable*
        // (a loud-fail at compile), never silently `false`.
        let ctx = FakeContext {
            metrics: vec![],
            dimensions: vec![],
            models: vec![],
            lineage: LineageGraph::default(),
            parseable: true,
        };
        assert_eq!(ctx.source_introspectable(), None);
        assert_eq!(ctx.raw_docs_readable(), None);
        assert!(!ctx.can_answer("source_introspectable"));
        assert!(!ctx.can_answer("raw_docs_readable"));
    }

    #[test]
    fn raw_source_adapter_answers_constitutive_raw_shape() {
        // An adapter that DOES probe a raw source (overriding the defaults) makes the constitutive
        // predicates answerable — the inversion the constitutive family depends on.
        struct RawFake;
        impl ContextLoader for RawFake {
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
                // A raw source has no MDL lineage yet; a leaked-static empty graph keeps the
                // signature borrow-clean for this test-only adapter.
                static EMPTY: std::sync::OnceLock<LineageGraph> = std::sync::OnceLock::new();
                EMPTY.get_or_init(LineageGraph::default)
            }
            fn source_introspectable(&self) -> Option<bool> {
                Some(true)
            }
            fn raw_docs_readable(&self) -> Option<bool> {
                Some(false)
            }
        }
        let ctx = RawFake;
        assert!(ctx.can_answer("source_introspectable"));
        assert!(ctx.can_answer("raw_docs_readable"));
        assert_eq!(ctx.source_introspectable(), Some(true));
        assert_eq!(ctx.raw_docs_readable(), Some(false));
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
    fn consumer_nodes_are_semantic_severity() {
        // metric → query and metric → dashboard: hitting a consumer is a silent number shift for
        // the end user, so it classifies Semantic even with no further metric downstream.
        let graph = LineageGraph {
            nodes: vec![
                node("metric:revenue.total", LineageKind::Metric),
                node("query:monthly-revenue", LineageKind::Query),
                node("dashboard:exec-weekly", LineageKind::Dashboard),
            ],
            edges: vec![
                edge("metric:revenue.total", "query:monthly-revenue"),
                edge("metric:revenue.total", "dashboard:exec-weekly"),
            ],
        };
        let radius = graph.blast_radius("metric:revenue.total");
        assert_eq!(
            radius.downstream,
            vec![
                "dashboard:exec-weekly".to_string(),
                "query:monthly-revenue".to_string(),
            ],
            "a metric with consumers is no longer a leaf"
        );
        assert_eq!(radius.severity, Severity::Semantic);
    }

    #[test]
    fn lineage_diagnostics_default_to_empty() {
        let ctx = FakeContext {
            metrics: vec![],
            dimensions: vec![],
            models: vec![],
            lineage: LineageGraph::default(),
            parseable: true,
        };
        assert!(ctx.lineage_diagnostics().is_empty());
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

    // --- prepared context ---------------------------------------------------------------------

    /// A document exercising every field, so the round-trip assertions below can be specific.
    fn prepared_document() -> String {
        r#"{
          "context_version": 1,
          "parseable": true,
          "metrics": [
            {"name": "total_revenue", "owner": "revenue", "declared": true,
             "additivity": "additive"},
            {"name": "amount", "owner": "orders", "declared": false}
          ],
          "dimensions": [
            {"name": "status", "owner": "orders", "is_temporal": false},
            {"name": "ordered_at", "owner": "orders", "is_temporal": true}
          ],
          "models": [
            {"name": "orders", "has_timestamp": true, "columns": ["id", "ordered_at"]}
          ],
          "lineage": {
            "nodes": [
              {"id": "model:orders", "kind": "model"},
              {"id": "metric:revenue.total_revenue", "kind": "metric"}
            ],
            "edges": [{"from": "model:orders", "to": "metric:revenue.total_revenue"}]
          },
          "lineage_diagnostics": ["a consumer's SQL did not parse; used a whole-word scan"]
        }"#
        .to_string()
    }

    #[test]
    fn prepared_context_reads_every_projection() {
        let ctx = PreparedContext::from_json(&prepared_document()).expect("document parses");

        assert!(ctx.is_parseable());
        assert_eq!(ctx.metrics().len(), 2);
        assert_eq!(ctx.metrics()[0].additivity, Some(Additivity::Additive));
        assert_eq!(ctx.metrics()[1].additivity, None);
        assert_eq!(ctx.models()[0].columns, vec!["id", "ordered_at"]);
        assert_eq!(ctx.lineage_diagnostics().len(), 1);
    }

    #[test]
    fn prepared_context_derives_time_dimensions_from_the_temporal_subset() {
        // The wire format carries `dimensions` only: the two collections cannot disagree because
        // one is computed from the other.
        let ctx = PreparedContext::from_json(&prepared_document()).expect("document parses");

        assert_eq!(ctx.dimensions().len(), 2);
        assert_eq!(ctx.time_dimensions().len(), 1);
        assert_eq!(ctx.time_dimensions()[0].name, "ordered_at");
    }

    #[test]
    fn prepared_context_supports_blast_radius() {
        // The whole point of the seam: a host-supplied graph is queried exactly like a natively
        // read one, so `blast_radius` keeps working with no adapter in the process.
        let ctx = PreparedContext::from_json(&prepared_document()).expect("document parses");

        let radius = ctx.lineage().blast_radius("model:orders");
        assert_eq!(
            radius.downstream,
            vec!["metric:revenue.total_revenue".to_string()]
        );
        assert_eq!(radius.severity, Severity::Semantic);
        assert!(ctx.lineage().is_resolvable());
    }

    #[test]
    fn prepared_context_keeps_raw_shape_probes_unanswerable_when_omitted() {
        // Omission must stay `None` — an *unanswerable* predicate — rather than collapsing into a
        // confident `false` about a raw source nobody looked at.
        let ctx = PreparedContext::from_json(&prepared_document()).expect("document parses");

        assert_eq!(ctx.source_introspectable(), None);
        assert!(!ctx.can_answer("source_introspectable"));
        assert!(!ctx.can_answer("raw_docs_readable"));
        // A declared metric is present, so this one *is* answerable.
        assert!(ctx.can_answer("metric_additive"));
    }

    #[test]
    fn prepared_context_answers_raw_shape_probes_when_stated() {
        let doc = r#"{"context_version": 1, "parseable": true,
                      "source_introspectable": true, "raw_docs_readable": false}"#;
        let ctx = PreparedContext::from_json(doc).expect("document parses");

        assert_eq!(ctx.source_introspectable(), Some(true));
        assert!(ctx.can_answer("source_introspectable"));
        assert_eq!(ctx.raw_docs_readable(), Some(false));
        assert!(ctx.can_answer("raw_docs_readable"));
    }

    #[test]
    fn prepared_context_carries_the_parse_error_of_an_unparseable_layer() {
        let doc = r#"{"context_version": 1, "parseable": false,
                      "parse_error": "models/orders/metadata.yml: missing `columns`"}"#;
        let ctx = PreparedContext::from_json(doc).expect("document parses");

        assert!(!ctx.is_parseable());
        assert!(ctx.parse_error().expect("error text").contains("columns"));
    }

    #[test]
    fn prepared_context_rejects_an_unreadable_version() {
        let doc = r#"{"context_version": 99, "parseable": true}"#;
        let err = PreparedContext::from_json(doc).expect_err("version is not readable");

        assert!(matches!(err, PreparedContextError::Version { found: 99 }));
    }

    #[test]
    fn prepared_context_rejects_an_unknown_field() {
        // Loud-fail over silent drop: a field this build does not know is a producer describing
        // something that would otherwise vanish without trace.
        let doc = r#"{"context_version": 1, "parseable": true, "metrics_v2": []}"#;
        let err = PreparedContext::from_json(doc).expect_err("unknown field is rejected");

        assert!(matches!(err, PreparedContextError::Malformed(_)));
    }

    #[test]
    fn prepared_context_rejects_an_unknown_lineage_kind() {
        let doc = r#"{"context_version": 1, "parseable": true,
                      "lineage": {"nodes": [{"id": "x", "kind": "wormhole"}], "edges": []}}"#;
        let err = PreparedContext::from_json(doc).expect_err("unknown kind is rejected");

        assert!(matches!(err, PreparedContextError::Malformed(_)));
    }
}
