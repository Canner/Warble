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
| `psql`, `createdb`, `dropdb` on `PATH` | the official DB environment shells out to them, and the autopsy replays through your `psql` |
| Model credentials | secrets, never stored in the repository |
| A gated GT JSONL from BIRD | gated benchmark material |

No minimum `psql` version: the autopsy sends one command per `-c`, so it reads the same rows on a
client older than 15 as on a newer one. That matters because `-c` prints only the *last* command's
result before 15, and a whole wrapped statement passed as one `-c` therefore returns nothing at all
on, say, Ubuntu 22.04's stock `psql` 14 — which compares equal to the gold's nothing and reads as a
pass on every task.

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
--database <name>              BIRD-Interact database to prepare (default: alien)
--gt <file>                    gated GT to import once; omit it on later runs
--official-checkout <dir>      seed an existing pinned checkout instead of cloning
--public-data <file>           copy an existing pinned bird_interact_data.jsonl
--postgres-container <name>    default warble_bird_interact_postgresql
--postgres-port <port>         default 55432, used only when creating the default container
--wren-bin <path>              default wren
```

Preparation is transactional. It validates the GT, imports and verifies both pinned sources, merges
only the official GT fields into all 300 rows, selects exactly `<database>_1` through
`<database>_5`, starts or verifies the labeled PostgreSQL container, introspects the database,
generates a physical-identity Wren MDL, links the official ADK at Warble's public cache, dry-plans
the staged project through Wren, and only then promotes `data/runtime`. **Any earlier failure leaves
an existing `data/runtime` byte-for-byte intact.**

Each of the five rows is re-checked against the database it names and the `Query` category rather
than trusted from its ID: BIRD-Interact numbers a database's Management tasks `<database>_M_1`, and
a database whose first five numbered tasks are not all Query is refused rather than promoted.

### One prepared database at a time

`data/runtime` holds exactly one database, and the smoke reads which one out of the manifest — so
`--database` is a preparation flag and never a smoke flag, for the same reason the container and
port are not smoke flags. Re-running preparation with a different `--database` replaces the runtime
tree; the run directory is named for the database (`data/runs/<database>-5`), so runs of different
databases never overwrite each other, and each run keeps its own copy of the manifest it was
measured against. Preflight refuses to start when the promoted runtime names a different database
than the run directory it is about to write into.

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

There is deliberately **no** database, container or port flag here: all three come from the
verified `data/runtime/manifest.json`, so the smoke can never silently diverge from preparation.

Before any service starts, the launcher re-verifies the manifest, the five-row smoke file, the
identity MDL, the private GT, the official checkout, the ADK public-data symlink, free ports, and a
Wren dry-plan — and recomputes the complete public snapshot **offline**, requiring its manifest
SHA-256 to equal the recorded one. Metadata changed after preparation fails here, not mid-run.

The official oracle gates the model run: five error-free rows for exactly the prepared database's
`_1` through `_5`, both phases passing. A failing oracle stops the workflow and the system agent is
never started.

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

The `alien` names above are the default database's. Preparing with `--database polar` promotes
`runtime/smoke-polar-5.jsonl` and `runtime/identity-projects/polar/target/mdl.json` in its place,
and its runs land in `data/runs/polar-5/`.

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

A rerun starts in an empty directory. Before it writes anything, a non-empty `data/runs/alien-5` is
moved aside to `data/runs/alien-5.<the time it was last written>`, and the new path is printed as it
happens. Nothing is deleted, and nothing is ever moved onto an existing archive. The run directory
has to keep its name — the report and autopsy recipes address a run by directory name — so the
alternative to moving it is a rerun that inherits the previous run's files: a stale `tolerant.json`
scores the new submissions under the same task ids, and `--oracle-only` reports traces belonging to a
run that no longer exists. Nothing inside a run directory is ever an input to a later run, in any
mode; everything a run genuinely reuses (the pinned checkout, the virtualenv, `data/runtime/`, the
container) lives outside it. An archive is itself a valid run directory, so the displaced run stays
readable by `just report-bird-eval alien-5.<timestamp>`.

### Cleanup

The smoke stops only the child process groups it started. The Warble-owned PostgreSQL container is
deliberately left running for reuse. Stop it yourself when you are done — this is a stop, not a
delete, so the prepared database survives:

```bash
docker stop warble_bird_interact_postgresql
```

Archived runs accumulate: every rerun leaves one more `data/runs/alien-5.<timestamp>` behind, and
nothing removes them for you. They are yours to delete once you have read what you needed from them.

## Reading a finished run

A finished run is a directory of raw record. Two commands turn it into something a person can read,
and they are deliberately separate: one never leaves the disk, the other needs the database.

```bash
just autopsy-bird-eval alien-5   # needs PostgreSQL; writes tolerant.json if it measured a task
just report-bird-eval alien-5    # offline; fills its tolerant column from that file
```

Run them in that order — the report reads what the autopsy wrote — and name runs positionally, by
their directory name under `data/runs/`.

### Three refusals

Both commands would rather write nothing than write something a reader would quote. All three checks
below run before any run is read and before any statement is replayed, so a refusal costs nothing
and arrives before the work.

**The run must match the tree that is on disk now.** Both commands take a run's provenance from its
own `data/runs/<run>/manifest.json` and then read gold SQL, ambiguity snippets and difficulty labels
— and, for the autopsy, the container, host port and template database — out of the *current*
`data/runtime/`. Those two stop being the same measurement the moment preparation is re-run for a
different subset: the report would print this run's commits over gold the run never faced, and the
autopsy would replay another tree's gold against another tree's database and write the verdicts into
this run's directory, where the report reads them beside this run's manifest and presents the pair
as one run. So the two manifests are compared on **dataset identity and database identity** — the
official and public-snapshot commits and the snapshot's `manifestSha256`, `groundTruth.sha256`, the
merged dataset and the promoted smoke subset by file name and hash, `outputs.mdl.sha256`,
`database.name`, `database.template`, `database.container`, `database.hostPort`,
`database.imageId`, and `taskIds`. Any difference names the field and both values, and stops.
`createdAt` is deliberately not compared, because re-preparing byte-identical inputs moves the
clock and nothing else; nor are `version`, the mutable `:latest` in `database.imageReference`
(`imageId` is the content-addressed identity, and it *is* compared), `database.repoDigests`, the two
`repository` fields, or `wren.version`. A missing or unparseable `data/runtime/manifest.json` is the
same refusal rather than a lesser one: with nothing to compare against, the dataset about to be read
cannot be shown to be the one the run faced.

**A `tolerant.json` that exists must say something.** The report refuses a malformed one — not JSON,
not a JSON object, or holding any value that is not a boolean — and refuses an empty `{}` just as
loudly, naming the file either way. Neither is a degrade, because every alternative invents a score.
Filtering the bad entries out renders a confident `tolerant 0/N` describing nothing. Falling back to
*not computed* quietly downgrades a **broken** autopsy to one that never ran. And scoring an empty
map is the worst of the three: a strict pass counts as a tolerant pass, so an empty verdict map
renders a tolerant column **byte-identical to strict**, and a reader sees "tolerant found nothing
extra" where the truth is "nothing was measured". The autopsy holds the other end of this — it no
longer writes a file it has no verdicts for — so the only empty ones left are what older builds
already wrote.

**A gold-bearing artifact may only be written where Git ignores it.** `report.json`, `report.html`
and `autopsy.html` all embed the benchmark's own `sol_sql`, and both pages now say so in a notice
under the title — one wording, pinned in the IR and carried verbatim by `report.json`, because a
self-contained page is exactly the kind of file someone forwards without opening a task block first
and the constraint has to travel on the artifact rather than in a README its recipient never sees.
`--out` and `--json` are therefore a gated-material question and not a convenience: a path that
resolves outside this package's `data/` tree is refused, not written. Containment is checked on the
resolved **real** path and by path segment, so `..` traversal, a symlink pointing out of the tree,
and a sibling whose name merely starts with the same letters (`data-public/`) are all outside it.
The recipes make the risk concrete — they `cd eval/bird-interact` first, so a bare
`--out report.html` used to land gold SQL in a tracked directory, one `git add -A` from being
committed.

### `just report-bird-eval <run> [<run> ...]`

```text
--out <file>                   one HTML file covering every named run
                               (default: data/runs/<run>/report.html, one per run)
