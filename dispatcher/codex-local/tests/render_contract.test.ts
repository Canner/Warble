import assert from "node:assert/strict";
import { test } from "node:test";

import { validateDashboardRenderEnvelope } from "../src/index.js";
import { preparedDashboard } from "./helpers.js";

const valid = {
  blocks: [
    { type: "kpi_card", label: "Orders", value: 42, unit: "orders" },
    {
      type: "chart",
      chart_type: "line",
      x: "month",
      series: ["orders"],
      rows: [{ month: "Jan", orders: 42 }],
    },
    {
      type: "definition",
      sql: "SELECT month, COUNT(*) AS orders FROM orders GROUP BY month",
      source_tables: ["orders"],
      filters: [],
    },
  ],
  summary: "Order overview",
  verified: true,
};

test("validates the IR-declared dashboard envelope", () => {
  assert.deepEqual(
    validateDashboardRenderEnvelope(valid, preparedDashboard().node),
    valid,
  );
});

test("canonicalizes null optional dashboard fields to omission", () => {
  const withNullOptionals = {
    ...valid,
    blocks: [
      { ...valid.blocks[0], delta: null },
      valid.blocks[1],
      valid.blocks[2],
    ],
  };
  assert.deepEqual(
    validateDashboardRenderEnvelope(withNullOptionals, preparedDashboard().node),
    valid,
  );
});

test("rejects undeclared blocks or fields, malformed typed values, and missing provenance", () => {
  const cases = [
    { ...valid, blocks: [{ type: "markdown", text: "fake" }] },
    { ...valid, blocks: [{ type: "kpi_card", label: "Orders", value: 42, secret: "x" }, valid.blocks[2]] },
    { ...valid, blocks: [{ type: "chart", chart_type: "radar", x: "month", series: ["orders"], rows: [] }, valid.blocks[2]] },
    { ...valid, blocks: [valid.blocks[0]] },
    { ...valid, verified: "yes" },
  ];
  for (const value of cases) {
    assert.throws(() => validateDashboardRenderEnvelope(value, preparedDashboard().node));
  }
});
