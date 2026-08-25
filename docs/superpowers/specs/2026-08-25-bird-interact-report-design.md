# BIRD-Interact report and autopsy design

## Goal

Turn a finished `data/runs/<run>/` into an answer to three questions, without reading
JSON by hand:

1. **How much did it score, and is that score trustworthy?**
2. **Why did the rest fail** — did the agent misread the question, or understand it and
   write the query badly? Those have opposite fixes.
3. **What is missing from the answer** it did submit, measured against gold.

The design is ported from the external harness's `bird-interact-report` / `-diagnose` / `-autopsy`
scripts. Only the *analyses* are ported. Their data model is WrenAI's legacy local
harness (`results.jsonl`, dual strict/tolerant scoring, best-of-N arms) and none of it
applies here, so every input is re-sourced from this package's own tree.

## Boundary

**No runtime command reads an external project.** The port is a reading of that source, not a
dependency on it, and nothing here links, imports, or shells into that checkout.

Two commands, split on the only boundary that is enforceable — what the command is
allowed to touch:

| Command | Reads | Touches PostgreSQL |
| --- | --- | --- |
| `just report-bird-eval` | `data/` tree only | never |
| `just autopsy-bird-eval` | `data/` tree + the prepared database | yes |

Autopsy is also where the **tolerant** verdict is computed, because tolerant needs both
result sets executed and the offline report may not execute SQL. Autopsy writes
`data/runs/<run>/tolerant.json`; the report consumes it when present.

That is the same split as `--oracle-only` versus the full smoke, for the same reason:
a command's blast radius should be legible from its name, not from its flags.

Both take the container and port from the verified `data/runtime/manifest.json`, never
from a flag, so a report can never describe a database the run did not use.

## Inputs

Everything already exists after a smoke; nothing new is written during a run.

```text
data/runs/<run>/a-interact.json      # official verdicts: reward, phase1/2, budget, dialogue
data/runs/<run>/oracle.json          # the gate that let the model run start
data/runs/<run>/manifest.json        # provenance copy of the runtime manifest
data/runs/<run>/python-environment.json
data/runs/<run>/logs/*.log           # user-simulator health lives here
data/runs/<run>/traces/<task>/trace.json     # Warble's record: semantic_sql, native_sql
data/runs/<run>/traces/<task>/metadata.json  # ir_hash, mdl_hash, model, timings
data/runtime/bird_interact_data_with_gt.jsonl
data/cache/bird-interact-lite/<db>/<db>_kb.jsonl
```

### Two records of the same run, deliberately cross-checked

`a-interact.json` is the **official** record and is authoritative for every verdict:
`total_reward`, `phase1_passed`, `phase2_passed`, `budget_used`.

`traces/<task>/` is **Warble's** record and is authoritative for planning provenance:
each submission's `semantic_sql` (what the agent wrote) beside its `native_sql` (what
Wren planned), plus `ir_hash` and `mdl_hash`.

The builder reads both and asserts they agree on task identity, reward, and phase
outcomes. A disagreement is reported as a named defect, never silently reconciled — the
two files disagreeing means one of them is lying about what ran.

## Architecture

```text
inputs ──► report-build ──► report.json ──► report-html ──► report.html
             (pure)          (the IR)         (pure)
```

Analysis and presentation are separated by a JSON document, mirroring this repo's own
`compile → IR → dispatch` seam. The IR is what tests assert against and what a future CI
gate would read; HTML is one renderer over it, and never the only place a number exists.

### Modules

| File | Responsibility | Purity |
| --- | --- | --- |
| `src/report-model.ts` | report IR types and their Zod schema | types only |
| `src/report-build.ts` | inputs → report IR | pure |
| `src/report-diagnose.ts` | snippet grading, failure classification | pure |
| `src/report-simulator.ts` | user-simulator health and the void verdict | pure |
| `src/report-html.ts` | IR → self-contained HTML | pure |
| `src/report-cli.ts` | the `warble-bird-report` bin | the only I/O |
| `src/autopsy-goldgap.ts` | SQL builders, question diff, gap description | pure |
| `src/autopsy-tolerant.ts` | cell normalisation and the tolerant column-mapping search | pure |
| `src/autopsy-cli.ts` | the `warble-bird-autopsy` bin | I/O + `psql` |

`report-build.ts` receives already-parsed inputs; `report-cli.ts` is the only module that
reads the filesystem. This follows `core/`'s sans-IO discipline for the same reason: the
analysis becomes testable without a prepared tree.

PostgreSQL access shells out to `psql -X -A -t` with a fixed statement, exactly as
`prepare-cli.ts` already introspects. No `pg` dependency is added.

