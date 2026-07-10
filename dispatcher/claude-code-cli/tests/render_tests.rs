use serde_json::json;
use warble_claude_code::{parse_envelope, render_envelope_to_html, Envelope, RenderOptions};

fn sample_envelope() -> Envelope {
    Envelope {
        blocks: vec![
            json!({ "type": "kpi_card", "label": "Total customers", "value": 100 }),
            json!({
                "type": "kpi_card",
                "label": "Total revenue",
                "value": 1672.4,
                "unit": "USD",
                "delta": -3.2
            }),
            json!({
                "type": "table",
                "columns": ["status", "orders", "revenue"],
                "rows": [
                    ["completed", 67, 1103.5],
                    ["shipped", 32, 568.9]
                ]
            }),
            json!({
                "type": "chart",
                "chart_type": "bar",
                "x": "status",
                "series": ["orders"],
                "rows": [
                    ["completed", 67],
                    ["shipped", 32]
                ]
            }),
        ],
        summary: Some("Most orders are completed.".to_string()),
        verified: None,
    }
}

#[test]
fn render_envelope_to_html_is_deterministic() {
    let envelope = sample_envelope();
    let a = render_envelope_to_html(&envelope, &RenderOptions::default());
    let b = render_envelope_to_html(&envelope, &RenderOptions::default());
    assert_eq!(a, b);
}

#[test]
fn rendered_html_is_a_self_contained_document_with_block_data() {
    let envelope = sample_envelope();
    let options = RenderOptions {
        title: Some("Orders".to_string()),
    };
    let html = render_envelope_to_html(&envelope, &options);

    assert!(html.starts_with("<!doctype html>"), "is an HTML document");
    assert!(html.contains("<title>Orders</title>"));
    // No external network dependency — fully self-contained artifact.
    assert!(
        !html.contains("http://") && !html.contains("https://"),
        "must not reference external resources"
    );
    // KPI + table data present.
    assert!(html.contains("Total customers"));
    assert!(html.contains("1672.4"));
    assert!(html.contains("completed"));
    assert!(html.contains("1103.5"));
    // Chart rendered as inline SVG bars.
    assert!(html.contains("<svg"));
    assert!(html.contains("<rect"));
    // Summary carried through.
    assert!(html.contains("Most orders are completed."));
}

#[test]
fn delta_direction_renders_up_down_markers() {
    let envelope = sample_envelope();
    let html = render_envelope_to_html(&envelope, &RenderOptions::default());
    assert!(html.contains("delta down"), "negative delta -> down");
}

#[test]
fn html_escapes_untrusted_strings_from_the_envelope() {
    let envelope = Envelope {
        blocks: vec![json!({
            "type": "kpi_card",
            "label": "<script>alert(1)</script>",
            "value": "x & y"
        })],
        summary: None,
        verified: None,
    };
    let html = render_envelope_to_html(&envelope, &RenderOptions::default());
    assert!(
        !html.contains("<script>alert(1)</script>"),
        "must not inject raw markup"
    );
    assert!(html.contains("&lt;script&gt;"));
    assert!(html.contains("x &amp; y"));
}

#[test]
fn narrative_block_renders_title_and_escaped_paragraphs() {
    let envelope = Envelope {
        blocks: vec![json!({
            "type": "narrative",
            "title": "Why revenue rose",
            "text": "Completed orders drove the increase.\n\nA <b>secondary</b> factor was fewer returns."
        })],
        summary: None,
        verified: None,
    };
    let html = render_envelope_to_html(&envelope, &RenderOptions::default());
    assert!(
        html.contains("<h2>Why revenue rose</h2>"),
        "title as heading"
    );
    assert!(html.contains("<p>Completed orders drove the increase.</p>"));
    // two blank-line-separated paragraphs
    assert!(html.contains("<p>A &lt;b&gt;secondary&lt;/b&gt; factor was fewer returns.</p>"));
    assert!(
        !html.contains("<b>secondary</b>"),
        "narrative text must be escaped, never injected as markup"
    );
    assert!(
        !html.contains("no reference renderer"),
        "narrative is a known block, not the unknown fallback"
    );
}

#[test]
fn narrative_block_defaults_its_heading_when_untitled() {
    let envelope = Envelope {
        blocks: vec![json!({ "type": "narrative", "text": "Just prose." })],
        summary: None,
        verified: None,
    };
    let html = render_envelope_to_html(&envelope, &RenderOptions::default());
    assert!(html.contains("<h2>Narrative</h2>"));
    assert!(html.contains("<p>Just prose.</p>"));
}

#[test]
fn unknown_block_types_render_as_labeled_json_instead_of_panicking() {
    let envelope = Envelope {
        blocks: vec![json!({ "type": "sankey", "nodes": ["a", "b"] })],
        summary: None,
        verified: None,
    };
    let html = render_envelope_to_html(&envelope, &RenderOptions::default());
    assert!(html.contains("sankey"));
    assert!(html.contains("no reference renderer"));
}

