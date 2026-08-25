# BIRD-Interact a-interact eval for Warble + Wren

BIRD-Interact is an interactive text-to-SQL benchmark, pinned here at
`https://github.com/bird-bench/BIRD-Interact.git`. Where a classic text-to-SQL benchmark hands the
model a fully specified question, BIRD-Interact hands it an **ambiguous** one over a real PostgreSQL
database and makes it work the gap out for itself, against a hierarchical knowledge base, database
documentation, and a function-driven **user simulator** it has to interrogate. Tasks span BI queries
and CRUD/management work, and every one is graded by executing the result, never by SQL string
match.

The benchmark has two modes. `c-interact` is passive and conversational on a fixed workflow;
**`a-interact`** — the mode this package runs — is agentic: the model leads, choosing each next
action itself. A task runs in two phases, a phase-1 ambiguous query and then a phase-2 follow-up the
user delivers only once phase 1 has been submitted successfully (rewards 0.7 and 0.3). Every action
costs **bird-coins** from a per-task budget — a fixed starting allowance, more for each planted
ambiguity, plus an adjustable user-patience term — and talking to the user is among the dearest.
Schema reads, knowledge lookups, trial SQL, clarification, and submission therefore all compete for
the same finite budget: what is measured is interaction *strategy* under scarcity, not SQL skill
alone.

**Why Warble runs it.** The rest of [`eval/`](../README.md) grades Warble against goldens Warble
wrote — the right tool for tier→model decisions, but the house grading the house. Here the question,
the ambiguity, the user, the database, the scorer, and the ground truth all belong to someone else,
while the agent under test is an ordinary declared Warble profile (`agent/`) with no privileged
escape hatch. It also exercises what a single golden question cannot: multi-turn tool discipline, a
budget the agent has to plan against, and Wren planning SQL inside a loop Warble does not drive.

```text
official runner ──► :6000  system agent   ← Warble owns this (this package): the session loop,
                           │                nine charged tools, one budget ledger, and Wren
                           │                planning Query SQL before BIRD executes or scores it
                           ├──► :6001  user simulator            official · authoritative
                           └──► :6002  DB environment + scorer   official · authoritative
```

## What this package replaces

This package replaces only the official BIRD system-agent service on port 6000. The pinned official
orchestrator, user simulator (6001), DB environment/scorer (6002), PostgreSQL data, and ground truth
remain authoritative. Warble supplies the agent/session/tool loop; Wren plans query-like SQL before
the official DB service executes or scores it.

The implementation follows the official `a-interact` action space: nine charged tools, one budget
ledger across phase 1 and phase 2, authoritative `/submit` outcomes, and the official free terminal
submit when the budget is exhausted. Management SQL bypasses Wren planning and reaches the official
submission service unchanged.

Everything the run needs is prepared into this package's ignored `data/` tree.
**No runtime command reads any project outside this repository** — no external checkout, its
virtualenv, its `.env`, or a Wren project provisioned outside Warble; the gated ground-truth file may be *imported* from anywhere once, and is copied —
never linked.

## Prerequisites

| Requirement | Why it stays external |
| --- | --- |
| Docker | runs the official `shawnxxh/bird-interact-postgresql` image |
| Python >= 3.10 and < 3.13 | the official ADK's supported interpreter range |
| `psql`, `createdb`, `dropdb` on `PATH` | the official DB environment shells out to them |
| Model credentials | secrets, never stored in the repository |
| A gated GT JSONL from BIRD | gated benchmark material |

### The gated ground truth

`bird_interact_gt_kg_testcases_1008.jsonl` holds `sol_sql`, `external_knowledge`, and `test_cases`
for all 300 Lite tasks. The public Hugging Face dataset omits them deliberately. Obtain the file
**only through the official BIRD gated process** below; this README publishes no download URL for
it. Only this half is manual — preparation fetches and verifies the public half itself from the
pinned commit.

**1. Ask BIRD for the file.** Email `bird.bench25@gmail.com` with the tag
`[bird-interact-lite GT&Test Cases]` in the subject; the reply is automatic and carries the GT
JSONL. That request path is documented by the pinned checkout itself — see
`data/cache/BIRD-Interact/README.md` and `BIRD-Interact-ADK/README.md` — so a reviewer can re-check
it at the pin rather than taking this README's word for it. Ask for **lite**;
`[bird-interact-full GT&Test Cases]` returns the larger full-set file, which this package rejects.

