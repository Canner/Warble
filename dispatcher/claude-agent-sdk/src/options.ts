/**
 * IR enum → `query({options})` mapping — the core of this back-end, the TS analogue of the
 * file target's `emit.rs`. Keyed on the **three orthogonal IR enums** (`realization_kind`,
 * `effect.outcome.kind`, `trigger.kind`), never on a component's id/verb: adding another component
 * of an existing type changes 0 lines here. Enum values this target does not yet
 * realize fail loudly ("wall-hit"), mirroring `emit.rs::unsupported`.
 *
 * This module is pure/data: it builds the serializable `query()` options + a metadata report. The
 * live callbacks — `canUseTool` runtime enforcement — are attached by `run.ts` from `guardrails.ts`,
 * so the mapping stays testable offline.
 */
import type { AgentDefinition, Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";

import { DispatchError } from "./error.js";
import { distinctTiers, type ComponentNode, type Guardrail, type RenderBlock } from "./ir.js";
import { ModelConfig, type Provider } from "./models.js";
import type { ResolutionReport } from "./resolve.js";
import { planProviderRouting, type RoutingMode, type StagedStep } from "./route.js";
import { profileFor, type Criticality } from "./targets.js";

const PER_STEP_PROVIDER_CAPABILITY = "llm:per_step_provider";

// --- render flavor (docs/spec/ir-schema.md §v0.3 §4) --------------------------------------------

export type RenderFlavor = "programmatic" | "prompt";
export const DEFAULT_RENDER_FLAVOR: RenderFlavor = "programmatic";

export function parseRenderFlavor(value: string): RenderFlavor {
  if (value === "programmatic" || value === "prompt") return value;
  throw new DispatchError(
    `unknown --render-flavor '${value}' (expected: programmatic, prompt)`,
  );
}

// --- constants (mirrors emit.rs) ----------------------------------------------------------------

const PER_STEP_TIER_CAPABILITY = "llm:per_step_tier";
// Capabilities realized by the `wren` CLI — any of them grants the Bash tool. semantic_introspection
// (via `wren context show`) belongs here alongside sql_execution/genbi_build (mirrors emit.rs).
// +Constitutive: schema_introspection (proposing a context edit) is realized the same way, so it
// grants Bash too.
const DATA_ACCESS_CAPABILITIES = [
  "sql_execution:read_only",
  "genbi_build",
  "semantic_introspection",
  "schema_introspection",
  // +Setup (genbi-setup): source_connect/context_build are realized via Bash (the `wren` CLI plus,
  // under the setup_execution guardrail below, connector CLIs like `dlt`), so they grant Bash too.
  "source_connect",
  "context_build",
];
const READ_ONLY_GUARDRAIL_NAME = "read_only_execution";
const ARTIFACT_WRITE_GUARDRAIL_NAME = "artifact_write";
// The 5th enforcement point (genbi-setup): onboarding a NEW project has no pre-bound context to
// gate reads against, and its writes are project-scaffolding, not a render artifact or a gated MDL
// mutation — so it gets its own name-keyed guardrail rather than overloading read_only_execution or
// artifact_write. Matched by `.name` via `findGuardrail`, exactly like the other four.
const SETUP_GUARDRAIL_NAME = "setup_execution";
const RENDER_CONTRACT_CAPABILITY = "render_contract";
const DEFAULT_ARTIFACT_SCOPE = ".";
/** Bash rule patterns denied outright (defense in depth; canUseTool is the semantic gate). */
export const DESTRUCTIVE_BASH_DENY = ["Bash(rm:*)", "Bash(sudo:*)", "Bash(dd:*)"];
const DEFAULT_MAX_TURNS = 40;

function unsupported(field: string, value: string): DispatchError {
  return new DispatchError(
    `${field} '${value}' is not supported by the claude-agent-sdk:local target (wall-hit)`,
  );
}

// --- handler support checks (documented extension points; loud-fail today) ----------------------

/** `realization_kind`: `skill` (MVP) + `tool` (+Assertive; independently-invoked monitor) + `gated-tool`
 *  (+Mutating; a tool behind a hard approval gate — dry-run/blast-radius/human-approval/rollback). */
function realizationSupported(node: ComponentNode): boolean {
  return (
    node.realization_kind === "skill" ||
    node.realization_kind === "tool" ||
    node.realization_kind === "gated-tool"
  );
}

/** `trigger.kind`: `one_shot` (MVP) + `scheduled` (+Assertive; cadence borrowed from the runtime
 *  scheduler). `event` (activation by an inbound event) is not yet a realized handler and loud-fails
 *  here, even though the `event_bus` transport it would borrow is now realize-via. */
function triggerSupported(node: ComponentNode): boolean {
  return node.trigger.kind === "one_shot" || node.trigger.kind === "scheduled";
}

/** `effect.outcome.kind`: `none` (render-only, MVP) + `assertion` (+Assertive: read-only verdict +
 *  emitted signal) + `mutation` (+Mutating: gated dry-run/apply). `dispatch` still loud-fails
 *  (+Orchestrating). */
function outcomeSupported(node: ComponentNode): boolean {
  return (
    node.effect.outcome.kind === "none" ||
    node.effect.outcome.kind === "assertion" ||
    node.effect.outcome.kind === "mutation"
  );
}

/** Whether this component's outcome is an `assertion` — keyed on the outcome enum, never id/verb. */
function isAssertion(node: ComponentNode): boolean {
  return node.effect.outcome.kind === "assertion";
}

/** Whether this component's outcome is a `mutation` (+Mutating) — keyed on the outcome enum, never
 *  id/verb. */
export function isMutation(node: ComponentNode): boolean {
  return node.effect.outcome.kind === "mutation";
}

// --- helpers ------------------------------------------------------------------------------------

function hasDataAccess(caps: readonly string[]): boolean {
  return caps.some((c) => DATA_ACCESS_CAPABILITIES.includes(c));
}

function isReadOnly(guardrails: readonly Guardrail[]): boolean {
  return guardrails.some((g) => g.name === READ_ONLY_GUARDRAIL_NAME);
}

/** True when this component carries the `setup_execution` guardrail (genbi-setup's onboarding
 *  flavor) — matched by name, same as every other enforcement point. */
function isSetup(guardrails: readonly Guardrail[]): boolean {
  return guardrails.some((g) => g.name === SETUP_GUARDRAIL_NAME);
}

function findGuardrail(guardrails: readonly Guardrail[], name: string): Guardrail | undefined {
  return guardrails.find((g) => g.name === name);
}

/** The project root a setup component may write into (`Write`/`Edit` + broadened Bash), or `null`
 *  when the component does not declare `setup_execution`. Defaults to `.`, mirroring
 *  `DEFAULT_ARTIFACT_SCOPE`. */
function computeSetupScope(guardrails: readonly Guardrail[]): string | null {
  const g = findGuardrail(guardrails, SETUP_GUARDRAIL_NAME);
  if (!g) return null;
  return g.scope ?? DEFAULT_ARTIFACT_SCOPE;
}

/** Per-step-tier split: a skill whose steps span >1 tier. Realized in-loop via SDK `agents`. */
export function shouldSplitPerStepTier(node: ComponentNode): boolean {
  return (
    node.realization_kind === "skill" &&
    (node.required_capabilities.includes(PER_STEP_TIER_CAPABILITY) ||
      distinctTiers(node.llm_calls).length > 1) &&
    distinctTiers(node.llm_calls).length > 1
  );
}

// --- render gate --------------------------------------------------------------------------------

export type GateKind = "realize" | "degrade" | "none";

/**
 * How a RUNTIME render failure (`warble render` exiting non-zero, after the gate already resolved to
 * `realize`) should be handled — distinct from `GateKind`'s `"degrade"`, which is a DESIGN-TIME
 * capability degrade (no artifact-write surface at all, so no render is even attempted). Derived from
 * the resolved `render_contract` capability's criticality: `best-effort` → `"degrade"` (fall back to
 * the agent's own text, per the capability model's "best-effort may degrade" rule); `required` /
 * `safety-critical` → `"fail"` (never silently degrade).
 */
export type GateFailureMode = "degrade" | "fail";

export interface RenderGate {
  kind: GateKind;
  scope: string | null;
  flavor: RenderFlavor | null;
  /** Only meaningful when `kind === "realize"` (a runtime render call actually happens). Optional so
   *  the facet stays additive: a consumer that doesn't know about it sees `undefined` and must default
   *  to today's hard-fail behavior, never assume degrade. */
  onFailure?: GateFailureMode;
}

/** best-effort degrades on a runtime render failure; required/safety-critical never silently degrade. */
function onFailureFor(criticality: Criticality): GateFailureMode {
  return criticality === "best-effort" ? "degrade" : "fail";
}

/**
 * The render gate resolves to `realize` only when `render_contract` is `realize-via` on the target
 * AND an `artifact_write` guardrail is declared AND there are render blocks — same shape as the file
 * target. `structured_output_capture` is native here, so the requested flavor is honored as-is.
 */
function resolveRenderGate(
  node: ComponentNode,
  report: ResolutionReport,
  flavor: RenderFlavor,
): RenderGate {
  const artifactWrite = findGuardrail(node.guardrails, ARTIFACT_WRITE_GUARDRAIL_NAME);
  if (!artifactWrite || node.effect.render_blocks.length === 0) {
    return { kind: "none", scope: null, flavor: null };
  }
  const renderEntry = report.find((r) => r.capability === RENDER_CONTRACT_CAPABILITY);
  switch (renderEntry?.outcome) {
    case "realize-via":
      return {
        kind: "realize",
        scope: artifactWrite.scope ?? DEFAULT_ARTIFACT_SCOPE,
        flavor,
        onFailure: onFailureFor(renderEntry.criticality),
      };
    case "degrade":
      return { kind: "degrade", scope: null, flavor: null };
    default:
      return { kind: "none", scope: null, flavor: null };
  }
}

/** Only the prompt flavor needs the agent to write the file itself; programmatic keeps it read-only. */
function gateGrantsWrite(gate: RenderGate): boolean {
  return gate.kind === "realize" && gate.flavor === "prompt";
}

// --- tools --------------------------------------------------------------------------------------

export interface ToolPlan {
  /** Base built-in tool set made available to the agent (`tools` option). */
  tools: string[];
  /** Auto-allowed without a permission check. */
  allowedTools: string[];
  /** Hard-removed (defense in depth). */
  disallowedTools: string[];
}

/**
 * Read-only enforcement, layer 1 (static). `Read` is auto-allowed; `Bash` is available but NOT
 * auto-allowed, so every bash call is routed to `canUseTool` (layer 2, guardrails.ts) for a semantic
 * decision — the file target's allow/deny *strings* can't do that. `Write`/`Edit` are excluded from
 * the base set entirely on the read-only path.
 */
function buildTools(node: ComponentNode, gate: RenderGate): ToolPlan {
  const dataAccess = hasDataAccess(node.required_capabilities);
  const readOnly = isReadOnly(node.guardrails);
  const setup = isSetup(node.guardrails);
  const grantsWrite = gateGrantsWrite(gate);
  const mutating = !readOnly;

  const tools = ["Read"];
  if (dataAccess) tools.push("Bash");
  if (mutating) tools.push("Edit");
  if (mutating || grantsWrite) tools.push("Write");

  const allowedTools = ["Read"];
  // Setup components are not read-only (they scaffold a project), so the destructive/redirection
  // Bash denylist would otherwise be dropped along with the read-only floor — keep it explicitly:
  // setup broadens Bash beyond `wren` (canUseTool, guardrails.ts) but never past this denylist.
  const disallowedTools = readOnly || setup ? [...DESTRUCTIVE_BASH_DENY] : [];

  return { tools, allowedTools, disallowedTools };
}

// --- render section text (ports emit.rs) --------------------------------------------------------

const ENVELOPE_EXAMPLE = `\`\`\`json
{
  "blocks": [
    { "type": "kpi_card", "label": "Total revenue", "value": 1672.4, "unit": "USD" },
    { "type": "table", "columns": ["status", "orders"], "rows": [["completed", 67], ["shipped", 32]] },
    { "type": "chart", "chart_type": "bar", "x": "status", "series": ["orders"],
      "rows": [["completed", 67], ["shipped", 32]] },
    { "type": "definition", "sql": "SELECT status, count(*) AS orders FROM orders GROUP BY status",
      "source_tables": ["orders"], "filters": [] }
  ],
  "verified": true,
  "summary": "One or two sentences of prose (optional)."
}
\`\`\``;

/**
 * Shared verify + definition contract text (G2 hard line + G3 shallow card) — the exact-word twin of
 * `emit.rs::VERIFY_DEFINITION_CONTRACT`, so both back-ends instruct the agent identically and the one
 * reference renderer (`warble render`) turns the same envelope into identical bytes.
 */
const VERIFY_DEFINITION_CONTRACT =
  "Before you answer you MUST verify (per-answer verify, required): actually execute the query " +
  "through `wren`, then validate the result set is legitimate (non-empty where a value is expected, " +
  "types/units sane, grain matches the question). If it is not, repair the query and re-run; if it " +
  "still cannot be validated, REFUSE — say so plainly and do not fabricate a number. Set the " +
  'envelope\'s top-level `"verified": true` ONLY when a query ran and its result set passed ' +
  "validation. Always include one `definition` block — the shallow \"how this was computed\" card: " +
  "the exact `sql` you ran, the `source_tables` it read, and the `filters` you applied. This is " +
  "run-level provenance only; do not invent unit/owner/formal-metric lineage (that is Phase 2).";

function formatRenderBlock(block: RenderBlock): string {
  const fields = Object.entries(block.fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  return `- \`${block.type}\`: { ${fields} }`;
}

function buildProgrammaticRenderSection(node: ComponentNode): string {
  return [
    "## Render output",
    "",
    "Block contract (produce data matching these shapes, not prose):",
    "",
    ...node.effect.render_blocks.map(formatRenderBlock),
    "",
    "Do NOT write any files and do NOT format the answer as prose or markdown. After gathering the " +
      "data via `wren`, your FINAL message must be a SINGLE JSON object — the render envelope — and " +
      "nothing else: a `blocks` array of instances conforming to the contract above, plus an " +
      "optional `summary` string. A downstream renderer turns this envelope into the dashboard " +
      "deterministically; you stay read-only.",
    "",
    VERIFY_DEFINITION_CONTRACT,
    "",
    "Envelope shape:",
    "",
    ENVELOPE_EXAMPLE,
  ].join("\n");
}

function buildPromptRenderSection(node: ComponentNode, gate: RenderGate): string {
  const scope = gate.scope ?? DEFAULT_ARTIFACT_SCOPE;
  return [
    "## Render output",
    "",
    "Block contract (produce data matching these shapes, not prose):",
    "",
    ...node.effect.render_blocks.map(formatRenderBlock),
    "",
    `After gathering the data via \`wren\`, write a SINGLE self-contained \`dashboard.html\` file ` +
      `into the artifact-write scope directory (\`${scope}\`), rendering the blocks above: KPI ` +
      `cards, an HTML table, and a simple chart (inline SVG or a CDN-loaded chart library — no ` +
      `build step). Also render a \`✓ Verified\` pill next to the title and a "how this was ` +
      `computed" definition panel (the SQL you ran, source tables, filters). End your reply ` +
      `stating the path of the file you wrote.`,
    "",
    VERIFY_DEFINITION_CONTRACT,
  ].join("\n");
}

function buildRenderSection(node: ComponentNode, gate: RenderGate): string | null {
  switch (gate.kind) {
    case "realize":
      return gate.flavor === "prompt"
        ? buildPromptRenderSection(node, gate)
        : buildProgrammaticRenderSection(node);
    case "degrade":
      return [
        "## Render output",
        "",
        "This target has no artifact-write surface for render output: render the results as a " +
          "markdown table plus a short prose summary instead. Do not write any files.",
      ].join("\n");
    case "none":
      return null;
  }
}

// --- assertion outcome section (+Assertive) — the TS twin of emit.rs::build_assertion_section ----

const VERDICT_ENVELOPE_EXAMPLE = `\`\`\`json
{
  "blocks": [
    { "type": "status", "state": "stale", "label": "orders freshness",
      "detail": "max(order_date) is 51h old; expected within 24h", "severity": "critical" }
  ],
  "verdict": { "type": "freshness_verdict", "fresh": false, "observed_lag_hours": 51, "expected_cadence": "24h" },
  "emitted": ["freshness_breach"],
  "verified": true
}
\`\`\``;

/**
 * The assertion output contract (+Assertive) — structural twin of the programmatic render section.
 * The agent stays fully read-only and emits a single `{ blocks, verdict, emitted }` envelope; the
 * dispatcher's `warble render` turns the `status` block into HTML. The core assert is deterministic
 * SQL (`max(timestamp)` vs cadence); the LLM only classifies severity when stale (`assess_severity`,
 * conditional). `verdict_type`/`emits` come straight from `effect.outcome` — the assertion arm the IR
 * spine already carries.
 */
function buildAssertionSection(node: ComponentNode): string {
  const outcome = node.effect.outcome;
  const verdictType = outcome.verdict_type ?? "verdict";
  const emits = outcome.emits ?? [];
  const actions =
    node.borrowed_actions.length > 0
      ? node.borrowed_actions.map((a) => `\`${a}\``).join(", ")
      : "a runtime notify channel";
  const emitsLine =
    emits.length === 0
      ? "This assertion emits no signals."
      : `On breach, list the emitted signal name(s) in the envelope's \`emitted\` array: ` +
        `[${emits.map((e) => `\`${e}\``).join(", ")}]. The runtime routes those signals to the ` +
        `borrowed on-breach actions (${actions}) over the notify channel — Warble declares the ` +
        `wiring (signal ↔ action); the transport (Slack / Jira / MCP) is borrowed, not owned by ` +
        `this agent.`;

  return [
    "## Assertion output",
    "",
    `This is an **assertive** component (outcome: assertion, verdict_type \`${verdictType}\`). Its ` +
      `core is a DETERMINISTIC check, not a judgment call: run the freshness assert through \`wren\` ` +
      `— \`SELECT max(<timestamp column>)\` on the bound model — and compare the observed lag ` +
      `against the expected cadence (\`expected_cadence\` param, or the MDL's declared cadence). ` +
      `Fresh iff the newest row is within the cadence; stale otherwise. Do NOT ask an LLM to decide ` +
      `fresh-vs-stale — that is a SQL comparison and must be reproducible.`,
    "",
    "Only when the data is STALE do you use judgment, via the `assess_severity` step, to classify " +
      "how bad it is (e.g. warn vs critical) from the lag magnitude and history. When fresh, there " +
      "is no severity to assess.",
    "",
    "Verdict block contract (produce data matching these shapes, not prose):",
    "",
    ...node.effect.render_blocks.map(formatRenderBlock),
    "",
    "Stay strictly read-only: only `SELECT` through `wren`, never write to the warehouse and never " +
      "write any files. Your FINAL message MUST be a SINGLE JSON object — the verdict envelope — and " +
      "nothing else: a `blocks` array (the `status` block above), a `verdict` object " +
      '(`{ type, fresh, ... }`), and, on breach, an `emitted` array. A downstream renderer turns the ' +
      '`status` block into HTML deterministically; you stay read-only. Set the top-level ' +
      '`"verified": true` only when the assert query actually ran and its result was validated.',
    "",
    emitsLine,
    "",
    "Envelope shape:",
    "",
    VERDICT_ENVELOPE_EXAMPLE,
  ].join("\n");
}

