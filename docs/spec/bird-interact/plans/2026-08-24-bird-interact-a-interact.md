# BIRD-Interact a-interact Eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Warble-owned replacement for the official BIRD-Interact `system_agent` service that runs the dedicated Warble agent through Wren while preserving the pinned official a-interact tool, budget, phase, and scoring contract.

**Architecture:** Add an isolated TypeScript package under `eval/bird-interact` and a compileable Warble profile under `eval/bird-interact-agent`. Pure protocol and SQL-routing modules sit below an HTTP/MCP/Agent SDK layer, so all contract behavior can be tested without model credentials or live BIRD services. The official BIRD orchestrator, user simulator, DB environment, and scorer stay external and authoritative.

**Tech Stack:** TypeScript 5, Node.js 20+, `node:test`, Anthropic Agent SDK in-process MCP tools, Zod schemas, Warble Claude Agent SDK source API, Wren CLI, official BIRD-Interact ADK commit `451fe2c3518ee1cf908d8139e2913483bd519381`.

---

## File map

- Create `eval/bird-interact/package.json` — isolated scripts, runtime dependencies, and CLI bin.
- Create `eval/bird-interact/package-lock.json` — reproducible npm dependency graph.
- Create `eval/bird-interact/tsconfig.json` and `eval/bird-interact/tsup.config.ts` — strict type-check and bundled CLI build.
- Create `eval/bird-interact/src/types.ts` — official-compatible HTTP/state/action types.
- Create `eval/bird-interact/src/protocol.ts` — pure cost, budget, reward, and phase transitions.
- Create `eval/bird-interact/src/wren-planner.ts` — query classification and shell-free `wren dry-plan` adapter.
- Create `eval/bird-interact/src/bird-client.ts` — typed official DB/user HTTP client.
- Create `eval/bird-interact/src/tools.ts` — charged action runtime plus exact nine MCP tools.
- Create `eval/bird-interact/src/agent.ts` — Warble IR preparation and Agent SDK session execution.
- Create `eval/bird-interact/src/server.ts` — official-compatible HTTP service and per-task session store.
- Create `eval/bird-interact/src/artifacts.ts` — safe per-task agent events, trace, and reproducibility metadata.
- Create `eval/bird-interact/src/cli.ts` — validated service configuration and entry point.
- Create `eval/bird-interact/src/index.ts` — reusable public test/integration exports.
- Create `eval/bird-interact/tests/*.test.ts` — service-free protocol, planner, client/tool, agent-option, server, profile, artifact, and upstream-contract tests.
- Create `eval/bird-interact/scripts/reference_driver.py` — opt-in scripted replay through the pinned official Python callbacks/tools.
- Create `eval/bird-interact-agent/**` — external-context Warble profile and benchmark-specific prompt.
- Create `eval/bird-interact/README.md` — setup, pinning, oracle/smoke/full runbook, and limitations.
- Modify `eval/README.md` — distinguish one-shot eval from BIRD interactive eval and link the runbook.
- Modify `justfile` — install/type-check/test/build recipes for the isolated package.

### Task 1: Package skeleton and pure protocol state machine

**Files:**
- Create: `eval/bird-interact/package.json`
- Create: `eval/bird-interact/tsconfig.json`
- Create: `eval/bird-interact/tsup.config.ts`
- Create: `eval/bird-interact/src/types.ts`
- Create: `eval/bird-interact/src/protocol.ts`
- Test: `eval/bird-interact/tests/protocol.test.ts`

- [ ] **Step 1: Create only the package/test configuration**

Use scripts:

```json
{
  "engines": { "node": ">=20" },
  "preinstall": "npm ci --prefix ../../dispatcher/claude-agent-sdk && npm run build --prefix ../../dispatcher/claude-agent-sdk",
  "check-types": "tsc --noEmit",
  "test": "node --import tsx --test --test-concurrency=1 tests/*.test.ts",
  "build": "tsup"
}
```

Add runtime dependencies matching the existing dispatcher (`@anthropic-ai/claude-agent-sdk`, `yaml`, `zod`) and dev dependencies (`@types/node`, `tsx`, `tsup`, `typescript`). Do not declare an unpublished `@warble/claude-agent-sdk` dependency. The `preinstall` command makes a fresh isolated `npm install`/`npm ci` first install and build the sibling package; Task 4 imports its generated `dist` API and declarations. Do not create production modules yet.

