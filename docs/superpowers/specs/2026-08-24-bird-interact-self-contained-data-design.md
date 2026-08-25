# Self-contained BIRD-Interact data and smoke design

## Goal

Make `eval/bird-interact` locally runnable without reading any external project's code, cache, `.env`, or
pre-provisioned Wren project. A developer with a Warble checkout, Docker, model credentials, and an
officially obtained gated GT file can prepare the pinned BIRD runtime and run three tasks from one
database. On the current machine, the existing gated GT file will be copied into Warble as a private,
gitignored input.

## Boundary

Warble owns the preparation commands, pinned-source validation, public-data download, GT merge,
identity MDL generation, three-task selection, service orchestration instructions, adapter, and run
artifacts. The following remain external prerequisites because they are authoritative benchmark or
secret material:

- Docker and the official `shawnxxh/bird-interact-postgresql` image;
- a supported Python 3.10-3.12 interpreter and the PostgreSQL client commands required by the
  official ADK (`psql`, `createdb`, and `dropdb`);
- the `wren` CLI under evaluation, supplied on `PATH` or by an explicit path;
- model authentication for the Warble system agent and official user simulator;
- a gated GT JSONL obtained from BIRD.

The preparation flow may clone the pinned official BIRD repository and public Hugging Face dataset
under Warble's ignored local data directory. It must not import or invoke an external project.

## Local data layout and safety

All mutable or gated material lives below `eval/bird-interact/data/` and is ignored by Git:

```text
data/
  private/
    bird_interact_gt_kg_testcases_1008.jsonl
    .env                         # optional model-provider settings
  cache/
    BIRD-Interact/               # pinned official checkout
    bird-interact-lite/          # verified public Hugging Face snapshot
      _warble-source.json        # per-file OID/size/SHA metadata
  runtime/
    bird_interact_data_with_gt.jsonl
    smoke-alien-3.jsonl
    identity-projects/
      alien/target/mdl.json
  runs/
    alien-3/
```

The repository tracks `data/README.md`, `data/.gitignore`, and
`eval/bird-interact/public-snapshot.json`, a trust root containing the pinned HF file path/OID/size
set. It never tracks the private, cache, runtime, or run contents. Preparation copies the GT rather
than moving it, sets private-file mode where supported, validates all IDs and fields described below,
and writes `data/runtime/manifest.json` with source revisions plus input/output SHA-256 hashes,
including the complete public snapshot manifest SHA-256. The smoke result copies this manifest
beside its official result. No command prints GT rows or credentials.

The official BIRD repository is fixed at
`https://github.com/bird-bench/BIRD-Interact.git` commit
`451fe2c3518ee1cf908d8139e2913483bd519381`. The Hugging Face repository is
`https://huggingface.co/datasets/birdsql/bird-interact-lite` and is fixed at
`f7881a9c2b9630cc4fc13b0c39279740b0a2fd87`. Preparation enumerates the snapshot from the pinned
Hugging Face tree API and downloads every file from an immutable `resolve/<commit>/<path>` endpoint,
avoiding a Git LFS runtime dependency. This includes the main JSONL and every database's schema,
column-meaning, and KB metadata required by the official DB/user-simulator services; the downloaded
`bird_interact_data.jsonl` must have SHA-256
`d155fa0855bc1885f77df2fcc357d3056e10426cd6093c0042aa99d79067af08`. Both an optional source
checkout and a reused cache must have the expected normalized `origin` URL, exact HEAD, no tracked
or staged changes, no unexpected untracked files, and all required files before the source is
imported or reused. Only explicitly ignored runtime entries created by this workflow, such as the
ADK `.venv` and local public-data symlink, are allowed. Python bytecode outside that venv is
forbidden. Fresh and reused public snapshots must exactly match both the tracked trust root and a
new listing of the pinned tree API. Every local file's size and Git blob OID (or declared LFS
OID/size contract) is recomputed; the main JSONL also requires the pinned SHA-256. Modified, missing,
or extra metadata files are rejected, and a failed refresh never patches a verified cache in place.

## Preparation command

A TypeScript preparation CLI inside `eval/bird-interact` accepts:

```text
--gt <path>             source GT to copy; optional after the private copy exists
--official-checkout <path>  optional existing pinned checkout; otherwise clone locally
--public-data <path>        optional existing main public JSONL; otherwise download the pinned file
--postgres-container <name>  official container name, default `warble_bird_interact_postgresql`
--postgres-port <port>        host port when creating the default container, default `55432`
--wren-bin <path-or-name>     Wren CLI, default `wren`
```

Version one deliberately prepares only the `alien_1`, `alien_2`, and `alien_3` Query smoke. It has
no generic `--db` or `--count` contract; unsupported selection is therefore impossible rather than
underspecified. General database selection can be added later with a separate ordering contract.

It performs idempotent, fail-loud steps:

1. copy and validate the GT into `data/private`;
2. clone or verify BIRD at commit `451fe2c3518ee1cf908d8139e2913483bd519381`;
3. download or verify the pinned `birdsql/bird-interact-lite` public snapshot, rejecting unsafe
   paths and requiring schema, column-meaning, and KB files for every database named by the 300
   public rows;
4. make the unchanged official ADK resolve its public metadata by creating the ignored symlink
   `data/cache/BIRD-Interact/BIRD-Interact-ADK/bird-interact-lite` pointing at the pinned public
   checkout; reject an existing nonmatching target;
5. merge public rows with GT into a distinct runtime file without modifying either source, then
   select exactly `alien_1`, `alien_2`, and `alien_3`, rejecting missing, duplicate, cross-database,
   or non-Query rows;
