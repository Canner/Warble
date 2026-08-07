import { isAbsolute } from "node:path";

import { CodexDispatchError } from "./error.js";
import {
  parseIr,
  SUPPORTED_IR_VERSION,
  TARGET,
  type ComponentNode,
  type LlmCall,
  type WarbleIr,
} from "./ir.js";
import type { CapabilityResolution } from "./prepare.js";
import { REQUEST_TRANSPORT_SERVER } from "./request_transport.js";

export interface AskMcpServerConfig {
  name: string;
  command: string;
  args?: string[];
  toolsByStep: Record<string, string[]>;
}

export interface AskTierModels {
  orchestrator: string;
  cheap: string;
  strong: string;
}

export interface AskWhenGuard {
  guard: "on_failure";
  target: string;
}

export interface PreparedAskStep {
  name: string;
  role: string;
  tier: "cheap" | "strong";
  model: string;
  prompt: string;
  consumes: string[];
  produces: string;
  conditional: boolean;
  when: AskWhenGuard | null;
  enabledTools: string[];
  requireSuccessfulTool: boolean;
}

export type AnalyticalExecutionKind = "answer_query" | "generate_dashboard";

export interface PreparedAskComponent {
  target: typeof TARGET;
  profile: string;
  node: ComponentNode;
  componentId: string;
  steps: PreparedAskStep[];
  capabilities: CapabilityResolution[];
  mcp: AskMcpServerConfig;
  models: AskTierModels;
  executionKind: AnalyticalExecutionKind;
  maxRepairAttempts: 0 | 1;
}

export interface PrepareAskInput {
  ir: string | WarbleIr;
  component: string;
  models: AskTierModels;
  mcp: AskMcpServerConfig;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

const TOOLS_BY_EXECUTION_KIND = {
  answer_query: [["get_context"], ["run_sql"], ["run_sql"]],
  generate_dashboard: [["get_context"], ["run_sql"]],
} as const;

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new CodexDispatchError(`${field} must not be empty`);
}

function parseWhen(step: LlmCall): AskWhenGuard | null {
  if (!step.conditional) {
    if (step.when !== null) {
      throw new CodexDispatchError(`step '${step.name}' is unconditional but has a when guard`);
    }
    return null;
  }
  if (
    typeof step.when !== "object" ||
    step.when === null ||
    Array.isArray(step.when) ||
    (step.when as Record<string, unknown>)["guard"] !== "on_failure" ||
    typeof (step.when as Record<string, unknown>)["target"] !== "string"
  ) {
    throw new CodexDispatchError(
      `step '${step.name}' wall-hit: Ask repair requires on_failure(target)`,
    );
  }
  return {
    guard: "on_failure",
    target: (step.when as Record<string, string>)["target"]!,
  };
}

function validateCommonAnalyticalShape(node: ComponentNode): void {
  if (
    node.type !== "analytical" ||
    node.realization_kind !== "skill" ||
    node.trigger.kind !== "one_shot" ||
    node.effect.outcome.kind !== "none"
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Codex analytical execution requires analytical/skill/one_shot/none`,
    );
  }
  if (node.context_binding.binding_mode !== "runtime_selected") {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Codex analytical execution requires runtime_selected context binding`,
    );
  }
}

function hasExactCapabilities(node: ComponentNode, expected: ReadonlySet<string>): boolean {
  return (
    node.required_capabilities.length === expected.size &&
    node.required_capabilities.every((capability) => expected.has(capability))
  );
}

