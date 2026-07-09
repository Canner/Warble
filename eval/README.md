# Warble eval (MVP)

Execution-based eval for Warble profiles: replay golden **questions** through a dispatched agent
under different tier→model bindings, compare **result sets** (never SQL strings), and print a
**Pareto** (accuracy vs cost vs latency). This is the closed loop that turns "which tier is good
enough" from a guess into a number (vision §6; `docs/capability-model.md` — eval consumes the
`structured_output_capture` capability, which the headless CLI target provides).

## Layout

| Path | What |
| --- | --- |
| `compare/` | `warble-eval-compare` (Rust) — deterministic result-set comparison: `scalar` / `set` / `ordered`, numeric tolerance, column-order/name-insensitive (compares values). stdin JSON → stdout `{pass, reason}`. |
| `golden/jaffle/*.yaml` | Golden cases: `question` + `expected` result + `match` mode + `tags`. Ground truth = **results** captured against a frozen jaffle_shop DuckDB via the semantic layer. `easy` (`cases.yaml`, 8) + `hard` (`hard.yaml`, 6). |
| `answer-agent/` | A Warble project mounting the `answer_query` component (analytical/skill; returns a structured `{columns, rows}` so results are comparable). |
| `runner/` | `warble-eval-runner` (Rust) — for each golden × binding, runs the dispatched agent headless (`claude -p --model <binding> --output-format json`), extracts the result, scores via the `warble-eval-compare` lib, aggregates → Pareto + `report.json`. Driven by `warble eval run`. |

The tier→model **binding is runtime-injected** here via `claude --model` (same IR/agent, different
binding — exactly what the ablation varies). The queryable project (connection + data) is injected
via `--project`; the agent files are installed into `<project>/.claude` for the run and removed after.

## Run

Everything is `warble` subcommands — one native binary, no Node.

```bash
# 1. build the warble CLI (compile + dispatch + eval run/compare are all subcommands)
cargo build --release -p warble-cli   # from the workspace root; binary at target/release/warble

# 2. compile + dispatch the answer_query agent
warble compile eval/answer-agent -o /tmp/answer-ir.json
warble dispatch /tmp/answer-ir.json --target claude-code:headless --out /tmp/answer-agent

# 3. run the Pareto (needs a queryable wren project with `wren` on its venv PATH)
warble eval run \
  --project /path/to/a/queryable/wren-project \
  --agent-dir /tmp/answer-agent \
  --golden eval/golden/jaffle/cases.yaml \
  --models opus,haiku --out /tmp/report.json
```

`warble eval compare` (reads a `CompareRequest` JSON on stdin) remains available standalone for the
comparator alone.

## Result (POC run, jaffle_shop, 14 goldens = 8 easy + 6 hard)

Both `strong→opus` and `strong→haiku` scored **100% accuracy on all 14** questions (simple-agg
through multi-join, time-grain, column pivots, top-N dates, a semantic edge, and a cents-vs-dollars
unit case). Cost and latency were the only differentiators:

| binding | accuracy | cost (easy / hard) | avg latency (easy / hard) |
| --- | --- | --- | --- |
| strong→opus | 1.00 | $0.32 / $0.34 | 25.8s / 48.1s |
| strong→haiku | 1.00 | $0.10 / $0.11 | 20.2s / 32.8s |

**Closed-loop conclusion:** at this scale the semantic layer carries the text-to-SQL difficulty, so
the cheap tier is reliable — eval says **downgrade strong→cheap** for ~3× cost savings at no
accuracy loss (and often lower latency). The decision is data-driven, not guessed.

**Honest bounds:** the jaffle MDL is small and well-described, so no accuracy gap appeared. To find
where the cheap tier breaks, the golden set needs a larger/messier schema (many models, missing
descriptions, ambiguous names), genuinely ambiguous NL, or multi-hop joins. Also: single run per
case (no variance), and cost is subscription-computed. Golden-truth generation — not the runner — is
the long-term bottleneck (see `../../plans` eval-framework notes: curate → capture-confirmed → synthetic).