- [ ] **Step 2: Write failing protocol tests**

Tests must call public functions and prove:

```ts
assert.equal(calculateInitialBudget({ critical: 2, knowledge: 1, patience: 3 }), 18);
assert.deepEqual(beginAction(stateWithBudget(2), "ask_user"), {
  kind: "execute", cost: 2, budgetBefore: 2, budgetAfter: 0,
});
assert.deepEqual(beginAction(stateWithBudget(1), "ask_user"), {
  kind: "reject", cost: 0, budgetBefore: 1, budgetAfter: 1,
});
assert.equal(beginAction(stateWithBudget(2), "submit_sql").budgetAfter, -1);
assert.equal(beginAction(stateWithBudget(3), "submit_sql").budgetAfter, -1);
```

Add separate tests for all nine tool prices, rejected-action immutability, phase-1 with follow-up, phase-1 without follow-up, failed submit, phase-2 pass, reward accumulation, and a forced submit ending the task after the result.

- [ ] **Step 3: Run the tests and verify RED**

Run:

```bash
cd eval/bird-interact
npm install
node --import tsx --test tests/protocol.test.ts
```

Expected: FAIL because `src/protocol.ts` and exported functions do not exist. Confirm this is the only failure cause.

- [ ] **Step 4: Implement minimal official-compatible types and protocol functions**

Define the exact nine-name `BirdToolName` union, immutable `TOOL_COSTS`, `BirdSessionState`, `SubmitSqlResponse`, `ActionDecision`, `calculateInitialBudget`, `beginAction`, and `applySubmitResponse`. Keep I/O out of this module.

`beginAction` rules:

```ts
if (budget < cost && tool !== "submit_sql") return rejectWithoutCharge;
if (tool === "submit_sql" && budget - cost <= 0) return executeWithBudget(-1);
return executeWithBudget(budget - cost);
```

`applySubmitResponse` must mutate only the fields allowed by the spec and treat BIRD response fields as authoritative.

- [ ] **Step 5: Run protocol tests and type-check GREEN**

Run:

```bash
node --import tsx --test tests/protocol.test.ts
npm run check-types
```

Expected: all protocol tests pass and TypeScript reports no errors.

- [ ] **Step 6: Commit Task 1**

```bash
git add eval/bird-interact/package.json eval/bird-interact/package-lock.json \
  eval/bird-interact/tsconfig.json eval/bird-interact/tsup.config.ts \
  eval/bird-interact/src/types.ts eval/bird-interact/src/protocol.ts \
  eval/bird-interact/tests/protocol.test.ts
git commit -m "feat(eval): add BIRD a-interact protocol state"
```

### Task 2: Wren query classification and planner

**Files:**
- Create: `eval/bird-interact/src/wren-planner.ts`
- Test: `eval/bird-interact/tests/wren-planner.test.ts`
- Test fixture: `eval/bird-interact/tests/fixtures/fake-wren.mjs`

- [ ] **Step 1: Write failing query-classification tests**

Cover case-insensitive `SELECT`, `WITH`, and `EXPLAIN`, leading line/block comments, and non-query `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, and an empty statement. Assert the classifier follows the pinned BIRD lexical rule rather than a full SQL parser.

- [ ] **Step 2: Write failing process-planner tests**

Use a fake executable that records argv/cwd and prints deterministic SQL. Prove the planner invokes this exact shape without a shell:

```text
<wren-bin> dry-plan --sql <semantic-sql> --datasource postgres --mdl <project>/target/mdl.json
cwd=<project>
```

Also assert non-zero exit raises `WrenPlanningError` containing stderr but not environment variables.

- [ ] **Step 3: Run planner tests and verify RED**

Run `node --import tsx --test tests/wren-planner.test.ts`.

Expected: FAIL because the planner module does not exist.

- [ ] **Step 4: Implement minimal classifier and `ProcessWrenPlanner`**

Use `spawn`/`execFile`, never `exec` or a shell. Resolve `<root>/<dbName>` and reject a resolved project outside the configured root. Return trimmed stdout and fail on empty stdout.

- [ ] **Step 5: Run planner tests and type-check GREEN**

Run:

```bash
node --import tsx --test tests/wren-planner.test.ts
npm run check-types
```

- [ ] **Step 6: Commit Task 2**

```bash
git add eval/bird-interact/src/wren-planner.ts \
  eval/bird-interact/tests/wren-planner.test.ts \
  eval/bird-interact/tests/fixtures/fake-wren.mjs
