# pi hybrid runtime foundation

This package provides local Cedar authorization for model recipients, component invocation
and disclosure. It is published on npm as `@warble/pi`, version-locked to the Warble release it ships with. It provides a bounded compiled-IR private runner using the pinned pi agent core,
immutable disclosure artifacts and a mandatory fetch boundary. The separate `pi:hybrid` CLI target now emits launch artifacts for a limited pi-tui frontend;
stock pi InteractiveMode and `pi:interactive` keep their existing contracts.

## Local verification

From the repository root, with Node 22.19 or later:

```sh
just install-pi-ts
just lint-pi-ts
just test-pi-ts
just build-pi-ts
node dispatcher/pi/tests/built-smoke.mjs
```

Tests use the real Cedar WASM evaluator, pinned pi agent loop and loopback HTTP/SSE fixtures,
with no real provider, credential or database access. Runtime tests exercise the built package;
`check-types` and `test` build it first so a clean checkout has no hidden build dependency.
The built-package smoke test also verifies that the emitted ESM can load the Node WASM entry.

## Integration

```ts
import { PolicyAuthority, selectionPreset } from "@warble/pi";

// Load from a trusted deployment configuration; see examples/deployment.cedar.
const authority = new PolicyAuthority(deploymentPolicy, event => auditSink.append(event));
const recipient = authority.registerRecipient({
  project: "project-a",
  role: "planner",
  zone: "public",
  deployment: "cloud-planner",
});

// A trusted adapter registers identity/classification, never raw metadata content.
const catalog = authority.registerResource({
  project: "project-a",
  kind: "schema.structure",
  document: "catalog",
});
const selection = {
  ...selectionPreset("schema-aware", ["catalog"]),
  components: ["private-oracle"],
  approvedAnswers: true, // Independent choice, not implied by schema-aware.
};
const session = authority.openSession(recipient, selection, operatorIsAuthorized);
const decision = authority.authorize({
  session,
  resource: catalog,
  action: "receive_metadata",
});
if (decision.decision === "deny") return unavailable(decision.reason);

// Before releasing the exact immutable content associated with this handle:
const current = authority.checkGrant(decision.grant!);
if (current.decision === "deny") return unavailable(current.reason);
// The runtime must also enforce IR/tool scope, content validation and provider egress.
```

`registerRecipient`, resource registration/replacement, `openSession`, `replaceDeployment`,
and the result-verifier API are **trusted control-plane methods**. Never expose them as model
tools or directly deserialize model input into them. Opaque handles are frozen, process-local
objects backed by private registries; copying, serializing or forging their shape does not
produce a valid handle. A future IPC bridge must retain its own authenticated registry.

`authorize` accepts exactly `{session, resource, action}`. Extra identity/classification/context
fields deny. The host derives project, role, zone, deployment, resource category/version,
recipient approval, operator authority and epoch from registered state. Cross-project access,
incorrect actions, an unauthorized operator or a mismatched approved recipient deny even under
a blanket deployment permit. Component permission does not create an IR call edge.

## Selections and resource categories

`selectionPreset` returns an editable starting point. `openSession` immediately converts it
to a separate immutable Cedar policy set. Later mutation of the source object has no effect.

| Mode | Initial metadata selection |
|---|---|
| `blind` | None |
| `schema-aware` | Structure and descriptions in explicitly supplied schema documents |
| `business-aware` | Schema selection plus rules in explicitly supplied rule documents |

No document IDs means no metadata permission. Any preset may be edited before admission:

```ts
import type { SessionSelection } from "@warble/pi";

const selection = {
  metadata: [
    { kind: "schema.structure", documents: ["catalog"] },
    { kind: "knowledge.rules", documents: ["approved-rules"] },
    { kind: "mdl.expressions", documents: ["approved-calculations"] },
  ],
  approvedAnswers: false,
  components: ["private-oracle"],
} satisfies SessionSelection;
```

Each entry can explicitly use `documents: "*"`, but deployment policy still caps it.