--json <file>                  one JSON file: a single report, or an array of them
                               (default: data/runs/<run>/report.json, one per run)
```

**Offline.** It re-executes nothing, contacts no service, and recomputes no score from the database:
everything on the page comes from what the run already recorded — `a-interact.json`, the run's own
`manifest.json`, each `traces/<task>/trace.json` and `metadata.json`, `python-environment.json`,
`logs/user-simulator.log`, `user-simulator.json` — plus the prepared dataset under `data/runtime/`,
whose `manifest.json` the run is checked against first. It never reads `data/private/.env`, so the
file holding your key is not on its path at all. Naming several runs together with `--out` renders
them as a single comparison page; every run also gets a one-line summary on stderr.

The simulator's model is read from the run's own `user-simulator.json`, which the smoke writes when
it starts one. A run made before that record existed reports the model as **unrecorded** rather than
guessing from the current `.env` — a guess dressed as provenance is worse than a stated gap, since
editing `.env` between the run and the report would otherwise rewrite what the run is said to have
used.

The report cross-checks the official row against Warble's own trace in both directions — identity,
reward, both phase outcomes, a trace with no official row, a manifest task with no official row —
and names each disagreement as a **defect** instead of reconciling it. Two files disagreeing means
one of them is wrong about what ran, and the reader has to know which numbers are in question.

**Gold is shown as the benchmark wrote it.** Each task's phase-1 `sol_sql` — and phase 2's own
`follow_up.sol_sql`, under its own heading, because phase 2 answers a different question — is
rendered beside that task's submissions: the failure class says which *kind* of miss it was, and
only gold beside the submission shows what the miss actually is. A statement that already carries
line breaks is printed **untouched**. The benchmark's authors laid gold out themselves, at a median
of 30 lines, and this package has no better information than they did; re-indenting it by
parenthesis depth split `WITHIN GROUP (ORDER BY …)` and `FILTER (WHERE …)` at their inner keyword
and altered 298 of the dataset's 300 gold statements. Only Wren's plan is reformatted, and only
because it arrives as one flat line — 778 characters in this run's shortest case — and even there
the formatter changes whitespace *between* tokens and nothing else, rebuilding the statement from
its own lexer first and handing back anything that does not reconstruct byte-for-byte. What the
agent itself wrote is never reformatted at all.

### Why each task landed where it did

Every scored task carries a **failure class**. The reward says a task failed; it does not say
whether the agent misread the question or merely wrote the query badly, and those two have opposite
fixes — ask better versus generate better. The classes are decided strongest evidence first:

| Class | What it says |
| --- | --- |
| `passed` | the official scorer passed it |
| `passed-tolerant` | right numbers, wrong shape — the replay passed where strict did not |
| `no-record` | Warble kept no trace of this task, so what it submitted is unknown |
| `no-sql` | nothing was submitted — infrastructure, not the agent |
| `exec-error` | the submitted SQL did not run |
| `intent-miss` | answered a different question: a critical ambiguity resolved wrongly, or a required knowledge entry never opened |
| `intent-ok` | understood the question; the divergence is downstream of understanding |
| `intent-ungraded` | no critical ambiguity in the record could be graded either way, so no claim is made |

Two of those exist to stop the report claiming more than it knows. **`no-record`** is kept apart
from `no-sql` because "submitted" is read *off* Warble's trace: with no trace at all, a class
asserting that nothing was submitted would be derived from the absence of the record of
submissions. **`intent-ungraded`** guards the other end. `intent-ok` is the strongest thing this
report says in the agent's favour, so it requires evidence rather than the absence of contrary
evidence — a critical ambiguity that was actually graded and found present. It used to be the
unguarded fall-through, which published a task with no dataset row at all — nothing to grade,
nothing to miss — as *understood*, on an empty list. That case reads as `intent-ungraded` now.

The evidence is the dataset's own `user_query_ambiguity`: every planted ambiguity names the
`sql_snippet` a correct resolution must produce, and each snippet is graded against the agent's last
**phase-1** submission as `exact` (the fragment is there, modulo aliases, quoting, casts and
whitespace), `columns` (every column it references is there, written differently), `miss` (at least
one column it needs never appears), or **`inconclusive`**. That last grade exists because columns
are read from *qualified* references only — tokenising and subtracting a keyword list would need
that list to be complete or it reports `avg` and `case` as columns — and 395 of the 826
critical-ambiguity snippets in the merged dataset carry no `alias.Column` reference at all: whole
`CREATE FUNCTION` bodies, fragments like `COUNT(*) FILTER (WHERE SNQI > 0)`. A snippet with no
qualified column that did not match literally evidences nothing about the agent, whatever the agent
wrote — grading it `miss` manufactured this report's strongest claim *against* the agent out of
nothing. Only `miss` counts against the agent, and only a critical one.

A record the writer cut short is the second reason for `inconclusive`. Every recorded string stops
at 2,000 characters, so a fragment missing from a long submission may simply sit past the cut, and
grading it `miss` would turn the recorder's own limit into an accusation. A submission that reaches
the cut therefore has all of its misses withdrawn; `exact` and `columns` still stand, because text
found inside a prefix is genuinely in the whole.

The other half of `intent-miss` — a required knowledge entry never opened — is narrower than it
looks, on purpose. An entry counts as never obtained only when the task's asks came back with
nothing usable at all: every answer canned or empty, or no ask attempted. `ask_user` is the only
route back to an entry the benchmark deleted, so a channel that returned nothing does evidence that
nothing came through it. Once any real answer arrives, though, *which* entry it carried is unknown —
this report reads no knowledge base, so it cannot match an answer to an id. It then publishes `null`
for both the recovered and the missed list, and the page prints **not determined**. `null` is not
`[]` here: an empty list says the report looked and found none, `null` says it could not look. The
report used to mark every withheld entry recovered on the first real answer to any question, so a
single reply about something else could clear a genuine miss.

### `just autopsy-bird-eval <run>`

```text
--out <file>                   where to write the page
                               (default: data/runs/<run>/autopsy.html)