#[test]
fn chart_accepts_keyed_rows_as_well_as_positional_rows() {
    let envelope = Envelope {
        blocks: vec![json!({
            "type": "chart",
            "chart_type": "line",
            "x": "month",
            "series": ["revenue"],
            "rows": [
                { "month": "Jan", "revenue": 10 },
                { "month": "Feb", "revenue": 25 }
            ]
        })],
        summary: None,
        verified: None,
    };
    let html = render_envelope_to_html(&envelope, &RenderOptions::default());
    assert!(html.contains("<svg"));
    assert!(html.contains("<path"), "line chart drawn as an SVG path");
    assert!(html.contains("Jan"));
}

#[test]
fn verified_facet_renders_a_pill_only_when_true() {
    // true -> pill present
    let verified = Envelope {
        blocks: vec![json!({ "type": "kpi_card", "label": "N", "value": 1 })],
        summary: None,
        verified: Some(true),
    };
    let html = render_envelope_to_html(&verified, &RenderOptions::default());
    assert!(
        html.contains(r#"<span class="verified-pill">"#),
        "true -> ✓ Verified pill"
    );

    // false / absent -> no pill (verification is asserted, never assumed)
    for v in [Some(false), None] {
        let e = Envelope {
            blocks: vec![json!({ "type": "kpi_card", "label": "N", "value": 1 })],
            summary: None,
            verified: v,
        };
        let html = render_envelope_to_html(&e, &RenderOptions::default());
        assert!(
            !html.contains(r#"<span class="verified-pill">"#),
            "no pill for {v:?}"
        );
    }
}

#[test]
fn parse_envelope_reads_the_verified_facet() {
    let raw = json!({
        "blocks": [{ "type": "kpi_card", "label": "N", "value": 1 }],
        "verified": true
    })
    .to_string();
    let env = parse_envelope(&raw).expect("should parse");
    assert_eq!(env.verified, Some(true));
}

#[test]
fn definition_block_renders_sql_source_tables_and_filters_with_phase2_note() {
    let envelope = Envelope {
        blocks: vec![json!({
            "type": "definition",
            "sql": "SELECT count(*) FROM customers WHERE status = 'completed'",
            "source_tables": ["customers", "orders"],
            "filters": ["status = 'completed'"]
        })],
        summary: None,
        verified: None,
    };
    let html = render_envelope_to_html(&envelope, &RenderOptions::default());
    assert!(html.contains("Definition — how this was computed"));
    // SQL shown, escaped, inside a <pre>.
    assert!(html.contains("<pre>SELECT count(*) FROM customers"));
    assert!(html.contains("customers, orders"), "source tables listed");
    assert!(
        html.contains("status = &#x27;completed&#x27;") || html.contains("status = 'completed'")
    );
    // Honest shallow marker: full lineage is Phase 2, not claimed here.
    assert!(
        html.contains("Phase 2"),
        "definition card marks itself shallow"
    );
    assert!(
        !html.contains("no reference renderer"),
        "definition is a known block, not the unknown fallback"
    );
}

#[test]
fn parse_envelope_reads_a_clean_json_envelope() {
    let raw = json!({
        "blocks": sample_envelope().blocks,
        "summary": "Most orders are completed."
    })
    .to_string();
    let env = parse_envelope(&raw).expect("should parse");
    assert_eq!(env.blocks.len(), 4);
    assert_eq!(env.summary.as_deref(), Some("Most orders are completed."));
}

#[test]
fn parse_envelope_extracts_an_envelope_from_a_fenced_json_block() {
    let payload = json!({
        "blocks": [{ "type": "kpi_card", "label": "N", "value": 1 }]
    })
    .to_string();
    let raw = format!(
        "Here is the dashboard data:\n```json\n{}\n```\nLet me know if you need more.",
        payload
    );
    let env = parse_envelope(&raw).expect("should parse");
    assert_eq!(env.blocks.len(), 1);
}

#[test]
fn parse_envelope_finds_a_balanced_object_inside_surrounding_prose() {
    let raw = r#"The result is { "blocks": [ { "type": "kpi_card", "label": "N", "value": 1 } ], "summary": "hi" } — done."#;
    let env = parse_envelope(raw).expect("should parse");
    assert_eq!(env.blocks.len(), 1);
    assert_eq!(env.summary.as_deref(), Some("hi"));
}

#[test]
fn parse_envelope_errs_with_a_clear_message_when_no_envelope_is_present() {
    let err = parse_envelope("I could not find any data.").unwrap_err();
    assert!(err.0.contains("render envelope"));
}
