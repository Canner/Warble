//! Build Warble's semantic [`LineageGraph`] from a wren [`Manifest`].
//!
//! Edges are oriented **upstream → downstream** (`from` depended on, `to` dependent), so a node's
//! blast radius is its forward-reachable set (capability-model §7.1: `raw → models → relationships
//! → metrics/dimensions → views`). The graph is built purely from structural references —
//! relationships, cube base objects, and view statements — without executing or expanding SQL.
//!
//! Node id conventions (stable, queryable): `model:<name>`, `rel:<name>`, `cube:<name>`,
//! `metric:<cube>.<measure>`, `dim:<cube>.<dimension>`, `view:<name>`.

use warble::{LineageEdge, LineageGraph, LineageKind, LineageNode};
use wren_core_base::mdl::manifest::Manifest;

pub fn model_id(name: &str) -> String {
    format!("model:{name}")
}
pub fn rel_id(name: &str) -> String {
    format!("rel:{name}")
}
pub fn cube_id(name: &str) -> String {
    format!("cube:{name}")
}
pub fn metric_id(cube: &str, measure: &str) -> String {
    format!("metric:{cube}.{measure}")
}
pub fn dim_id(cube: &str, dimension: &str) -> String {
    format!("dim:{cube}.{dimension}")
}
pub fn view_id(name: &str) -> String {
    format!("view:{name}")
}

/// Build the lineage DAG. References to models that do not exist (a dangling relationship member,
/// cube base object, or view table) still produce an edge whose `from` endpoint is absent from the
/// node set — so [`LineageGraph::is_resolvable`] detects them.
pub fn build(manifest: &Manifest) -> LineageGraph {
    let mut nodes: Vec<LineageNode> = Vec::new();
    let mut edges: Vec<LineageEdge> = Vec::new();

    let push_node = |id: String, kind: LineageKind, nodes: &mut Vec<LineageNode>| {
        if !nodes.iter().any(|n| n.id == id) {
            nodes.push(LineageNode { id, kind });
        }
    };

    let model_names: Vec<String> = manifest.models.iter().map(|m| m.name.clone()).collect();

    for model in &manifest.models {
        push_node(model_id(&model.name), LineageKind::Model, &mut nodes);
    }

    // Relationships depend on both joined models.
    for rel in &manifest.relationships {
        let rid = rel_id(&rel.name);
        push_node(rid.clone(), LineageKind::Relationship, &mut nodes);
        for member in &rel.models {
            edges.push(LineageEdge {
                from: model_id(member),
                to: rid.clone(),
            });
        }
    }

    // Cubes depend on their base object (a model or view); measures/dimensions depend on the cube.
    for cube in &manifest.cubes {
        let cid = cube_id(&cube.name);
        push_node(cid.clone(), LineageKind::Cube, &mut nodes);
        edges.push(LineageEdge {
            from: model_id(&cube.base_object),
            to: cid.clone(),
        });
        for measure in &cube.measures {
            let mid = metric_id(&cube.name, &measure.name);
            push_node(mid.clone(), LineageKind::Metric, &mut nodes);
            edges.push(LineageEdge {
                from: cid.clone(),
                to: mid,
            });
        }
        for dim in &cube.dimensions {
            let did = dim_id(&cube.name, &dim.name);
            push_node(did.clone(), LineageKind::Dimension, &mut nodes);
            edges.push(LineageEdge {
                from: cid.clone(),
                to: did,
            });
        }
        for tdim in &cube.time_dimensions {
            let did = dim_id(&cube.name, &tdim.name);
            push_node(did.clone(), LineageKind::Dimension, &mut nodes);
            edges.push(LineageEdge {
                from: cid.clone(),
                to: did,
            });
        }
    }

    // Views depend on every model whose name appears as a whole word in the view statement.
    for view in &manifest.views {
        let vid = view_id(&view.name);
        push_node(vid.clone(), LineageKind::View, &mut nodes);
        for model_name in &model_names {
            if statement_references(&view.statement, model_name) {
                edges.push(LineageEdge {
                    from: model_id(model_name),
                    to: vid.clone(),
                });
            }
        }
    }

    LineageGraph { nodes, edges }
}

/// Naive whole-word containment check: does `statement` reference `name` as a standalone token?
/// Avoids the false positive where `orders` matches inside `raw_orders` by requiring
/// non-identifier boundaries on both sides.
fn statement_references(statement: &str, name: &str) -> bool {
    let bytes = statement.as_bytes();
    let name_bytes = name.as_bytes();
    if name_bytes.is_empty() {
        return false;
    }
    let is_ident = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut start = 0;
    while let Some(pos) = statement[start..].find(name) {
        let abs = start + pos;
        let before_ok = abs == 0 || !is_ident(bytes[abs - 1]);
        let after_idx = abs + name_bytes.len();
        let after_ok = after_idx >= bytes.len() || !is_ident(bytes[after_idx]);
        if before_ok && after_ok {
            return true;
        }
        start = abs + name_bytes.len();
    }
    false
}
