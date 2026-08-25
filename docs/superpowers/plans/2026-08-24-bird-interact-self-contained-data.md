# BIRD-Interact Self-Contained Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Warble's BIRD-Interact adapter independently prepare the pinned official Lite data, privately import GT, generate a physical-identity Wren project, and run the fixed `alien_1..3` official oracle and a-interact smoke without reading an external project at runtime.

**Architecture:** Two Warble-owned CLIs share pure dataset/source/MDL modules. `warble-bird-prepare` imports all external inputs into the ignored `eval/bird-interact/data` tree, starts or verifies a Warble-labeled official PostgreSQL container, validates and stages every output, then promotes one runtime directory only after the public-data link and Wren dry-plan succeed. `warble-bird-smoke` creates a Python environment from the pinned official checkout, starts only its own three HTTP child processes, requires the official oracle to pass, and then invokes the pinned official a-interact runner. Public metadata, gated GT, credentials, generated MDL, logs, and results remain gitignored.

**Tech Stack:** TypeScript/Node 20 (`node:test`, Zod, `dotenv`, `execFile`/`spawn`), pinned BIRD-Interact Python ADK, Docker/PostgreSQL, Wren CLI, Just, Rust/Warble CLI.

---

## Execution constraints

- The source design is [the approved design](../specs/2026-08-24-bird-interact-self-contained-data-design.md). Do not broaden v1 beyond the three Query tasks `alien_1`, `alien_2`, and `alien_3`.
- `--gt`, `--official-checkout`, and `--public-data` are import sources. After preparation, oracle and model commands may read only Warble's `eval/bird-interact/data` tree and normal tool installations; they must not retain a symlink to a path outside this repository.
- The default database container is `warble_bird_interact_postgresql`, labeled `ai.getwren.warble.eval=bird-interact`, using the official image on host port `55432`. Never stop, remove, or reconfigure an unrelated existing container.
- Run external commands with `execFile`/`spawn` argument arrays and bounded timeouts. Do not construct shell command strings from paths, IDs, SQL, container names, or environment values.
- Never print GT rows or credential values. Pass model credentials only to the system agent and user simulator. The DB environment gets an allowlisted environment with PostgreSQL/service variables and no model-provider variables.
- Set `PYTHON_DOTENV_DISABLED=1` on every official Python process and verify the installed
  `python-dotenv` honors it. Reject an `.env` inside the official checkout; never let official code
  discover credentials from its cwd or an ancestor directory.
- Build runtime files in a sibling staging directory. A validation, download, Docker, schema, or dry-plan failure must leave an existing `data/runtime` unchanged.

### Task 1: Establish the private data boundary

**Files:**

- Create: `eval/bird-interact/data/.gitignore`
- Create: `eval/bird-interact/data/README.md`
- Create: `eval/bird-interact/tests/data-boundary.test.ts`

- [ ] **Step 1: Write the failing ignore-boundary test**

Add `tests/data-boundary.test.ts`. Resolve the Warble repository root from `import.meta.url`, invoke Git with `execFile`, and assert:

```ts
const privateGt = "eval/bird-interact/data/private/bird_interact_gt_kg_testcases_1008.jsonl";
assert.equal((await git(["check-ignore", "--no-index", "--quiet", privateGt])).code, 0);
assert.equal((await git(["check-ignore", "--no-index", "--quiet", "eval/bird-interact/data/README.md"])).code, 1);
```

Also assert that the tracked README states that `private/`, `cache/`, `runtime/`, and `runs/` are local-only and that GT must come through BIRD's official gated process.

- [ ] **Step 2: Run the test and confirm the boundary is absent**

Run: `cd eval/bird-interact && node --import tsx --test tests/data-boundary.test.ts`

Expected: FAIL because `data/.gitignore` and `data/README.md` do not exist.

- [ ] **Step 3: Add the minimal tracked data shell**

Use this allowlist-style `data/.gitignore`:

```gitignore
*
!.gitignore
!README.md
```

Document the exact local tree, mode-0600 GT copy, optional `private/.env`, immutable public tree and
resolve URLs, official and HF pins, hashes, required per-database metadata, and the rule that nothing
below this directory is a score source unless the preparation manifest validates it.

- [ ] **Step 4: Re-run the boundary test**

Run: `cd eval/bird-interact && node --import tsx --test tests/data-boundary.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the boundary**

```bash
git add eval/bird-interact/data/.gitignore \
  eval/bird-interact/data/README.md \
  eval/bird-interact/tests/data-boundary.test.ts