git commit -m "feat(eval): plan BIRD query SQL through Wren"
```

### Task 3: Official BIRD clients and charged tool runtime

**Files:**
- Create: `eval/bird-interact/src/bird-client.ts`
- Create: `eval/bird-interact/src/tools.ts`
- Test: `eval/bird-interact/tests/bird-client.test.ts`
- Test: `eval/bird-interact/tests/tools.test.ts`

- [ ] **Step 1: Write failing `FetchBirdClient` tests**

Start local Node HTTP servers on ephemeral ports and assert the exact endpoint/payload pairs from the pinned official schema. Cover non-2xx, malformed JSON, request timeout, and upstream error bodies.

- [ ] **Step 2: Run client tests and verify RED**

Run `node --import tsx --test tests/bird-client.test.ts`.

Expected: FAIL because `FetchBirdClient` does not exist.

- [ ] **Step 3: Implement the typed client**

Implement `execute`, `schema`, column-meaning, knowledge, `askUser`, `phaseTransition`, and `submit`. Keep base URLs injectable and use `AbortSignal.timeout`.

- [ ] **Step 4: Run client tests GREEN**

Run `node --import tsx --test tests/bird-client.test.ts` and confirm all pass.

- [ ] **Step 5: Write failing charged-tool tests**

Test `BirdToolRuntime.invoke(name, args)` directly, not through source inspection or SDK mocks. Prove:

- each tool uses the right client method and charges before the call;
- upstream client failures remain charged and become tool-visible error text rather than escaping as an agent/service exception;
- rejected non-submit actions do not call the client or alter budget;
- Wren planner failure consumes the action cost and does not call BIRD;
- query-like execute/submit SQL is planned and both semantic/native SQL enter the trajectory;
- non-query `execute_sql` bypasses Wren and lets BIRD reject it;
- Management `submit_sql` bypasses Wren and reaches BIRD unchanged;
- `ask_user` appends both dialogue messages;
- phase-1 follow-up calls `/phase_transition` and returns the follow-up in the tool text;
- result previews are capped, arguments are redacted, and no connection secrets persist.

- [ ] **Step 6: Run tool tests and verify RED**

Run `node --import tsx --test tests/tools.test.ts`.

Expected: FAIL because the runtime does not exist.

- [ ] **Step 7: Implement `BirdToolRuntime` and nine SDK MCP tool definitions**

Keep the action executor independent of SDK types. Add `createBirdMcpServer(runtime)` as a thin mapping using `tool`, `createSdkMcpServer`, and Zod argument schemas. Register exactly the nine pinned tool names.

- [ ] **Step 8: Run client/tool tests and type-check GREEN**

Run:

```bash
node --import tsx --test tests/bird-client.test.ts tests/tools.test.ts
npm run check-types
```

- [ ] **Step 9: Commit Task 3**

```bash
git add eval/bird-interact/src/bird-client.ts eval/bird-interact/src/tools.ts \
  eval/bird-interact/tests/bird-client.test.ts eval/bird-interact/tests/tools.test.ts
git commit -m "feat(eval): expose charged BIRD a-interact tools"
```

### Task 4: Warble profile and Agent SDK execution

**Files:**
- Create: `eval/bird-interact-agent/profile.yml`
- Create: `eval/bird-interact-agent/context/binding.yml`
- Create: `eval/bird-interact-agent/components/bird_interact/component.yml`
- Create: `eval/bird-interact-agent/components/bird_interact/steps/solve.md`
- Create: `eval/bird-interact/src/agent.ts`
- Test: `eval/bird-interact/tests/agent.test.ts`
- Test: `eval/bird-interact/tests/profile.test.ts`

- [ ] **Step 1: Write the profile files**

Bind `kind: external` to `bird-interact://runtime`, declare one `strong` step, no Wren preconditions, no generic SQL capability, and no borrowed built-ins. The prompt must enumerate costs, require explicit submit, preserve phase continuity, and forbid access outside the nine tools.