// --- mutation outcome section (+Mutating) — the TS twin of buildAssertionSection ----------------

const MUTATION_DIFF_ENVELOPE_EXAMPLE = `\`\`\`json
{
  "blocks": [
    { "type": "diff", "target": "models/orders.yml", "change_type": "update",
      "diff": "--- a/models/orders.yml\\n+++ b/models/orders.yml\\n@@ -3,1 +3,1 @@\\n- grain: order_id\\n+ grain: order_id, order_date" }
  ],
  "blast_radius": { "downstream_nodes": ["metric:total_revenue"], "protected_hit": false },
  "applied": false,
  "verified": true
}
\`\`\``;

// +Constitutive: same envelope shape as the data-mutation twin above, minus the `blast_radius` field
// — a context-write is gated by scope authorization, not a downstream-lineage impact computation.
const CONTEXT_MUTATION_DIFF_ENVELOPE_EXAMPLE = `\`\`\`json
{
  "blocks": [
    { "type": "diff", "target": "models/orders.yml", "change_type": "mdl_bootstrap",
      "diff": "--- a/models/orders.yml\\n+++ b/models/orders.yml\\n@@ -3,1 +3,1 @@\\n- grain: order_id\\n+ grain: order_id, order_date" }
  ],
  "applied": false,
  "verified": true
}
\`\`\``;

