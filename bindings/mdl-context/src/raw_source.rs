//! Warble ContextLoader adapter #2 — the raw-source adapter (constitutive family).
//!
//! A CONSTITUTIVE component's bound Context is a **raw source** with no MDL yet — the component's
//! output *is* the MDL (or a knowledge enrichment). This adapter answers the two raw-shape probes
//! (`source_introspectable` / `raw_docs_readable`) that [`crate::MdlContext`] leaves `None`, which
//! is the inversion the constitutive family depends on: a bound raw source is *parseable* (the
//! coarse floor passes) even though it carries no metrics/dimensions/models/lineage at all.
//!
//! Pipeline mirrors [`crate::project`]: a host-I/O reader ([`read_raw_dir`], native-only) fills
//! [`RawSources`] from disk; [`RawSourceContext::from_sources`] is the pure, WASM-friendly parse.

use serde::Deserialize;

use warble::{ContextLoader, DimensionInfo, LineageGraph, MetricInfo, ModelInfo};

/// A raw source's `schema.json`: a source name + its tables. Deliberately permissive — the fixture
/// carries extra keys (a top-level `description`, possibly per-column notes) that this adapter does
/// not need, so no `deny_unknown_fields`.
#[derive(Debug, Deserialize)]
struct RawSchema {
    #[allow(dead_code)]
    source: String,
    #[serde(default)]
    tables: Vec<RawTable>,
}

#[derive(Debug, Deserialize)]
struct RawTable {
    #[allow(dead_code)]
    name: String,
    #[serde(default)]
    columns: Vec<RawColumn>,
}

#[derive(Debug, Deserialize)]
struct RawColumn {
    #[allow(dead_code)]
    name: String,
    #[serde(rename = "type")]
    #[allow(dead_code)]
    col_type: String,
}

/// The raw file contents of a raw source, read by the host. `from_sources` operates purely over
/// these bytes (WASM-friendly); the native [`read_raw_dir`] convenience fills them from disk.
pub struct RawSources {
    pub schema_json: String,
    /// Whether `docs/` exists under the raw source dir and contains at least one file.
    pub has_docs: bool,
}

/// A `ContextLoader` backed by a raw (pre-MDL) source. Carries no metrics/dimensions/models/lineage
/// — that is what a CONSTITUTIVE component's output *produces* — but answers the two raw-shape
/// probes that make `source_introspectable` / `raw_docs_readable` evaluable instead of unanswerable.
pub struct RawSourceContext {
    parseable: bool,
    source_introspectable: Option<bool>,
    raw_docs_readable: Option<bool>,
    lineage: LineageGraph,
}

impl RawSourceContext {
    /// Build from read raw-source sources. On a schema parse failure, returns
    /// [`RawSourceContext::unparseable`] rather than an error, per the sans-IO probe model.
    pub fn from_sources(sources: &RawSources) -> Self {
        match serde_json::from_str::<RawSchema>(&sources.schema_json) {
            Ok(schema) => {
                let introspectable = schema.tables.iter().any(|t| !t.columns.is_empty());
                RawSourceContext {
                    parseable: true,
                    source_introspectable: Some(introspectable),
                    raw_docs_readable: Some(sources.has_docs),
                    lineage: LineageGraph::default(),
                }
            }
            Err(_) => Self::unparseable(),
        }
    }

    /// A bound-but-broken raw source: `schema.json` failed to parse. `is_parseable()` is `false`,
    /// so `warble::compile`'s coarse floor loud-fails before either precondition is even evaluated —
    /// the probe values below are set to `None` (cannot answer over a source we couldn't read) to be
    /// honest rather than guess a `Some(false)` we didn't actually establish.
    pub fn unparseable() -> Self {
        RawSourceContext {
            parseable: false,
            source_introspectable: None,
            raw_docs_readable: None,
            lineage: LineageGraph::default(),
        }
    }
}