## The report IR

### Run level

**Provenance**, copied from the run's `manifest.json` and `python-environment.json`:
official commit, Hugging Face commit, image ID and repo digests, Wren version, Python
version, task IDs, system-agent model, and the user-simulator model. A reported score
that cannot say what produced it is not reportable.

**Strict scoring**, from `a-interact.json.metrics`: `total_reward`, `average_reward`,
`phase1_rate`, `phase1_count`, `phase2_rate`, `phase2_count`, over `total_tasks`. Plus
the oracle gate's own result, because a model run is only meaningful behind a passing
oracle.

**Tolerant scoring**, the same aggregate shape recomputed over the per-task tolerant
verdicts, present only when `tolerant.json` is. The two are always rendered side by side;
a tolerant number is never shown without the strict one beside it, because tolerant
answers a deliberately weaker question and is not a substitute headline.

### Strict and tolerant

**Strict** is the official scorer's verdict, taken unchanged from `a-interact.json`. It
enforces `conditions.order` and compares row tuples.

**Tolerant** answers the different question — *did it compute the right numbers* — and is
ported from `bird_interact_score.py`'s `tolerant_ex`:

- true when every value gold asked for is present under **some** column mapping, so extra
  agent columns and extra rows are absorbed;
- order-insensitive by design; `conditions.order` stays enforced by strict, which is
  always reported beside it;
- row multiplicity is preserved — unlike `ex_base`'s set comparison, which strict inherits
  and which ignores duplicate-row counts;
- cells normalise across the numeric tower: `int`, `float` and `Decimal` collapse to one
  `num` key, non-integral values to 6 significant figures, dates to `%Y-%m-%d`. Without
  this a correct `AVG` reads as wrong because `Decimal('-4.56') != -4.56` in float — a
  scorer artifact, not agent behaviour;
- an empty gold result passes only against an empty prediction. Containment against
  nothing is vacuously true and must never be a free pass;
- the column-mapping search is pruned per gold column and capped at 2,000,000 candidate
  visits. **Hitting the cap is reported as "could not measure", never as a tolerant
  failure.** The search is synchronous and CPU-bound, so an uncapped pathological input
  does not run slow, it stalls with no log line — and a cap that silently reads as "fail"
  would invent a verdict.

The deviations tolerant absorbs are the ones this harness actually produces. The source
documents `alien_1` yielding values identical to gold in all three rows and failing on
`ORDER BY ... ASC` where gold sorts `DESC`. The 2026-08-25 run of this package produced
exactly that on the same task, which is the case tolerant exists to name.

Tolerant needs both result sets executed, so it is computed by `autopsy` and read by the
report from `tolerant.json`. When that file is absent the report renders the tolerant
column as **not computed — run `just autopsy-bird-eval`**. The offline report never
executes SQL and never guesses a tolerant verdict.

**Comparability warnings**, emitted as a list the HTML leads with:

- the run is a subset of one database's Query tasks, never a BIRD-Interact score, and
  never comparable with the official leaderboard;
- the user-simulator model, whenever it differs from the official default
  `anthropic/claude-sonnet-4-5-20250929`, because the simulator's behaviour is part of
  the measurement;
- results from WrenAI's legacy local harness use different action, context, and scoring
  boundaries and are not comparable with this in either direction;
- task count, and whether any Management task ran — the full a-interact protocol is only
  exercised when both Query and Management tasks are present.

**Budget**: per-task `budget_used` against `initial_budget`, and how many tasks ended
exhausted. Budget exhaustion with no passing phase is the difference between "wrong
answer" and "ran out of room to find one", and the headline reward cannot express it.

**Breakdowns** by `difficulty_tier` and by `high_level`.

`difficulty_tier` carries **two vocabularies in the same dataset** — `Simple` /
`Moderate` / `Challenging` on 270 rows and `Easy` / `Medium` / `Hard` on 30. The
breakdown reports the dataset's labels verbatim and states that both vocabularies are
present. It must not silently fold them together: the mapping between them is an
assumption this package has no authority to make.

### User-simulator health

A section with no counterpart in the source, added because this harness has already been
bitten by its absence.

The official user simulator calls its model with a hardcoded `temperature=0`. A model
that rejects that value fails **every** call, and `user_simulator/server.py` falls
through to a canned `"I'm not sure I understand your question."`. The run still completes
with error-free result rows and a valid-looking protocol trace — and scores near zero,
because BIRD deliberately deletes one required knowledge entry per task and `ask_user` is
the only way to recover it.

