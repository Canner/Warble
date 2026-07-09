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