**2. Save the attachment unchanged.** Put it anywhere readable — `--gt` copies the *contents* into
`data/private/` under the name above, so the path you keep it at is yours to choose. Do not let a
mail client or editor re-encode it or rewrite its line endings, and do not run the official
`combine_public_with_gt.py`: this package merges the GT fields into the pinned, byte-verified public
snapshot itself, and pre-merging against an unpinned public copy throws that verification away.

**3. Check it before importing.** 300 rows, each carrying the four fields the merge reads:

```bash
gt=/absolute/path/to/bird_interact_gt_kg_testcases_1008.jsonl
python3 -c 'import json,sys; rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]; need=("sol_sql","external_knowledge","test_cases","follow_up"); print(len(rows),"rows;",sum(all(k in r for k in need) for r in rows),"complete")' "$gt"
shasum -a 256 "$gt"
```

Expect `300 rows; 300 complete`. Keep that SHA-256: preparation records the same digest in the
runtime manifest, so it is what ties a reported result to the exact GT that produced it.

**4. Import it once** with `just prepare-bird-eval --gt "$gt" …`. Preparation validates all 300
rows, copies the file to `data/private/` with mode `0600`, and hashes it into the manifest. Later
runs omit `--gt`; preparation revalidates the private copy every time. `data/` is gitignored — never
commit the GT, and never place a copy inside the official checkout.

If preparation refuses the file, the message names the mistake:

| Failure | Cause |
| --- | --- |
| `ground-truth data must contain exactly 300 rows` | the full-set GT, or a truncated download, rather than Lite |
| `Invalid ground-truth JSONL at line N` | the attachment was mangled — saved as HTML, re-encoded, or re-wrapped in transit |
| `Invalid ground-truth row at line N` | valid JSON, but missing one of the four fields — usually the public file, not the GT one |
| `Public and ground-truth instance ID sets must be identical` | a GT release for a different dataset revision than the pinned public snapshot |

### A Warble-local pinned Wren CLI

Do not reuse another project's Wren executable:

```bash
/absolute/path/to/python3.11 -m venv eval/bird-interact/data/cache/wren-cli
eval/bird-interact/data/cache/wren-cli/bin/python -m pip install 'wrenai==0.8.1'
eval/bird-interact/data/cache/wren-cli/bin/wren --version
```

Pass that executable to both commands with `--wren-bin`; its reported version is recorded in the
preparation manifest.

## Pinned sources

| Source | Pin |
| --- | --- |
| Official code | `https://github.com/bird-bench/BIRD-Interact.git` @ `451fe2c3518ee1cf908d8139e2913483bd519381` |
| Public data | `https://huggingface.co/datasets/birdsql/bird-interact-lite` @ `f7881a9c2b9630cc4fc13b0c39279740b0a2fd87` |
| `bird_interact_data.jsonl` SHA-256 | `d155fa0855bc1885f77df2fcc357d3056e10426cd6093c0042aa99d79067af08` |
| PostgreSQL image | `docker.io/shawnxxh/bird-interact-postgresql:latest` |

Public data is acquired from the pinned Hugging Face **tree API**
(`.../tree/<commit>?recursive=true&limit=1000`) and downloaded from immutable
`resolve/<commit>/<path>` URLs, so no Git LFS client is required. The snapshot is the *complete*
metadata set — the main JSONL plus every database's `<db>_schema.txt`,
`<db>_column_meaning_base.json`, and `<db>_kb.jsonl` — because charged BIRD tools read those files.

`public-snapshot.json` is tracked in Git as the local trust root: the exact sorted **57-file**
path/type/OID/size listing returned by the pinned commit. On every acquisition *and* every reuse,
each local file's byte size, SHA-256, and standard **Git blob OID** (`SHA1("blob " + size + NUL +
bytes)`) are recomputed and compared against both that tracked listing and a fresh tree listing. A
modified, deleted, or added metadata file fails; a changed local manifest cannot legitimize changed
content because the blob OID is pinned in Git. A failed refresh never patches a verified cache in
place.

The official checkout is verified the same way before it is imported or reused: normalized `origin`,
exact detached HEAD, an index that matches the pinned HEAD tree (including assume-unchanged and
skip-worktree flags), no unexpected untracked entries, and no Python bytecode outside the managed
`.venv`.

### `latest` is not provenance

The `latest` tag is mutable, so the tag alone proves nothing about what ran. Preparation records
the container's **actual image ID and repository digests** in the manifest, and a later preparation
requires them to match. A mismatch is an actionable error; Warble never removes or rebuilds the
container for you. Inspect them yourself with:

```bash
bird_image_id=$(docker inspect warble_bird_interact_postgresql --format '{{.Image}}')
docker image inspect "$bird_image_id" --format '{{.Id}} {{json .RepoDigests}}'
```

## The workflow

Run everything from the Warble repository root.

```bash
just install-bird-eval

