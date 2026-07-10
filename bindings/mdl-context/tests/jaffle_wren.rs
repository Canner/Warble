//! Integration tests over the real `examples/jaffle-wren` project. As authored it is **cube-less**
//! (models + columns + relationships + views, no declared metrics), which exercises the honest
//! Phase 2 boundary: existence predicates hold via columns, but `metric_additive` is unanswerable.

use std::path::Path;

use warble::ContextLoader;
use warble_mdl_context::{read_project_dir, MdlContext};

fn jaffle_wren() -> MdlContext {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/jaffle-wren");
    let sources = read_project_dir(&dir)
        .expect("read jaffle-wren")
        .expect("jaffle-wren is a wren project");
    MdlContext::try_from_sources(&sources).expect("jaffle-wren assembles into a valid manifest")
}

#[test]
fn parses_and_projects_models() {
    let ctx = jaffle_wren();
    assert!(ctx.is_parseable());

    // Every jaffle model is projected.
    let model_names: Vec<&str> = ctx.models().iter().map(|m| m.name.as_str()).collect();
    for expected in [
        "customers",
        "orders",
        "raw_customers",
        "raw_orders",
        "raw_payments",
    ] {
        assert!(
            model_names.contains(&expected),
            "missing model {expected}: {model_names:?}"
        );
    }

    // orders has a DATE column (order_date) → has_timestamp.
    let orders = ctx.model("orders").expect("orders model");
    assert!(orders.has_timestamp, "orders has a DATE column");
}

#[test]
fn existence_predicates_hold_via_columns() {
    let ctx = jaffle_wren();
    // Numeric columns (amount, customer_lifetime_value, …) → has_metric holds even with no cube.
    assert!(
        !ctx.metrics().is_empty(),
        "numeric columns are queryable metrics"
    );
    // Textual columns (status, first_name, …) → groupable dimensions.
    assert!(!ctx.dimensions().is_empty());
    // DATE columns (order_date, first_order, …) → time dimensions.
    assert!(!ctx.time_dimensions().is_empty());
}

#[test]
fn metric_additive_is_unanswerable_on_cubeless_project() {
    let ctx = jaffle_wren();
    // No declared cube measure ⇒ additivity is not expressible ⇒ can_answer=false (the "format
    // can't carry it" loud-fail), NOT a silent false. This is the exact case the D cube resolves.
    assert!(
        !ctx.can_answer("metric_additive"),
        "cube-less jaffle-wren cannot answer metric_additive"
    );
    // Every implicit column-metric carries no additivity.
    assert!(ctx
        .metrics()
        .iter()
        .all(|m| !m.declared && m.additivity.is_none()));
    // Existence predicates are still answerable.
    assert!(ctx.can_answer("has_metric"));
    assert!(ctx.can_answer("has_time_dimension"));
}

#[test]
fn lineage_is_resolvable() {
    let ctx = jaffle_wren();
    let lineage = ctx.lineage();
    assert!(
        lineage.is_resolvable(),
        "no dangling references in jaffle-wren lineage"
    );
    // Relationships connect real models: orders → rel:orders_customers is an edge.
    assert!(lineage.contains("model:orders"));
    assert!(lineage.contains("rel:orders_customers"));
    assert!(lineage
        .edges
        .iter()
        .any(|e| e.from == "model:orders" && e.to == "rel:orders_customers"));
}