```

Exactly one run: an autopsy replays SQL against one database, so a second positional is a usage
error rather than a silently ignored argument. It writes `data/runs/<run>/autopsy.html`, which
states per task the verdict, what is actually missing from the agent's result, and the ambiguous
question diffed against what the task actually meant — and `data/runs/<run>/tolerant.json`, the
phase-1 verdicts the report reads, whenever it measured at least one task.

The container, host port and template database all come from `data/runtime/manifest.json`; there is
deliberately no flag for them, so an autopsy cannot address a database preparation did not build.
**An unreachable database is a refusal, not a degraded report** — it probes first and stops, naming
the container and how to start it, rather than writing a page whose every verdict would be missing.
Within a reachable run, degradation is per task and never per section: a statement that will not
execute, or a comparison that hits its search ceiling, makes that one task read *could not measure*,
stays out of `tolerant.json` entirely, and is never recorded as a failing verdict.

**When every task reads *could not measure*, the page is written and the verdict file is not.** The
per-task reasons are the whole finding in a run like that, so `autopsy.html` is still worth having;
`tolerant.json` is not, because an empty verdict map is scored as a full tolerant column that
renders identical to strict from nothing measured. The command says so on stderr and exits non-zero,
and any `tolerant.json` already in the run directory is left untouched — this autopsy has nothing to
replace it with. "The autopsy measured nothing" is therefore no longer a state a file can be in.

A replay leaves nothing behind, and three separate layers say so rather than one. The **privilege**
is the guarantee: preparation provisions a `warble_autopsy_readonly` role holding `pg_read_all_data`
and nothing else, and the replay connects as that role instead of as the image's superuser. A
superuser's read-only-ness is only ever a *setting* — `default_transaction_read_only` is `USERSET`,
so a replayed statement can turn it off for itself — whereas a role that lacks the privilege cannot
grant itself one. The **setting** and the `BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;` wrapper
stay on top of it, catching accidents first and with a clearer message. The **category skip** is the
third: `Management` submissions are mutations by definition and are never replayed at all.

You can see the layering in the error text: an ordinary mutation is refused by the wrapper (*cannot
execute … in a read-only transaction*), while a payload that strips the setting reaches the
privilege and is refused there (*permission denied*).

A runtime prepared before the role existed has no role to connect as. The autopsy asks the cluster
rather than trusting the manifest, replays as the superuser when the role is absent, and says so —
on stderr and in a box above the first verdict — naming `just prepare-bird-eval` as the fix. It
never claims the guarantee it is not enforcing.

That read-only constraint is why some tasks never reach the database at all. A task is listed
*not attempted*, with its reason, when its `instance_id` matches no dataset row — there is no gold
to replay — or when its gold needs `preprocess_sql`, mutating setup a read-only replay cannot
reproduce and without which gold would compute a different answer. A `Management` task does reach
the replay loop and reads *could not measure* there, with its own reason stated: a management
submission is a mutation and cannot be a read-only CTE. The fixed `alien_1` through `alien_5` set is
all `Query` and every task has a dataset row, so none of the three applies to it.

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
column sums the official per-task reward. **The tolerant column counts tasks** — one per pass,
because a replay yields a *verdict* per task and there is nothing to sum. It carries no
reward-named field at all: its type holds counts and the share of tasks those counts are, and no
`totalReward` or `averageReward` to print. That is the fix, and it is a type rather than a
renderer's discretion, because the row that used to sit one line under strict's genuine reward
average was labelled "Average reward (tolerant)" and carried the pass **rate** — `0.60` under
`0.20`, read by anyone as one quantity tripling. Read them side by side.

The tolerant column exists only when `tolerant.json` does, and absent is the only one of that file's
states that is not an error:

| `tolerant.json` | What the report does |
| --- | --- |
| absent | the tolerant column reads **not computed — run `just autopsy-bird-eval`** |
| present and valid | the column is scored from its verdicts |
| present but empty `{}` | the report **refuses** and names the file |
| present but malformed | the report **refuses** and names the file |

Both refusals are hard for the reason given under [Three refusals](#three-refusals): every
alternative invents a score, and an empty map invents the most convincing one.

The recorded `alien-5` run is the worked example (`data/runs/alien-5/report.json`):

```text
strict     average reward 0.20    phase 1 passed 1/5 (20%)
tolerant   tasks passed phase 1   3/5 (60%)   — a count of tasks, not a reward
defects    none                   alien_1 and alien_4 classify as passed-tolerant
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