just prepare-bird-eval \
  --gt /absolute/path/to/bird_interact_gt_kg_testcases_1008.jsonl \
  --wren-bin "$PWD/eval/bird-interact/data/cache/wren-cli/bin/wren"

just smoke-bird-eval --oracle-only \
  --python-bin /absolute/path/to/python3.11 \
  --wren-bin "$PWD/eval/bird-interact/data/cache/wren-cli/bin/wren"

just smoke-bird-eval \
  --python-bin /absolute/path/to/python3.11 \
  --wren-bin "$PWD/eval/bird-interact/data/cache/wren-cli/bin/wren"
```

### `just prepare-bird-eval`

```text
--gt <file>                    gated GT to import once; omit it on later runs
--official-checkout <dir>      seed an existing pinned checkout instead of cloning
--public-data <file>           copy an existing pinned bird_interact_data.jsonl
--postgres-container <name>    default warble_bird_interact_postgresql
--postgres-port <port>         default 55432, used only when creating the default container
--wren-bin <path>              default wren
```

Preparation is transactional. It validates the GT, imports and verifies both pinned sources, merges
only the official GT fields into all 300 rows, selects exactly `alien_1` through `alien_5`,
starts or verifies the labeled PostgreSQL container, introspects `alien`, generates a
physical-identity Wren MDL, links the official ADK at Warble's public cache, dry-plans the staged
project through Wren, and only then promotes `data/runtime`. **Any earlier failure leaves an
existing `data/runtime` byte-for-byte intact.**

An existing container is adopted only when it runs the official image, publishes `5432/tcp`, and —
for the default name — carries the `ai.getwren.warble.eval=bird-interact` label. Warble creates only
the default container and never stops, removes, or reconfigures an unrelated one.

### `just smoke-bird-eval`

```text
--oracle-only                  stop after a passing oracle; never inspect or start port 6000
--wren-bin <path>              default wren
--python-bin <path>            default python3.11; must report >= 3.10 and < 3.13
--system-model <name>          default claude-sonnet-4-5-20250929
```

There is deliberately **no** container or port flag here: both come from the verified
`data/runtime/manifest.json`, so the smoke can never silently diverge from preparation.

Before any service starts, the launcher re-verifies the manifest, the five-row smoke file, the
identity MDL, the private GT, the official checkout, the ADK public-data symlink, free ports, and a
Wren dry-plan — and recomputes the complete public snapshot **offline**, requiring its manifest
SHA-256 to equal the recorded one. Metadata changed after preparation fails here, not mid-run.

The official oracle gates the model run: five error-free rows for exactly `alien_1` through
`alien_5`, both phases passing. A failing oracle stops the workflow and the system agent is never
started.

## Model credentials

Put them in `data/private/.env` (mode `0600`) or the process environment; explicit process values
always win. That file is ignored by Git and is never copied into the official checkout. Nothing is
tracked in the repository — create it yourself from this `.env.example` content:

```dotenv
# data/private/.env.example — copy to data/private/.env and fill in
USER_SIM_MODEL=anthropic/claude-sonnet-4-5-20250929
ANTHROPIC_API_KEY=

# OpenAI instead:
# USER_SIM_MODEL=openai/gpt-4o
# OPENAI_API_KEY=

# Google instead:
# USER_SIM_MODEL=gemini/gemini-2.5-pro
# GEMINI_API_KEY=

# A LiteLLM proxy instead:
# USER_SIM_MODEL=litellm_proxy/gpt-4o
# LITELLM_API_BASE=http://127.0.0.1:4000
# LITELLM_API_KEY=

# Ollama instead (no key required):
# USER_SIM_MODEL=ollama/llama3.1
# OLLAMA_API_BASE=http://127.0.0.1:11434

# The Warble system agent uses the Claude Agent SDK's own authentication:
# CLAUDE_CODE_OAUTH_TOKEN=
```

Missing user-simulator authentication fails preflight before any service starts. The Warble system
agent accepts `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, or a successful silent
`claude auth status`; its OAuth token is never sent to the user simulator or any official runner.