The IR therefore carries:

- `llmCallFailures`: occurrences of `LLM call failed` in `logs/user-simulator.log`;
- `cannedResponses`: how many `ask_user` answers across the run were exactly the canned
  string, and out of how many asks;
- `verdict`: `healthy` | `degraded` | `void`.

`void` when there was at least one LLM failure, or when every ask in the run got the
canned answer. **A `void` run's scores are withheld** — strict and tolerant alike:
`report.json` records the metrics under a `withheld` envelope and the HTML renders the
reason where the score would be, rather than a number a reader could quote. A broken simulator is indistinguishable from a
weak agent unless something looks, so this looks, every time.

`degraded` when some but not all asks got the canned answer; scores render with the
warning attached.

### Task level

Per task, from the official row cross-checked against the Warble trace:

- `reward`, `phase1Passed`, `phase2Passed`, `budgetUsed`, `budgetRemaining`,
  `initialBudget`, `modelTurns`, `elapsedSeconds`;
- **tool trajectory summary**: calls per tool with their charged cost, and each
  `submit_sql` attempt with the budget before and after it. Submitting is the most
  expensive action and its failures carry no diagnostic, so how many times a task
  submitted blind is a first-class number, not a detail;
- **asks**: each `ask_user` question with the answer, and whether that answer was the
  canned non-answer;
- **knowledge**: the `external_knowledge` IDs the task requires, which of them
  `knowledge_ambiguity[].deleted_knowledge` withheld from the agent's view, and whether a
  withheld one was recovered through `ask_user`. A required definition the agent never
  obtained explains a failure better than the SQL diff does;
- **ambiguity verdicts** (below);
- **failure class** (below);
- **planning provenance**: `semantic_sql` beside `native_sql` for each submission, so a
  Wren planning defect is distinguishable from an agent authoring defect.

## Diagnosis: why a task failed

Ported from `lib/bird-interact-diagnose.ts`, whose signal is a field this package's
merged dataset already carries: `user_query_ambiguity` names each ambiguity the question
deliberately introduced *and* the `sql_snippet` a correct resolution must produce.

### Graded, asymmetric snippet matching

`matchSnippet(agentSql, snippet)` returns `exact` | `columns` | `miss`:

- `exact` — the fragment is present, modulo aliases, quoting, casts and whitespace;
- `columns` — every column the fragment references appears, written differently;
- `miss` — at least one column the fragment needs never appears.

Normalisation lowercases, strips comments and whitespace, drops every `qualifier.`
prefix, and removes `::type` casts. Gold writes `s.ModType`; the agent, coming through
the MDL, writes `public.signals.modtype`. Keeping qualifiers would fail every comparison
on naming rather than on meaning.

The asymmetry is load-bearing and the report states it: a snippet **present** is strong
evidence the agent reached the data the intended reading needs. A snippet **absent** is
weak — `IN ('New','First Quarter')` and `= 'New' OR = 'First Quarter'` are one reading
written twice. Only `miss` counts as evidence of a misread, and nothing here promotes a
grade into a verdict.

Snippets are graded against the **last** submitted SQL of the phase. Critical and
non-critical ambiguities stay separate: only the critical ones are budgeted and scored
upstream, and a non-critical miss is a stylistic divergence, not a misread question.

### Failure classes

```text
passed            the official scorer passed it (strict)
passed-tolerant   right numbers, wrong shape — tolerant passed, strict did not
no-sql            nothing to score — infrastructure, not the agent
exec-error        the submitted SQL did not run
intent-miss       answered a different question — a critical ambiguity resolved
                  wrongly, or a required knowledge entry the agent never obtained
intent-ok         understood the question; the divergence is downstream of
                  understanding
```

`intent-miss` requires a **critical** ambiguity graded `miss`, or a required
`external_knowledge` entry the task never opened — it cannot have applied a formula it
never read. Everything clearing that bar is `intent-ok`: understanding is evidenced, so
the defect is a join, an output shape, a sort direction, or a defect in gold. Those are
not separable from the run record alone, so the class is named and attribution is left to
the per-task detail rather than guessed.

`passed-tolerant` is tested before the misread check: a task whose numbers are right has
demonstrably not misread the question, whatever its output shape. It can only be assigned
when `tolerant.json` exists. Without it a strict failure falls through to the intent
classes and the report says the tolerant column was not computed, rather than implying the
task failed on more than it did.

## Autopsy: what is missing from the answer

Ported from `lib/bird-interact-goldgap.ts`. Answers the question below diagnosis: of what
gold asked for, which parts did the agent's result set not contain.