6. inspect the `alien` database in the official PostgreSQL container and generate a physical-identity
   Wren MDL with table and column names unchanged and no descriptions, samples, knowledge, or GT;
7. run a representative `wren dry-plan` preflight against the generated MDL;
8. promote the staged runtime only after the local public-data symlink and every preflight above
   succeed.

GT validation requires exactly 300 unique nonempty string `instance_id` values. Every GT row must
contain a nonempty list of nonempty SQL strings in `sol_sql`, list-valued `external_knowledge` and
`test_cases` fields (which may be empty), and a dictionary-valued `follow_up`. Each follow-up must
contain `sol_sql` as either a nonempty string or nonempty list of nonempty strings plus list-valued
`external_knowledge` and `test_cases`. Public data must contain exactly 300 unique IDs and nonempty
string `instance_id`, `selected_database`, `category`, and `amb_user_query` fields plus a dictionary
`follow_up`. Schema validation must preserve all other official metadata, including `query`,
`user_query_ambiguity`, `knowledge_ambiguity`, and forward-compatible unknown fields; it must not
strip data needed by the official user simulator. The public and GT ID sets must be identical before
any output is written. After the official field merge, every row is revalidated and the output must
still contain exactly the same 300 IDs.

The MDL generator uses `docker exec ... psql` against `pg_catalog`/`information_schema`; it does not
need Wren UI or a WrenAI project. PostgreSQL types are mapped deterministically to Wren types, with
unsupported types reported before writing output. It writes atomically.

## Smoke execution

The README provides one sequence rooted in `eval/bird-interact`:

1. prepare local data and the `alien` identity project, starting or verifying the Warble-owned
   official PostgreSQL container as part of preparation;
2. create the official ADK venv inside the ignored pinned checkout;
3. start the user-simulator and DB-environment services against that container;
4. compile the Warble profile and start the Warble system agent on port 6000;
5. run the official orchestrator over `smoke-alien-3.jsonl` with concurrency 1;
6. inspect the official result JSON and Warble traces under `data/runs/alien-3`;
7. stop only processes started by the documented smoke command.

`data/private/.env` is loaded by the Warble-owned smoke launcher and merged only into the Warble
system agent and official user-simulator environments, without logging values. The DB-environment
service receives only its database/service configuration and no model-provider secrets. The file supports official ADK variables such as
`USER_SIM_MODEL`, provider API/base settings, and the Claude Agent SDK's normal authentication
variables. The launcher never writes this environment into the official checkout. Explicit process
environment values take precedence over the private file. Missing user-simulator or system-agent
authentication fails preflight before services start. Every official Python process is launched
with `PYTHON_DOTENV_DISABLED=1` and `PYTHONDONTWRITEBYTECODE=1`; startup verifies that the installed
`python-dotenv` honors the former, and cache verification rejects Python bytecode outside the allowed
ADK venv. An existing `.env` inside the official checkout is rejected with instructions to move its
settings to `data/private/.env`; ancestor `.env` files are ignored. An existing ADK venv is reused
only when its actual interpreter is Python 3.10-3.12 and has the same major/minor as the requested
`--python-bin`; a mismatch fails without deleting anything. The oracle runner gets no model secrets,
and `--oracle-only` neither checks model authentication nor requires port 6000.

The three-task result is explicitly labeled a Query subset smoke, not a full BIRD-Interact score.
The flow first runs the official oracle over the same three rows; a failed oracle blocks the model
run.

## Error handling

Preparation exits nonzero before mutating runtime outputs when the GT is incomplete, source pins are
wrong, the public download/hash is incomplete, the selected database is absent, the container is
unhealthy, schema introspection fails, a type cannot be represented, or `wren dry-plan` fails. Temporary files
are renamed only after validation. Service commands use bounded health checks and preserve logs under
the ignored run directory. Existing private GT and cache entries are reused only after revalidation.
The actual PostgreSQL image ID and repository digest are recorded in the manifest and verified when
the container is reused; the mutable `latest` tag alone is never treated as sufficient provenance.

## Tests and acceptance

Service-free tests cover GT validation/merge, deterministic three-task selection, no source
overwrite, identity MDL generation from a synthetic introspection result, type failures, pin
validation, and ignored-path enforcement. Existing official differential, TypeScript typecheck/build,
and Rust workspace tests remain green.

Live acceptance for this change is:

- the copied GT exists inside Warble and `git check-ignore` proves it cannot be committed normally;
- no runtime command accesses a path outside this repository;
- the three-row oracle for `alien_1..3` passes;
- the a-interact run completes all three rows and writes official results plus one trace directory per
  task, even if model rewards are zero.

## Implementation status

The design ships as three binaries in the isolated `eval/bird-interact` package, wired to Just
recipes that forward their arguments:

| Command | Recipe | Source |
| --- | --- | --- |
| `warble-bird-prepare` | `just prepare-bird-eval` | `src/prepare-cli.ts` |
| `warble-bird-smoke` | `just smoke-bird-eval` | `src/smoke-cli.ts` |
| `warble-bird-interact` | (started by the smoke launcher) | `src/cli.ts` |

Two decisions were settled during implementation and are binding:

- **The smoke command has no container or port flag.** Both come from the verified
  `data/runtime/manifest.json`, so a run can never silently diverge from what preparation validated.
- **`--postgres-port` applies only when Warble creates the default container.** An existing
  container's actual published `5432/tcp` mapping wins and is what the manifest records.

`data/runs/alien-3/logs/` additionally holds `compile.log` and `adapter-build.log` beside the five
service and runner logs the design names; both are Warble-side build steps, not official processes.