In the limited TUI, `/metadata` lists document IDs currently permitted by the deployment
ceiling. `/metadata knowledge.rules=approved-rules` selects only that document;
`/metadata schema.structure=catalog knowledge.rules=*` selects those categories/documents,
and `/metadata none` clears the metadata set. Every valid change starts an empty epoch.
The heading shows requested, effective and unavailable documents before a model call.
These operator controls are never model tools and never add catalog/denied names to prompts.
`/policy <name>` restores the named preset; `/reset`, `/model` and `/project` retain an override.
Programmatic callers use `HybridPlanner.reset({...choice, disclosure: [...]})`; the optional
override changes metadata only and is validated/snapshotted before asynchronous initialization.

| Category | Meaning supplied by the trusted adapter |
|---|---|
| `schema.structure` | Model/column names, types, relationships |
| `schema.descriptions` | Descriptions and enum meanings |
| `mdl.expressions` | Expressions and source mappings |
| `knowledge.rules` | Identified business-rule documents/sections |
| `knowledge.sql` | Verified SQL and SQL examples |
| `data.samples` | Example data values |
| `data.raw` | Raw data rows |
| `answer.approved` | A verifier-approved projection for one exact recipient |
| `component` | A host-known component identity for invocation authorization |

The last two categories have independent actions: `receive_answer` and `invoke_component`.
The seven metadata/data categories use `receive_metadata`. Defaults do not include expressions,
SQL, samples, raw data, approved answers or component invocations.

`context`, unspecified/unknown categories and multi-category labels are refused. A document
containing both rules and raw data cannot simply be labeled `knowledge.rules`: the trusted
adapter must produce safely classified fragments, or refuse the mixed document. Cedar does
not classify prose, inspect values, anonymize data or validate an LLM summary.

Only a trusted verifier may call `registerApprovedAnswer({project, document}, recipient)`,
after projection and validation. Ordinary `registerResource` refuses `answer.approved`.
This separates the API used by metadata loaders from the one used by the result verifier;
it is not a sandbox against hostile host code.

Identifiers are bounded adapter-owned references (`[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}`), not
paths, credentials, source text or provider URLs. Use `DisclosureBoundary` to retain content separately from the authorization registry.

## Decisions, errors and lifecycle

Effective authorization requires both **deployment Allow AND session-selection Allow**.
The two sets are evaluated independently; their permit rules are never concatenated.
Deployment policies are checked against the fixed `DISCLOSURE_SCHEMA` in strict mode.
Every evaluation validates entity records and the request; missing principal/resource records
are rejected even if a blanket Cedar permit would not dereference them.

Cedar normally skips policies that encounter evaluation errors. This adapter checks all
evaluation diagnostics and turns any error into `cedar_error`, including a failed `forbid`
alongside a successful `permit`. Parse/schema/entity/request failures and evaluator exceptions
also fail closed. Error codes never contain the underlying Cedar message or source.
Configuration registration errors throw fixed codes before a handle is issued.