**`--oracle-only` is credential-free.** The oracle replays official ground truth and never calls the
user simulator, so that mode requires no model configuration at all and never checks system-agent
authentication or port 6000.

## Official-process isolation

Every official Python process is launched with an allowlisted environment holding only `PATH`,
`HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `NO_PROXY`/`no_proxy`, `PYTHONPATH`, `PYTHON_DOTENV_DISABLED=1`,
`PYTHONDONTWRITEBYTECODE=1`, `DATASET`, the `PG_*` settings, the three service ports, and
`PATIENCE`. The DB environment and both official runners receive **no** model key, token, model
name, or provider base URL; only the user simulator and the Warble system agent get credentials.

Warble's **own** children — the `cargo` compile, the adapter build, and the system agent — are the
only processes that additionally receive `USER`. The Claude Agent SDK resolves a claude.ai login
through the macOS Keychain, and that lookup reports "not logged in" without it, so a run that relies
on `claude auth status` instead of an explicit key fails preflight otherwise. No official BIRD
process ever receives it; the package test asserts both halves of that boundary from one input
environment.

- `PYTHON_DOTENV_DISABLED=1` stops official code from discovering an ancestor `.env`, and startup
  verifies the installed `python-dotenv` actually honors it.
- An `.env` file **inside the official checkout is rejected** before anything spawns; move its
  settings to `data/private/.env`.
- `PYTHONDONTWRITEBYTECODE=1` keeps the pinned source tree clean, and cache verification **rejects
  Python bytecode** anywhere outside the managed `.venv`.
- An existing ADK virtualenv is reused only when its own interpreter reports Python 3.10-3.12 **and
  the same major/minor version** as `--python-bin`. On a mismatch the run fails with instructions;
  Warble never deletes or rebuilds it for you.

### Python provenance, stated honestly

The launcher installs the pinned checkout's `requirements.txt` into
`data/cache/BIRD-Interact/BIRD-Interact-ADK/.venv`. **That file does not pin the full transitive
dependency graph, so the resulting environment is not reproducible from the pin alone.** What is
recorded instead is what actually ran:

```text
data/runs/alien-5/python-environment.json   # versions, requirements SHA-256, freeze SHA-256
data/runs/alien-5/python-freeze.txt         # pip freeze --all
```

## Package layout

The Warble profile this adapter serves is tracked inside the package, beside the TypeScript source:

```text
eval/bird-interact/
  agent/                                             # the Warble profile, compiled by warble-cli
  src/  tests/                                       # the system-agent adapter and its tests
  public-snapshot.json  upstream.json                # tracked trust roots
  data/                                              # ignored local tree (see below)
```

`just smoke-bird-eval` compiles `agent/` into the run directory before it starts anything; to compile
it by hand from the Warble root:

```bash
cargo run --locked -p warble-cli -- compile eval/bird-interact/agent -o /tmp/bird-interact-ir.json
```

## Local data layout

```text
eval/bird-interact/data/
  private/bird_interact_gt_kg_testcases_1008.jsonl   # mode 0600, gitignored
  private/.env                                       # optional, gitignored
  cache/BIRD-Interact/                               # pinned official checkout
  cache/bird-interact-lite/                          # verified public snapshot
  cache/wren-cli/                                    # Warble-local pinned Wren CLI
  runtime/bird_interact_data_with_gt.jsonl           # 300 merged rows
  runtime/smoke-alien-5.jsonl                        # exactly alien_1 .. alien_5
  runtime/identity-projects/alien/target/mdl.json
  runtime/manifest.json                              # revisions, hashes, image ID, port, version
  runs/alien-5/
```

Only `data/.gitignore` and `data/README.md` are tracked. Results and provenance land here:

```text
data/runs/alien-5/oracle.json
data/runs/alien-5/a-interact.json
data/runs/alien-5/manifest.json                      # copy of the runtime manifest used
data/runs/alien-5/logs/                              # one log per child process
data/runs/alien-5/traces/<task-id>/agent-events.jsonl
data/runs/alien-5/traces/<task-id>/trace.json
data/runs/alien-5/traces/<task-id>/metadata.json
```

A successful a-interact run requires five error-free result rows and one trace directory per task.
A zero reward is an acceptable smoke outcome; a missing or errored row is not.

### Cleanup

The smoke stops only the child process groups it started. The Warble-owned PostgreSQL container is
deliberately left running for reuse. Stop it yourself when you are done — this is a stop, not a
delete, so the prepared database survives:

```bash
docker stop warble_bird_interact_postgresql
```

## Reading a finished run

A finished run is a directory of raw record. Two commands turn it into something a person can read,
and they are deliberately separate: one never leaves the disk, the other needs the database.

```bash
just autopsy-bird-eval alien-5   # needs the prepared PostgreSQL; writes tolerant.json
just report-bird-eval alien-5    # offline; fills its tolerant column from that file
```

Run them in that order — the report reads what the autopsy wrote — and name runs positionally, by
their directory name under `data/runs/`.

### `just report-bird-eval <run> [<run> ...]`

```text
--out <file>                   one HTML file covering every named run
                               (default: data/runs/<run>/report.html, one per run)
