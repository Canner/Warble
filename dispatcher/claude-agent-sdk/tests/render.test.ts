import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderEnvelope } from "../src/render.js";

// Integration: reuse the Rust reference renderer (`warble render`) — the same binary/HTML the file
// target produces. Skips if the release binary hasn't been built (`just release`).
const WARBLE_BIN = fileURLToPath(new URL("../../../target/release/warble", import.meta.url));
const HAVE_BIN = existsSync(WARBLE_BIN);

const FINAL_TEXT = `Here is your dashboard.
\`\`\`json
{ "blocks": [
  { "type": "kpi_card", "label": "Total revenue", "value": 1672.4, "unit": "USD" },
  { "type": "table", "columns": ["status","orders"], "rows": [["completed",67],["shipped",32]] },
  { "type": "chart", "chart_type": "bar", "x": "status", "series": ["orders"], "rows": [["completed",67],["shipped",32]] }
], "summary": "Revenue and orders by status." }
\`\`\``;

test(
  "renderEnvelope shells to `warble render` → deterministic self-contained HTML (tolerates fenced/prose output)",
  { skip: HAVE_BIN ? false : "warble release binary not built (run `just release`)" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "warble-sdk-render-test-"));
    const outA = join(dir, "A.html");
    const outB = join(dir, "B.html");
    renderEnvelope(FINAL_TEXT, outA, { warbleBin: WARBLE_BIN });
    renderEnvelope(FINAL_TEXT, outB, { warbleBin: WARBLE_BIN });

    const a = readFileSync(outA, "utf8");
    const b = readFileSync(outB, "utf8");
    assert.equal(a, b, "same envelope ⇒ identical bytes (deterministic renderer)");
    assert.ok(a.startsWith("<!doctype html>"));
    assert.ok(a.includes("1672.4"), "KPI value rendered");
    assert.ok(a.includes("<table>"), "table rendered");
    assert.ok(a.includes("<svg"), "chart rendered as inline SVG");
  },
);

// Phase 1.3: hero envelope — full kpi_card + table + chart + definition + top-level verified facet,
// run through the real reference renderer end to end.
const HERO_FINAL_TEXT = `Here is your dashboard.
\`\`\`json
{ "blocks": [
  { "type": "kpi_card", "label": "Total revenue", "value": 1672.4, "unit": "USD" },
  { "type": "table", "columns": ["status","orders"], "rows": [["completed",67],["shipped",32]] },
  { "type": "chart", "chart_type": "bar", "x": "status", "series": ["orders"], "rows": [["completed",67],["shipped",32]] },
  { "type": "definition", "sql": "SELECT status, count(*) AS orders FROM orders GROUP BY status",
    "source_tables": ["orders"], "filters": [] }
], "verified": true, "summary": "Revenue and orders by status." }
\`\`\``;

test(
  "renderEnvelope: hero envelope (verified pill + definition panel + table + chart) renders deterministically",
  { skip: HAVE_BIN ? false : "warble release binary not built (run `just release`)" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "warble-sdk-render-hero-test-"));
    const out = join(dir, "hero.html");
    renderEnvelope(HERO_FINAL_TEXT, out, { warbleBin: WARBLE_BIN });

    const html = readFileSync(out, "utf8");
    assert.ok(html.startsWith("<!doctype html>"));
    assert.match(html, /<span class="verified-pill">[^<]*Verified/, "verified facet renders as a pill");
    assert.match(html, /class="panel definition"/, "definition block renders as a panel");
    assert.ok(
      html.includes("SELECT status, count(*) AS orders FROM orders GROUP BY status"),
      "definition panel includes the exact SQL",
    );
    assert.match(html, /Phase 2/, "definition panel carries the shallow-provenance Phase 2 note");
    assert.ok(html.includes("<table>"), "table rendered");
    assert.ok(html.includes("67") && html.includes("32"), "table data rendered");
    assert.ok(html.includes("<svg"), "chart rendered as inline SVG");
  },
);

// A deliberately-unresolvable warbleBin makes spawnSync fail ENOENT deterministically, with no
// dependency on whether the release binary is built — this is the path someone hits after
// `npm install @warble/claude-agent-sdk` on its own, with no `warble` binary anywhere on PATH.
test("renderEnvelope: a missing `warble` binary names the `cargo install warble-cli` remedy", () => {
  const dir = mkdtempSync(join(tmpdir(), "warble-sdk-render-missing-bin-test-"));
  const out = join(dir, "missing.html");
  assert.throws(
    () => renderEnvelope(FINAL_TEXT, out, { warbleBin: "/definitely/not/a/real/warble/binary" }),
    (e: unknown) =>
      e instanceof Error &&
      /cargo install warble-cli/.test(e.message) &&
      /--warble-bin/.test(e.message),
  );
});