git commit -m "test(eval): protect local BIRD data"
```

### Task 2: Validate and merge official public data with gated GT

**Files:**

- Create: `eval/bird-interact/src/eval-data.ts`
- Create: `eval/bird-interact/tests/eval-data.test.ts`

- [ ] **Step 1: Add focused failing dataset tests**

Build synthetic 300-row public and GT arrays, including one follow-up with string `sol_sql` and one with list `sol_sql`. Test these exported operations:

```ts
parsePublicJsonl(text): PublicTask[]
parseGroundTruthJsonl(text): GroundTruthTask[]
mergePublicWithGroundTruth(publicRows, gtRows): CombinedTask[]
selectAlienSmoke(combinedRows): CombinedTask[]
serializeJsonl(rows): string
sha256(contents): string
```

Cover all of the following:

- exactly 300 unique, identical IDs are required on both sides;
- malformed JSON reports the 1-based line number but not the row contents;
- required public and GT/follow-up fields use the strict shapes in the design;
- schema parsing preserves `query`, `user_query_ambiguity`, `knowledge_ambiguity`, and a synthetic
  unknown sentinel at both the row and follow-up levels;
- the merge overwrites only the official GT fields (`sol_sql`, `external_knowledge`, `test_cases`, and their follow-up equivalents);
- inputs are not mutated and their serialized bytes do not change;
- selection returns exactly `alien_1`, `alien_2`, `alien_3` in that order and rejects missing, duplicate, non-`alien`, or non-`Query` rows.

- [ ] **Step 2: Run the focused tests and see the missing-module failure**

Run: `cd eval/bird-interact && node --import tsx --test tests/eval-data.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/eval-data.ts`.

- [ ] **Step 3: Implement strict schemas and deterministic merge**

Use Zod `.passthrough()` semantics for public, GT, combined, and nested follow-up objects so strict
required-field validation never strips official or forward-compatible metadata. Use explicit set
comparisons. Do not use object spread for the whole GT row. Merge only the benchmark's authoritative fields:

```ts
const merged = {
  ...publicRow,
  sol_sql: gtRow.sol_sql,
  external_knowledge: gtRow.external_knowledge,
  test_cases: gtRow.test_cases,
  follow_up: {
    ...publicRow.follow_up,
    sol_sql: gtRow.follow_up.sol_sql,
    external_knowledge: gtRow.follow_up.external_knowledge,
    test_cases: gtRow.follow_up.test_cases,
  },
};
```

Revalidate all 300 combined rows. Serialize one compact JSON object per line with a final newline so output hashes are deterministic.

- [ ] **Step 4: Run focused and package tests**

Run:

```bash
cd eval/bird-interact
node --import tsx --test tests/eval-data.test.ts
npm run check-types
npm test
```

Expected: all PASS; existing official differential may skip only when `BIRD_INTERACT_CHECKOUT` is unset.

- [ ] **Step 5: Commit dataset preparation**

```bash
git add eval/bird-interact/src/eval-data.ts eval/bird-interact/tests/eval-data.test.ts
git commit -m "feat(eval): validate BIRD smoke data"
```

### Task 3: Acquire and verify pinned official sources

**Files:**

- Create: `eval/bird-interact/src/source-cache.ts`
- Create: `eval/bird-interact/tests/source-cache.test.ts`
- Create: `eval/bird-interact/public-snapshot.json`

- [ ] **Step 1: Add failing source-cache tests with local fixtures**

Define a dependency-injected `CommandRunner` and `Downloader`. Use temporary local Git repositories rather than the network. Test:

- normalized HTTPS/SSH origin comparison, exact detached HEAD, required files, no staged/tracked
  changes, and no unexpected untracked files, tested independently for an external seed and a
  reused Warble cache;
- source import produces a fresh Warble-local clone and never a symlink to the seed path;
- `.git/info/exclude` receives only the ADK `bird-interact-lite` symlink and `.venv/` entries;
- a seed with wrong origin, wrong HEAD, dirty tracked file, or missing ADK file fails before clone;
- a reused cache with any of those failures is rejected rather than silently repaired;
- an untracked `shared/_local_provider.py` or `.env` is rejected; only the workflow's explicitly
  ignored ADK `.venv/` and `bird-interact-lite` symlink are permitted in a reused cache;
- `__pycache__`, `.pyc`, and `.pyo` anywhere outside the allowed ADK `.venv` are rejected even when
  the official `.gitignore` would hide them;
- the downloader enumerates the pinned HF tree API with pagination, accepts only safe relative file
  paths, follows immutable resolve URLs, caps per-file/total bytes, and stages the complete snapshot;
- the snapshot requires schema, column-meaning, and KB files for every `selected_database` in the
  public 300 rows, not only the main JSONL;
- the main JSONL rejects a wrong fixed SHA before cache replacement; every downloaded file records
  its tree OID, byte size, and computed SHA-256;
- the tracked `public-snapshot.json` contains the exact 57-file path/type/OID/size set returned by the
  pinned commit; a fresh or reused tree listing must match it exactly;
- modifying, deleting, or adding any non-main metadata file causes reuse to fail, even if the ignored
  cache manifest was modified at the same time;
- reuse recomputes each local file's size, SHA-256, and Git blob OID against the tracked/API record;
  if a future pinned entry declares LFS metadata, use its LFS SHA-256 OID and size contract instead;
- a provided `--public-data` main JSONL is copied only after the same hash check and never linked;
  remaining metadata still comes from the pinned snapshot;
- a previously verified cache is idempotently reused.

The production constants are:

```ts
export const BIRD_REPOSITORY = "https://github.com/bird-bench/BIRD-Interact.git";
export const BIRD_COMMIT = "451fe2c3518ee1cf908d8139e2913483bd519381";
export const PUBLIC_COMMIT = "f7881a9c2b9630cc4fc13b0c39279740b0a2fd87";
export const PUBLIC_SHA256 = "d155fa0855bc1885f77df2fcc357d3056e10426cd6093c0042aa99d79067af08";
export const PUBLIC_TREE_URL = `https://huggingface.co/api/datasets/birdsql/bird-interact-lite/tree/${PUBLIC_COMMIT}?recursive=true&limit=1000`;
export const PUBLIC_RESOLVE_ROOT = `https://huggingface.co/datasets/birdsql/bird-interact-lite/resolve/${PUBLIC_COMMIT}`;
```

- [ ] **Step 2: Run the focused test and see it fail**

Run: `cd eval/bird-interact && node --import tsx --test tests/source-cache.test.ts`

Expected: FAIL because `source-cache.ts` is missing.

- [ ] **Step 3: Implement clone/import/download verification**

Before cloning an external seed, verify the seed's own normalized origin, exact HEAD, clean
tracked/staged/untracked state, and required-file allowlist:

```text
BIRD-Interact-ADK/requirements.txt
BIRD-Interact-ADK/shared/config.py
BIRD-Interact-ADK/db_environment/server.py
BIRD-Interact-ADK/user_simulator/server.py
BIRD-Interact-ADK/orchestrator/runner.py
```

Only then use `git clone --no-hardlinks <seed> <temp>`, reset the new clone's `origin` to the official
URL, detach at the pinned commit, reverify, and atomically rename it into
`data/cache/BIRD-Interact`. For a network acquisition, clone the official URL into the same temporary
location. Never rewrite a seed's origin and never make the runtime depend on the external seed path.

Check the tracked `public-snapshot.json` into Git as the local trust root. It must contain the fixed
commit and exact sorted 57-file path/type/OID/size listing obtained from the pinned API; tests reject
duplicates and any mismatch with the expected 18 database metadata triplets.

Enumerate the pinned tree API on every acquisition or preparation reuse, follow pagination links only on the same Hugging Face origin, and
download all file entries through `PUBLIC_RESOLVE_ROOT`. Reject absolute paths, `..`, empty path
segments, symlink-like entries, duplicate paths, unexpected response sizes, and a snapshot missing
`<db>/<db>_schema.txt`, `<db>/<db>_column_meaning_base.json`, or `<db>/<db>_kb.jsonl` for any database
present in the 300 public rows. Use Node `fetch`, a 120-second per-request abort deadline, and
conservative per-file and total byte ceilings. Stage the complete snapshot and hash before rename.
Persist non-secret source metadata as
`data/cache/bird-interact-lite/_warble-source.json`:

```json
{
  "repository": "https://huggingface.co/datasets/birdsql/bird-interact-lite",
  "commit": "f7881a9c2b9630cc4fc13b0c39279740b0a2fd87",
  "mainSha256": "d155fa0855bc1885f77df2fcc357d3056e10426cd6093c0042aa99d79067af08",
  "files": [{ "type": "file", "path": "alien/alien_schema.txt", "oid": "...", "size": 13055, "sha256": "..." }]
}
```

On reuse, require the local content path set to equal the tracked/API 57-file set plus only
`_warble-source.json`, then recompute byte size, SHA-256, and standard Git blob
OID as `SHA1("blob " + size + NUL + bytes)`. Compare OID/size to both trust roots and SHA-256 to the
ignored source manifest. A changed ignored manifest cannot legitimize changed content because the
blob/LFS OID is independently pinned in Git. Download a complete sibling staging snapshot and rename
it only after every file passes; never repair individual files in place.

- [ ] **Step 4: Run focused, type, and package tests**

Run:

```bash
cd eval/bird-interact
node --import tsx --test tests/source-cache.test.ts
npm run check-types
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit source acquisition**

