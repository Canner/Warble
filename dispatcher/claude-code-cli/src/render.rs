//! Warble reference renderer (v0.3, programmatic flavor) — Rust port of `render.ts`.
//!
//! This is the deterministic half of the render contract: the agent stays fully
//! read-only and emits a structured `{ blocks, summary }` envelope as its final
//! output; THIS module turns that envelope into a self-contained `dashboard.html`
//! — no LLM in the loop, same input always yields the same bytes.

use crate::error::DispatchError;
use serde_json::Value;

/// Document rendering options.
#[derive(Debug, Clone, Default)]
pub struct RenderOptions {
    /// Document title (default: "Dashboard"). Kept out of the envelope so the
    /// same envelope renders identically regardless of who invokes it.
    pub title: Option<String>,
}

/// A parsed Warble render envelope (blocks + optional summary + optional verify facet).
#[derive(Debug, Clone)]
pub struct Envelope {
    pub blocks: Vec<Value>,
    pub summary: Option<String>,
    /// The per-answer verify cue (G2, hard line): `Some(true)` ⇒ the agent executed the query and
    /// validated the result set before answering, and the renderer shows a `✓ Verified` pill. Any
    /// other value (absent/false) shows no pill — verification is asserted, never assumed.
    pub verified: Option<bool>,
}

// ---------------------------------------------------------------------------
// Envelope extraction — tolerate the model wrapping the JSON
// ---------------------------------------------------------------------------

/// Extract a Warble render envelope from raw agent output. The agent is asked
/// to emit *only* the JSON envelope, but models routinely wrap it in ```json
/// fences or surround it with a sentence. This is deliberately forgiving:
///
///  1. try to parse the whole string as JSON;
///  2. else pull the contents of the first ```json / ``` fenced block;
///  3. else scan for the first balanced `{...}` object that contains a
///     top-level `"blocks"` key.
///
/// Returns an error if none of those yield an object with a `blocks` array.
pub fn parse_envelope(raw: &str) -> Result<Envelope, DispatchError> {
    let fenced = extract_fenced_block(raw);
    let balanced = extract_balanced_object(raw);
    let candidates: [Option<&str>; 3] = [Some(raw.trim()), fenced.as_deref(), balanced.as_deref()];

    for candidate in candidates.into_iter().flatten() {
        if let Some(parsed) = try_parse_object(candidate) {
            if let Some(obj) = parsed.as_object() {
                if let Some(Value::Array(_)) = obj.get("blocks") {
                    return Ok(normalize_envelope(obj));
                }
            }
        }
    }

    Err(DispatchError::new(
        "could not find a render envelope ({ \"blocks\": [...] }) in the agent output",
    ))
}

fn try_parse_object(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok()
}