/**
 * +Constitutive twin of {@link buildMutationSection} for `outcome.target === "context"`. Reuses the
 * same two-phase gated-tool lifecycle (never a new outcome/trigger/realization arm); phase 2 is a
 * scoped context-write authorization gate (guardrail `context_write_authz`) instead of a blast-radius
 * computation — the write must resolve to a path inside the guardrail's `scope`, or it is denied
 * outright, regardless of how small the change is. This function must never mention the word "blast"
 * — even a negation/contrast ("not a blast-radius computation") still contains the literal substring,
 * which back-end tests treat as leaking the wrong gate into the wrong scope.
 */
function buildContextMutationSection(node: ComponentNode): string {
  const outcome = node.effect.outcome;
  const target = outcome.target ?? "the bound node";
  const changeType = outcome.change_type ?? "update";
  const contextGuardrail = findGuardrail(node.guardrails, "context_write_authz");
  const scope = contextGuardrail?.scope ?? DEFAULT_ARTIFACT_SCOPE;

  return [
    "## Mutation output",
    "",
    `This is a **constitutive** component (outcome: mutation, target \`${target}\`, change_type ` +
      `\`${changeType}\`). It runs the same two-phase gated lifecycle as any mutating component, ` +
      "never a direct write:",
    "",
    "1. **Dry-run first (must_dry_run).** Propose the edit as a DIFF only — do not apply it. Your " +
      "first-phase FINAL message must be a single JSON envelope carrying a `diff` block (the exact " +
      "unified diff you intend to apply) and `\"applied\": false`. Never write to the target file " +
      "in this phase.",
    "",
    `2. **Context-write gate (context_write_authz, locked, scope \`${scope}\`).** This is a scoped ` +
      "PATH-AUTHORIZATION check, NOT a downstream-lineage impact computation — the proposed write " +
      `must resolve to a path inside the \`${scope}\` scope (the models/metrics/knowledge structure ` +
      "this component owns) or it is denied outright. Writing outside this scope is never permitted, " +
      "however small the change.",
    "",
    "3. **Human approval (human_approval, locked).** Applying the diff is gated on explicit approval " +
      "delivered over the runtime's approval channel. On a target with no human/approval channel " +
      "wired, this component cannot run past the dry-run phase — that is the honest capability edge, " +
      "not a bug to route around.",
    "",
    "4. **Apply + rollback (rollback_available).** Only apply after approval clears. A git " +
      "checkpoint is taken first so the apply can be rolled back; rollback is BORROWED from version " +
      "control, not owned by this agent. After applying, set `\"applied\": true` in your final " +
      "envelope.",
    "",
    "Diff block contract (produce data matching this shape, not prose):",
    "",
    ...node.effect.render_blocks.map(formatRenderBlock),
    "",
    "Your FINAL message at each phase MUST be a SINGLE JSON object — the mutation envelope — and " +
      "nothing else: a `blocks` array (the `diff` block above) and \"applied\" (`false` on the " +
      "dry-run, `true` only after a real apply). Set the top-level \"verified\": true only when the " +
      "diff was actually computed against the live target (never fabricated).",
    "",
    "Envelope shape:",
    "",
    CONTEXT_MUTATION_DIFF_ENVELOPE_EXAMPLE,
  ].join("\n");
}