The report matches both of those strings exactly, so both are pinned against
`user_simulator/server.py` in the pinned checkout: an upstream that rewords either one fails
`just test-bird-eval` instead of quietly disarming the gate that reads them.

A broken simulator is therefore indistinguishable from a weak agent unless something looks — so the
report looks, every time, at the LLM failures in `logs/user-simulator.log` and at what came back
from the run's asks. The denominator is asks **attempted**, never asks answered: a charged
`ask_user` that errored leaves the call in the trajectory and no dialogue turn at all, and grading
on answers alone once graded a run whose every ask errored as `healthy` — it had answered all zero
of the asks it appeared to receive.

A refusal, though, is not an attempt. An `ask_user` the budget refused is written to the trajectory
the way the official run writes it — the tool's full price beside a budget that did not move — but
nothing was charged and the simulator was never called. Counting it would let a run that simply ran
out of coins look like a run whose simulator went silent, which is a withheld score for the wrong
reason. So the counts read only entries whose budget actually moved, and the page labels that column
**Tool calls (charged)** to say so.

| Verdict | When | Effect |
| --- | --- | --- |
| `healthy` | every attempted ask came back with a real answer, including a run that never asked | scores reported |
| `degraded` | some attempts came back canned, or came back with nothing | scores reported, and the page says so |
| `void` | any LLM call failure, or a run that asked at least once and got no real answer at all | **every score withheld** |

