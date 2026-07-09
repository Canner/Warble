/**
 * IR enum → `query({options})` mapping — the core of this back-end (plan §5), the TS analogue of the
 * file target's `emit.rs`. Keyed on the **three orthogonal IR enums** (`realization_kind`,
 * `effect.outcome.kind`, `trigger.kind`), never on a component's id/verb: adding another component
 * of an existing type changes 0 lines here (impl-notes §5.1). Enum values this target does not yet
 * realize fail loudly ("wall-hit"), mirroring `emit.rs::unsupported`.
 *
 * This module is pure/data: it builds the serializable `query()` options + a metadata report. The
 * live callbacks — `canUseTool` runtime enforcement — are attached by `run.ts` from `guardrails.ts`,
 * so the mapping stays testable offline.
 */
import type { AgentDefinition, Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";

import { DispatchError } from "./error.js";
import { distinctTiers, type ComponentNode, type Guardrail, type RenderBlock } from "./ir.js";
import { ModelConfig } from "./models.js";
import type { ResolutionReport } from "./resolve.js";

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
const DATA_ACCESS_CAPABILITIES = ["sql_execution:read_only", "genbi_build"];
const READ_ONLY_GUARDRAIL_NAME = "read_only_execution";
const ARTIFACT_WRITE_GUARDRAIL_NAME = "artifact_write";
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

/** `realization_kind`: only `skill` in MVP. `tool`/`gated-tool` = +1 handler each when built. */
function realizationSupported(node: ComponentNode): boolean {
  return node.realization_kind === "skill";
}

/** `trigger.kind`: only `one_shot`. `scheduled`/`event` also loud-fail at capability resolution. */
function triggerSupported(node: ComponentNode): boolean {
  return node.trigger.kind === "one_shot";
}

/** `effect.outcome.kind`: only `none` (render-only) in MVP. */
function outcomeSupported(node: ComponentNode): boolean {
  return node.effect.outcome.kind === "none";
}

// --- helpers ------------------------------------------------------------------------------------

function hasDataAccess(caps: readonly string[]): boolean {
  return caps.some((c) => DATA_ACCESS_CAPABILITIES.includes(c));
}

function isReadOnly(guardrails: readonly Guardrail[]): boolean {
  return guardrails.some((g) => g.name === READ_ONLY_GUARDRAIL_NAME);
}

function findGuardrail(guardrails: readonly Guardrail[], name: string): Guardrail | undefined {
  return guardrails.find((g) => g.name === name);
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

export interface RenderGate {
  kind: GateKind;
  scope: string | null;
  flavor: RenderFlavor | null;
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
  const grantsWrite = gateGrantsWrite(gate);
  const mutating = !readOnly;

  const tools = ["Read"];
  if (dataAccess) tools.push("Bash");
  if (mutating) tools.push("Edit");
  if (mutating || grantsWrite) tools.push("Write");

  const allowedTools = ["Read"];
  const disallowedTools = readOnly ? [...DESTRUCTIVE_BASH_DENY] : [];

  return { tools, allowedTools, disallowedTools };
}

// --- render section text (ports emit.rs) --------------------------------------------------------

const ENVELOPE_EXAMPLE = `\`\`\`json
{
  "blocks": [
    { "type": "kpi_card", "label": "Total revenue", "value": 1672.4, "unit": "USD" },
    { "type": "table", "columns": ["status", "orders"], "rows": [["completed", 67], ["shipped", 32]] },
    { "type": "chart", "chart_type": "bar", "x": "status", "series": ["orders"],
      "rows": [["completed", 67], ["shipped", 32]] }
  ],
  "summary": "One or two sentences of prose (optional)."
}
\`\`\``;

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
      `build step). End your reply stating the path of the file you wrote.`,
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

function buildPreamble(node: ComponentNode): string {
  return [
    `You are bound to the wren project at \`${node.context_binding.project}\` (your working directory).`,
    "All data access MUST go through the `wren` CLI (e.g. `wren --sql ...`, `wren cube list`, " +
      "`wren genbi build ...`) — never raw SQL clients, never filesystem tricks against the " +
      "underlying warehouse.",
  ].join("\n");
}

// --- per-step-tier split (in-loop via `agents`) — plan §4.5 / §5 --------------------------------

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
    agents[subagentName(node.verb, call.name)] = {
      description: `'${call.name}' step of ${node.verb} (tier: ${call.tier}).`,
      prompt: call.prompt + ioNote,
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
  model: string;
  /** Subagent tier→model, present only on the split path. */
  subagentModels: Record<string, string>;
  tierCollapseNote: string | null;
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
  const permissionMode: PermissionMode = "default";
  const maxTurns = cfg.maxTurns ?? DEFAULT_MAX_TURNS;
  const renderSection = buildRenderSection(node, gate);
  const split = shouldSplitPerStepTier(node);

  const base: Options = {
    cwd: cfg.cwd,
    permissionMode,
    maxTurns,
    // SDK isolation: do NOT load ambient ~/.claude or project .claude settings, so nothing outside
    // this plan can widen the tool allowlist. wren strict_mode is read by the wren CLI itself.
    // (settingSources omitted == isolation mode.)
  };

  if (split) {
    // Per-step tier realized IN-LOOP: a driver delegates to one tier-bound subagent per step via the
    // Task tool. The driver has NO Bash → delegation is structurally forced (design-notes insight),
    // not merely prompted. This is `llm:per_step_tier` = native on this target (no static files).
    const agents = buildAgents(node, gate, cfg.models);
    const driverTools = ["Task", "Read"];
    if (gateGrantsWrite(gate)) driverTools.push("Write");

    const driverPrompt = [
      buildPreamble(node),
      "",
      buildDriverBody(node),
      ...(renderSection
        ? [
            "",
            "You collect the subagents' output and produce the render output yourself " +
              "(the subagents never do).",
            "",
            renderSection,
          ]
        : []),
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
        model: cfg.models.orchestrator(),
        subagentModels,
        tierCollapseNote: null,
      },
    };
  }

  // Single-tier (collapse) path: one model, no subagents.
  const model = cfg.models.collapsedModel(node.llm_calls);
  const toolPlan = buildTools(node, gate);
  const systemPrompt = [
    buildPreamble(node),
    "",
    node.prompt_fragment,
    ...(renderSection ? ["", renderSection] : []),
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
      model,
      subagentModels: {},
      tierCollapseNote: tierCollapseNote(node, model),
    },
  };
}