```bash
git add eval/bird-interact/src/source-cache.ts \
  eval/bird-interact/tests/source-cache.test.ts \
  eval/bird-interact/public-snapshot.json
git commit -m "feat(eval): pin official BIRD sources"
```

### Task 4: Generate a leak-free physical-identity Wren MDL

**Files:**

- Create: `eval/bird-interact/src/identity-mdl.ts`
- Create: `eval/bird-interact/tests/identity-mdl.test.ts`

- [ ] **Step 1: Add failing MDL tests from synthetic introspection**

Use shuffled table/column fixtures and assert stable table and ordinal-column ordering. The output is intentionally minimal:

```json
{
  "catalog": "wren",
  "schema": "public",
  "models": [{
    "name": "weather",
    "tableReference": { "schema": "public", "table": "weather" },
    "columns": [{ "name": "condition", "type": "VARCHAR" }]
  }],
  "relationships": [],
  "views": []
}
```

Assert the JSON contains no descriptions, samples, knowledge, SQL, test cases, GT, semantic aliases, or calculated fields. Cover the `alien` database types observed in the official image:

```text
character, character varying, text -> VARCHAR
smallint -> SMALLINT
integer -> INTEGER
numeric -> DECIMAL
double precision -> DOUBLE
date -> DATE
time without time zone -> TIME
timestamp with time zone -> TIMESTAMP
```