In a void run's `report.json`, `strict` and `tolerant` are both `null` and `withheld` carries the
reason in the run's own counts. **Withholding is total**: the rule is that nothing a score could be
recovered from gets published, and that reaches well past the two headline numbers. Every per-task
`reward`, `phase1Passed`, `phase2Passed` and `tolerantPassed` is `null`, so is every per-task
`failureClass`, each difficulty and high-level breakdown row keeps its task census while its
`averageReward` and `phase1Count` go `null`, and inside every submission both `result` and `phase`
go `null` too. Anything less is not withholding — it hands the suppressed score straight back to
whatever reads `report.json`, which is the CI-gate consumer this IR exists for.

Each of those was a real escape rather than a hypothetical one, and each was found later than the
one before it. The failure class came first: the recorded void run's page masked its reward cells
while printing `intent-miss` beside them five times, so one page said no score from this run means
anything *and* pinned the failure on the agent five times over. The submission's `result` was the
last and the widest — it is the scorer's own sentence, and that same run published sixteen of them,
every one reading *SQL failed Phase 1.* Counting them reconstructs 0 of 5 tasks passing phase 1,
which is precisely the figure withheld everywhere else on the page; on a task that had passed, the
same field would have carried the literal `Reward: 0.7`. `phase` went with it though nobody had
reported it, because a submission labelled *phase 2* says the scorer accepted the phase-1 attempt
before it — a verdict wearing a number.

