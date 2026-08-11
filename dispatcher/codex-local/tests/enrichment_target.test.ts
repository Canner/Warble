import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CodexDispatchError, prepareSetup } from "../src/index.js";
import { fakeMcp } from "./helpers.js";

const ENRICH_IR_PATH = fileURLToPath(
  new URL("../../../genbi-enrich-context/ir.golden.json", import.meta.url),
);

test("apply_enrichment stays a host-executed target wall-hit", () => {
  const ir = readFileSync(ENRICH_IR_PATH, "utf8");
  assert.throws(
    () => prepareSetup({ ir, component: "apply_enrichment", model: "gpt-5.4", mcp: fakeMcp() }),
    (error: unknown) =>
      error instanceof CodexDispatchError &&
      /apply_enrichment.*host-executed/.test(error.message),
    "the host-executed identity must not be prepared through the public Setup API",
  );
});
