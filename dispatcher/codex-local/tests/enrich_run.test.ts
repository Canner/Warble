import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { prepareEnrich, runEnrich } from "../src/index.js";
import { ENRICH_IR_PATH, FAKE_APP_SERVER, fakeEnrichMcp } from "./helpers.js";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `warble-codex-local-enrich-run-${label}-`));
  scratch.push(path);
  return path;
}

function twoStepInspectComponent() {
  const raw = readFileSync(ENRICH_IR_PATH, "utf8");
  const ir = JSON.parse(raw) as { components: Array<Record<string, unknown>> };
  const component = ir.components.find((candidate) => candidate["id"] === "survey_context")!;
  const first = (component["llm_calls"] as Array<Record<string, unknown>>)[0]!;
  first["name"] = "survey";
  first["produces"] = "context_gaps";
  const second = structuredClone(first);
  second["name"] = "confirm_gaps";
  second["consumes"] = ["context_gaps"];
  second["produces"] = "gaps_confirmed";
  component["llm_calls"] = [first, second];
  return prepareEnrich({
    ir: JSON.stringify(ir),
    component: "survey_context",
    model: "gpt-5.4",
    mcp: fakeEnrichMcp(),
  });
}

test("an n-step Enrich component actually runs two turns in order on one persistent session, marshalling produces into the second turn's consumes", async () => {
  // A genuine end-to-end run through the real app-server protocol seam (fake-app-server.mjs's
  // additive "enrich-multi-step" branch — see that file for why it echoes back the produces field
  // generically rather than a second hardcoded per-component answer), not just a prepare()-time
  // acceptance test. Mirrors run.test.ts's equivalent Setup evidence test.
  const codexHome = temp("home");
  const cwd = temp("cwd");
  const component = twoStepInspectComponent();
  assert.equal(component.steps.length, 2);

  const events: unknown[] = [];
  const result = await runEnrich(component, "enrich-multi-step evidence request", {
    codexHome,
    cwd,
    externalAuthentication: "provisioned",
    codexBin: process.execPath,
    codexArgsPrefix: [FAKE_APP_SERVER],
    env: { PATH: process.env.PATH },
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(
    result.steps.map((step) => ({ name: step.name, ran: step.ran, ok: step.ok })),
    [
      { name: "survey", ran: true, ok: true },
      { name: "confirm_gaps", ran: true, ok: true },
    ],
  );
  assert.deepEqual(result.steps[0]!.value, { ok: true });
  assert.equal(result.finalText, '{"gaps_confirmed":{"ok":true}}');

  // Proves this ran as two turns on the SAME session/thread, in order, not two independent
  // sessions -- and that the second turn's request actually carried the first turn's marshalled
  // produces value, not merely that the second turn happened to answer correctly on its own.
  const turnStarted = (events as Array<{ t: string; turn?: { threadId?: string } }>).filter(
    (event) => event.t === "turn_started",
  );
  assert.equal(turnStarted.length, 2);

  const state = JSON.parse(readFileSync(join(codexHome, "fake-app-state.json"), "utf8")) as {
    requests: Array<{ method: string; params: Record<string, unknown> }>;
  };
  const turnStarts = state.requests.filter((entry) => entry.method === "turn/start");
  assert.equal(turnStarts.length, 2);
  const firstInput = (turnStarts[0]!.params["input"] as Array<{ text: string }>)[0]!.text;
  const secondInput = (turnStarts[1]!.params["input"] as Array<{ text: string }>)[0]!.text;
  assert.doesNotMatch(firstInput, /Inputs from earlier steps/);
  assert.match(secondInput, /Inputs from earlier steps \(JSON\):/);
  assert.match(secondInput, /"context_gaps":\{"ok":true\}/);
});