impl ContextLoader for RawSourceContext {
    fn is_parseable(&self) -> bool {
        self.parseable
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
    fn source_introspectable(&self) -> Option<bool> {
        self.source_introspectable
    }
    fn raw_docs_readable(&self) -> Option<bool> {
        self.raw_docs_readable
    }
}

// --- native host convenience ---------------------------------------------------------------------

/// Read a raw-source directory into [`RawSources`] (native host only; the pure
/// [`RawSourceContext::from_sources`] path is what a WASM host feeds directly). Returns `None` if
/// the directory has no `schema.json` — i.e. it is not a raw source — so the caller can fall through
/// to another adapter or an unparseable context.
#[cfg(not(target_arch = "wasm32"))]
pub fn read_raw_dir(dir: &std::path::Path) -> std::io::Result<Option<RawSources>> {
    use std::fs;

    let schema_path = dir.join("schema.json");
    if !schema_path.is_file() {
        return Ok(None);
    }
    let schema_json = fs::read_to_string(&schema_path)?;

    let docs_dir = dir.join("docs");
    let has_docs = docs_dir.is_dir()
        && fs::read_dir(&docs_dir)?
            .filter_map(Result::ok)
            .any(|e| e.path().is_file());

    Ok(Some(RawSources {
        schema_json,
        has_docs,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good_sources(has_docs: bool) -> RawSources {
        RawSources {
            schema_json: r#"{
                "source": "synthetic_shop",
                "description": "a raw source",
                "tables": [
                    { "name": "raw_orders", "columns": [
                        { "name": "order_id", "type": "INTEGER" },
                        { "name": "amount", "type": "DECIMAL" }
                    ] }
                ]
            }"#
            .to_string(),
            has_docs,
        }
    }

    #[test]
    fn good_schema_is_introspectable_and_reflects_docs() {
        let ctx = RawSourceContext::from_sources(&good_sources(true));
        assert!(ctx.is_parseable());
        assert_eq!(ctx.source_introspectable(), Some(true));
        assert_eq!(ctx.raw_docs_readable(), Some(true));

        let ctx_no_docs = RawSourceContext::from_sources(&good_sources(false));
        assert_eq!(ctx_no_docs.raw_docs_readable(), Some(false));
    }

    #[test]
    fn empty_tables_are_not_introspectable() {
        let sources = RawSources {
            schema_json: r#"{"source":"empty_src","tables":[]}"#.to_string(),
            has_docs: false,
        };
        let ctx = RawSourceContext::from_sources(&sources);
        assert!(ctx.is_parseable(), "an empty-but-valid schema still parses");
        assert_eq!(ctx.source_introspectable(), Some(false));
    }

    #[test]
    fn unparseable_schema_yields_unparseable_context() {
        let sources = RawSources {
            schema_json: "not json at all".to_string(),
            has_docs: true,
        };
        let ctx = RawSourceContext::from_sources(&sources);
        assert!(!ctx.is_parseable());
        assert_eq!(ctx.source_introspectable(), None);
        assert_eq!(ctx.raw_docs_readable(), None);
    }

    #[test]
    fn raw_source_context_can_answer_raw_shape_predicates() {
        let ctx = RawSourceContext::from_sources(&good_sources(true));
        assert!(ctx.can_answer("source_introspectable"));
        assert!(ctx.can_answer("raw_docs_readable"));
    }

    #[test]
    fn mdl_context_cannot_answer_raw_shape_predicates() {
        // An MDL-only adapter leaves the raw-shape probes at their trait defaults (`None`) — the
        // inversion this adapter exists to fill in.
        use crate::MdlContext;
        use wren_core_base::mdl::manifest::Manifest;

        let json = r#"{
          "catalog":"wren","schema":"public",
          "models":[],"relationships":[],"cubes":[],"views":[]
        }"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();
        let ctx = MdlContext::from_manifest(&manifest);
        assert_eq!(ctx.source_introspectable(), None);
        assert_eq!(ctx.raw_docs_readable(), None);
        assert!(!ctx.can_answer("source_introspectable"));
        assert!(!ctx.can_answer("raw_docs_readable"));
    }
}
