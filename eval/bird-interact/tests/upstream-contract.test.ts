import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import * as protocol from "../src/protocol.js";

const EXPECTED_COMMIT = "451fe2c3518ee1cf908d8139e2913483bd519381";
const EXPECTED_SOURCES = [
  "system_agent/callbacks.py",
  "system_agent/tools.py",
  "system_agent/server.py",
  "orchestrator/ainteract.py",
  "shared/models.py",
];
const EXPECTED_PATHS = {
  system_agent: {
    health: "/health",
    init_session: "/init_session",
    run_session: "/run_session",
  },
  db_environment: {
    execute: "/execute",
    schema: "/schema",
    all_column_meanings: "/all_column_meanings",
    column_meaning: "/column_meaning",
    knowledge_names: "/knowledge_names",
    knowledge: "/knowledge",
    submit: "/submit",
  },
  user_simulator: {
    ask: "/ask",
    phase_transition: "/phase_transition",
  },
};

test("upstream pin is an executable copy of the official a-interact contract", async () => {
  const pinPath = resolve(import.meta.dirname, "../upstream.json");
  const pin = JSON.parse(await readFile(pinPath, "utf8")) as Record<string, unknown>;

  assert.equal(pin.repository, "https://github.com/bird-bench/BIRD-Interact.git");
  assert.equal(pin.commit, EXPECTED_COMMIT);
  assert.equal(pin.source_root, "BIRD-Interact-ADK");
  assert.deepEqual(pin.source_paths, EXPECTED_SOURCES);
  for (const path of pin.source_paths as string[]) {
    assert.equal(path.startsWith("/") || path.startsWith("BIRD-Interact-ADK/"), false);
  }
  assert.equal(pin.mode, "a-interact");
  assert.deepEqual(pin.tool_costs, protocol.TOOL_COSTS);
  assert.deepEqual(pin.http_paths, EXPECTED_PATHS);
  assert.deepEqual(pin.service_ports, {
    system_agent: 6000,
    user_simulator: 6001,
    db_environment: 6002,
  });
  assert.equal(pin.initial_budget_formula_version, "adk-ainteract-v1");
  assert.equal(
    pin.mode,
    (protocol as unknown as Record<string, unknown>).BIRD_INTERACT_MODE,
  );
  assert.deepEqual(
    pin.http_paths,
    (protocol as unknown as Record<string, unknown>).BIRD_HTTP_PATHS,
  );
  assert.deepEqual(
    pin.service_ports,
    (protocol as unknown as Record<string, unknown>).BIRD_SERVICE_PORTS,
  );
  assert.equal(
    pin.initial_budget_formula_version,
    (protocol as unknown as Record<string, unknown>).INITIAL_BUDGET_FORMULA_VERSION,
  );
  assert.equal(
    protocol.calculateInitialBudget({ critical: 2, knowledge: 1, patience: 3 }),
    18,
  );
});
