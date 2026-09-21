---
title: "Direct-session producer"
description: "Versioned step plans for host-owned runtimes, with explicit tool requirements and fail-closed compatibility boundaries."
---

<!-- @generated from docs/spec/direct-session.md by scripts/gen-reference.mjs — do not edit; edit the spec and re-run `npm run gen:reference` -->

`warble produce-session` produces a deterministic step plan for a **host-owned runtime**.
It does not execute a model, launch a vendor, grant permissions, read a semantic project,
or emit discovery/config files. It is separate from `dispatch`, not a new native TUI mode.

The legacy producer format is `session_plan_version: "1"`, accepting exactly IR **0.8**.
The host contract's `version: "1"` is independent of the IR and package versions.
`producer_version` reports the binary's package version; a host must pin a tested binary
and supported format tuple. Older installed packages without this command, and IR 0.6/0.7,
are not compatible. Producing a plan is not evidence that an installed runtime can execute it.

## CLI

```bash
warble produce-session ir.json --component analyze \
  --host-contract host.json --out session-plan.json
```

All four arguments are required. `--component` selects an exact advertised entrypoint ID;
the supported behavior is selected by IR anatomy, never by that ID or its verb.
Optional repeated `--slot NAME=VARIANT` selects prompt wording; `--slot NAME=` removes it.
Duplicate or out-of-scope slot flags fail. An unanswered `present_when` fails, including
when a default exists. Single-level variants are supported; nested slot references fail.

Inputs are UTF-8 JSON with unique keys, limited to 4 MiB each. Expansion has a conservative
4 MiB upper bound; compact output including its digest is also limited to 4 MiB.
The command reads only the two explicit input files. It does not resolve the context
project path, inspect user homes, discover a Hub/compiler checkout, or access the network.

Validation completes before output creation. The destination must not exist (including a
symlink); missing parent directories are not created. The new file is mode 0600 on Unix.
The file is written and synced directly, **not atomically renamed**: the calling host must
use its own private directory and consume it only after exit success. An ordinary write
error removes the new file; process termination can leave a partial file, which is not a
valid plan. Success writes no stdout.

Vendor flags such as `--target`, `--models-config`, `--native-mcp` or credentials are not
accepted. Nothing about producing a plan starts or authorizes execution.

## Host contract

Example for a read-only analysis with adjacent repair:

```json
{
  "version": "1",
  "tiers": ["cheap", "strong"],
  "capabilities": {
    "semantic_introspection": {"tool": "inspect_context"},
    "sql_execution:read_only": {"tool": "query_read_only"},
    "render_contract": {}
  },
  "guardrails": [
    {"name": "read_only_execution", "locked": true},
    {"name": "row_limit", "locked": false, "threshold": 100},
    {"name": "statement_timeout", "locked": false, "threshold": 30},
    {"name": "deterministic_gate", "locked": true}
  ],
  "execution": [
    "ordered_steps", "isolated_step_tools", "artifact_provenance",
    "per_step_tiers", "bounded_repair", "render_contract"
  ]
}
```

The root and every capability/guardrail object are closed: unknown fields fail.
Tiers and execution features must be unique, nonempty strings. Tier names are open
IR tier names, **not concrete provider/model configuration**.

| Capability | Host binding |
| --- | --- |
| `semantic_introspection` | Exactly one named tool |
| `sql_execution:read_only` | Exactly one named tool |
| `artifact_write` | Exactly one named tool, plus a locked scoped guardrail |
| `render_contract` | `{}`: host-side schema validation |
| `structured_output_capture` | `{}`: host-side output capture |

No other capability is currently supported. Tool names match
`[A-Za-z][A-Za-z0-9_]{0,63}`; tool aliases across capabilities fail because they could
undo per-step narrowing. Tool argument/result schemas, implementation and authorization
belong to the host, not to this file. A name is not a shell command or an arbitrary RPC.
Host capability inventory may be a superset; only selected requirements are emitted.

Guardrails must match the selected component **exactly**, including `locked`,
threshold and scope. A locked `read_only_execution` guardrail is mandatory.
The closed supported vocabulary is:

- `read_only_execution`, `deterministic_gate`: no threshold or scope.
- `row_limit`: positive integer maximum result rows.
- `statement_timeout`: positive integer timeout in seconds.
- `artifact_write`: no threshold; a nonempty relative logical scope, without absolute
  paths, backslashes, control characters, empty segments or parent traversal. `.` is a
  valid logical root. This is **not a filesystem grant**; the host must safely resolve and
  enforce containment, including symlink handling.

An unlocked guardrail is still a requirement at its emitted value; it is not permission
for a running model to change it.

## Supported behavior

The initial subset is `analytical + skill + one_shot + none`, with 1–128 steps:

- Independent steps, in declared order.
- Adjacent `on_failure` repair targeting an unconditional preceding step. The repair
  consumes that step's declared result and declares its **own distinct** product.
  It is emitted as `repair_fold`, with `max_attempts: 1` and `on_exhaustion: "fail"`.
  Tier, prompt, capability narrowing and product identity remain those of the repair,
  not those of the target.
