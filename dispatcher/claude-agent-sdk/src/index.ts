/**
 * `@warble/claude-agent-sdk` — the Warble Claude Agent SDK back-end, as an embeddable library.
 *
 * Consume the same `ir.json` a Rust `warble compile` emits and drive the Agent SDK's in-loop
 * `query({options})`. Typical use:
 *
 * ```ts
 * import { dispatch } from "@warble/claude-agent-sdk";
 * const out = await dispatch(
 *   { ir: fs.readFileSync("ir.json", "utf8"), question: "orders overview", irPath: "ir.json" },
 *   { outDir: "./run" },
 * );
 * console.log(out.components[0].result.htmlPath, out.components[0].result.trace);
 * ```
 *
 * For full control of the loop, stop at `prepareDispatch` and hand `plan.options` to the SDK's
 * `query()` yourself.
 */

// errors
export { DispatchError } from "./error.js";

// IR
export {
  parseIr,
  distinctTiers,
  SUPPORTED_IR_VERSIONS,
  REALIZATION_KINDS,
  COMPONENT_TYPES,
  TRIGGER_KINDS,
  OUTCOME_KINDS,
} from "./ir.js";
export type {
  WarbleIr,
  ComponentNode,
  ContextBinding,
  IrConfig,
  LlmCall,
  Guardrail,
  Trigger,
  RenderBlock,
  Outcome,
  Effect,
  PreconditionResult,
  RealizationKind,
  ComponentType,
  TriggerKind,
  OutcomeKind,
} from "./ir.js";

// targets + capability resolution
export {
  DEFAULT_TARGET,
  isKnownTarget,
  knownTargetNames,
  localProfile,
  profileFor,
} from "./targets.js";
export type {
  TargetId,
  CapabilityProfile,
  CapabilityEntry,
  CapabilityOutcome,
  ProvidedBy,
  Criticality,
} from "./targets.js";
export {
  resolveCapabilities,
  resolveNodeCapabilities,
  collectRequiredCapabilities,
} from "./resolve.js";
export type { ResolutionReport, ResolvedCapability } from "./resolve.js";

// tier → model binding (+ hybrid-LLM spike: provider/endpoint layer-3 binding)
export { ModelConfig } from "./models.js";
export type { Provider, TierBinding } from "./models.js";

// per-step provider routing (hybrid-LLM spike, §9.2 layer 3 / D4)
export {
  planProviderRouting,
  resolveStagedSteps,
  distinctProviders,
  usesLocalProvider,
  buildStepMessages,
} from "./route.js";
export type { RoutingMode, RoutingPlan, StagedStep, StepMessage } from "./route.js";

// OpenAI-compatible local provider client (hybrid-staged path)
export { callOpenAiCompat, buildChatRequest, extractCompletionText } from "./localClient.js";
export type { CallLocalOptions, ChatRequest } from "./localClient.js";

// hybrid-tool realization: per-step model as a tool the orchestrator calls (WARBLE_HYBRID_MODE=tool)
export { runHybridTool, buildToolDriverPrompt } from "./hybridTool.js";

// IR → query({options}) mapping
export {
  buildDispatchPlan,
  parseRenderFlavor,
  shouldSplitPerStepTier,
  DEFAULT_RENDER_FLAVOR,
  DESTRUCTIVE_BASH_DENY,
} from "./options.js";
export type {
  DispatchPlan,
  DispatchMeta,
  BuildConfig,
  RenderFlavor,
  RenderGate,
  GateKind,
  ToolPlan,
} from "./options.js";

// runtime guardrail enforcement
export { makeReadOnlyGuard } from "./guardrails.js";
export type { GuardConfig, Denial } from "./guardrails.js";

// render (reuse the Rust reference renderer)
export { renderEnvelope } from "./render.js";
export type { RenderResult } from "./render.js";

// drive the loop + trace
export { runDispatch, aggregateTrace } from "./run.js";
export type { RunResult, RunConfig, Trace, StepUsage } from "./run.js";

// multi-turn chat session (single profile — G1)
export {
  ChatSession,
  createChatSession,
  createSessionState,
  appendTurn,
  buildTurnPrompt,
  lastSessionId,
  lastResolvedIntent,
  distillFollowup,
  decideClarify,
  DEFAULT_CLARIFY_THRESHOLD,
} from "./session.js";
export type {
  SessionState,
  Turn,
  ResolvedIntent,
  ClarifyOutcome,
  TurnResult,
  AskOptions,
} from "./session.js";

// high-level API
export {
  prepareDispatch,
  dispatch,
  resolveProjectCwd,
} from "./dispatch.js";
export type {
  DispatchInput,
  PreparedDispatch,
  PreparedComponent,
  DispatchRunConfig,
  DispatchOutcome,
  ComponentOutcome,
} from "./dispatch.js";

// codegen (emit a standalone TS agent module from the IR)
export { emitAgentModule } from "./codegen.js";
export type { EmitOptions } from "./codegen.js";