Unknown and array/user-defined types must fail with the table, column, and PostgreSQL type, without writing a file.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd eval/bird-interact && node --import tsx --test tests/identity-mdl.test.ts`

Expected: FAIL because `identity-mdl.ts` is missing.

- [ ] **Step 3: Implement introspection parsing and MDL generation**

Export a fixed SQL query over `information_schema.tables` and `information_schema.columns`. Production invokes it as an argument to:

```text
docker exec <container> psql -X -A -t -v ON_ERROR_STOP=1 -U root -d alien -c <sql>
```

Have PostgreSQL return one JSON value, validate it with Zod, and pass it into the pure builder. Use `ProcessWrenPlanner` for a representative quoted `SELECT * FROM <first physical table> LIMIT 1` dry-plan, so argument shape and timeout behavior remain identical to the live adapter.

- [ ] **Step 4: Run focused and package tests**

Run:

```bash
cd eval/bird-interact
node --import tsx --test tests/identity-mdl.test.ts
npm run check-types
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit the identity project builder**

```bash
git add eval/bird-interact/src/identity-mdl.ts eval/bird-interact/tests/identity-mdl.test.ts
git commit -m "feat(eval): build identity Wren MDL"
```

### Task 5: Implement the transactional preparation CLI

**Files:**

- Create: `eval/bird-interact/src/prepare-cli.ts`
- Create: `eval/bird-interact/tests/prepare-cli.test.ts`
- Modify: `eval/bird-interact/package.json`
- Modify: `eval/bird-interact/tsup.config.ts`
- Modify: `eval/bird-interact/package-lock.json`

- [ ] **Step 1: Add failing parser and orchestration tests**

Test the CLI contract exactly:

```text
--gt <file>
--official-checkout <directory>
--public-data <file>
--postgres-container <name>  # default warble_bird_interact_postgresql
--postgres-port <port>       # default 55432, used only when creating the default container
--wren-bin <path-or-name>    # default wren
```

The exported orchestration function accepts an injected data root for temporary tests, but this is
not a public CLI flag. With fake source, Docker, schema, and Wren dependencies, assert this ordering:

1. validate the source GT before copying it mode `0600`;
2. import/verify official and public sources into the data root;
3. verify public and GT ID sets, merge, and select the fixed smoke;
4. verify/start PostgreSQL and introspect `alien`;
5. stage combined JSONL, three-row JSONL, identity MDL, and manifest;
6. validate or create the official ADK public-data symlink to the Warble-local public cache;
7. dry-plan against the staged project;
8. atomically promote `runtime.next-*` to `runtime` as the final mutation.

Seed an existing `runtime/sentinel` and inject failures at merge, Docker, type mapping, symlink, and
dry-plan; every failure must preserve the old runtime byte-for-byte and remove staging. Assert the
manifest records revisions, hashes, image reference, actual image ID/repository digest, container
name/port, Wren version, task IDs, creation time, and
`publicSnapshot: { commit, fileCount: 57, manifestSha256 }` for the deterministic complete public
snapshot manifest, but never an input absolute path or credential.

- [ ] **Step 2: Run the CLI tests and see the missing implementation fail**

Run: `cd eval/bird-interact && node --import tsx --test tests/prepare-cli.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement safe container ownership and runtime promotion**

When the default container is absent, run the official image with:

```text
docker run -d
  --name warble_bird_interact_postgresql
  --label ai.getwren.warble.eval=bird-interact
  -e POSTGRES_USER=root
  -e POSTGRES_PASSWORD=123123
  -e TZ=Asia/Hong_Kong
  -p 55432:5432
  docker.io/shawnxxh/bird-interact-postgresql:latest
  -c max_connections=300
  -c shared_buffers=256MB
```

Poll `pg_isready` through `docker exec` with a bounded deadline. If a same-name container exists,
inspect its image, label, and `5432/tcp` mapping before starting/reusing it. Record the immutable
container image ID and repository digest from Docker. On later preparation, require them to match the
previous runtime manifest; do not treat the mutable `latest` tag as provenance. A mismatch is an
actionable error; never remove it. Permit an explicitly named custom existing official-image
container, but still verify its image and mapped port.

Before promotion, resolve both sides of the official ADK symlink and require the target to be the
Warble-local verified public cache. Reject any nonmatching file/directory/link. Promote runtime with
rename/restore semantics: move an old runtime to a same-parent backup, move the validated staging
directory into place, then remove the backup; on failure restore the backup. Do not use recursive
deletion on any path until path containment under the resolved data root is proven.

- [ ] **Step 4: Wire package binaries and build entries**

Add bins/scripts without changing the existing adapter entry:

```json
"bin": {
  "warble-bird-interact": "./dist/cli.js",
  "warble-bird-prepare": "./dist/prepare-cli.js",
  "warble-bird-smoke": "./dist/smoke-cli.js"
}
```

Add `src/prepare-cli.ts` now and reserve `src/smoke-cli.ts` in Task 6 before the final build. Update the lockfile only through `npm install --package-lock-only`/`npm install` as appropriate.

- [ ] **Step 5: Run the preparation suite**

Run:

```bash
cd eval/bird-interact
node --import tsx --test tests/prepare-cli.test.ts
npm run check-types
npm test
npm run build
node dist/prepare-cli.js --help
```

Expected: tests/build PASS; help exits zero without touching Docker or data.

- [ ] **Step 6: Commit the preparation CLI**

```bash
git add eval/bird-interact/src/prepare-cli.ts \
  eval/bird-interact/tests/prepare-cli.test.ts \
  eval/bird-interact/package.json \
  eval/bird-interact/package-lock.json \
  eval/bird-interact/tsup.config.ts