- Exact upstream `consumes` references and unique step/product identities.
  An independent product is available `after_attempt`; a repair product only
  `if_executed`. A downstream consumer of a conditional-only product is refused in
  this version: no implicit alias, pass-through, fallback or invented result.
- Per-step `capabilities` narrows the component requirement set. Omission inherits;
  an empty array grants no tools; `null` and widening fail.
  `produces_exclusive` retains the sole producing-step provenance.
- Shared resolved `brief`, individual step instructions, borrowed-action descriptions,
  context requirements/preconditions/check results, guardrails and render blocks.

The IR's `prompt_fragment` is a derived display projection, not a second instruction
source. It is slot-validated but not concatenated into the step prompts.
Render blocks imply the host's `render_contract` capability even when it is not in the
component's declared capabilities; it never adds a model tool.

Nonempty component calls, assets, params/binds, other anatomy, mutation/setup/scheduling,
other conditional forms, unsupported guardrail shapes, unknown policy fields and failed
preconditions wall-hit. Unselected components are not executable work; only their unique
identities are checked. Existing composed dashboard behavior is **not supported** here.

The producer is a strict supported-subset consumer, not a replacement for the compiler.
It accepts trusted compiled IR and rejects unknown executable fields instead of guessing
their meaning. Display/evaluation metadata is non-executable. Context binding
(`runtime_selected` or `pinned`) is hashed, not opened; its resolved metadata is opaque.

## Plan fields and identity

| Field | Meaning |
| --- | --- |
| `session_plan_version`, `producer_version`, `warble_ir_version` | Independent compatibility versions |
| `input_ir_sha256`, `host_contract_sha256` | SHA-256 of the exact input bytes, including whitespace |
| `profile`, `component` | Selected compiled identity |
| `context_identity_sha256` | Digest of the compact context-binding JSON |
| `instructions.brief`, `steps` | Resolved shared framing and ordered structured steps |
| `slot_supply` | Explicit variant/absence decisions contributing to plan identity |
| `required_capabilities` | Original component declarations |
| `required_host_capabilities`, `capability_bindings` | Selected non-model host requirements, including implied render validation |
| `guardrails`, `required_execution` | Exact host enforcement/semantics obligations |
| `borrowed_actions`, `context_requirements`, `context_precondition`, `precondition_result`, `render_blocks` | Preserved requirements, not runtime evidence |
| `authority: "host_owned"`, `execution_status: "not_executed"` | Explicit ownership and non-execution markers |
| `plan_sha256` | Digest of the compact plan without this field |

Each step carries `name`, `tier`, `consumes`, `produces`, `produces_exclusive`,
`instructions`, effective `capabilities`, sorted `tools`, `when`, `realization` and
`product_availability`. Independent realization is `{"kind":"independent"}`.
Repair realization additionally carries `fold_into`, `failure_input`, `max_attempts`,
and `on_exhaustion`.

Digests use `sha256:<lowercase hex>`; compact serialization uses recursively
lexicographically sorted object keys and retains array order (serde_json without
preserve-order). Consumers should use the same serialization, not an unrelated generic
canonical-JSON algorithm. Digests detect drift; **they are not signatures, authorization,
or secret redaction**. Prompts may contain caller-supplied sensitive content; protect plans.

## Host obligations before execution

A host contract is an **implementation claim**, not certification. The host must:

1. Validate the full format/version and exact binary/IR/context/contract identity.
   Reject unsupported fields/semantics and stale bindings; never fall back to a broader
   native session. A compile-time passing precondition must be revalidated against the
   selected live context before execution.
2. Keep sessions, credential material, expiry/revocation, context generation, typed tool
   schemas and tool authorization outside the model. Credentials never enter this plan
   or model tool arguments.
3. Give each step only its declared tools and bound tier; disable ambient shell/network,
   vendor discovery tools, hooks and MCP capabilities not explicitly authorized by the
   host. A broad default tool surface invalidates `isolated_step_tools`.
4. Enforce read-only queries, row/time limits, deterministic validation and artifact scope
   at the trusted operation boundary, not by trusting prompt compliance.
5. Track artifacts by producing step and attempt. A failed attempt supplies a typed
   non-secret failure result under its declared product, **not fabricated successful
   data**. Repair receives that result via `failure_input` and runs only on host-observed
   failure, at most once. Failure after repair aborts; unrelated failures cannot be
   swallowed. A skipped repair produces nothing. Never overwrite its target's exclusive
   product; subsequent consumers retain their exact declared source.
6. Supply only the user's request, shared brief, current step instructions and declared
   inputs to the current step. Do not flatten the whole plan into one conversation and
   claim equivalent tier, dataflow, provenance or repair enforcement.
7. Validate render/output schemas, own cancellation/descendant cleanup, and refuse
   execution unless actual runtime readiness and all permission boundaries are proven.

