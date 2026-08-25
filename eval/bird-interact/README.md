# BIRD-Interact a-interact eval for Warble + Wren

This package replaces only the official BIRD system-agent service on port 6000. The pinned official
orchestrator, user simulator (6001), DB environment/scorer (6002), PostgreSQL data, and ground truth
remain authoritative. Warble supplies the agent/session/tool loop; Wren plans query-like SQL before
the official DB service executes or scores it.

The implementation follows the official `a-interact` action space: nine charged tools, one budget
ledger across phase 1 and phase 2, authoritative `/submit` outcomes, and the official free terminal
submit when the budget is exhausted. Management SQL bypasses Wren planning and reaches the official
submission service unchanged.

Everything the run needs is prepared into this package's ignored `data/` tree.
**No runtime command reads an external project**, its virtualenv, its `.env`, or a Wren project provisioned
outside Warble; the gated ground-truth file may be *imported* from anywhere once, and is copied —
never linked.

## What is measured

This is the full a-interact protocol only when the run includes both Query and Management tasks,
official user simulation, official DB isolation/scoring, and the complete Lite task set.

The shipped smoke deliberately runs exactly three fixed Query tasks — `alien_1`, `alien_2`, and
`alien_3`. **That is a Query subset, not a full BIRD-Interact score**, and it must never be compared
with the official leaderboard. Results from WrenAI's legacy local harness use different
action/context/scoring boundaries and must not be compared with either.

Live model/BIRD commands below are opt-in integration tests. They need model credentials, the gated
GT file, and Docker. Unit, HTTP, profile, and differential-oracle tests do not call a model.

## Prerequisites

| Requirement | Why it stays external |
| --- | --- |
| Docker | runs the official `shawnxxh/bird-interact-postgresql` image |
| Python >= 3.10 and < 3.13 | the official ADK's supported interpreter range |
| `psql`, `createdb`, `dropdb` on `PATH` | the official DB environment shells out to them |
| Model credentials | secrets, never stored in the repository |
| A gated GT JSONL from BIRD | gated benchmark material |

### The gated ground truth

`bird_interact_gt_kg_testcases_1008.jsonl` holds `sol_sql`, `external_knowledge`, and `test_cases`.
The public Hugging Face dataset omits them.
Obtain the file **only through the official BIRD gated process** — this README deliberately
publishes no download URL for it. Preparation reads it through
`--gt`, validates all 300 rows, and copies it to `data/private/` with mode `0600`. Later runs omit
`--gt`; preparation revalidates the private copy every time.

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
only the official GT fields into all 300 rows, selects exactly `alien_1`, `alien_2`, `alien_3`,
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

Before any service starts, the launcher re-verifies the manifest, the three-row smoke file, the
identity MDL, the private GT, the official checkout, the ADK public-data symlink, free ports, and a
Wren dry-plan — and recomputes the complete public snapshot **offline**, requiring its manifest
SHA-256 to equal the recorded one. Metadata changed after preparation fails here, not mid-run.

The official oracle gates the model run: three error-free rows for exactly `alien_1`, `alien_2`, and
`alien_3`, both phases passing. A failing oracle stops the workflow and the system agent is never
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
# USER_SIM_MODEL=proxy/whatever
# LITELLM_BASE_URL=http://127.0.0.1:4000
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
data/runs/alien-3/python-environment.json   # versions, requirements SHA-256, freeze SHA-256
data/runs/alien-3/python-freeze.txt         # pip freeze --all
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
  runtime/smoke-alien-3.jsonl                        # exactly alien_1, alien_2, alien_3
  runtime/identity-projects/alien/target/mdl.json
  runtime/manifest.json                              # revisions, hashes, image ID, port, version
  runs/alien-3/
```

Only `data/.gitignore` and `data/README.md` are tracked. Results and provenance land here:

```text
data/runs/alien-3/oracle.json
data/runs/alien-3/a-interact.json
data/runs/alien-3/manifest.json                      # copy of the runtime manifest used
data/runs/alien-3/logs/                              # one log per child process
data/runs/alien-3/traces/<task-id>/agent-events.jsonl
data/runs/alien-3/traces/<task-id>/trace.json
data/runs/alien-3/traces/<task-id>/metadata.json
```

A successful a-interact run requires three error-free result rows and one trace directory per task.
A zero reward is an acceptable smoke outcome; a missing or errored row is not.

### Cleanup

The smoke stops only the child process groups it started. The Warble-owned PostgreSQL container is
deliberately left running for reuse. Stop it yourself when you are done — this is a stop, not a
delete, so the prepared database survives:

```bash
docker stop warble_bird_interact_postgresql
```

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

## Reproducibility record

Keep these together with every reported result:

```bash
git -C "$PWD" rev-parse HEAD
cat eval/bird-interact/data/runs/alien-3/manifest.json
cat eval/bird-interact/data/runs/alien-3/python-environment.json
shasum -a 256 eval/bird-interact/data/runs/alien-3/python-freeze.txt
shasum -a 256 eval/bird-interact/data/runs/alien-3/agent-ir.json
```

The runtime manifest already records the official and Hugging Face revisions, the complete public
snapshot's file count and manifest SHA-256, the GT and output hashes, the container name/port, the
image reference plus its actual ID and repository digests, the Wren version, and the fixed task IDs.
Per-task metadata records the model, service URLs, Warble Agent SDK version, IR hash/version,
resolved Wren project, MDL hash, and run timestamps. Record the user-simulator model and prompt
version alongside them.

Known live-only boundary: service-free tests do not prove model quality, provider availability, the
gated GT, database image health, or Wren planning against real data. The
prepare → oracle → differential → a-interact order above is the acceptance gate for a reportable
measurement, and its three-task result is always labeled a Query subset.