git commit -m "feat(eval): prepare self-contained BIRD runtime"
```

### Task 6: Implement oracle-gated three-task smoke orchestration

**Files:**

- Create: `eval/bird-interact/src/smoke-cli.ts`
- Create: `eval/bird-interact/tests/smoke-cli.test.ts`
- Modify: `eval/bird-interact/package.json`
- Modify: `eval/bird-interact/package-lock.json`
- Modify: `eval/bird-interact/tsup.config.ts`

- [ ] **Step 1: Install the dotenv parser and add failing smoke tests**

Run: `cd eval/bird-interact && npm install dotenv@^17`

Test this public CLI contract exactly:

```text
--oracle-only                 # run DB/user services and oracle; do not inspect/start port 6000
--wren-bin <path-or-name>     # default wren
--python-bin <path-or-name>   # default python3.11; require Python >=3.10,<3.13
--system-model <name>         # default claude-sonnet-4-5-20250929
--help
--version
```

The smoke command reads the container name and mapped PostgreSQL port from the verified preparation
manifest; there is no second container/port override that could silently diverge from preparation.
The exported launcher accepts an injected data root and process runner for tests, but neither is a
public CLI flag.

Test pure environment/process-plan helpers and a dependency-injected launcher:

- private `.env` is optional, parsed without shell evaluation, and explicit process environment wins;
- public, private, and nested metadata are never included in a log message or command error;
- provider-aware user-simulator auth accepts Anthropic/OpenAI/Google/LiteLLM/Ollama configurations and rejects missing required auth before spawning services;
- system-agent auth accepts a relevant environment token or a successful silent `claude auth status` probe;
- DB environment and both official runner invocations receive only `PATH`, locale/temp/home/no-proxy
  plus `PYTHONPATH`, `PYTHON_DOTENV_DISABLED=1`, `PG_*`, the three service ports, `PATIENCE`, and
  `DATASET`; they receive no key/token/model/base provider variable;
- user simulator and system agent receive the merged model environment;
- with a sentinel `.env` in an ancestor of a synthetic ADK plus a direct Python probe from a nested
  cwd, prove `PYTHON_DOTENV_DISABLED=1` prevents loading; an `.env` directly inside the real ADK is
  rejected before spawn;
- a synthetic official-module import runs with `PYTHONDONTWRITEBYTECODE=1`, creates no
  `__pycache__`, and a `prepare -> smoke-like import -> prepare` sequence still reuses the checkout;
- unsupported Python 3.9/3.13/3.14 fails before venv creation; 3.10/3.11/3.12 pass;
- an existing ADK venv must itself report Python 3.10-3.12 and the same major/minor as
  `--python-bin`; mismatch fails without deleting or recreating the venv;
- smoke recomputes the local public snapshot's exact path set, OID/size, and deterministic manifest
  SHA without network access; changed metadata after prepare fails before any service starts;
- occupied ports fail without killing their owners;
- health checks have deadlines and include the correct log path on failure;
- only registered child process groups receive `SIGTERM`, then `SIGKILL` after a deadline;
- oracle JSON with any error, wrong IDs/count, or a failed phase blocks system-agent startup;
- `--oracle-only` exits after a passing oracle without requiring model credentials or checking port
  6000;
- successful a-interact accepts zero reward but requires exactly three error-free result rows and three Warble trace directories.

Snapshot the complete process plan, including executable, argument array, cwd, environment key set,
log file, and output file for every child/run described in Step 3.

- [ ] **Step 2: Run the smoke tests and see them fail**

Run: `cd eval/bird-interact && node --import tsx --test tests/smoke-cli.test.ts`

Expected: FAIL because `smoke-cli.ts` is missing.

- [ ] **Step 3: Implement the owned-process launcher**

Use these fixed Warble-local paths:

```text
run root:       data/runs/alien-3
IR:             data/runs/alien-3/agent-ir.json
oracle result:  data/runs/alien-3/oracle.json
model result:   data/runs/alien-3/a-interact.json
logs:           data/runs/alien-3/logs/{db-environment,user-simulator,system-agent,oracle,a-interact}.log
traces:         data/runs/alien-3/traces/<task-id>/{agent-events.jsonl,trace.json,metadata.json}
manifest copy:  data/runs/alien-3/manifest.json
Python record:  data/runs/alien-3/python-environment.json
pip freeze:     data/runs/alien-3/python-freeze.txt
```

The launcher must:

1. verify `runtime/manifest.json`, the fixed smoke file, MDL, pinned official checkout, public symlink,
   Docker health, host PostgreSQL clients, Wren dry-plan, and ports. Offline-recompute the complete
   public snapshot from the tracked trust root/local bytes and require its manifest SHA-256 to equal
   the runtime manifest before any service starts;
2. reject an ADK-local `.env`; verify `--python-bin` reports Python >=3.10,<3.13; create
   `cache/BIRD-Interact/BIRD-Interact-ADK/.venv` if absent and install the pinned checkout's
   `requirements.txt`; otherwise prove `uvicorn`, `httpx`, `litellm`, `psycopg2`, and the official
   packages import. When the venv already exists, run its own interpreter to require Python
   3.10-3.12 and an exact major/minor match with `--python-bin`; on mismatch, fail with instructions
   to move/rebuild it and do not delete it. Do not describe the unbounded transitive requirements as
   dependency-pinned; record the requirements SHA-256, actual venv Python version,
   `pip freeze --all`, and its SHA-256 in the fixed Python provenance files;
3. compile `eval/bird-interact-agent` into the run directory and build the TypeScript adapter;
4. start official DB environment (6002) and user simulator (6001), with separate log files and bounded health checks;
5. invoke the official runner with `--mode oracle --data <Warble smoke> --concurrency 1`, then parse and require all three phases to pass;
6. for `--oracle-only`, save the manifest beside the result and clean up owned children;
7. otherwise start Warble's system agent on 6000 with the runtime identity-project root and explicit Wren binary;
8. invoke the official runner with `--mode a-interact --data <Warble smoke> --concurrency 1`;
9. validate result completeness, copy the manifest beside results, and clean up only owned children on success, failure, `SIGINT`, or `SIGTERM`.

Build the following exact process records with argument arrays, never shell strings (`<...>` are
resolved absolute paths/values):

```text
compile
  exe: cargo
  argv: [run,--locked,-p,warble-cli,--,compile,eval/bird-interact-agent,-o,<run>/agent-ir.json]
  cwd: <Warble root>
  env: non-model build allowlist