/**
 * The mutation outcome contract (+Mutating) — structural twin of {@link buildAssertionSection}. A
 * gated-tool component's lifecycle is two-phase: PROPOSE a diff, then (only after the runtime's
 * approval gate clears) APPLY it. `target`/`change_type` come straight from `effect.outcome` — the
 * mutation arm the IR spine already carries. The guardrails named below (`must_dry_run`,
 * `blast_radius_limit`, `human_approval`, `rollback_available`) are keyed on guardrail *name*, never
 * on this component's id/verb.
 *
 * +Constitutive reuses this SAME function/arm: `outcome.target === "context"` early-returns to
 * {@link buildContextMutationSection}, which swaps phase 2 (blast-radius gate) for a scoped
 * context-write authorization gate. Every other target value (a data path, or none) keeps the
 * blast-radius lifecycle below unchanged.
 */
export function buildMutationSection(node: ComponentNode): string {
  const outcome = node.effect.outcome;
  if (outcome.target === "context") {
    return buildContextMutationSection(node);
  }
  const target = outcome.target ?? "the bound node";
  const changeType = outcome.change_type ?? "update";

  return [
    "## Mutation output",
    "",
    `This is a **mutating** component (outcome: mutation, target \`${target}\`, change_type ` +
      `\`${changeType}\`). It runs a two-phase gated lifecycle, never a direct write:`,
    "",
    "1. **Dry-run first (must_dry_run).** Propose the edit as a DIFF only — do not apply it. Your " +
      "first-phase FINAL message must be a single JSON envelope carrying a `diff` block (the exact " +
      "unified diff you intend to apply) and `\"applied\": false`. Never write to the target file " +
      "or the warehouse in this phase.",
    "",
    "2. **Blast-radius gate (blast_radius_limit).** The downstream impact of the edited node is " +
      "computed from Warble's `blast_radius` over the MDL lineage graph, not by you. An empty " +
      "radius auto-allows; exceeding the guardrail's threshold escalates to human approval; " +
      "touching a protected asset blocks outright. Report the affected downstream nodes you are " +
      "aware of in the envelope's `blast_radius` field, but the gate decision itself is made by the " +
      "runtime, not by your judgment.",
    "",
    "3. **Human approval (human_approval, locked).** Applying the diff is gated on explicit approval " +
      "delivered over the runtime's approval channel. On a target with no human/approval channel " +
      "wired, this component cannot run past the dry-run phase — that is the honest capability edge, " +
      "not a bug to route around.",
    "",
    "4. **Apply + rollback (rollback_available).** Only apply after approval clears. A git " +
      "checkpoint is taken first so the apply can be rolled back; rollback is BORROWED from version " +
      "control, not owned by this agent. After applying, set `\"applied\": true` in your final " +
      "envelope.",
    "",
    "Diff block contract (produce data matching this shape, not prose):",
    "",
    ...node.effect.render_blocks.map(formatRenderBlock),
    "",
    "Your FINAL message at each phase MUST be a SINGLE JSON object — the mutation envelope — and " +
      "nothing else: a `blocks` array (the `diff` block above), a `blast_radius` object, and " +
      '`"applied"` (`false` on the dry-run, `true` only after a real apply). Set the top-level ' +
      '`"verified": true` only when the diff was actually computed against the live target (never ' +
      "fabricated).",
    "",
    "Envelope shape:",
    "",
    MUTATION_DIFF_ENVELOPE_EXAMPLE,
  ].join("\n");
}