This configuration-only step is the documented TDD exception; behavior is tested immediately in the next step.

- [ ] **Step 2: Write failing profile and option-construction tests**

The profile test invokes the repository Warble compiler and asserts the resulting IR contains one `bird_interact` component with external context and no schema digest. The agent test calls a pure `buildBirdAgentOptions` and asserts:

```ts
assert.deepEqual(options.tools, []);
assert.deepEqual(options.allowedTools.sort(), EXPECTED_NINE_MCP_NAMES.sort());
assert.ok(options.disallowedTools.includes("Bash"));
assert.ok(options.disallowedTools.includes("Read"));
assert.ok(options.mcpServers?.bird);
```

Also prove a stored SDK session id becomes `resume` on the next run, the first run has no `resume`, `/run_session.message` is the only user prompt, turn 61 is stopped, and no MCP action executes after `task_done=true` or negative budget.
Assert the task's resolved Wren project path, not the external context locator, is passed as both `prepareDispatch({project})` and Agent SDK `options.cwd`.

- [ ] **Step 3: Run profile/agent tests and verify RED**

Run `node --import tsx --test tests/profile.test.ts tests/agent.test.ts`.

Expected: profile compiles, but agent test fails because `src/agent.ts` does not exist.

- [ ] **Step 4: Implement `WarbleBirdAgent`**

Import `prepareDispatch` and `ModelConfig` through the sibling package's built public entry point; Task 1's `preinstall` guarantees `dist` and its own sibling `node_modules` exist before type-check/build:

```ts
import {
  prepareDispatch,
  ModelConfig,
} from "../../../dispatcher/claude-agent-sdk/dist/index.js";
```

`tsup` bundles that repository-relative dist entry into the eval CLI. For each task call `prepareDispatch` with `project: <wren-project-root>/<db_name>` so the `bird-interact://runtime` external context locator never becomes the Agent SDK filesystem cwd. Select the configured component, attach the per-task MCP server, replace generic tools with the exact allowlist, and call the Agent SDK `query()` loop. Cap model turns at 60, store the returned session id, serialize safe event previews into `adk_events`, and stop accepting tool execution after `task_done` or negative budget.

Expose injection seams for `query()` and IR preparation so unit tests never call a model.

- [ ] **Step 5: Run profile/agent tests and type-check GREEN**

Run:

```bash
node --import tsx --test tests/profile.test.ts tests/agent.test.ts
npm run check-types
```

- [ ] **Step 6: Commit Task 4**

```bash
git add eval/bird-interact-agent eval/bird-interact/src/agent.ts \
  eval/bird-interact/tests/agent.test.ts eval/bird-interact/tests/profile.test.ts
git commit -m "feat(eval): add Warble BIRD a-interact agent"
```

### Task 5: Official-compatible system-agent HTTP service

**Files:**
- Create: `eval/bird-interact/src/server.ts`
- Test: `eval/bird-interact/tests/server.test.ts`

- [ ] **Step 1: Write failing real-HTTP tests**

Start the Node server on an ephemeral port with a fake agent factory. Exercise actual HTTP requests for:

- `GET /health` without credentials or upstream services;
- valid `/init_session` response schema;
- `reset=false` returning the existing session;
- `reset=true` replacing it;
- `/run_session` returning official-compatible response and state;
- unknown task 404, malformed body/mode 400, same-task concurrent run 409;
- two different task ids running concurrently without state leakage;
- fake runner failure 500 while initialized state remains inspectable on retry.

- [ ] **Step 2: Run server tests and verify RED**

Run `node --import tsx --test tests/server.test.ts`.

Expected: FAIL because the server does not exist.

- [ ] **Step 3: Implement the session store and HTTP handler**

Use `node:http`, Zod request validation, a `Map<string, SessionRecord>`, and a per-record `running` flag. Do not add non-standard cleanup endpoints. Redact errors sent to clients while logging safe diagnostics to stderr.

- [ ] **Step 4: Run server tests and type-check GREEN**

Run:

```bash
node --import tsx --test tests/server.test.ts
npm run check-types
```

- [ ] **Step 5: Commit Task 5**

```bash
git add eval/bird-interact/src/server.ts eval/bird-interact/tests/server.test.ts
git commit -m "feat(eval): serve the BIRD system-agent contract"
```