The deterministic tests cover production, rejection, identity and a relocated binary
without vendor/runtime/project dependencies. They do **not** prove a live vendor runtime,
broker, authenticated turn or production sandbox.

## Composed format 2

An explicit host `version: "2"` selects a separate plan shape. Format 1 continues rejecting
component calls. Format 2 has `entry` and a `components` registry, **no top-level `steps`**;
consumers must reject unknown versions instead of coercing this shape into format 1.

The host supplies `protocol: "warble-component-host/1"`, the following exact ordered
`execution` list, and `components`, keyed by every component in the selected root's reachable
closure (no missing or additional bindings):

```json
[
  "immutable_step_authority", "isolated_component_tools", "fresh_child_context",
  "verified_context_preconditions", "component_owned_bindings", "exact_step_tiers",
  "exact_dataflow", "bounded_repair", "shared_admission_ledger",
  "deadline_and_descendant_cancellation", "normalized_child_results",
  "root_only_persistence", "redacted_usage_trace"
]
```

Each component's binding uses the format-1 host declaration fields (`version`, `tiers`,
`capabilities`, exact `guardrails`, `execution`) with `version: "2"`. In this version,
`artifact_write` and `component_invocation` require `{}` rather than a model tool. Persistence
is a root terminal host action. SQL and semantic introspection still require distinct named
tools. Inventory may be a superset; emitted grants remain narrowed to the current component
and step. Guardrails additionally support parameterless `additivity_guard` and positive integer
`drill_depth_limit`.

Each registry record retains its full validated `declaration`, exact `component_calls`,
derived step tools, tier, repair, products, context, and binding identity. Already compiled
optional/required parameter bindings are supported; missing bindings and unresolved predicate
arguments fail. Source parameters, assets and slots remain unsupported. Only advertised roots
may be selected; reachable internal callees need not be entrypoints. Callee write guardrails,
artifact capabilities and borrowed actions fail before output. Duplicate aliases, tool/alias
collisions, cycles, missing targets and depth violations fail. Compile-time passing context
checks must exactly match declared predicates; the host must still verify fresh context.

The shared admission limits are depth 8, 32 calls, 40 steps total, 12 steps per child, one
in-flight sibling, 65,536 request bytes, 1,048,576 result bytes and a 120,000 ms root deadline.
`model_turn_hard_limit` and `monetary_hard_limit` are explicitly false: a host step admission is
not proof of a bounded number of vendor-internal model calls. Host limits and cancellation must
cover descendants and retries, close admission on revocation, and discard late results.

## Native conversation with host-owned steps

`dispatch --target claude-code:interactive|codex:interactive --purpose analysis` may explicitly
use `--native-host FILE`, alongside `--native-scope` and `--native-mcp`. This emits native launch
format **5** and `.warble/component-plans.json`; old flags and contracts continue rejecting
composition. This is a new execution realization, not a native subagent enforcement claim.

The closed native host descriptor contains:

- `version: "1"`, `protocol: "warble-component-host/1"`, and `vendor: "claude"|"codex"`.
- Nonempty bounded opaque `session_id`, `auth_identity`, `runtime_generation`. The auth identity
  is a host reference to an approved account, never a token, key or credential.
- `binding` equal to the native scope's project identity, generation and revision.
- `prepared_contexts`: a SHA-256 digest per governed component, bound by the host to its actual
  fresh prepared context and typed tool binding.
- `roots`: a complete format-2 host declaration per admitted root. Claude scope preserves
  native standalone agents and admits each composed advertised root. A pinned entry prepares
  only that exact root. Codex scope remains unsupported.

The native driver retains conversation and selection through authored descriptions. Each
governed wrapper has one fixed root tool (`warble_run_<derived identity>`); its only model
argument is `request`. The immutable `root_tools` registry defines the mapping. This is root
admission, not active-step attestation. The host supplies step and invocation identity through
private runner closures, never model arguments or transcript markers. Child work receives no
outer session credentials, shell tools, ambient network or history. Results return via the
correlated tool response; hosts must not inject responses as PTY user input.

Claude scope's existing top-level union grants remain intact; no isolation is claimed for that
outer conversation. Governed wrappers have only their admission tool. Pinned Codex discovery
contains only its selected root, a read-only discovery workspace and disabled command network,
without a Wren executable grant. The host must pin and validate the actual vendor binary,
effective configuration and environment before launch; emitted configuration alone cannot prove
isolation or account identity. Governed execution must use the same approved vendor/account as
the native conversation, with no API-key fallback or cross-vendor substitution.

Launch format 5 binds the host plan digest, target, account reference, session, runtime generation,
binding and admitted roots. The host must verify all fields against live owned state, the plan,
artifact ownership and original IR/context before starting any work. Replayed, stale, expired or
changed bindings and executable substitutions must be rejected. Plan digests detect drift, not
truth or permission. Emission remains `not_executed`; runtime certification and activation are
separate requirements.