function buildPreamble(cwd: string): string {
  return [
    `You are bound to the wren project at \`${cwd}\` (your working directory).`,
    "All data access MUST go through the `wren` CLI (e.g. `wren --sql ...`, `wren cube list`, " +
      "`wren genbi build ...`) — never raw SQL clients, never filesystem tricks against the " +
      "underlying warehouse.",
  ].join("\n");
}

// --- per-step-tier split (in-loop via `agents`) --------------------------------------------------

/** The SDK's `agents[].model` is a restricted alias union; narrow a resolved model onto it. */
function toAgentModel(model: string): "sonnet" | "opus" | "haiku" | "inherit" {
  if (model === "sonnet" || model === "opus" || model === "haiku" || model === "inherit") {
    return model;
  }
  throw new DispatchError(
    `per-step-tier realization on claude-agent-sdk:local requires each tier's model to be one of ` +
      `sonnet|opus|haiku|inherit (SDK agents[].model is a restricted alias union), but got '${model}'. ` +
      `Use those aliases in --models-config, or the single-tier collapse path.`,
  );
}

function subagentName(verb: string, callName: string): string {
  return `${verb}__${callName}`;
}

function buildDriverBody(node: ComponentNode): string {
  const producers = new Map<string, string>();
  for (const call of node.llm_calls) {
    if (call.produces) producers.set(call.produces, call.name);
  }
  const steps = node.llm_calls.map((call, i) => {
    const parts = [
      `Run the \`${subagentName(node.verb, call.name)}\` subagent (step \`${call.name}\`) via the Task tool.`,
    ];
    if (call.consumes.length > 0) {
      const sources = call.consumes
        .map((slot) => {
          const producer = producers.get(slot);
          return producer ? `\`${slot}\` (the \`${producer}\` subagent's output)` : `\`${slot}\``;
        })
        .join(", ");
      parts.push(`Pass it ${sources} as input.`);
    }
    if (call.produces) parts.push(`Take its output as \`${call.produces}\` for the steps after it.`);
    return `${i + 1}. ${parts.join(" ")}`;
  });

  return [
    `You orchestrate the \`${node.verb}\` steps by delegating each one to its dedicated subagent via ` +
      `the Task tool, in order. Do not perform a step's work yourself — each step's tier-appropriate ` +
      `subagent does it.`,
    "",
    "Steps, in order:",
    "",
    ...steps,
    "",
    "Marshal each subagent's declared output into the next subagent's declared input exactly as " +
      "named above; do not invent or rename slots.",
  ].join("\n");
}