--json <file>                  one JSON file: a single report, or an array of them
                               (default: data/runs/<run>/report.json, one per run)
```

**Offline.** It re-executes nothing, contacts no service, and recomputes no score from the database:
everything on the page comes from what the run already recorded — `a-interact.json`, the run's
`manifest.json`, each `traces/<task>/trace.json` and `metadata.json`, `python-environment.json`,
`logs/user-simulator.log`, `user-simulator.json`, and the prepared dataset. It never reads
`data/private/.env`, so the file holding your key is not on its path at all. Naming several runs
together with `--out` renders them as a single comparison page; every run also gets a one-line
summary on stderr.

The simulator's model is read from the run's own `user-simulator.json`, which the smoke writes when
it starts one. A run made before that record existed reports the model as **unrecorded** rather than
guessing from the current `.env` — a guess dressed as provenance is worse than a stated gap, since
editing `.env` between the run and the report would otherwise rewrite what the run is said to have
used.

The report cross-checks the official row against Warble's own trace in both directions — identity,
reward, both phase outcomes, a trace with no official row, a manifest task with no official row —
and names each disagreement as a **defect** instead of reconciling it. Two files disagreeing means
one of them is wrong about what ran, and the reader has to know which numbers are in question.

### `just autopsy-bird-eval <run>`

```text
--out <file>                   where to write the page
                               (default: data/runs/<run>/autopsy.html)