**What stays visible is what the agent did.** Every submission keeps its attempt number, the SQL the
agent wrote, the SQL Wren planned, its cost and the budget either side; the run keeps its tool
calls, its asks and their answers, the knowledge record, the ambiguity grades, the budget totals and
the provenance. Those are facts about the agent's behaviour, and they stay true when the reward does
not. Only the scorer's verdict is withheld.

**Defects are reworded, never masked.** A defect states something about the *record* — the official
file and Warble's trace disagree — and not about the agent, so dropping it would delete the very
anomaly that justifies withholding the run, from the reader who most needs to see it. All of them
survive; only the three templates that quote a verdict lose their values. The reward line reads
`official reward 0.7 but trace reward 0` on a reportable run and
`the official reward and the trace reward disagree; both values are withheld` on a withheld one, and
the two phase-verdict lines do the same. That is not a leak: knowing two records disagree about
phase 1 does not tell you which of them said it passed.

**The schema enforces the envelope, in both directions.** A report that withholds while publishing a
recoverable score does not validate, and neither does a reportable run that dropped a per-task
reward, phase verdict, failure class or submission `result` — so `null` in those fields cannot come
to mean anything but withheld. `phase` is the one deliberate exception to that reverse rule: a trace
that recorded no phase yields `null` on a perfectly reportable run, so only the forward direction is
enforceable for it. Masking cells in one renderer was never the guarantee the IR claimed to make.

A further refinement holds the defect lines to the same line, refusing any that states an outcome on
a withheld run. The check is `statesAnOutcome`, and the source is blunt about what it is worth: a
regular expression over free text is a blocklist, so it is a **tripwire and not a proof**, and it
exists only because `result` and `defects` are the two fields that are unavoidably prose — every
field that *can* be typed is typed and nulled instead. So if it fires on a new defect line,
**reword the defect** so it names the disagreement without either side of it, rather than loosening
the pattern. That wording is what a withheld report is supposed to say anyway.

An agent turn the simulator never replied to is kept out of the canned count and named as a defect
instead, and it still counts as an ask attempted — so one unanswered turn cannot carry an otherwise
all-canned run from `void` up to `degraded` and publish the scores the rule exists to withhold.

### The difficulty breakdown

`difficulty_tier` carries **two vocabularies** in the pinned dataset — `Simple`/`Moderate`/
`Challenging` on 270 of the 300 rows, `Easy`/`Medium`/`Hard` on the other 30 — and the breakdown
**does not merge them**. It groups by the dataset's own label and names the vocabularies a run
touched; mapping one vocabulary onto the other is an assumption this report has no authority to
make. `alien_1` through `alien_5` all sit in the first one (`Simple`, `Moderate`). On a void run the
census of each row survives and its two score figures do not, for the reason above.

## Mandatory official differential

Before accepting any measurement, replay the pinned official callbacks and tools against this
adapter. **`just test-bird-eval` now runs it for you.** The recipe points `BIRD_INTERACT_CHECKOUT`
at `data/cache/BIRD-Interact` — the deterministic path preparation writes the pinned checkout to —
whenever that directory exists, so the differential this README calls mandatory actually runs
instead of skipping on every ordinary invocation. Setting the variable by hand is no longer part of
the workflow; an explicit one from the environment still wins, for pointing the suite at a checkout
somewhere else. A tree that has never run preparation has no checkout, and the two tests pinned to
it — this differential and the pin of the official user-simulator model — skip cleanly rather than
fail. Wherever the variable is set, a wrong HEAD, missing source, import problem, or mismatch is a
hard failure.

To run the differential on its own:

```bash
BIRD_INTERACT_CHECKOUT="$PWD/eval/bird-interact/data/cache/BIRD-Interact" \
  node --import tsx --test eval/bird-interact/tests/official-differential.test.ts
```

## Local verification

```bash
just lint-bird-eval
just test-bird-eval
just build-bird-eval
```