function buildAgents(
  node: ComponentNode,
  gate: RenderGate,
  models: ModelConfig,
): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {};
  // Subagents get the per-component read-only data tools (Read + Bash gated), never Write.
  const noGate: RenderGate = { kind: "none", scope: null, flavor: null };
  const subTools = buildTools(node, noGate);
  for (const call of node.llm_calls) {
    const ioNote = `\n\n(consumes [${call.consumes.join(", ")}] / produces ${call.produces ?? "(none)"})`;
    const prompt = node.brief ? `${node.brief}\n\n${call.prompt}` : call.prompt;
    agents[subagentName(node.verb, call.name)] = {
      description: `'${call.name}' step of ${node.verb} (tier: ${call.tier}).`,
      prompt: prompt + ioNote,
      tools: subTools.tools,
      model: toAgentModel(models.require(call.tier)),
    };
  }
  return agents;
}

// --- the dispatch plan --------------------------------------------------------------------------

export interface DispatchMeta {
  verb: string;
  target: string;
  readOnly: boolean;
  split: boolean;
  render: RenderGate;
  /** True when the outcome is an `assertion`: the final message is a verdict envelope (status block). */
  assertion: boolean;
  /** True when the outcome is a `mutation`: the final message is a diff/apply envelope (gated). */
  mutation: boolean;
  model: string;
  /** Subagent tier→model, present only on the split path. */
  subagentModels: Record<string, string>;
  tierCollapseNote: string | null;
  /** How the steps are realized (hybrid-LLM spike): single | sdk-split | hybrid-staged. */
  mode: RoutingMode;
  /** Distinct providers across the steps (order-preserving). `["anthropic"]` on the existing paths. */
  providers: Provider[];
  /** Per-step resolved bindings — populated on the `hybrid-staged` path (empty otherwise), so run.ts
   *  can drive each step on its own provider and marshal `produces`→`consumes`. */
  stagedSteps: StagedStep[];
  /** The project root a `setup_execution` component may write into (genbi-setup's onboarding
   *  flavor), or `null` for every other component. Threaded to `makeReadOnlyGuard` so Bash broadens
   *  beyond `wren` and Write/Edit are scoped to this root, instead of denied outright. `null` on the
   *  hybrid-staged path (out of scope — see buildHybridStagedPlan). */
  setupScope: string | null;
}

