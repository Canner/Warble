---
title: Evaluating a profile
description: "How to use warble eval run to Pareto-compare tier→model bindings over golden cases, and warble eval compare for a single expected-vs-actual result-set check."
---

`warble eval` exercises the tier/model ablation loop described in
[Tiers & model binding](/concepts/tiers-and-model-binding). Its default `--models` mode replays a
selected agent/runtime once per **flat whole-run** model override; differentiated tier bindings are
a separate, `claude-agent-sdk`-only mode described below.
This page covers the two subcommands in the day-to-day loop — `eval run` and `eval compare`. (A few
more subcommands — `ablate`, `verify-context`, `capture`, `gate`, `monitor-report` — exist for the
closed loop and live suites; run `warble eval --help` for the full list.)

## `warble eval run` — replay goldens, print a Pareto

**1. Have the right agent artifact and a golden set**

The default `claude-code-cli` backend needs `--agent-dir`, a `warble dispatch` output containing
`.claude/agents/…`. The `claude-agent-sdk` and `codex-local` backends instead need `--ir`, with a
different artifact shape for each; see [Which back-end runs the agent](#which-back-end-runs-the-agent).
Every `eval run` mode needs a queryable `--project` and a `--golden` file.

**2. Run it**

```bash
warble eval run --project examples/jaffle-wren --agent-dir agent \
    --golden goldens.yaml --models opus,haiku --parallel 4
```

`--models` is the comma-separated **flat whole-run** model sweep (default `opus,haiku`): each model
is applied to every tier for one pass, and each golden runs once per listed model. The Pareto printed
at the end compares those runs on accuracy, cost, and latency. `--parallel <n>` runs that many cases
concurrently per model — `4`–`8` is a reasonable
speedup, but note that under contention the per-case latency column is also measuring queueing, not
pure model latency.

### Differentiated tier bindings

To inject a different concrete model for each tier during the eval run, use either
`--models-config <tiers.yml>` or all three inline flags: `--strong`, `--cheap`, and
`--orchestrator`. This mode is accepted only with `--backend claude-agent-sdk`; another backend
loud-fails before dispatch rather than flattening or ignoring the binding. `--models-config` takes
precedence over the inline flags.

A differentiated binding runs **one** pass with the resolved tier mapping and bypasses the
`--models` sweep. Omit the differentiated options when you want the normal flat sweep. For a
Claude Code file-target run that should retain a tiered mapping, dispatch the agent with the desired
`warble dispatch --models-config` or inline tier binding first, then run eval with
`--models frontmatter` (and no tier-injection flags) so the runner preserves the emitted mapping.

**3. Narrow or sample for a fast inner loop**

```bash
warble eval run --project examples/jaffle-wren --agent-dir agent \
    --golden goldens.yaml --tags smoke --sample per-tag:3
```

`--tags` restricts to goldens carrying at least one of the listed tags (empty = all). `--sample`
sub-samples the tag-filtered set for a smoke run: a bare count (`20`), a fraction (`0.2` or `20%`),
or `per-tag[:K]` (`K` per tag — this is the smoke default). Use `--out <path>` to also keep the full
JSON report.

:::tip
Every case result is keyed by `(case, agent, model, context)` in a **trace cache**
(`--cache-dir`, default `<project>/.warble/eval-cache`). An unchanged key re-scores from cache with
**0 LLM calls**, so editing only a golden's `expected` field re-scores in seconds instead of
re-running the model. Pass `--no-cache` to bypass the cache entirely and force fresh LLM calls,
refreshing the cached result as it goes.
:::

### Which back-end runs the agent

`--backend` picks the runtime that actually executes each case (default `claude-code-cli`, driving
the `claude` CLI headlessly). It is a separate axis from `--target` on `warble dispatch` — `--target`
picks a *capability posture within one back-end* (e.g. `claude-code:headless`), while `--backend`
picks *which* runtime is asked to run the dispatched agent at all. Three values have a real adapter
today: `claude-code-cli`, `claude-agent-sdk`, and `codex-local` (each of the latter two needs its own
build step first — `just build-ts` / `just build-codex-ts` — `resolve_adapter` names the missing one
if you forget). The remaining accepted value, `vercel`, parses but has no eval runner adapter yet —
it fails loudly at run time (`backend '<name>' has no eval runner adapter yet — supported:
claude-code-cli, claude-agent-sdk, codex-local`) rather than silently falling back to a default.
Seeing that error means you asked for a back-end without an adapter, not that `eval run` is broken.

`codex-local` takes a different artifact under `--ir` than `claude-agent-sdk` does — see the next
section — and it is worth being clear about the boundary. Its eval adapter accepts two unambiguous
dispatch-spec shapes: the original setup shape (`connect_source` / `build_context`) and an explicit
ask shape (`answer_query`). Setup still has no scorer for its `build_success` metric, so that path
only exercises dispatch plumbing. Ask returns its final answer text through the ordinary result
extractor and table comparator, so it produces the same scored case result as the other answer
backends; no codex-specific scorer is involved.

### `codex-local`'s dispatch spec

The `codex-local` adapter needs inputs the `claude-agent-sdk` adapter does not: `--component` (it
dispatches exactly one named component, not every component in the IR) and an external MCP server
binding. The fixed `BackendAdapter::invoke` signature has no extra parameter for them, so for this
back-end `--ir` does not point at the compiled IR directly — it points at a small JSON **dispatch
spec**. Existing setup specs remain valid without a discriminator:

```json title="setup-dispatch-spec.json"
{
  "ir_path": "ir.json",
  "component": "build_context",
  "mcp": {
    "name": "setup",
    "command": "./mcp-server",
    "args": [],
    "source_tools": [],
    "context_tools": ["probe_setup"]
  }
}
```

- **`ir_path`** — path to the compiled IR (`warble compile` output). Resolved relative to the spec
  file's own directory if not absolute, so the spec can travel with its sibling artifacts.
- **`component`** — the single setup-shaped component (`connect_source` / `build_context`) to
  dispatch.
- **`mcp.name`** — the server name `dispatch` registers the tools under (defaults to `"setup"`).
- **`mcp.command`** / **`mcp.args`** — how to launch the MCP server backing the component (`command`
  is also resolved relative to the spec file's directory).
- **`mcp.source_tools`** / **`mcp.context_tools`** — which of that server's tools are allowlisted for
  the `connect_source` / `build_context` step respectively.

Save that JSON next to your compiled IR and point `--ir` at the spec file, not the IR:

```bash
warble eval run --project <project> --ir setup-dispatch-spec.json \
    --golden goldens.yaml --backend codex-local
```

An ask spec is explicit and includes the dedicated Codex home plus the per-step grants consumed by
`AskMcpServerConfig.toolsByStep`:

```json title="ask-dispatch-spec.json"
{
  "shape": "ask",
  "ir_path": "ir.json",
  "component": "answer_query",
  "codex_home": "/absolute/path/to/dedicated-codex-home",
  "mcp": {
    "name": "wren",
    "command": "/absolute/path/to/wren",
    "args": [
      "serve", "mcp", "--project", "/absolute/path/to/wren-project", "--quiet"
    ],
    "tools_by_step": {
      "resolve_intent": ["get_context"],
      "generate_sql": ["run_sql"],
      "repair_sql": ["run_sql"]
    }
  }
}
```

The production server here is supplied by the separately installed `wren` CLI, not by Warble:
`wren serve mcp --project /absolute/path/to/wren-project --quiet`. Its tool names are exactly
`get_context` and `run_sql`, matching the Warble-side names. The current dispatcher exposes one
shared `--query-tool` grant for both SQL steps, so `generate_sql` and `repair_sql` must declare the
same allowlist; unequal lists fail before Codex starts.

Run ask evaluation with one flat model binding. The adapter repeats that one model across the
dispatcher CLI's three required model slots; it does not turn this into a differentiated-tier run:

```bash
warble eval run --project /absolute/path/to/wren-project --ir ask-dispatch-spec.json \
    --golden goldens.yaml --backend codex-local --models gpt-5.4
```

The ask shape requires that flat `--models` binding. Differentiated
`--strong`/`--cheap`/`--orchestrator` bindings remain unsupported for `codex-local` and fail before
dispatch, as they did for the setup shape.

Passing the compiled IR directly under `--ir` (as you would for `claude-agent-sdk`) fails loudly and
names this section rather than silently misreading the file. Mixing setup-only and ask-only fields
also fails loudly instead of choosing a shape by field order.

## Authoring your own golden set

`eval run` is generic: point `--project` at any queryable wren project and `--golden` at any cases
YAML, and it works — nothing here is specific to the bundled `examples/jaffle-wren`. This section
walks through writing a golden set from scratch against a project you stood up yourself.

### The golden schema

A golden file is one YAML document:

```yaml
dataset: jaffle_shop                              # optional, free-form label for context_version's prefix
context_version: jaffle_shop@ec11b6de20539b4       # optional but recommended — see "Pinning context_version" below
cases:
  - id: revenue_excluding_returns                  # unique within the file
    question: "What is total revenue, excluding returned and pending-return orders?"
    tags: [filter-agg, knowledge-rule]              # free-form; drives --tags and --sample per-tag:K
    match: scalar                                  # scalar | set | ordered
    tolerance: { numeric: 0.01 }                    # numeric epsilon; default 0.0 (exact)
    expected:
      columns: [revenue]
      rows: [[1623.0]]
    # result_kind: table                            # table (default) | verdict — see eval/README.md
```

`dataset` and `context_version` are both optional — a minimal file can skip straight to `cases`.
Every other field on a case is required except `tags`, `tolerance` (defaults to exact, `numeric:
0.0`), and `result_kind` (defaults to `table`; `verdict` is for assertive/monitor-style cases whose
final message is a `{blocks, verdict, emitted, verified}` envelope rather than a result table — see
`eval/README.md` if you're evaluating that component family).

### Choosing a `match` mode

- **`scalar`** — the expected table is a single row (often a single cell): counts, sums, rates,
  percentages. Use this for "how many / how much / what fraction" questions where there is exactly
  one right number (within `tolerance`).
- **`set`** — the expected table is a set of rows compared **without** regard to order: breakdowns
  by category, "which customers/orders satisfy X." Use this whenever the question doesn't imply a
  ranking, so a correct agent isn't penalized for returning group-by rows in a different order.
- **`ordered`** — the expected rows are compared **in sequence**: top-N, rankings, time series. Use
  this only when the question actually implies an order (top-3 by revenue) — and when you do, spell
  out the tie-break rule in the question text itself (e.g. "breaking ties by customer_id ascending"),
  because the agent has no other way to know which of two equally-ranked rows you expect first.

### `tolerance` semantics

`tolerance.numeric` is the only field — a per-case epsilon applied to numeric comparisons. `0.0`
(the default, so an omitted `tolerance:` means exact match) is right for anything computed by a
simple, non-lossy aggregation (counts, sums over exact-typed columns). Give derived or rounded
values headroom: a percentage you asked the agent to round to 2 decimals still needs a hair of
tolerance for floating rounding at the boundary (`0.01`–`0.02` is usually enough); a ratio computed
from two aggregates independently is more forgiving still. Tolerance is not a substitute for getting
the underlying rule right — see the knowledge-rules trap below.

### `tags`, `--tags`, and `--sample per-tag:K`

`tags` is a free-form list per case with two consumers:

- **`--tags a,b`** keeps a case if it carries **at least one** of the listed tags (union match, not
  intersection) — empty `--tags` keeps everything.
- **`--sample per-tag:K`** (or bare `per-tag`, meaning `K=1`) sub-samples the already-tag-filtered
  set: it walks the file in order and keeps a case as long as *any* of its tags is still under the
  `K` quota, and keeping it counts toward the quota for **all** its tags at once. A case tagged
  `[filter-agg, knowledge-rule]` can single-handedly satisfy both tags' quotas — so a small,
  deliberately multi-tagged smoke set can cover a lot of ground with few cases. `--sample` also
  accepts a bare count (`--sample 20`) or a fraction (`--sample 0.2` / `--sample 20%`), spread evenly
  across the (tag-filtered) list — those ignore tags entirely and just subsample.

Tag your cases by what they exercise (a trap, a join shape, an aggregation style), not by which
table they touch — that's what makes `per-tag:1` a meaningful smoke run instead of an arbitrary
prefix of the file.

### Pinning `context_version`

`context_version` pins the golden to the MDL it was confirmed against, in `<dataset>@<mdl-sha>`
form. It's optional, but skipping it means `eval verify-context` can never tell you whether your
`expected` values still reflect the current semantic layer — see the next section.

### The knowledge-rules trap

:::danger The knowledge-rules trap
Real projects have canonical rules that aren't visible in the schema: which rows count as "real" data
(test accounts, cancelled/returned orders), which timezone a date is reported in, what an enum value
actually means for a business metric. If a case's `expected` was computed **without** applying one of
those rules, and the agent under test **does** apply it correctly, the agent gets marked wrong for
being right. The driftwood golden set's own header, after a v1→v2 recalibration that hit exactly this,
puts it bluntly: *"the judge must obey its own laws."* Get the underlying rule wrong in `expected` and
no amount of `tolerance` saves you — you are precisely, confidently scoring the correct answer as a
failure.

The fix is not a schema feature — it's discipline: before hand-computing `expected`, write down (or
re-read, if the project already has one, e.g. `instructions.md`) the exact rule for the metric in
question, and apply it the same way every case in the file does.
:::

**Worked example — this happened while writing this guide, not staged for it.** The case
`revenue_excluding_returns` above asks: "What is the total revenue from orders, excluding returned
and pending-return orders?" The first draft's `expected` used one defensible reading — exclude both
`returned` **and** `return_pending` orders (`WHERE status NOT IN ('returned', 'return_pending')`) —
worth **1585.0**. The agent under test answered **1623.0** instead: the reading that excludes only
orders whose status is fully `returned` (`WHERE status != 'returned'`).

**That disagreement is a signal to go check the rule — not a reason to adopt the agent's number.**
Copying whichever answer the agent gave, right at that moment, would be exactly the circular mistake
the next section warns against: the golden would quietly become "whatever this agent says" instead of
an independent ground truth.

So: go check the rule. And the honest finding was that **this project doesn't have one.**
`models/orders/metadata.yml` only *enumerates* the status values (`placed, shipped, completed,
return_pending, or returned`) with no revenue semantics attached to any of them; the project's rules
file (the one the `:::danger` block above points you at) had nothing written for this metric either;
and the project's pre-built `total_revenue` metric is an unfiltered `SUM(amount)` — no status
exclusion at all, a fourth position nobody was even asking for. The one place the project *does* write
a revenue-adjacent rule is a neighboring metric, `customer_lifetime_value`, documented as "sum of all
**completed** order amounts" — which, generalized to this question, implies a third, still-different
reading (`status = 'completed'`, worth **1103.0**). Three defensible numbers, and none of them handed
to you by the project.

That's the trap in its real depth — a level past "the agent disagreed with me": **the rule doesn't
exist yet, and a golden can't be honestly authored until someone decides it and writes it down** — in
the project's own rules file, where the agent reading that same file will also see it. Only then does
`expected` follow from a written law instead of a guess, and the agent and the golden end up judged by
the same thing. For this guide, the deliberate call was to keep `1623.0` — but that's a **recorded
decision** (e.g. "a return isn't final until it completes, so `return_pending` orders still count as
revenue"), not a number that happened to already be sitting on the screen.

### Getting `expected` right: query the semantic layer directly

The cleanest way to populate `expected` is **not** to run the agent and copy its answer — that's
circular: you'd be testing the agent's consistency with itself, not its correctness against ground
truth, and any of its systematic mistakes become permanently "correct" in your golden set. Instead,
write the SQL yourself, run it straight through the semantic layer, and paste the JSON output in
verbatim:

```bash
wren query -s "select count(*) as n from customers where number_of_orders = 0" -o json -q
# {"n":38}
```

The shape of that JSON output — `{"columns": [...], "rows": [[...]]}` after a small reshape, or
directly usable as one row's values — is exactly what `expected` wants, so there's no translation
step to get wrong. This also forces you to actually read and reason about the rule (see above)
*before* looking at what any agent says, instead of after — which is the order that keeps the golden
independent of the thing it's grading.

### `verify-context`: is my golden's ground truth still current?

```bash
warble eval verify-context --golden goldens.yaml --project examples/jaffle-wren
```

reports one of three states by comparing the golden's `context_version` pin against a freshly
computed SHA over the project's MDL files (every `*.yml`/`*.yaml`/`*.md` under the project, content-
addressed — a pure connection/credential edit that leaves the models untouched does not move it):

- **Fresh** — the pin is a SHA (7–64 hex chars) and matches the current MDL SHA (or is a valid
  abbreviated prefix of it). Nothing to do.
- **Stale** — the pin is a SHA but the MDL has changed since. Your `expected` values may no longer
  reflect the current semantic layer. Don't re-stamp blindly: run `--reverify --agent-dir <dir>
  --models <bindings>` first to see **which cases the MDL change actually moved** — a schema
  description tweak might move nothing; a changed enum or a renamed column might move several.
- **Unpinned** — the pin isn't SHA-shaped (e.g. a symbolic label like `frozen-poc`, or no
  `context_version` at all). Fine for a brand-new golden; `--strict` treats this as a failure too, so
  a CI gate can require every shipped golden to be pinned.

`--stamp` rewrites `context_version:` in place to `<dataset>@<current-mdl-sha>`, preserving the
existing dataset prefix (or comments/formatting elsewhere in the file — the rewrite is line-based).
**Treat `--stamp` as a claim, not a formality**: it declares "I've checked, and this golden's ground
truth still holds under the new MDL" — sometimes true after a no-op schema edit, sometimes exactly
the silent golden-set rot this whole mechanism exists to catch, if you stamp without actually
re-checking the affected cases' `expected` values against the new semantics first.

### Why authoring is cheap: measured, not asserted

The trace cache (above) is what makes an authoring loop fast rather than a full LLM re-run per edit.
Measured directly against 5 hand-written cases on `examples/jaffle-wren`:

- **Cold run** (`--no-cache`, all 5 cases fresh): 35.456s wall, 5 LLM calls, $0.2237 total.
- **After editing only a case's `tolerance`** (no `expected`/question/tag change): 0.151s wall,
  reported as **5 hit / 0 miss — re-score only, 0 LLM calls this run**.
- **After editing only a case's `expected`** (the exact edit from the worked example above, `1585.0`
  → `1623.0`): 0.152s wall, same **5 hit / 0 miss**, 0 LLM calls.

Both edits changed only the comparison inputs, not the case's identity (`id`/`question`) or the
agent/model/context axes the cache key is built from — so the cached actual result is reused and only
re-scored locally. In practice this means: write a case, run once to get the real cost of the LLM
call, then iterate on `expected`/`tolerance`/`match` for free until the case reads the way you intend.

## `warble eval compare` — one expected-vs-actual check

`compare` is the per-case result-set scorer `eval run` uses under the hood — it isn't the CI gate
itself; that's the separate `eval gate` subcommand (see the [CLI reference](/reference/cli)). To
exercise the scorer directly for a single result-set comparison, pipe a `CompareRequest` JSON in on
stdin:

```bash
warble eval compare < request.json
```

It writes a `CompareResult` JSON to stdout and exits non-zero when the comparison fails — wire it
straight into a CI step without parsing prose.

:::note
`eval run` needs the backend-specific artifact described above. `eval compare` is stdin-only: it
needs only a `CompareRequest` JSON and never needs a dispatched agent. For every flag on every
`eval` subcommand, see the [CLI reference](/reference/cli).
:::