function validateAnswerShape(node: ComponentNode): void {
  validateCommonAnalyticalShape(node);
  if (node.llm_calls.length !== 3) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Ask requires three ordered llm_calls`,
    );
  }
  const [first, second, repair] = node.llm_calls as [LlmCall, LlmCall, LlmCall];
  if (
    first.tier !== "cheap" ||
    first.conditional ||
    first.consumes.length !== 0 ||
    first.produces === null
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: first Ask step must be unconditional cheap with no consumes and one output`,
    );
  }
  if (
    second.tier !== "strong" ||
    second.conditional ||
    second.produces === null ||
    second.consumes.length !== 1 ||
    second.consumes[0] !== first.produces
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: second Ask step must be unconditional strong and consume the first output`,
    );
  }
  const when = parseWhen(repair);
  if (
    repair.tier !== "strong" ||
    repair.produces === null ||
    repair.consumes.length !== 1 ||
    repair.consumes[0] !== second.produces ||
    when?.target !== second.name
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: third Ask step must be strong on_failure repair of the preceding output`,
    );
  }

  const expectedCapabilities = new Set([
    "sql_execution:read_only",
    "llm:per_step_tier",
    "llm:strong",
    "llm:cheap",
  ]);
  if (!hasExactCapabilities(node, expectedCapabilities)) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Ask capability set must be read-only SQL plus cheap/strong per-step tiering`,
    );
  }
  const guards = new Map(node.guardrails.map((guard) => [guard.name, guard]));
  if (
    guards.size !== 4 ||
    guards.get("read_only_execution")?.locked !== true ||
    guards.get("deterministic_gate")?.locked !== true ||
    guards.get("row_limit")?.locked !== false ||
    guards.get("statement_timeout")?.locked !== false ||
    guards.get("row_limit")?.threshold !== 1000 ||
    guards.get("statement_timeout")?.threshold !== 30
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: Ask guardrails must match the locked read-only/deterministic and bounded row/timeout contract`,
    );
  }
}