adapter build
  exe: npm
  argv: [run,build]
  cwd: <Warble root>/eval/bird-interact
  env: non-model build allowlist

DB environment
  exe: <ADK>/.venv/bin/python
  argv: [-m,uvicorn,db_environment.server:app,--host,127.0.0.1,--port,6002,--log-level,warning]
  cwd: <ADK>
  env: safe official env with PG_PORT from manifest and PYTHON_DOTENV_DISABLED=1
  log: <run>/logs/db-environment.log

user simulator
  exe: <ADK>/.venv/bin/python
  argv: [-m,uvicorn,user_simulator.server:app,--host,127.0.0.1,--port,6001,--log-level,warning]
  cwd: <ADK>
  env: safe official env plus allowlisted model variables; PYTHON_DOTENV_DISABLED=1
  log: <run>/logs/user-simulator.log

oracle
  exe: <ADK>/.venv/bin/python
  argv: [-m,orchestrator.runner,--mode,oracle,--data,<runtime>/smoke-alien-3.jsonl,--concurrency,1,--output,<run>/oracle.json]
  cwd: <ADK>
  env: safe official env only; PYTHON_DOTENV_DISABLED=1
  log: <run>/logs/oracle.log

Warble system agent (normal mode only)
  exe: node
  argv: [<package>/dist/cli.js,--ir,<run>/agent-ir.json,--wren-project-root,<runtime>/identity-projects,--model,<system-model>,--user-simulator-url,http://127.0.0.1:6001,--db-environment-url,http://127.0.0.1:6002,--out,<run>/traces,--port,6000,--wren-bin,<wren-bin>]
  cwd: <Warble root>
  env: non-model runtime allowlist plus allowlisted system-agent auth variables
  log: <run>/logs/system-agent.log

a-interact runner (normal mode only)
  exe: <ADK>/.venv/bin/python
  argv: [-m,orchestrator.runner,--mode,a-interact,--data,<runtime>/smoke-alien-3.jsonl,--concurrency,1,--output,<run>/a-interact.json]
  cwd: <ADK>
  env: safe official env only; PYTHON_DOTENV_DISABLED=1
  log: <run>/logs/a-interact.log
```

`safe official env` contains only `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `NO_PROXY`,
`no_proxy`, `PYTHONPATH=<ADK>`, `PYTHON_DOTENV_DISABLED=1`,
`PYTHONDONTWRITEBYTECODE=1`, `DATASET=lite`,
`PG_HOST=127.0.0.1`, `PG_PORT=<verified manifest port>`, `PG_USER=root`, `PG_PASSWORD=123123`,
`SYSTEM_AGENT_PORT=6000`, `USER_SIM_PORT=6001`, `DB_ENV_PORT=6002`, and `PATIENCE=3`. Model
variables are selected rather than forwarding the entire parent environment. The user-simulator
allowlist contains `USER_SIM_MODEL`, LiteLLM base/key, and only the API variables required by the
selected provider. The system-agent allowlist contains its Claude SDK authentication variables such
as `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`; the OAuth token is never sent to the user
simulator or any official runner. Explicit parent values override the parsed private file.

Use child process groups so uvicorn descendants are cleaned up. Keep the Warble-owned PostgreSQL container running for reuse; document a separate explicit cleanup command rather than removing it automatically.

- [ ] **Step 4: Wire and build the smoke entry**

Add `src/smoke-cli.ts` to `tsup.config.ts`, keep all three bins in `package.json`, and ensure every CLI uses a direct-execution guard so importing it in tests has no side effects.

- [ ] **Step 5: Run smoke-focused and full package verification**

Run:

```bash
cd eval/bird-interact
node --import tsx --test tests/smoke-cli.test.ts
npm run check-types
npm test
npm run build
node dist/smoke-cli.js --help
```

Expected: PASS; help starts no processes.

- [ ] **Step 6: Commit the smoke launcher**

```bash
git add eval/bird-interact/src/smoke-cli.ts \
  eval/bird-interact/tests/smoke-cli.test.ts \
  eval/bird-interact/package.json \
  eval/bird-interact/package-lock.json \
  eval/bird-interact/tsup.config.ts
git commit -m "feat(eval): run oracle-gated BIRD smoke"
```

### Task 7: Replace the manual README with the self-contained workflow

**Files:**

- Modify: `eval/bird-interact/README.md`
- Modify: `justfile`
- Modify: `docs/superpowers/specs/2026-08-24-bird-interact-self-contained-data-design.md`
- Create: `eval/bird-interact/tests/readme-workflow.test.ts`

- [ ] **Step 1: Add a failing documentation contract test**

Assert README/Just contain:

- the official BIRD gated GT explanation (do not invent a public GT URL);
- the pinned GitHub and Hugging Face revisions, tree/resolve acquisition, complete public metadata
  snapshot, tracked 57-file OID/size trust root, reuse verification, main JSONL SHA, and official
  Docker image;
- the actual Docker image ID/repository digest is captured and checked because `latest` is mutable;
- a verified Python 3.10-3.12 prerequisite, `--python-bin`, requirements hash, and `pip freeze`
  provenance (without claiming transitive dependencies are pinned);
- a Warble-local Wren CLI installation example, such as a venv under `data/cache/wren-cli` with pinned `wrenai==0.8.1`, plus `--wren-bin`;
- GT import, prepare, oracle-only, and full three-task commands;
- `data/private/.env.example` content shown in README (not a tracked secret file), including `USER_SIM_MODEL` and provider examples;
- the exact fixed IDs and Query-subset warning;
- result, log, trace, manifest, and cleanup locations;
- `PYTHON_DOTENV_DISABLED=1` / `PYTHONDONTWRITEBYTECODE=1` isolation, the rule that ADK-local `.env`
  and source-tree bytecode are rejected, and existing-venv interpreter matching;
- an explicit statement that runtime never reads an external project;
- Just recipes `prepare-bird-eval` and `smoke-bird-eval` that forward arguments.

- [ ] **Step 2: Run the contract test and confirm old docs fail**

Run: `cd eval/bird-interact && node --import tsx --test tests/readme-workflow.test.ts`

Expected: FAIL because the README still instructs users to manage data and identity projects outside Warble.

- [ ] **Step 3: Document the one-root workflow and recipes**

The README sequence must be copy/pasteable from the Warble root:

```bash
just install-bird-eval
/absolute/path/to/python3.11 -m venv eval/bird-interact/data/cache/wren-cli
eval/bird-interact/data/cache/wren-cli/bin/python -m pip install 'wrenai==0.8.1'

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

Explain that later runs omit `--gt`; preparation validates the private copy every time. Document `docker stop warble_bird_interact_postgresql` as an optional non-destructive stop, not automatic deletion. Preserve the existing protocol/scoring explanation and differential-test instructions, but remove all claims that identity projects and combined data must live outside Warble.

- [ ] **Step 4: Run documentation and package tests**

Run:

```bash
cd eval/bird-interact
node --import tsx --test tests/readme-workflow.test.ts tests/data-boundary.test.ts
cd ../..
just lint-bird-eval
just test-bird-eval
just build-bird-eval
```

Expected: PASS.

- [ ] **Step 5: Commit docs and recipes**

```bash
git add eval/bird-interact/README.md \
  eval/bird-interact/tests/readme-workflow.test.ts \
  docs/superpowers/specs/2026-08-24-bird-interact-self-contained-data-design.md \
  justfile
git commit -m "docs(eval): explain official BIRD data setup"
```

### Task 8: Import the real GT and run the `alien` three-task acceptance

**Files:**

- Create locally, never commit: `eval/bird-interact/data/private/bird_interact_gt_kg_testcases_1008.jsonl`
- Create locally, never commit: `eval/bird-interact/data/private/.env` when credentials are available
- Create locally, never commit: `eval/bird-interact/data/cache/**`
- Create locally, never commit: `eval/bird-interact/data/runtime/**`
- Create locally, never commit: `eval/bird-interact/data/runs/alien-3/**`

- [ ] **Step 1: Prove the destination is ignored before importing GT**

Run from the Warble root:

```bash
git check-ignore -v \
  eval/bird-interact/data/private/bird_interact_gt_kg_testcases_1008.jsonl
```

Expected: exit zero and a rule from `eval/bird-interact/data/.gitignore`.

- [ ] **Step 2: Create a Warble-local pinned Wren CLI**

```bash
/absolute/path/to/python3.11 -m venv \
  eval/bird-interact/data/cache/wren-cli
eval/bird-interact/data/cache/wren-cli/bin/python -m pip install 'wrenai==0.8.1'
eval/bird-interact/data/cache/wren-cli/bin/wren --version
```

Record the reported version in the manifest. Do not use another project's venv or executable.

- [ ] **Step 3: Prepare using the existing gated GT only as an import source**

```bash
just prepare-bird-eval \
  --gt /absolute/path/to/bird_interact_gt_kg_testcases_1008.jsonl \
  --wren-bin "$PWD/eval/bird-interact/data/cache/wren-cli/bin/wren"
```

Then rerun without any external path to prove local reuse:

```bash
just prepare-bird-eval \
  --wren-bin "$PWD/eval/bird-interact/data/cache/wren-cli/bin/wren"
```

Expected: exactly 300 combined rows; exactly `alien_1`, `alien_2`, `alien_3` in the smoke; private GT mode `0600`; official/public/source hashes in the manifest; identity MDL dry-plan passes.

Also require the runtime manifest to report the pinned public commit, `fileCount: 57`, and a nonempty
`manifestSha256`; this binds every official schema/column-meaning/KB file used by charged tools.

- [ ] **Step 4: Run the credential-free official oracle gate**

```bash
just smoke-bird-eval --oracle-only \
  --python-bin /absolute/path/to/python3.11 \
  --wren-bin "$PWD/eval/bird-interact/data/cache/wren-cli/bin/wren"
jq -e '
  .metrics.total_tasks == 3 and
  ([.results[].task_id] == ["alien_1", "alien_2", "alien_3"]) and
  all(.results[]; (.error | not) and .phase1_passed and .phase2_passed)
' eval/bird-interact/data/runs/alien-3/oracle.json
```

Expected: PASS. Any oracle failure stops here; do not run the model.

- [ ] **Step 5: Configure private model auth without printing it**

Create `eval/bird-interact/data/private/.env` mode `0600` only if required variables are not already present in the process environment. Include `USER_SIM_MODEL` and the matching provider authentication. Do not display or persist values in command output, logs, Git, or the official checkout. Confirm only file existence/mode and the launcher's redacted preflight.

- [ ] **Step 6: Run official a-interact over the three alien questions**

```bash
just smoke-bird-eval \
  --python-bin /absolute/path/to/python3.11 \
  --wren-bin "$PWD/eval/bird-interact/data/cache/wren-cli/bin/wren"
jq -e '
  .metrics.total_tasks == 3 and
  ([.results[].task_id] == ["alien_1", "alien_2", "alien_3"]) and
  all(.results[]; .error | not)
' eval/bird-interact/data/runs/alien-3/a-interact.json
```

Expected: three completed official results. Zero rewards are acceptable for this smoke; missing/error rows are not.

- [ ] **Step 7: Verify traces, provenance, self-containment, and Git safety**

```bash
test "$(wc -l < eval/bird-interact/data/runtime/smoke-alien-3.jsonl)" -eq 3
for id in alien_1 alien_2 alien_3; do
  test -f "eval/bird-interact/data/runs/alien-3/traces/$id/trace.json"
done
test -f eval/bird-interact/data/runs/alien-3/manifest.json
test -f eval/bird-interact/data/runs/alien-3/python-environment.json
test -s eval/bird-interact/data/runs/alien-3/python-freeze.txt
! rg -n '<external-source-path>' \
  eval/bird-interact/data/runtime eval/bird-interact/data/runs
bird_image_id=$(docker inspect warble_bird_interact_postgresql --format '{{.Image}}')
docker image inspect "$bird_image_id" --format '{{.Id}} {{json .RepoDigests}}'
git status --short
git diff --check
```

Expected: no data/cache/runtime/private file appears in Git status and no runtime artifact contains a path outside this repository.

- [ ] **Step 8: Run the complete regression gate**

```bash
just lint-bird-eval
BIRD_INTERACT_CHECKOUT="$PWD/eval/bird-interact/data/cache/BIRD-Interact" just test-bird-eval
just build-bird-eval
cargo test --workspace --locked --quiet
```

Expected: all TypeScript tests, the mandatory official differential, build, and Rust workspace tests PASS.

- [ ] **Step 9: Commit only source and documentation, never local data**

```bash
git status --short
git diff --check
git log --oneline --decorate -10
```

If any final source-only correction was necessary, commit it with a focused message. Verify `git ls-files eval/bird-interact/data` lists only `.gitignore` and `README.md`.