**Question diff.** A word-level LCS diff of `amb_user_query` against the dataset's clear
`query`, rendered above each failing task. Every masked term is a changed span, so "what
was withheld" stops being something the reader must find by reading two paragraphs side
by side.

**Result gap**, with two rules that make the comparison mean anything:

1. **Match on values, never on column names.** The agent names columns after the user's
   words (`condition_name`); gold names them after the schema (`weathprofile`). A
   name-based diff reports a perfect answer as a total miss. The official scorer compares
   values too, which is why a name mismatch never costs a point.
2. **A per-column diff is only meaningful when row counts agree.** Two result sets of
   different heights cannot share a column multiset, so every column would report
   missing and the reader would learn only "the row set is wrong" — the more useful
   finding, stated once. `describeGap` returns one of three shapes rather than a column
   list with a caveat.

Both statements run inside `BEGIN; SET TRANSACTION READ ONLY` against the same database
the scorer used. Management submissions are skipped for the gap: their statements are
mutations and cannot be a CTE.

## Commands

```text
just report-bird-eval <run> [<run> ...] [--out <file>] [--json <file>]
just autopsy-bird-eval <run> [--out <file>]
```

`<run>` names a directory under `data/runs/`. With more than one run the report becomes a
comparison, which is the question this harness is usually asked; the comparability
warnings lead the page for that reason.

Defaults write beside the run: `data/runs/<first>/report.json` and `report.html` for the
report, and `data/runs/<run>/tolerant.json` plus `autopsy.html` for the autopsy.

The generated-at timestamp is passed into the renderer rather than read inside it, so the
same inputs render byte-identically under test.

## Error handling

Loud by default, in keeping with this repo's wall-hit rule.

- A missing run directory, an unreadable `a-interact.json`, or a run whose manifest does
  not match `data/runtime/manifest.json` is an error, not a degraded report.
- A truncated final line in a JSONL input is skipped with a message naming the line — a
  killed run's complete records are still good.
- An unknown record discriminator is skipped with a message: that is a newer writer, not
  a corrupt file, but a reader silently dropping records is worth saying.
- A trace directory that disagrees with the official row is reported as a named defect.
- **Autopsy with no reachable container fails loudly**, naming the container and port
  from the manifest. It does not silently omit the gap section: a report missing a
  section for an unstated reason is worse than one that refuses to run.
- Within a *reachable* autopsy, an individual task whose gold or submission will not
  execute yields a stated "could not measure" for that task, with the error. The command
  degrades per task, never per section.

## Tests and acceptance

`node:test`, matching the package's existing suite.

- `report-diagnose`: normalisation, `snippetColumns`, each `matchSnippet` grade, and each
  `classifyPhase` branch, including the knowledge-never-opened path into `intent-miss`.
- `report-build`: fixed inputs produce a fixed IR; the official/trace cross-check reports
  a disagreement; the two `difficulty_tier` vocabularies both survive into the breakdown
  unmerged.
- **User-simulator health**: a log with `LLM call failed` yields `void`; an all-canned ask
  set yields `void`; a `void` IR withholds scores; a partially canned set yields
  `degraded` with scores present. This is the regression test for the failure that
  motivated the section.
- `report-html`: renders every IR section; a `void` run renders the reason where the
  score would be and never renders the number.
- `autopsy-goldgap`: `questionDiff` spans, and each of `describeGap`'s three shapes,
  including the row-count-mismatch shape.
- `autopsy-tolerant`: each `normalizeCell` branch, including `Decimal`/float collapse and
  the 6-significant-figure rule; extra agent columns, extra rows and reordered rows all
  pass; a genuinely wrong value fails; empty gold passes only against empty prediction;
  row multiplicity is not discarded; and the visit ceiling raises rather than returning
  false, so a capped search reports "could not measure".
- `report-build`: a run with `tolerant.json` classifies a strict-fail/tolerant-pass task
  as `passed-tolerant`; the same run without it renders the tolerant column as not
  computed and never assigns that class.
- `readme-workflow`: the README documents both commands, their outputs, and the void rule.

Acceptance is:

- `report.json` plus `report.html` generated from the existing `data/runs/alien-5` run;
- a `void` report from `data/runs/alien-5-VOID-usersim-broken`, whose scores are withheld;
- an autopsy over `data/runs/alien-5` producing `tolerant.json`, in which `alien_1` —
  values identical to gold, sorted the other way — is `passed-tolerant`, and the report
  regenerated over the same run shows it in the tolerant column.

## Implementation status

Not started. This document is the design; the implementation plan follows.