export interface DispatchPlan {
  /** The user question (assembled prompt for `query()`). */
  prompt: string;
  /** Serializable `query()` options (canUseTool is attached later by run.ts). */
  options: Options;
  meta: DispatchMeta;
}

export interface BuildConfig {
  target: string;
  flavor: RenderFlavor;
  models: ModelConfig;
  question: string;
  /** Absolute path to the bound wren project (resolved by the CLI). */
  cwd: string;
  maxTurns?: number;
}

/** Note recorded when >1 tier collapses onto a single model (only on the non-split path). */
function tierCollapseNote(node: ComponentNode, model: string): string | null {
  const tiers = distinctTiers(node.llm_calls);
  if (tiers.length <= 1) return null;
  const steps = node.llm_calls.map((c) => `${c.name}=${c.tier}`).join(", ");
  return `per-step tiers [${steps}] collapsed to single model '${model}'`;
}

/**
 * Build the `query({options})` for one resolved IR node. Loud-fails on any unsupported enum value
 * before producing anything (wall-hit), mirroring `emit.rs`.
 */
export function buildDispatchPlan(
  node: ComponentNode,
  report: ResolutionReport,
  cfg: BuildConfig,
): DispatchPlan {
  if (!realizationSupported(node)) {
    throw unsupported("realization_kind", node.realization_kind);
  }
  if (!triggerSupported(node)) {
    throw unsupported("trigger.kind", node.trigger.kind);
  }
  if (!outcomeSupported(node)) {
    throw unsupported("outcome.kind", node.effect.outcome.kind);
  }

  const gate = resolveRenderGate(node, report, cfg.flavor);
  const readOnly = isReadOnly(node.guardrails);
  const setupScope = computeSetupScope(node.guardrails);
  const permissionMode: PermissionMode = "default";
  const maxTurns = cfg.maxTurns ?? DEFAULT_MAX_TURNS;
  const renderSection = buildRenderSection(node, gate);
  const assertionSection = isAssertion(node) ? buildAssertionSection(node) : null;
  const mutationSection = isMutation(node) ? buildMutationSection(node) : null;
  const split = shouldSplitPerStepTier(node);
  // Per-step provider routing: the anthropic split decision above only applies when
  // every step's provider is anthropic; a non-anthropic binding forces the hybrid-staged path.
  const routing = planProviderRouting(node, cfg.models, split);

  const base: Options = {
    cwd: cfg.cwd,
    permissionMode,
    maxTurns,
    // SDK isolation: do NOT load ambient ~/.claude or project .claude settings, so nothing outside
    // this plan can widen the tool allowlist. wren strict_mode is read by the wren CLI itself.
    // (settingSources omitted == isolation mode.)
  };

  if (routing.mode === "hybrid-staged") {
    return buildHybridStagedPlan(node, gate, cfg, base, readOnly, routing.providers, routing.steps);
  }

  if (split) {
    // Per-step tier realized IN-LOOP: a driver delegates to one tier-bound subagent per step via the
    // Task tool. `llm:per_step_tier` = native on this target (no static files).
    //
    // The SDK CLAMPS each subagent's `agents[].tools` to the tools enabled at the PARENT session
    // level (`tools` below) — a subagent can never receive a tool its parent session doesn't have,
    // regardless of what `buildAgents` declares for it. So for a data-access component, Bash MUST be
    // enabled here or the Task subagents can never run `wren` (found via a parity spike, 2026-07-15).
    // Delegation is enforced by the driver PROMPT (`buildDriverBody`, "do not perform a step's work
    // yourself") plus the `canUseTool` semantic gate (guardrails.ts) — NOT by withholding the tool:
    // `allowedTools` below deliberately excludes Bash, so every call still routes through that gate.
    const agents = buildAgents(node, gate, cfg.models);
    const driverTools = hasDataAccess(node.required_capabilities)
      ? ["Task", "Read", "Bash"]
      : ["Task", "Read"];
    if (gateGrantsWrite(gate)) driverTools.push("Write");

    const driverPrompt = [
      buildPreamble(cfg.cwd),
      "",
      ...(node.brief ? [node.brief, ""] : []),
      buildDriverBody(node),
      ...(renderSection
        ? [
            "",
            "You collect the subagents' output and produce the render output yourself " +
              "(the subagents never do).",
            "",
            renderSection,
          ]
        : [
            "",
            // No render section (e.g. answer_query): the final step already produced the user-facing
            // structured answer — including its `verified` facet and shallow `definition` (G2/G3).
            // Pass it through verbatim; do NOT re-prose or drop those fields, or the ✓ Verified cue
            // and definition card are lost on the way out.
            "Your FINAL message MUST be the terminal step's structured output verbatim — a single " +
              "JSON object with its `columns`/`rows` (or refusal) plus the `verified` boolean and " +
              "the shallow `definition` it emitted. Do not summarize it into prose or drop any field.",
          ]),
      ...(assertionSection ? ["", assertionSection] : []),
      ...(mutationSection ? ["", mutationSection] : []),
    ].join("\n");

    const subagentModels: Record<string, string> = {};
    for (const call of node.llm_calls) {
      subagentModels[subagentName(node.verb, call.name)] = cfg.models.require(call.tier);
    }

    const options: Options = {
      ...base,
      model: cfg.models.orchestrator(),
      systemPrompt: driverPrompt,
      agents,
      tools: driverTools,
      allowedTools: ["Read", "Task"],
      disallowedTools: readOnly ? [...DESTRUCTIVE_BASH_DENY] : [],
    };

    return {
      prompt: cfg.question,
      options,
      meta: {
        verb: node.verb,
        target: cfg.target,
        readOnly,
        split: true,
        render: gate,
        assertion: isAssertion(node),
        mutation: isMutation(node),
        model: cfg.models.orchestrator(),
        subagentModels,
        tierCollapseNote: null,
        mode: "sdk-split",
        providers: ["anthropic"],
        stagedSteps: [],
        setupScope,
      },
    };
  }

  // Single-tier (collapse) path: one model, no subagents.
  const model = cfg.models.collapsedModel(node.llm_calls);
  const toolPlan = buildTools(node, gate);
  const systemPrompt = [
    buildPreamble(cfg.cwd),
    "",
    ...(node.brief ? [node.brief, ""] : []),
    node.prompt_fragment,
    ...(renderSection ? ["", renderSection] : []),
    ...(assertionSection ? ["", assertionSection] : []),
    ...(mutationSection ? ["", mutationSection] : []),
  ].join("\n");

  const options: Options = {
    ...base,
    model,
    systemPrompt,
    tools: toolPlan.tools,
    allowedTools: toolPlan.allowedTools,
    disallowedTools: toolPlan.disallowedTools,
  };

  return {
    prompt: cfg.question,
    options,
    meta: {
      verb: node.verb,
      target: cfg.target,
      readOnly,
      split: false,
      render: gate,
      assertion: isAssertion(node),
      mutation: isMutation(node),
      model,
      subagentModels: {},
      tierCollapseNote: tierCollapseNote(node, model),
      mode: "single",
      providers: ["anthropic"],
      stagedSteps: [],
      setupScope,
    },
  };
}