```

Exactly one run: an autopsy replays SQL against one database, so a second positional is a usage
error rather than a silently ignored argument. It writes `data/runs/<run>/tolerant.json` — the
phase-1 verdicts the report reads — and `data/runs/<run>/autopsy.html`, which states per task the
verdict, what is actually missing from the agent's result, and the ambiguous question diffed against
what the task actually meant.

The container, host port and template database all come from `data/runtime/manifest.json`; there is
deliberately no flag for them, so an autopsy cannot address a database preparation did not build.
**An unreachable database is a refusal, not a degraded report** — it probes first and stops, naming
the container and how to start it, rather than writing a page whose every verdict would be missing.
Within a reachable run, degradation is per task and never per section: a statement that will not
execute, or a comparison that hits its search ceiling, makes that one task read *could not measure*,
stays out of `tolerant.json` entirely, and is never recorded as a failing verdict.

Every statement runs inside `BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;`, so a replay leaves
nothing behind. That is also why some tasks are listed *not attempted*, each with its reason:
`Management` submissions are mutations, gold that needs `preprocess_sql` needs mutating setup a
read-only replay cannot reproduce, and a task whose `instance_id` matches no dataset row has no gold
to replay at all. The fixed `alien_1` through `alien_5` set is all `Query`, so all five are
attempted.

### Strict and tolerant

**Strict is the official verdict, untouched.** The pinned scorer executes both statements, rounds
them, and compares result sets — `conditions.order` decides whether row order counts — and the
dataset's own custom `test_cases` can accept a submission on terms of their own.

**Tolerant asks the weaker question strict cannot**: were the agent's numbers right? It searches for
an injective mapping of gold's columns onto the agent's under which every gold row, with its
multiplicity, is contained in the agent's rows — so extra columns, extra rows, row order and numeric
representation stop deciding the answer.

Non-integral values round to **2 decimal places**, and that 2 is not this package's choice: it is
`preprocess_results(results, decimal_places: int = 2)` in the pinned checkout's
`BIRD-Interact-ADK/shared/db_utils.py`, the function the official *strict* comparator puts every
value through before comparing. Tolerant must never be pickier than strict on an axis strict has
already decided, so rounding harder than the official comparator — six significant figures, say —
would make tolerant reject pairs strict accepts, which is backwards.

For the same reason, **tolerant is a superset of strict rather than an alternative to it**: a task
counts as tolerant when strict passed *or* the replay passed. Strict acceptance can arrive through
custom `test_cases` a result-set replay cannot reproduce — in the recorded `alien-5` run, `alien_2`
passes strict on `STDDEV` where the replay wants `STDDEV_POP` — and without that *or* the pair would
render inverted, as if tolerant were the harder bar.

**The two columns are in different units and must never be subtracted from one another.** The strict
column sums the official per-task reward; the tolerant column counts tasks, one per pass, because a
replay yields a verdict and there is no reward to sum. Read them side by side.

The tolerant column exists only when `tolerant.json` does, and the ways it can be missing are not
one state:

| `tolerant.json` | What the report does |
| --- | --- |
| absent | the tolerant column reads **not computed — run `just autopsy-bird-eval`** |
| present, valid, empty `{}` | an autopsy ran and judged nothing — a real state, not "not computed" |
| present but malformed | the report **refuses** and names the file |

Malformed is a hard error rather than a degrade because every alternative invents a score: filtering
the bad entries out would render a confident `tolerant 0/N` describing nothing, and falling back to
"not computed" would quietly downgrade a *broken* autopsy to one that never ran.

The recorded `alien-5` run is the worked example (`data/runs/alien-5/report.json`):

```text
strict     phase 1 1/5    average reward 0.20
tolerant   phase 1 3/5    average 0.60
defects    none           alien_1 and alien_4 classify as passed-tolerant
```

Two of the five tasks computed gold's numbers and scored zero for shaping them differently. Making
that visible is the whole point of carrying both columns; it is not a correction to the official
score, which stays 1/5.

### A void run reports no score at all

The official user simulator (`user_simulator/server.py`) calls its model with a hardcoded
`temperature=0`. **A model that rejects that value fails every call** — the simulator swallows the
exception, logs `LLM call failed`, and falls through to a canned non-answer, *I'm not sure I
understand your question.* The run still finishes, and finishes clean: error-free result rows, a
valid-looking protocol trace, budgets spent. It also scores near zero, because the benchmark
deliberately deletes one required knowledge entry per task and asking the user is the only way to
recover it, so the agent is answering every question with a hole in it.

A broken simulator is therefore indistinguishable from a weak agent unless something looks — so the
report looks, every time, at the LLM failures in `logs/user-simulator.log` and at the canned answers
among the run's asks:

| Verdict | When | Effect |
| --- | --- | --- |
| `healthy` | no LLM call failure, no canned answer | scores reported |
| `degraded` | some answers canned | scores reported, and the page says so |
| `void` | any LLM call failure, or every ask canned | **every score withheld** |

In a void run's `report.json`, `strict` and `tolerant` are both `null` and `withheld` carries the
reason in the run's own counts; the page renders every per-task reward as *withheld* too, since a
run whose simulator was not answering produces per-task rewards no more trustworthy than their
average. Everything that is not a score is still reported: dialogue, budget, tool calls, defects,
provenance. An agent turn the simulator never replied to is kept out of the canned ratio and named
as a defect instead, so one unanswered turn cannot carry an otherwise all-canned run from `void` up
to `degraded` and publish the scores the rule exists to withhold.

### The difficulty breakdown

`difficulty_tier` carries **two vocabularies** in the pinned dataset — `Simple`/`Moderate`/
`Challenging` on 270 of the 300 rows, `Easy`/`Medium`/`Hard` on the other 30 — and the breakdown
**does not merge them**. It groups by the dataset's own label and names the vocabularies a run
touched; mapping one vocabulary onto the other is an assumption this report has no authority to
make. `alien_1` through `alien_5` all sit in the first one (`Simple`, `Moderate`).

## Mandatory official differential

Before accepting any measurement, replay the pinned official callbacks and tools against this
adapter. The package test skips it only when `BIRD_INTERACT_CHECKOUT` is absent; when the variable
is set, a wrong HEAD, missing source, import problem, or mismatch is a hard failure:

```bash
BIRD_INTERACT_CHECKOUT="$PWD/eval/bird-interact/data/cache/BIRD-Interact" \
  node --import tsx --test eval/bird-interact/tests/official-differential.test.ts
```

## Local verification

```bash
just lint-bird-eval
just test-bird-eval
just build-bird-eval
BIRD_INTERACT_CHECKOUT="$PWD/eval/bird-interact/data/cache/BIRD-Interact" just test-bird-eval
```