### Task 6: CLI, trace artifacts, and package integration

**Files:**
- Create: `eval/bird-interact/src/cli.ts`
- Create: `eval/bird-interact/src/index.ts`
- Create: `eval/bird-interact/src/artifacts.ts`
- Test: `eval/bird-interact/tests/cli.test.ts`
- Test: `eval/bird-interact/tests/artifacts.test.ts`
- Modify: `eval/bird-interact/package.json`
- Modify: `justfile`

- [ ] **Step 1: Write failing CLI/config tests**

Test pure argv parsing for required `--ir` and `--wren-project-root`, defaults for ports/official service URLs/out dir/model, positive timeouts, missing paths, and `--help`/`--version`. Verify no service starts during parsing.

- [ ] **Step 2: Write failing artifact tests**

Use a temporary task output root and assert every task writes:

```text
<out>/<task-id>/agent-events.jsonl
<out>/<task-id>/trace.json
<out>/<task-id>/metadata.json
```

`agent-events.jsonl` contains safe SDK event previews in order. `trace.json` contains the official-compatible tool trajectory plus dialogue, phase flags, reward, budget, and session id. `metadata.json` contains task/model/service URLs, Warble Agent SDK package version, IR version/hash, resolved Wren project path, MDL hash, and timestamps. Assert all three exclude environment variables, API keys, cookies, connection-file contents, and full upstream HTTP error bodies.

- [ ] **Step 3: Run CLI/artifact tests and verify RED**

Run `node --import tsx --test tests/cli.test.ts tests/artifacts.test.ts`.

- [ ] **Step 4: Implement CLI composition and safe artifact writer**

Implement an append-only event writer and atomic final `trace.json`/`metadata.json` writes. Compose `FetchBirdClient`, `ProcessWrenPlanner`, `WarbleBirdAgent`, artifact writer, and the HTTP server. Add the package bin and export reusable pure modules from `src/index.ts`.

- [ ] **Step 5: Add isolated just recipes**

Append:

```make
bird_eval_dir := "eval/bird-interact"

install-bird-eval:
    cd {{bird_eval_dir}} && npm ci
lint-bird-eval:
    cd {{bird_eval_dir}} && npm run check-types
test-bird-eval:
    cd {{bird_eval_dir}} && npm test
build-bird-eval:
    cd {{bird_eval_dir}} && npm run build
```

- [ ] **Step 6: Run CLI/artifact tests, type-check, and build GREEN**

Run:

```bash
node --import tsx --test tests/cli.test.ts tests/artifacts.test.ts
npm run check-types
npm run build
```

- [ ] **Step 7: Commit Task 6**

```bash
git add eval/bird-interact/src/cli.ts eval/bird-interact/src/index.ts \
  eval/bird-interact/src/artifacts.ts eval/bird-interact/tests/cli.test.ts \
  eval/bird-interact/tests/artifacts.test.ts \
  eval/bird-interact/package.json eval/bird-interact/package-lock.json justfile
git commit -m "feat(eval): add BIRD adapter CLI and trace artifacts"
```

### Task 7: Runbook, official pin fixture, and full verification

**Files:**
- Create: `eval/bird-interact/README.md`
- Create: `eval/bird-interact/upstream.json`
- Create: `eval/bird-interact/scripts/reference_driver.py`
- Create: `eval/bird-interact/tests/fixtures/differential-actions.json`
- Modify: `eval/README.md`
- Test: `eval/bird-interact/tests/upstream-contract.test.ts`
- Test: `eval/bird-interact/tests/official-differential.test.ts`

- [ ] **Step 1: Write the failing upstream-pin test**

Load `upstream.json` and assert it names the repository URL, commit
`451fe2c3518ee1cf908d8139e2913483bd519381`, source root
`BIRD-Interact-ADK`, and pinned source paths relative to that root
(`system_agent/callbacks.py`, `system_agent/tools.py`,
`system_agent/server.py`, `orchestrator/ainteract.py`, and `shared/models.py`),
mode `a-interact`, exact nine costs, HTTP paths, and initial-budget formula
version. Compare those fields to exported runtime constants so documentation
cannot drift from execution.

- [ ] **Step 2: Run the pin test and verify RED**