/**
 * Build the plan for the `hybrid-staged` path: ≥1 step binds to a non-Anthropic provider, so the
 * back-end drives the steps itself (run.ts) rather than a single `query()` — one isolated invocation per
 * step on its own provider, marshaling `produces`→`consumes`. We therefore build NO SDK `agents` (which
 * would loud-fail on a local model id via `toAgentModel`); the per-step bindings live in `meta.stagedSteps`.
 *
 * `options` carries the shared read-only data tool plan (cloud steps run with Read + gated Bash(wren);
 * local steps ignore tools) plus cwd/isolation, so run.ts can assemble each step's `query()`/local call.
 * Render is out of POC scope on this path: `answer_query` (the demo) is render-none and the terminal
 * step's structured output passes through; a realize/degrade render under hybrid loud-fails (documented
 * wall-hit) rather than silently dropping the dashboard.
 */
function buildHybridStagedPlan(
  node: ComponentNode,
  gate: RenderGate,
  cfg: BuildConfig,
  base: Options,
  readOnly: boolean,
  providers: Provider[],
  steps: StagedStep[],
): DispatchPlan {
  // Binding-time hybrid gate (llm:per_step_provider): a non-Anthropic provider in the binding is what
  // triggers this path, so the requirement is checked here (binding known), not as an IR-static
  // capability. Loud-fail if the target's profile does not realize it.
  const perStepProvider = profileFor(cfg.target)?.[PER_STEP_PROVIDER_CAPABILITY];
  if (!perStepProvider || perStepProvider.outcome === "fail") {
    throw new DispatchError(
      `${PER_STEP_PROVIDER_CAPABILITY}: fail on ${cfg.target} — the binding routes a step to a ` +
        `non-Anthropic provider (${providers.filter((p) => p !== "anthropic").join(", ")}), but this ` +
        `target does not support per-step provider routing (hybrid). Use an all-cloud binding, or a ` +
        `target that realizes ${PER_STEP_PROVIDER_CAPABILITY}.`,
    );
  }
  if (gate.kind !== "none") {
    throw new DispatchError(
      `hybrid-staged provider routing does not yet realize a '${gate.kind}' render gate on ` +
        `${cfg.target} (wall-hit); the POC covers render-none components like answer_query. ` +
        `Bind this component all-cloud, or extend the staged executor's render handling.`,
    );
  }
  const toolPlan = buildTools(node, gate);
  // Driver model for the hybrid-tool realization (WARBLE_HYBRID_MODE=tool): the orchestrator tier if
  // defined, else the strongest step's model. Unused by the default staged executor (kept harmless).
  let driverModel: string;
  try {
    driverModel = cfg.models.orchestrator();
  } catch {
    driverModel = cfg.models.collapsedModel(node.llm_calls);
  }
  const options: Options = {
    ...base,
    model: driverModel,
    tools: toolPlan.tools,
    allowedTools: toolPlan.allowedTools,
    disallowedTools: toolPlan.disallowedTools,
  };
  return {
    // The staged executor assembles each step's prompt from `meta.stagedSteps`; the top-level prompt is
    // the raw question (marshaled per step by run.ts).
    prompt: cfg.question,
    options,
    meta: {
      verb: node.verb,
      target: cfg.target,
      readOnly,
      assertion: isAssertion(node),
      mutation: isMutation(node),
      split: false,
      render: gate,
      model: `hybrid-staged(${providers.join("+")})`,
      subagentModels: {},
      tierCollapseNote: null,
      mode: "hybrid-staged",
      providers,
      stagedSteps: steps,
      // Hybrid+setup is out of scope (locked decision): a setup component's steps are not staged
      // across providers, so this path never sees setup_execution in practice; null is the safe,
      // explicit default rather than silently inheriting a scope this path doesn't enforce.
      setupScope: null,
    },
  };
}
