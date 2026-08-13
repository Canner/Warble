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

test("validates a terminal envelope against a non-genbi render contract, not genbi's own", () => {
  const node = preparedDashboard().node;
  const customNode = {
    ...node,
    effect: {
      ...node.effect,
      render_blocks: [
        { type: "kpi_card", fields: { title: "string", amount: "number" } },
        { type: "note", fields: { text: "string" } },
        { type: "definition", fields: { sql: "string" } },
      ],
    },
  };
  const customValue = {
    blocks: [
      { type: "kpi_card", title: "Revenue", amount: 100 },
      { type: "note", text: "context" },
      { type: "definition", sql: "SELECT 1" },
    ],
    verified: true,
  };
  assert.deepEqual(validateDashboardRenderEnvelope(customValue, customNode), customValue);
  // genbi's own valid envelope must be rejected here: this node declares a
  // different contract, so the envelope is checked against its own IR, not
  // genbi's shape carried over from elsewhere.
  assert.throws(() => validateDashboardRenderEnvelope(valid, customNode));
});

test("rejects undeclared blocks or fields and malformed typed values", () => {
  const cases = [
    { ...valid, blocks: [{ type: "markdown", text: "fake" }] },
    { ...valid, blocks: [{ type: "kpi_card", label: "Orders", value: 42, secret: "x" }, valid.blocks[2]] },
    { ...valid, blocks: [{ type: "chart", chart_type: "radar", x: "month", series: ["orders"], rows: [] }, valid.blocks[2]] },
    { ...valid, verified: "yes" },
  ];
  for (const value of cases) {
    assert.throws(() => validateDashboardRenderEnvelope(value, preparedDashboard().node));
  }
});

test("accepts a dashboard with only one declared block type and no definition (content shape is not this target's concern)", () => {
  // The consumer (genbi host) now owns the "at least one data panel and one
  // definition" content requirement; this target validates only what the
  // IR declares (`effect.render_blocks`), never a hardcoded block vocabulary.
  const singleBlock = { blocks: [valid.blocks[0]], summary: valid.summary, verified: true };
  assert.deepEqual(
    validateDashboardRenderEnvelope(singleBlock, preparedDashboard().node),
    singleBlock,
  );
});
