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

MVP realizes nearly the full IR surface: all three `realization_kind`s (`skill`/`tool`/
`gated-tool`), three of four `effect.outcome.kind`s (`none`/`assertion`/`mutation`), and two of
three `trigger.kind`s (`one_shot`/`scheduled`). Scoped to those three IR enums, only the `dispatch`
outcome and the `event` trigger remain documented loud-failing extension points ("wall-hits") —
handler count still stays ≈`3 realization + 4 outcome + 3 trigger`, never growing per-component; an
unrealized arm is an `options.ts` early-throw, not a missing code path.

A fourth, orthogonal axis has its own loud-fail: `llm:per_step_provider` (hybrid cloud+local
routing) loud-fails for any hybrid-staged step under a non-`none` render gate. Where it *is*
supported, there are two realizations — a staged-executor and an in-process `dispatch_step` tool —
selected by `WARBLE_HYBRID_MODE`; see `docs/spec/capability-model.md` §7.2 for the selection rule
and both realizations.

## Target

One `engine × mode` target: **`claude-agent-sdk:local`** — the local `@anthropic-ai/claude-agent-sdk`
(subscription login, compute on your machine). Its capability profile
(`src/targets.ts`) is owned by *this* back-end in TypeScript — the shared thing across back-ends is
the IR + the capability-model semantics, not the profile data.

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

# inspect the resolved plan without dispatching (agents/steps/tiers/capabilities/guardrails)
npx tsx src/cli.ts manifest ../../examples/render-demo/ir.golden.json --out ./run/manifest.json

# multi-turn chat over one component (stdin, line-by-line; Ctrl-D to end)
npx tsx src/cli.ts chat ../../examples/render-demo/ir.golden.json --component answer_query

# authenticated subscription picker data; no user prompt, tools, or MCP session is created
npx tsx src/cli.ts list-models --project /absolute/path/to/project --timeout 10000
```

Flags: `--target` (default `claude-agent-sdk:local`), `--models-config <yaml>` or inline
`--strong/--cheap/--orchestrator`, `--render-flavor programmatic|prompt` (default programmatic),
`--project <dir>` (override the bound wren project cwd), `--warble-bin <path>`, `--out <path>`,
`--max-turns N`, `--title`, `--dry-run` (`dispatch` only), `--standalone` (`emit` only).

`manifest` runs the same preparation as `emit` — no `question`, `query()` is never called — and
serializes the resolved agents/steps/tiers/capabilities/guardrails to stdout or `--out`, structurally
identical to the vercel back-end's bundle (see [`src/manifest.ts`](./src/manifest.ts)) — a consumer
can source a display from whichever back-end actually runs, instead of always reading the vercel
bundle target's output.

`chat` opens a multi-turn session ([`src/session.ts`](./src/session.ts), G1 — single profile, many
turns) over one component (`--component`, default `answer_query`), resuming the SDK session turn
over turn. `--stream-json` streams one `WarbleChatEvent` NDJSON line per event
([`src/events.ts`](./src/events.ts)) instead of plain final-answer text, ending each turn with a
`{"t":"answer",…}` line; every turn also emits a `{"t":"session","id":…}` line — on success **and**
on a failed turn — so a caller can resume that conversation with `--resume <session-id>`.

`list-models` emits exactly one versioned JSON object for the currently authenticated Claude
subscription. It exposes only model ID, display name, and description; unavailable authentication,
runtime, timeout, or protocol states are returned as sanitized JSON. It uses an empty SDK input and
always cleans up its idle query, so it never sends a user turn or enables tools, MCP, or settings.

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

A full run that returns **real numbers** needs the `wren` CLI on PATH and a wired connection. The
committed `examples/jaffle-wren` bundles the semantic layer **and** the `jaffle_shop.duckdb` file
itself, but `wren_project.yml` has no connection block yet, so it still isn't queryable as-shipped —
and `wren` is a separate install, the same runtime prerequisite the file target has. The SDK plumbing,
runtime guardrail enforcement, per-step-tier delegation, and deterministic render are all verified
independently of that data runtime (see `SDK-NOTES.md` and the test suite).
