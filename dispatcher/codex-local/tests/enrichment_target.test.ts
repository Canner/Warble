import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CodexDispatchError, prepareSetup } from "../src/index.js";
import { fakeMcp } from "./helpers.js";

const ENRICH_IR_PATH = fileURLToPath(
  new URL("../../../genbi-enrich-context/ir.golden.json", import.meta.url),
);

test("bound-project enrichment stays a target wall-hit until the host supplies approval", () => {
  const ir = readFileSync(ENRICH_IR_PATH, "utf8");
  assert.throws(
    () => prepareSetup({ ir, component: "apply_enrichment", model: "gpt-5.4", mcp: fakeMcp() }),
    (error: unknown) =>
      error instanceof CodexDispatchError &&
      /Setup prototype requires/.test(error.message),
    "the setup-only target must not silently repurpose its broad onboarding path for gated enrichment",
  );
});