Run `node --import tsx --test tests/upstream-contract.test.ts`.

Expected: FAIL because `upstream.json` does not exist.

- [ ] **Step 3: Write the failing official differential replay test**

Create `tests/fixtures/differential-actions.json` as test input with a deterministic action vector covering affordable actions, rejected
non-submit, exact-zero submit, insufficient-budget submit, failed submit,
phase-1 pass with and without follow-up, and phase-2 pass. The Node test first
replays the vector through `protocol.ts`/`tools.ts`, then spawns:

```bash
python3 scripts/reference_driver.py \
  --official-checkout "$BIRD_INTERACT_CHECKOUT" \
  --actions tests/fixtures/differential-actions.json
```

`reference_driver.py` must verify checkout HEAD equals the pin, join the pinned
source root beneath the checkout, import the official `callbacks.py` and
`tools.py`, provide only the minimal fake ADK
tool context and fake `httpx.Client` responses, and emit normalized JSON for
observations, executed/rejected flags, costs, remaining budget, phase flags,
reward, and task completion. Compare the normalized sequences exactly.

Skip only when `BIRD_INTERACT_CHECKOUT` is absent. If the variable is present,
an import or prerequisite failure is a test failure. The runbook makes this
test mandatory before any full measurement.

- [ ] **Step 4: Run the differential test and verify RED**

With a pinned checkout and its Python requirements available, run:

```bash
BIRD_INTERACT_CHECKOUT=/path/to/BIRD-Interact \
  node --import tsx --test tests/official-differential.test.ts
```

Expected: FAIL because the reference driver does not exist; the action fixture is test input created in Step 3.

- [ ] **Step 5: Implement the reference driver and make differential replay GREEN**

Implement no benchmark logic in the driver; it only adapts/imports pinned
official functions and normalizes their results. Re-run the exact command and
require every vector to match.

- [ ] **Step 6: Add the pin and runbook**

Document:

1. checkout the pinned official repo and obtain gated GT;
2. start official PostgreSQL, user-simulator, and DB-environment services but replace port 6000 with `warble-bird-interact`;
3. prepare identity-named Wren projects under `<root>/<db_name>` without free column meanings/knowledge;
4. compile the included Warble profile;
5. run official oracle, selected Query/Management/knowledge/follow-up smoke tasks, then full Lite;
6. preserve model/user-simulator versions, dataset/GT hash, Wren/Warble commits, IR/MDL hash, and result files;
7. label any Query-only run as a subset and never compare legacy harness scores to the leaderboard.

Include exact commands, place the mandatory differential command between the
oracle validation and model-driven smoke/full run, and clearly mark model/BIRD
runs as credentialed opt-in integration tests.

- [ ] **Step 7: Run pin and differential tests GREEN**

Run:

```bash
node --import tsx --test tests/upstream-contract.test.ts
BIRD_INTERACT_CHECKOUT=/path/to/pinned/BIRD-Interact \
  node --import tsx --test tests/official-differential.test.ts
```

- [ ] **Step 8: Run complete fresh verification**

Run and read every result:

```bash
git diff --check HEAD~1
just lint-bird-eval
just test-bird-eval
just build-bird-eval
cargo run --locked -p warble-cli -- compile eval/bird-interact-agent \
  -o /tmp/bird-interact-agent-ir.json
git status --short
```

Expected: TypeScript type-check clean; all service-free tests pass; bundle builds;
profile compiles; only intentional task files plus the user's pre-existing
`examples/brief-demo/agent*` untracked directories are present.

- [ ] **Step 9: Review requirements against the spec**

Check every spec section explicitly: pinned schema, exact action surface/costs,
forced submit, authoritative submit transitions, query/Management routing,
single-session phase continuity, no free context tools, HTTP error/concurrency,
safe trace metadata, and runbook. Record any live-only limitation honestly.

- [ ] **Step 10: Commit Task 7**

```bash
git add eval/bird-interact/README.md eval/bird-interact/upstream.json \
  eval/bird-interact/scripts/reference_driver.py \
  eval/bird-interact/tests/fixtures/differential-actions.json \
  eval/bird-interact/tests/upstream-contract.test.ts \
  eval/bird-interact/tests/official-differential.test.ts eval/README.md
git commit -m "docs(eval): add BIRD a-interact runbook"
```