The test suite includes a real Cedar arithmetic-overflow case: native Cedar returns Allow with
an erroneous forbid, while the application returns Deny. See the official
[authorization semantics](https://docs.cedarpolicy.com/auth/authorization.html) and
[validation contract](https://docs.cedarpolicy.com/policies/validation.html).

Every `replaceDeployment` increments the policy version and invalidates every old session/grant,
including identical policy replacement. A failed replacement locks authorization closed instead
of retaining the previous policy. Admit a fresh session after a successful replacement.
`closeSession` invalidates that session's grants. There is no hot mutation of session selection.

Resource handles refer to immutable identity/version records. `replaceResource` revokes the old
version and returns a new handle; an invalid replacement also revokes the old version.
`revokeResource` invalidates pending grants. For a changed approved answer, revoke the old handle
and rerun verification before registering a new approved projection.

**Runtime obligations:** keep the actual payload associated with a handle immutable; invalidate
it before changing content/classification. Run `checkGrant` at the release boundary. Serialize
that final check and send against policy/epoch changes; do not insert an asynchronous gap and
treat the old boolean as a durable permit. On policy/model/project/selection change, cancel
in-flight work and start fresh conversation state. The hybrid runner and egress transport subscribe to invalidation and cancel active work.
Any authority invalidation conservatively closes every associated runtime/transport instance.
The limited TUI refuses compaction/resume/import/export rather than restoring old histories.

## Audit

Each decision returns a frozen audit record. An optional synchronous sink receives the same
record; sink failure denies and produces no grant. Sink callbacks should atomically persist
and not mutate authority. Reentrant revocation is detected before returning a grant; a record
already delivered to such a callback describes the decision before that revocation.

Audit fields contain the decision/fixed reason, opaque generated policy/session/resource IDs,
policy version/digest, schema/Cedar versions, epoch, selection digest, resource version, action,
and recipient role/zone. They exclude project/document/deployment names, policy text, metadata,
SQL, prompts, credentials, raw errors and payload hashes. Policy/selection digests identify
configuration; they are not anonymization of confidential text. Do not put secrets in policy
literals or identifier fields.

## Cedar implementation choice

The dependency is pinned to the official `@cedar-policy/cedar-wasm` **4.14.0**, using its
`/nodejs` entry. The installed WASM binary is about 4.2 MiB. It evaluates locally without a
service, Rust toolchain at runtime or external subprocess protocol.

| Option | Integration consequences |
|---|---|
| Rust Cedar helper | Native executable per platform, process startup/IPC and packaging work; process termination can support a separate evaluation deadline boundary |
| Official Node WASM binding — selected | Fits the TypeScript runtime, one pinned dependency, typed validation/evaluation diagnostics; synchronous evaluation cannot be interrupted in the same JS thread |

Policy text is bounded to 64 KiB; selections and identifiers are bounded too. This does not
establish a hard CPU deadline or hostile-policy isolation. A future runtime requiring a
killable evaluation deadline should run the adapter in a worker/process and fail closed on
timeout. No benchmark comparison or cancellation guarantee is claimed.

Only `cedar.ts` depends on the evaluation API. No Cedar syntax enters Warble IR, no Wren
dependency enters the compiler, and no native-host or launch protocol changes are made here.
The package version participates in workspace release-please bookkeeping and local checks,
but publication remains disabled until the full runtime has its own accepted launch contract.

## Bounded private execution

`createHybridSession` accepts trusted compiler IR, the host-selected entry, public session,
`DisclosureBoundary`, and component-owned tier bindings. It returns a fixed list of tools;
each tool accepts **only `{request: string}`**. The model never selects a callee, step, provider,
endpoint, tool set or credential. `close()` invalidates the instance and cancels active work.
Selection/model/project changes must create a new instance with fresh public history.

Current admission supports IR 0.9, an analytical `skill` / `one_shot` / `none` root with one
step and statically declared component aliases, each reaching a one-step non-entrypoint leaf.
It refuses conditional steps, consumes/produces, nested calls, slots, nontrivial context
requirements/preconditions, render/persistence effects and unsupported guardrails. A private
leaf's non-LLM capabilities and borrowed actions must exactly match host-bound read-only tools.
Missing, extra, public-zone or duplicate tools refuse before launch. This is an internal IR
execution API, **not a claim of conformance to `warble-component-host/1`, native-host v5, or a
new accepted launch protocol**. No IR changes are required.

Each invocation starts a new Node process using **`@earendil-works/pi-agent-core` and
`@earendil-works/pi-ai` 1.0.4**, the same agent-loop library underlying pi. The package-owned
child uses no config/resource discovery, files/shell tools, extensions, inherited transcript,
provider discovery or persistence. Its only environment is isolated `HOME`/`TMPDIR` and pi
offline/telemetry flags; credentials are explicit private model bindings sent over stdin.
Temporary directories are removed after process close. POSIX process groups kill descendants
on success and failure; Windows execution currently refuses. This is functional process
isolation, **not an OS sandbox against malicious installed code or a hostile tool adapter**.

The private provider adapter currently supports OpenAI-compatible chat completions only,
with fixed destination, redirects refused, and explicit credentials. It does not imply that
an arbitrary public model endpoint is a private deployment: the operator supplies trusted
zone/deployment bindings. The public planner supports explicit OpenAI/Anthropic API bindings in the limited TUI.

Private tools run in a host broker with exact names, trusted argument validation and
read-only implementations. They receive cancellation signals; adapters must honor these for
their own external I/O/descendants. The runtime kills its child process group and discards late
broker completions, but cannot forcibly terminate arbitrary JavaScript callbacks in the host.
No private event, progress, stderr, transcript, exception, usage or provenance object is forwarded.
Provider thinking blocks stay inside the private child and are discarded; only final JSON text
from a completed answer reaches host projection. Thinking-only, malformed and truncated answers refuse.
Errors collapse to `unavailable`; success reconstructs `content` and `structuredContent` from
one authorized artifact, with empty `details`.

Limits default to one in-flight invocation, 32 total attempts per runtime, 30-second end-to-end
deadline, 12 model requests/turns and 16 tool calls per child, 64-KiB request bytes and 1-MiB
private output bytes. Per-instance overrides can only lower these. Request and streamed provider
response bytes are checked as well as IPC output. Empty exit-0 output, malformed/duplicate events,
non-stop assistant results, unknown tools, trailing bytes and oversized output refuse. No monetary
or OS-level CPU/memory cap is claimed.

## Projection and egress

`DisclosureBoundary.metadata` stores an immutable JSON payload with a trusted category/document.
`read` performs Cedar checks for the exact session. `answer` invokes trusted deterministic
`Projection.project` and `Projection.validate`, then an optional private `judge`. Only a strictly
true judge result can proceed; throw, rejection, cancellation or an unprojectable result refuses.
The judge receives a copy and cannot widen the retained output. A judge never overrides Cedar.
The domain adapter must verify derivation and permitted content: JSON shape validation alone
cannot establish that an arbitrary text summary is safe. No generic SQL redactor is advertised.

`createEgressTransport` supplies a fetch function intended to be installed at the pi provider
transport boundary. A **trusted host assembler** must call `permit(fullProviderBody, artifacts)`
after constructing the whole request from public-owned input/instructions/tools and authorized
artifacts. The function does not classify arbitrary bytes passed by that trusted assembler.
Never expose `permit` to a model or use an optional extension hook as the authority.

The fetch wrapper checks the exact serialized body, fixed endpoint/method, one-use permit,
current session and every referenced artifact immediately before network I/O. It uses fixed
credentials and refuses redirects. Hook-mutated requests, duplicate JSON keys and unadmitted
retry/compaction/resume requests cannot send; each new request needs a fresh host permit.
Invalidation aborts pending network I/O. Closing an instance is required to release listeners.

The limited TUI now uses a private host-owned `HybridPlanner` instance. The only input is plain
text or configured selection changes; it installs no extensions or discovery. Its pinned provider
serializer receives only the admitted public transcript, and every network request passes the
mandatory transport with retained artifact authority. Public API credentials and headers are bound
explicitly; SDK retries, compaction, imports and alternative transports are refused.

See [the launch contract](../../docs/spec/pi-hybrid.md) and the
[synthetic profile](../../examples/hybrid-chat/README.md) for the actual parser, config format,
commands and verification. Runtime modules are trusted host code and are never exposed as model
tools. Tests use both public provider APIs and the real pi-tui in a PTY. Real model/auth,
consumer data verification and independent review require their own acceptance evidence.

## Adversarial verification

The limited TUI shows short host references (`[1]`) for approved tool data. `/evidence`
lists the current epoch's retained results; `/evidence 1` shows the request, completion time,
approved result and effective policy context. Inspection is local and makes no model call.
It cannot reopen private SQL, hidden metadata or a consumer's private evidence ledger.
References validate tool data through the configured adapter and disclosure boundary, not the
model's interpretation. Completion time is not source freshness. `HybridPlanner.evidence()`
returns detached snapshots; `formatAnswer()` changes display only, leaving provider history
and `prompt()` text unchanged. Neither method is a model tool.

The ledger is bounded to 32 records / 2 MiB and clears on reset, settings changes, fatal errors
and close. Evicted or cleared references are unavailable and numbers are never reused within
one process. TUI rendering maps recognized evidence UUIDs to references and labels unknown or
ambiguous UUIDs/numeric references as unavailable; it does not establish claim-to-result
semantic correctness. See the launch contract for the exact lifecycle and limitations.

`npm test` includes a six-case provider/selection wire matrix, private errors, unknown aliases,
throwing/denying/timed-out judges, and approved values retained in subsequent requests.
The terminal test captures only synthetic output, rejects compaction/import/resume/export/shell
commands, checks filesystem inventories for unexpected persistence, exits with Ctrl+C during
an active request, and starts a fresh process beside a planted stale-session canary.
Disabled surfaces are tested for refusal; they are not supported operations.

`npm run test:mutations` builds the package and runs six deliberate enforcement mutations in
disposable copies: session-selection bypass, Cedar diagnostics ignored, answer validation
removed, raw private result released, endpoint check removed and one-use permits made replayable.
Every unmodified baseline must pass and every mutation must cause a test assertion failure;
syntax/import failures do not count. Original runtime source and build artifacts are preserved.
Run these tests serially with the normal suite because process cleanup checks share temporary
directory observations. CI runs the mutation gate after the normal suite.

## Private service IPC

The package also ships `warble-pi-service` (`dist/service.js`), a host-owned stdio
subprocess entry point. It is not an MCP server and must not be registered as a
model tool. A trusted host sends an `init` request with protocol
`warble-private-service/1`, compiled IR, entry component, private model binding,
read-only tool declarations and at least two intersected Cedar policies. The
handshake returns IR version `0.9` and service schema version `1`.

The service schema supports `invoke_component`, `invoke_tool`, `execute_query`,
`receive_metadata` and `receive_answer`. Principal attributes distinguish the
original caller, worker/planner role, project and zone. Resource attributes carry
the host-verified kind, name, query columns and answer recipient. Session/epoch
are host-owned context. The host must authorize at each actual access or egress;
an earlier tool-discovery decision is not a substitute. Rule use within an
allowed private task has no separate authorization action.

`authorize` returns a boolean. `invoke` starts a bounded private pi invocation,
with both root and declared leaf components in the private execution boundary.
`tool_call` events have an invocation owner and numbered callback ID; only the
matching `tool_result` is accepted. The host authorizes component delegation
before child execution. `cancel` aborts that invocation; matching late replies
are discarded, while unsolicited replies terminate the channel. EOF cancels
active invocations and the existing supervisor cleans up private child groups.
Unknown operations, versions, missing mappings or unsupported IR fail closed.

Supported IR remains intentionally bounded: read-only analytical skill
components, one unconditional model step per component, a root and leaf
children, no effects/params/typed context requirements. Components may read
context through declared tools; the service does not inject an application
workflow or infer behavior from component names. Limits: eight concurrent
invocations, a 90-second root deadline, 60-second leaf deadline and the existing
per-loop turn/tool/byte budgets. Result semantics and disclosure projection are
the application's responsibility; a private model result is not automatically
an approved answer.

Use the matching built package with a POSIX Node 22.19+ host. This local service
contract does not provide multi-user network authentication, persistent
sessions, or isolation against the same operating-system user.

Service invocation failures may include an allowlisted `diagnostic` code on the private
host IPC error envelope. The message stays `service_unavailable`; diagnostics never
contain model output, provider error bodies, SQL, or credentials. Supervisors preserve
child/delegation failure codes (for example `deadline`, `invalid_json`, `model_error`)
for operator audit. These codes are not a public disclosure contract. A host must keep
its public failure projection generic and treat policy denials separately.

For private service invocations, provider SSE transport has a separate 8-MiB aggregate
wire budget per child. SSE framing and private reasoning consume this transport budget,
not the unchanged 1-MiB child protocol/output budget. The 64-KiB request limit, bounded
turn/tool counts and 90-second invocation deadline still apply. A wire-budget error is
reported internally as `response_limit`, not an opaque provider error. Other runner
clients retain their existing wire budget unless explicitly configured by the host.

A trusted service model binding may opt into the boolean `enableThinking` field;
when present it is sent as `chat_template_kwargs.enable_thinking`. Omission preserves
provider defaults and compatibility with endpoints that do not support that control.
It does not change tool schemas, destination restrictions, budgets or disclosure.

Service children require an exact evidence object. If the final assistant message has
invalid JSON or the wrong shape, the runner allows one format-only correction with
agent tools disabled, within the original turn, byte and wall-clock budgets. It never
extracts a token from prose or accepts a token on trust: the application host must still
validate token membership in the current invocation ledger. A second malformed reply
fails closed. Generic hybrid callers retain their existing output contract.