fn extract_fenced_block(raw: &str) -> Option<String> {
    // Port of /```(?:json)?\s*\n([\s\S]*?)\n```/i — first fenced block, case-insensitive.
    let lower = raw.to_ascii_lowercase();
    let mut search_from = 0usize;
    loop {
        let rel_start = lower[search_from..].find("```")?;
        let start = search_from + rel_start;
        let mut cursor = start + 3;
        // optional "json" (case-insensitive)
        if lower[cursor..].starts_with("json") {
            cursor += 4;
        }
        // \s* then a required \n
        let bytes = raw.as_bytes();
        let mut i = cursor;
        while i < bytes.len() && (bytes[i] as char).is_whitespace() && bytes[i] != b'\n' {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'\n' {
            // no newline right after the opening fence marker; try next occurrence
            search_from = start + 3;
            continue;
        }
        let content_start = i + 1;
        if let Some(rel_end) = raw[content_start..].find("\n```") {
            let content_end = content_start + rel_end;
            return Some(raw[content_start..content_end].trim().to_string());
        }
        return None;
    }
}

/// Find the first `{...}` region that mentions a `"blocks"` key, balancing braces.
fn extract_balanced_object(raw: &str) -> Option<String> {
    let chars: Vec<char> = raw.chars().collect();
    let start = chars.iter().position(|&c| c == '{')?;
    for i in start..chars.len() {
        if chars[i] != '{' {
            continue;
        }
        if let Some(end) = match_closing_brace(&chars, i) {
            let slice: String = chars[i..=end].iter().collect();
            if slice.contains("\"blocks\"") {
                return Some(slice);
            }
        }
    }
    None
}

/// Index of the `}` closing the `{` at `open`, respecting strings/escapes.
fn match_closing_brace(text: &[char], open: usize) -> Option<usize> {
    let mut depth: i64 = 0;
    let mut in_string = false;
    let mut escaped = false;
    for (i, &ch) in text.iter().enumerate().skip(open) {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
        } else if ch == '{' {
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
    }
    None
}

fn normalize_envelope(obj: &serde_json::Map<String, Value>) -> Envelope {
    let blocks = match obj.get("blocks") {
        Some(Value::Array(arr)) => arr.clone(),
        _ => Vec::new(),
    };
    let summary = match obj.get("summary") {
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    };
    let verified = obj.get("verified").and_then(Value::as_bool);
    Envelope {
        blocks,
        summary,
        verified,
    }
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

const STYLES: &str = r#":root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem;
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #f6f7f9; color: #1c1e21;
}
@media (prefers-color-scheme: dark) {
  body { background: #16181c; color: #e6e8eb; }
  .card, .panel { background: #22252b !important; border-color: #33373f !important; }
  th { background: #2a2e35 !important; }
  tr:nth-child(even) td { background: #1c1f24 !important; }
}
h1 { font-size: 1.4rem; margin: 0 0 1.25rem; }
.title-row { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; margin: 0 0 1.25rem; }
.title-row h1 { margin: 0; }
.verified-pill {
  display: inline-flex; align-items: center; gap: .3rem;
  font-size: .78rem; font-weight: 600; padding: .2rem .55rem; border-radius: 999px;
  background: #dafbe1; color: #1a7f37; border: 1px solid #aceebb;
}
@media (prefers-color-scheme: dark) {
  .verified-pill { background: #12331d !important; color: #4ac26b !important; border-color: #2a5a38 !important; }
  .definition code, .definition pre { background: #16181c !important; }
}
.definition pre {
  margin: .35rem 0 .75rem; padding: .6rem .75rem; border-radius: 6px; background: #f0f2f5;
  overflow-x: auto; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.definition .meta { font-size: .85rem; }
.definition .meta .k { opacity: .6; margin-right: .35rem; }
.definition .note { font-size: .75rem; opacity: .6; margin-top: .5rem; font-style: italic; }
h2 { font-size: 1rem; margin: 0 0 .75rem; font-weight: 600; opacity: .85; }
.kpi-row { display: flex; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.5rem; }
.card {
  background: #fff; border: 1px solid #e3e6ea; border-radius: 10px;
  padding: 1rem 1.25rem; min-width: 160px; flex: 1 1 160px;
}
.card .label { font-size: .8rem; opacity: .7; margin-bottom: .35rem; }
.card .value { font-size: 1.75rem; font-weight: 650; letter-spacing: -.01em; }
.card .unit { font-size: .9rem; opacity: .6; margin-left: .25rem; font-weight: 400; }
.card .delta { font-size: .8rem; margin-top: .35rem; }
.delta.up { color: #1a7f37; } .delta.down { color: #cf222e; }
.panel {
  background: #fff; border: 1px solid #e3e6ea; border-radius: 10px;
  padding: 1.25rem; margin-bottom: 1.5rem; overflow-x: auto;
}
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid #e3e6ea; }
th { background: #f0f2f5; font-weight: 600; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.summary { opacity: .8; max-width: 60ch; }
.warble-foot { margin-top: 2rem; font-size: .75rem; opacity: .45; }"#;

/// Deterministic categorical palette (accessible on both themes).
const PALETTE: [&str; 6] = [
    "#4c78a8", "#f58518", "#54a24b", "#e45756", "#72b7b2", "#b279a2",
];

fn esc(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Render a value as its "String(value ?? '')" equivalent then escape it, mirroring the TS `esc`
/// helper applied to loosely-typed envelope fields.
fn esc_value(value: &Value) -> String {
    esc(&value_to_display_string(value))
}

fn value_to_display_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_to_js_string(n),
        other => other.to_string(),
    }
}

/// Cell = string | number | boolean | null.
fn is_numeric(value: &Value) -> bool {
    match value.as_f64() {
        Some(n) => n.is_finite(),
        None => false,
    }
}

/// `String(n)` for a JSON number, e.g. as used by `esc(block.value)` when value isn't numeric.
fn number_to_js_string(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    n.as_f64().map(|f| f.to_string()).unwrap_or_default()
}

/// Locale-free number formatting so output bytes are stable across machines.
fn fmt_number(n: f64) -> String {
    if n.fract() == 0.0 && n.is_finite() {
        return format!("{}", n as i64);
    }
    let rounded = (n * 100.0).round() / 100.0;
    if rounded.fract() == 0.0 {
        format!("{}", rounded as i64)
    } else {
        // Trim trailing zeros the way JS Number#toString would (e.g. 1103.5, not 1103.50).
        let s = format!("{:.2}", rounded);
        let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
        s
    }
}

fn fmt_cell(value: &Value) -> String {
    if value.is_null() {
        return String::new();
    }
    if is_numeric(value) {
        return fmt_number(value.as_f64().unwrap());
    }
    value_to_display_string(value)
}

fn block_type(block: &Value) -> &str {
    block.get("type").and_then(Value::as_str).unwrap_or("")
}

/// Render a full envelope to a single self-contained HTML document. Pure and
/// deterministic: no clock, no randomness, stable ordering — the same envelope
/// always produces identical bytes.
pub fn render_envelope_to_html(envelope: &Envelope, options: &RenderOptions) -> String {
    let title = options.title.as_deref().unwrap_or("Dashboard");
    let kpis: Vec<&Value> = envelope
        .blocks
        .iter()
        .filter(|b| block_type(b) == "kpi_card")
        .collect();
    let others: Vec<&Value> = envelope
        .blocks
        .iter()
        .filter(|b| block_type(b) != "kpi_card")
        .collect();

    // Title row carries the `✓ Verified` pill (G2) when the envelope asserts verification.
    let verified_pill = if envelope.verified == Some(true) {
        r#"<span class="verified-pill">&#10003; Verified</span>"#
    } else {
        ""
    };
    let mut parts: Vec<String> = vec![format!(
        r#"<div class="title-row"><h1>{}</h1>{}</div>"#,
        esc(title),
        verified_pill
    )];

    if !kpis.is_empty() {
        let cards: String = kpis.iter().map(|b| render_kpi_card(b)).collect();
        parts.push(format!(r#"<div class="kpi-row">{}</div>"#, cards));
    }
    for block in &others {
        parts.push(render_block(block));
    }
    if let Some(summary) = &envelope.summary {
        if !summary.is_empty() {
            parts.push(format!(
                r#"<div class="panel"><h2>Summary</h2><p class="summary">{}</p></div>"#,
                esc(summary)
            ));
        }
    }
    parts.push(
        r#"<div class="warble-foot">Rendered by the Warble reference renderer (programmatic render flavor).</div>"#
            .to_string(),
    );

    [
        "<!doctype html>".to_string(),
        r#"<html lang="en">"#.to_string(),
        "<head>".to_string(),
        r#"<meta charset="utf-8">"#.to_string(),
        r#"<meta name="viewport" content="width=device-width, initial-scale=1">"#.to_string(),
        format!("<title>{}</title>", esc(title)),
        format!("<style>{}</style>", STYLES),
        "</head>".to_string(),
        "<body>".to_string(),
        parts.join("\n"),
        "</body>".to_string(),
        "</html>".to_string(),
        String::new(),
    ]
    .join("\n")
}

fn render_block(block: &Value) -> String {
    match block_type(block) {
        "table" => render_table(block),
        "chart" => render_chart(block),
        "narrative" => render_narrative(block),
        "definition" => render_definition(block),
        _ => render_unknown(block),
    }
}

/// Render a `narrative` block — the stdlib text/markdown block (ir-schema §v0.3). Minimal by
/// design: an optional `title` heading plus the `text` body, split into paragraphs on blank lines
/// with single newlines kept as `<br>`. The text is escaped (never injected as raw markup); this is
/// prose, not a rich-markdown renderer.
fn render_narrative(block: &Value) -> String {
    let title = block
        .get("title")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .map(|t| format!("<h2>{}</h2>", esc(t)))
        .unwrap_or_else(|| "<h2>Narrative</h2>".to_string());
    let text = block
        .get("text")
        .or_else(|| block.get("body"))
        .or_else(|| block.get("markdown"))
        .map(value_to_display_string)
        .unwrap_or_default();
    let paragraphs: String = text
        .split("\n\n")
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| format!("<p>{}</p>", esc(p).replace('\n', "<br>")))
        .collect();
    format!(r#"<div class="panel">{title}{paragraphs}</div>"#)
}

/// Render a `definition` block — the shallow definition card (G3). Surfaces *how this number was
/// actually computed on this run*: the SQL the agent ran, the source tables it touched, and the
/// filters it applied — all knowable at query time without MDL introspection. The panel is
/// explicitly labelled shallow: unit / owner / formal-metric lineage comes from MDL introspection
/// (Phase 2 ContextLoader) and is deliberately NOT claimed here.
fn render_definition(block: &Value) -> String {
    let sql = block
        .get("sql")
        .map(value_to_display_string)
        .filter(|s| !s.is_empty());
    let string_list = |key: &str| -> Vec<String> {
        block
            .get(key)
            .and_then(Value::as_array)
            .map(|arr| arr.iter().map(value_to_display_string).collect())
            .unwrap_or_default()
    };
    let source_tables = string_list("source_tables");
    let filters = string_list("filters");

    let mut inner = String::from(r#"<h2>Definition — how this was computed</h2>"#);
    if let Some(sql) = sql {
        inner.push_str(&format!("<pre>{}</pre>", esc(&sql)));
    }
    if !source_tables.is_empty() {
        inner.push_str(&format!(
            r#"<div class="meta"><span class="k">Source tables</span>{}</div>"#,
            esc(&source_tables.join(", "))
        ));
    }
    if !filters.is_empty() {
        inner.push_str(&format!(
            r#"<div class="meta"><span class="k">Filters</span>{}</div>"#,
            esc(&filters.join("; "))
        ));
    }
    inner.push_str(
        r#"<div class="note">Shallow provenance — the query behind this run. Unit, owner, and formal metric lineage arrive with MDL introspection (Phase 2).</div>"#,
    );
    format!(r#"<div class="panel definition">{inner}</div>"#)
}

fn render_kpi_card(block: &Value) -> String {
    let value_field = block.get("value").cloned().unwrap_or(Value::Null);
    let value = if is_numeric(&value_field) {
        fmt_number(value_field.as_f64().unwrap())
    } else {
        esc_value(&value_field)
    };
    let unit = match block.get("unit") {
        Some(u) => format!(r#"<span class="unit">{}</span>"#, esc_value(u)),
        None => String::new(),
    };
    let mut delta = String::new();
    if let Some(d) = block.get("delta").and_then(Value::as_f64) {
        if d.is_finite() {
            let dir = if d >= 0.0 { "up" } else { "down" };
            let sign = if d >= 0.0 { "\u{25B2}" } else { "\u{25BC}" };
            delta = format!(
                r#"<div class="delta {}">{} {}</div>"#,
                dir,
                sign,
                fmt_number(d.abs())
            );
        }
    }
    let label = block.get("label").cloned().unwrap_or(Value::Null);
    [
        r#"<div class="card">"#.to_string(),
        format!(r#"<div class="label">{}</div>"#, esc_value(&label)),
        format!(r#"<div class="value">{}{}</div>"#, value, unit),
        delta,
        "</div>".to_string(),
    ]
    .join("")
}

fn render_table(block: &Value) -> String {
    let columns: Vec<Value> = block
        .get("columns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let rows: Vec<Value> = block
        .get("rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    // A column is numeric if every non-empty cell under it is numeric.
    let numeric_col: Vec<bool> = columns
        .iter()
        .enumerate()
        .map(|(c, _)| {
            !rows.is_empty()
                && rows.iter().all(|row| {
                    let cell = row
                        .as_array()
                        .and_then(|r| r.get(c))
                        .cloned()
                        .unwrap_or(Value::Null);
                    cell.is_null()
                        || matches!(&cell, Value::String(s) if s.is_empty())
                        || is_numeric(&cell)
                })
        })
        .collect();

    let head: String = columns
        .iter()
        .enumerate()
        .map(|(c, col)| {
            format!(
                r#"<th class="{}">{}</th>"#,
                if numeric_col[c] { "num" } else { "" },
                esc_value(col)
            )
        })
        .collect();

    let body: String = rows
        .iter()
        .map(|row| {
            let cells: String = columns
                .iter()
                .enumerate()
                .map(|(c, _)| {
                    let cell = row
                        .as_array()
                        .and_then(|r| r.get(c))
                        .cloned()
                        .unwrap_or(Value::Null);
                    format!(
                        r#"<td class="{}">{}</td>"#,
                        if numeric_col[c] { "num" } else { "" },
                        esc(&fmt_cell(&cell))
                    )
                })
                .collect();
            format!("<tr>{}</tr>", cells)
        })
        .collect();

    format!(
        r#"<div class="panel"><h2>Table</h2><table><thead><tr>{}</tr></thead><tbody>{}</tbody></table></div>"#,
        head, body
    )
}

/// Normalized chart point: `{ x, values[] }`.
struct ChartPoint {
    x: String,
    values: Vec<f64>,
}

fn normalize_chart_rows(block: &Value) -> Vec<ChartPoint> {
    let series: Vec<String> = block
        .get("series")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let x_key = block.get("x").and_then(Value::as_str).unwrap_or("");
    let rows: Vec<Value> = block
        .get("rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    rows.iter()
        .map(|row| {
            if let Some(arr) = row.as_array() {
                let x = fmt_cell(&arr.first().cloned().unwrap_or(Value::Null));
                let values: Vec<f64> = series
                    .iter()
                    .enumerate()
                    .map(|(i, _)| to_number(&arr.get(i + 1).cloned().unwrap_or(Value::Null)))
                    .collect();
                ChartPoint { x, values }
            } else {
                let obj = row.as_object();
                let x = fmt_cell(
                    &obj.and_then(|o| o.get(x_key))
                        .cloned()
                        .unwrap_or(Value::Null),
                );
                let values: Vec<f64> = series
                    .iter()
                    .map(|name| {
                        to_number(
                            &obj.and_then(|o| o.get(name))
                                .cloned()
                                .unwrap_or(Value::Null),
                        )
                    })
                    .collect();
                ChartPoint { x, values }
            }
        })
        .collect()
}

fn to_number(value: &Value) -> f64 {
    if is_numeric(value) {
        return value.as_f64().unwrap();
    }
    if let Value::String(s) = value {
        if let Ok(n) = s.trim().parse::<f64>() {
            if n.is_finite() {
                return n;
            }
        }
    }
    0.0
}

const CHART_W: f64 = 640.0;
const CHART_H: f64 = 260.0;
const PAD_TOP: f64 = 16.0;
const PAD_RIGHT: f64 = 16.0;
const PAD_BOTTOM: f64 = 40.0;
const PAD_LEFT: f64 = 48.0;

fn render_chart(block: &Value) -> String {
    let points = normalize_chart_rows(block);
    let series: Vec<String> = block
        .get("series")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let chart_type = block
        .get("chart_type")
        .and_then(Value::as_str)
        .unwrap_or("");

    let svg = if points.is_empty() || series.is_empty() {
        r#"<p class="summary">No chart data.</p>"#.to_string()
    } else {
        render_chart_svg(chart_type, &points, &series)
    };

    let legend = if series.len() > 1 {
        let items: String = series
            .iter()
            .enumerate()
            .map(|(i, name)| {
                format!(
                    r#"<span style="margin-right:1rem"><span style="display:inline-block;width:.7rem;height:.7rem;border-radius:2px;background:{};margin-right:.3rem"></span>{}</span>"#,
                    PALETTE[i % PALETTE.len()],
                    esc(name)
                )
            })
            .collect();
        format!(
            r#"<div style="margin-top:.5rem;font-size:.8rem">{}</div>"#,
            items
        )
    } else {
        String::new()
    };

    let x_field = block.get("x").and_then(Value::as_str).unwrap_or("");
    let heading = if !x_field.is_empty() {
        format!("{} chart by {}", esc(chart_type), esc(x_field))
    } else {
        format!("{} chart", esc(chart_type))
    };

    format!(
        r#"<div class="panel"><h2>{}</h2>{}{}</div>"#,
        heading, svg, legend
    )
}

fn render_chart_svg(chart_type: &str, points: &[ChartPoint], series: &[String]) -> String {
    let plot_w = CHART_W - PAD_LEFT - PAD_RIGHT;
    let plot_h = CHART_H - PAD_TOP - PAD_BOTTOM;
    let all_values: Vec<f64> = points
        .iter()
        .flat_map(|p| p.values.iter().copied())
        .collect();
    let max_raw = all_values.iter().copied().fold(0.0_f64, f64::max);
    let min_raw = all_values.iter().copied().fold(0.0_f64, f64::min);
    let max = if max_raw == min_raw {
        max_raw + 1.0
    } else {
        max_raw
    };
    let min = min_raw;
    let y_of = |v: f64| PAD_TOP + plot_h - ((v - min) / (max - min)) * plot_h;
    let band_w = plot_w / points.len() as f64;

    if chart_type == "pie" {
        return render_pie_svg(points);
    }

    let axes = [
        format!(
            r#"<line x1="{}" y1="{}" x2="{}" y2="{}" stroke="currentColor" opacity=".25"/>"#,
            PAD_LEFT,
            PAD_TOP,
            PAD_LEFT,
            PAD_TOP + plot_h
        ),
        format!(
            r#"<line x1="{}" y1="{}" x2="{}" y2="{}" stroke="currentColor" opacity=".25"/>"#,
            PAD_LEFT,
            y_of(0.0),
            PAD_LEFT + plot_w,
            y_of(0.0)
        ),
        format!(
            r#"<text x="{}" y="{}" font-size="10" text-anchor="end" fill="currentColor" opacity=".6">{}</text>"#,
            PAD_LEFT - 6.0,
            y_of(max),
            esc(&fmt_number(max))
        ),
        format!(
            r#"<text x="{}" y="{}" font-size="10" text-anchor="end" fill="currentColor" opacity=".6">{}</text>"#,
            PAD_LEFT - 6.0,
            y_of(min) + 3.0,
            esc(&fmt_number(min))
        ),
    ]
    .join("");

    let x_labels: String = points
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let cx = PAD_LEFT + band_w * i as f64 + band_w / 2.0;
            format!(
                r#"<text x="{}" y="{}" font-size="10" text-anchor="middle" fill="currentColor" opacity=".6">{}</text>"#,
                cx,
                PAD_TOP + plot_h + 14.0,
                esc(&p.x)
            )
        })
        .collect();

    let marks = if chart_type == "bar" {
        let group_w = band_w * 0.7;
        let bar_w = group_w / series.len() as f64;
        points
            .iter()
            .enumerate()
            .map(|(i, p)| {
                p.values
                    .iter()
                    .enumerate()
                    .map(|(s, &v)| {
                        let x = PAD_LEFT
                            + band_w * i as f64
                            + (band_w - group_w) / 2.0
                            + bar_w * s as f64;
                        let y = y_of(v).min(y_of(0.0));
                        let h = (y_of(v) - y_of(0.0)).abs();
                        format!(
                            r#"<rect x="{}" y="{}" width="{}" height="{}" fill="{}"/>"#,
                            round(x),
                            round(y),
                            round(bar_w - 1.0),
                            round(h),
                            PALETTE[s % PALETTE.len()]
                        )
                    })
                    .collect::<String>()
            })
            .collect::<String>()
    } else {
        // line / area / scatter share the point geometry
        series
            .iter()
            .enumerate()
            .map(|(s, _)| {
                let coords: Vec<(f64, f64)> = points
                    .iter()
                    .enumerate()
                    .map(|(i, p)| {
                        let x = PAD_LEFT + band_w * i as f64 + band_w / 2.0;
                        let y = y_of(*p.values.get(s).unwrap_or(&0.0));
                        (x, y)
                    })
                    .collect();
                let color = PALETTE[s % PALETTE.len()];
                let path = coords
                    .iter()
                    .enumerate()
                    .map(|(i, (x, y))| {
                        format!(
                            "{}{},{}",
                            if i == 0 { "M" } else { "L" },
                            round(*x),
                            round(*y)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                let dots: String = coords
                    .iter()
                    .map(|(x, y)| {
                        format!(
                            r#"<circle cx="{}" cy="{}" r="2.5" fill="{}"/>"#,
                            round(*x),
                            round(*y),
                            color
                        )
                    })
                    .collect();
                if chart_type == "scatter" {
                    return dots;
                }
                let area = if chart_type == "area" {
                    let (last_x, _) = coords[coords.len() - 1];
                    let (first_x, _) = coords[0];
                    format!(
                        r#"<path d="{} L{},{} L{},{} Z" fill="{}" opacity=".15"/>"#,
                        path,
                        round(last_x),
                        round(y_of(0.0)),
                        round(first_x),
                        round(y_of(0.0)),
                        color
                    )
                } else {
                    String::new()
                };
                format!(
                    r#"{}<path d="{}" fill="none" stroke="{}" stroke-width="2"/>{}"#,
                    area, path, color, dots
                )
            })
            .collect::<String>()
    };

    format!(
        r#"<svg viewBox="0 0 {} {}" width="100%" role="img" style="max-width:{}px">{}{}{}</svg>"#,
        CHART_W, CHART_H, CHART_W, axes, x_labels, marks
    )
}

fn render_pie_svg(points: &[ChartPoint]) -> String {
    let total: f64 = points
        .iter()
        .map(|p| *p.values.first().unwrap_or(&0.0))
        .sum();
    let cx = CHART_H / 2.0;
    let cy = CHART_H / 2.0;
    let r = CHART_H / 2.0 - 16.0;
    if total <= 0.0 {
        return r#"<p class="summary">No chart data.</p>"#.to_string();
    }
    let mut angle = -std::f64::consts::FRAC_PI_2;
    let slices: String = points
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let v = *p.values.first().unwrap_or(&0.0);
            let frac = v / total;
            let next = angle + frac * 2.0 * std::f64::consts::PI;
            let large = if frac > 0.5 { 1 } else { 0 };
            let x1 = cx + r * angle.cos();
            let y1 = cy + r * angle.sin();
            let x2 = cx + r * next.cos();
            let y2 = cy + r * next.sin();
            let path = format!(
                r#"<path d="M{},{} L{},{} A{},{} 0 {} 1 {},{} Z" fill="{}"/>"#,
                round(cx),
                round(cy),
                round(x1),
                round(y1),
                r,
                r,
                large,
                round(x2),
                round(y2),
                PALETTE[i % PALETTE.len()]
            );
            angle = next;
            path
        })
        .collect();
    let legend: String = points
        .iter()
        .enumerate()
        .map(|(i, p)| {
            format!(
                r#"<div style="font-size:.8rem"><span style="display:inline-block;width:.7rem;height:.7rem;border-radius:2px;background:{};margin-right:.4rem"></span>{} — {}</div>"#,
                PALETTE[i % PALETTE.len()],
                esc(&p.x),
                esc(&fmt_number(*p.values.first().unwrap_or(&0.0)))
            )
        })
        .collect();
    format!(
        r#"<div style="display:flex;gap:1.5rem;align-items:center;flex-wrap:wrap"><svg viewBox="0 0 {} {}" width="{}" role="img">{}</svg><div>{}</div></div>"#,
        CHART_H, CHART_H, CHART_H, slices, legend
    )
}

/// Round to 2dp for compact, deterministic SVG coordinates.
fn round(n: f64) -> f64 {
    (n * 100.0).round() / 100.0
}

fn render_unknown(block: &Value) -> String {
    let json = esc(&serde_json::to_string_pretty(block).unwrap_or_default());
    let type_label = block
        .get("type")
        .cloned()
        .unwrap_or(Value::String(String::new()));
    format!(
        r#"<div class="panel"><h2>{} (no reference renderer)</h2><pre style="margin:0;white-space:pre-wrap">{}</pre></div>"#,
        esc_value(&type_label),
        json
    )
}
