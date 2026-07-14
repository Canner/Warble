# claude-agent-sdk

The second Warble back-end target: the **Claude Agent SDK** `query()` loop (TypeScript/Node).

Where `claude-code-cli` (Rust) emits *static* agent files, this back-end drives the SDK's **in-loop**
`query({options})` at runtime, so it is bound to the SDK's language (TypeScript). It consumes the
**same IR** (`docs/spec/ir-schema.md`) as every other back-end — it never links the Rust core; the
`ir.json` JSON document is the only thing crossing between them.

## What this back-end proves

- **IR JSON is a real language-neutral seam** — a Rust front-end (`warble compile`) emits `ir.json`;
  this **TypeScript** back-end consumes the identical file, with no shared types and no Rust link.
  (The file target can't show this — it lives in the same Rust workspace as the compiler.)
- **Thin, borrow-the-loop back-end** — the dispatcher only maps three orthogonal IR enums to
  `query({options})`; the agent loop, permissions, sandbox, and tool calls are all borrowed from the
  Agent SDK. Handler count ≈ `3 realization + 4 outcome + 3 trigger`, never per-component.
- **Closes three file-target wall-hits**:
  - **#1 per-step tier** → realized **in-loop** via SDK `agents` (per-agent model), no static
    subagent files. `llm:per_step_tier` is *native* on this target (vs *realize-via(subagents)* on
    the file target).
  - **#3 guardrail runtime enforcement** → the `read_only_execution` guardrail is enforced at
    runtime by a `canUseTool` callback that inspects every tool call and denies escapes with a
    reason fed back to the model — not the file target's static allow/deny strings.
  - **#5 per-step observability/trace** → per-step usage + per-tier cost/latency are captured from
    the `query()` message stream (`modelUsage`) into `trace.json`.
- **One renderer across back-ends** — the render step shells out to `warble render` (the Rust
  deterministic reference renderer); HTML is not re-implemented in TS.

MVP scope matches the file target's validated slice for apples-to-apples comparison: `skill` ·
`render`/`none` · `one_shot`, `read_only_execution`. `tool`/`gated-tool`, `assertion`/`mutation`/
`dispatch`, and `scheduled`/`event` are documented loud-failing extension points ("wall-hits").

## Target

One `engine × mode` target: **`claude-agent-sdk:local`** — the local `@anthropic-ai/claude-agent-sdk`
(subscription login, compute on your machine). Its capability profile
(`src/targets.ts`) is owned by *this* back-end in TypeScript — the shared thing across back-ends is
the IR + the capability-model semantics, not the profile data.

## Layout

```
src/
├── ir.ts          # IR JSON types + validating parser (mirrors docs/spec/ir-schema.md)
├── targets.ts     # claude-agent-sdk:local capability profile
├── resolve.ts     # capability resolution (native/realize-via/degrade/fail; safety-critical → abort)
├── models.ts      # tier → model binding (--models-config YAML; same format as the file target)
├── options.ts     # IR enums → query({options}) mapping (the core; loud-fails on unsupported values)
├── guardrails.ts  # runtime read-only enforcement via canUseTool
├── render.ts      # shell out to `warble render` (reuse the Rust renderer)
├── run.ts         # drive query(), capture the render envelope + per-step trace
├── dispatch.ts    # high-level API: prepareDispatch (pure) + dispatch (live)
├── codegen.ts     # emit an importable TS agent module from a prepared dispatch
├── index.ts       # public library barrel (@warble/claude-agent-sdk)
└── cli.ts         # warble-agent-sdk dispatch|emit <ir.json> [...]
```

## Three ways to use it

Same IR, same mapping — pick the surface that fits your integration.

### 1. CLI

```bash
npm install

# offline: build + inspect the assembled query() options without calling the SDK
npx tsx src/cli.ts dispatch ../../examples/render-demo/ir.golden.json "orders overview" \
    --out ./run --dry-run

# live: drive the Agent SDK loop, enforce read-only at runtime, render the dashboard
npx tsx src/cli.ts dispatch ../../examples/render-demo/ir.golden.json "orders overview" \
    --out ./run --render-flavor programmatic
#   → ./run/result.txt, ./run/trace.json, ./run/dashboard.html, ./run/capability-report.json
```

Flags: `--target` (default `claude-agent-sdk:local`), `--models-config <yaml>` or inline
`--strong/--cheap/--orchestrator`, `--render-flavor programmatic|prompt` (default programmatic),
`--project <dir>` (override the bound wren project cwd), `--warble-bin <path>`, `--max-turns N`,
`--title`, `--dry-run`.

### 2. Embed the library in your own TS app

`npm run build` emits `dist/` with types. Import and drive it in-process:

```ts
import { dispatch } from "@warble/claude-agent-sdk";

const out = await dispatch(
  { ir: fs.readFileSync("ir.json", "utf8"), question: "orders overview", irPath: "ir.json" },
  { outDir: "./run" },
);
console.log(out.components[0].result.htmlPath, out.components[0].result.trace);
```

For **full control of the loop**, stop at `prepareDispatch` and hand `plan.options` to the SDK's
`query()` yourself (add your own tools / MCP servers / permission strategy):

```ts
import { prepareDispatch, makeReadOnlyGuard } from "@warble/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";

const { components } = prepareDispatch({ ir, question: "orders overview", irPath: "ir.json" });
const { plan } = components[0];
const { canUseTool } = makeReadOnlyGuard({ readOnly: plan.meta.readOnly, writeScope: null, cwd: plan.options.cwd! });
for await (const m of query({ prompt: plan.prompt, options: { ...plan.options, canUseTool, /* + your tools */ } })) {
  /* your own streaming/UI */
}
```

### 3. Generate a TS agent module to check into your codebase (`emit`)

Freeze the resolved plan into an importable `.ts` (analogue of the file target emitting `.md`):

```bash
# thin (default): generated module imports the runtime helpers from @warble/claude-agent-sdk
npx tsx src/cli.ts emit ../../examples/render-demo/ir.golden.json --out src/agents/dashboard.ts

# standalone (eject): inlines the guard + trace + render shell — only @anthropic-ai/claude-agent-sdk
# + the `warble` binary (for render) are needed; no @warble/* dependency
npx tsx src/cli.ts emit ../../examples/render-demo/ir.golden.json --out src/agents/dashboard.ts --standalone
```

Each component becomes an exported `async function <verb>(question, opts?)` that drives the loop with
the frozen `query({options})`. The generated module type-checks under `--strict` in both modes.
Because `canUseTool` (guardrail) and render are live code, the **thin** output imports them from the
library; **standalone** inlines them (the `warble` binary is still used for render — that is the
renderer-reuse contract, not a TS dependency).

## Dev

```bash
npm run check-types    # tsc --strict, no emit
npm test               # node:test suite (offline; render test skips if `warble` isn't built)
npm run build          # tsup → dist/ (ESM .js + .d.ts) for the library + CLI bin
```

## Runtime prerequisite for a full data e2e

A full run that returns **real numbers** needs the `wren` CLI on PATH and a **queryable** DuckDB wren
project (connection + data). The committed `examples/jaffle-wren` ships the semantic layer only, and
`wren` is a separate install — the same runtime prerequisite the file target has. The SDK plumbing, runtime guardrail enforcement,
per-step-tier delegation, and deterministic render are all verified independently of that data
runtime (see `SDK-NOTES.md` and the test suite).