const DASHBOARD_RENDER_BLOCKS = [
  {
    type: "kpi_card",
    fields: { label: "string", value: "number|string", unit: "string?", delta: "number?" },
  },
  { type: "table", fields: { columns: "string[]", rows: "row[]" } },
  {
    type: "chart",
    fields: {
      chart_type: "bar|line|pie|area|scatter",
      x: "string",
      series: "string[]",
      rows: "row[]",
    },
  },
  {
    type: "definition",
    fields: { sql: "string", source_tables: "string[]", filters: "string[]" },
  },
] as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateDashboardShape(node: ComponentNode): void {
  validateCommonAnalyticalShape(node);
  if (node.llm_calls.length !== 2) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: dashboard execution requires two ordered llm_calls`,
    );
  }
  const [plan, compose] = node.llm_calls as [LlmCall, LlmCall];
  if (
    plan.tier !== "strong" ||
    plan.conditional ||
    plan.when !== null ||
    plan.consumes.length !== 0 ||
    plan.produces === null
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: first dashboard step must be unconditional strong with no consumes and one output`,
    );
  }
  if (
    compose.tier !== "cheap" ||
    compose.conditional ||
    compose.when !== null ||
    compose.produces === null ||
    compose.consumes.length !== 1 ||
    compose.consumes[0] !== plan.produces
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: second dashboard step must be unconditional cheap and consume the plan output`,
    );
  }
  const expectedCapabilities = new Set([
    "sql_execution:read_only",
    "genbi_build",
    "render_contract",
    "artifact_write",
    "llm:per_step_tier",
    "llm:strong",
    "llm:cheap",
  ]);
  if (!hasExactCapabilities(node, expectedCapabilities)) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: dashboard capability set must match read-only SQL, build, render, artifact, and cheap/strong per-step tiering`,
    );
  }
  const guards = new Map(node.guardrails.map((guard) => [guard.name, guard]));
  if (
    guards.size !== 2 ||
    guards.get("read_only_execution")?.locked !== true ||
    guards.get("artifact_write")?.locked !== true ||
    guards.get("artifact_write")?.scope !== "."
  ) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: dashboard guardrails must be locked read-only execution plus scoped artifact_write`,
    );
  }
  if (canonical(node.effect.render_blocks) !== canonical(DASHBOARD_RENDER_BLOCKS)) {
    throw new CodexDispatchError(
      `component '${node.id}' wall-hit: dashboard render contract must match the locked KPI/table/chart/definition schema`,
    );
  }
}

function executionKind(node: ComponentNode): AnalyticalExecutionKind {
  const capabilities = new Set(node.required_capabilities);
  if (capabilities.has("render_contract") || capabilities.has("artifact_write")) {
    validateDashboardShape(node);
    return "generate_dashboard";
  }
  validateAnswerShape(node);
  return "answer_query";
}

function roleName(stepName: string): string {
  const value = `warble_${stepName}`.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) {
    throw new CodexDispatchError(`step '${stepName}' cannot be mapped to a Codex agent role`);
  }
  return value;
}

export function prepareAsk(input: PrepareAskInput): PreparedAskComponent {
  const ir = typeof input.ir === "string" ? parseIr(input.ir) : input.ir;
  if (ir.warble_ir_version !== SUPPORTED_IR_VERSION) {
    throw new CodexDispatchError(
      `unsupported warble_ir_version '${ir.warble_ir_version}' (supported: ${SUPPORTED_IR_VERSION})`,
    );
  }
  const node = ir.components.find((candidate) => candidate.id === input.component);
  if (!node) {
    throw new CodexDispatchError(
      `component '${input.component}' was not found in profile '${ir.profile}'`,
    );
  }
  const kind = executionKind(node);
  if (!/^[A-Za-z0-9_-]+$/.test(input.mcp.name)) {
    throw new CodexDispatchError(
      `MCP server name '${input.mcp.name}' must contain only letters, digits, '_' or '-'`,
    );
  }
  if (input.mcp.name === REQUEST_TRANSPORT_SERVER) {
    throw new CodexDispatchError(`MCP server name '${input.mcp.name}' is reserved by the Ask request transport`);
  }
  if (!isAbsolute(input.mcp.command)) {
    throw new CodexDispatchError("Ask MCP server command must be absolute");
  }
  requireNonEmpty(input.models.orchestrator, "orchestrator model binding");
  requireNonEmpty(input.models.cheap, "cheap-tier model binding");
  requireNonEmpty(input.models.strong, "strong-tier model binding");

  const steps = node.llm_calls.map((step, index): PreparedAskStep => {
    const tier = step.tier;
    if (tier !== "cheap" && tier !== "strong") {
      throw new CodexDispatchError(`step '${step.name}' has unsupported tier '${tier}'`);
    }
    const enabledTools = unique(input.mcp.toolsByStep[step.name] ?? []);
    const expectedTools = TOOLS_BY_EXECUTION_KIND[kind][index]!;
    if (
      enabledTools.length !== expectedTools.length ||
      enabledTools.some((tool, toolIndex) => tool !== expectedTools[toolIndex])
    ) {
      throw new CodexDispatchError(
        `step '${step.name}' requires exact MCP tools: ${expectedTools.join(", ")}`,
      );
    }
    if (step.produces === null) {
      throw new CodexDispatchError(`step '${step.name}' must produce a named slot`);
    }
    return {
      name: step.name,
      role: roleName(step.name),
      tier,
      model: input.models[tier],
      prompt: step.prompt,
      consumes: [...step.consumes],
      produces: step.produces,
      conditional: step.conditional,
      when: parseWhen(step),
      enabledTools,
      requireSuccessfulTool: kind === "generate_dashboard" || index > 0,
    };
  });

  return {
    target: TARGET,
    profile: ir.profile,
    node,
    componentId: node.id,
    steps,
    capabilities: node.required_capabilities.map((capability) => {
      if (capability.startsWith("llm:")) {
        return { capability, outcome: "native", via: null };
      }
      if (capability === "sql_execution:read_only") {
        return { capability, outcome: "realize-via", via: `mcp:${input.mcp.name}` };
      }
      if (capability === "genbi_build" || capability === "render_contract") {
        return { capability, outcome: "native", via: "validated-render-envelope" };
      }
      if (capability === "artifact_write") {
        return { capability, outcome: "realize-via", via: "consumer-persisted-render-envelope" };
      }
      throw new CodexDispatchError(`component '${node.id}' has an unsupported capability`);
    }),
    mcp: input.mcp,
    models: input.models,
    executionKind: kind,
    maxRepairAttempts: kind === "answer_query" ? 1 : 0,
  };
}
