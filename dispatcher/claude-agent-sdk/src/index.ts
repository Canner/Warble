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

// authenticated provider-owned model catalog (no agent turn)
export { discoverClaudeModels, MODEL_CATALOG_VERSION } from "./model_catalog.js";
export type {
  DiscoverClaudeModelsOptions,
  ModelCatalogModel,
  ModelCatalogResult,
  ModelCatalogUnavailableCode,
} from "./model_catalog.js";

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
  inspectNodeCapabilities,
  collectRequiredCapabilities,
} from "./resolve.js";
export type { ResolutionReport, ResolvedCapability } from "./resolve.js";

// tier → model binding (+ provider/endpoint layer-3 binding, docs/spec/capability-model.md §7.2)
export { ModelConfig } from "./models.js";
export type { Provider, TierBinding } from "./models.js";

// per-step provider routing (see docs/spec/capability-model.md §7.2)
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
  GateFailureMode,
  ToolPlan,
} from "./options.js";

// runtime guardrail enforcement
export { makeReadOnlyGuard } from "./guardrails.js";
export type { GuardConfig, Denial } from "./guardrails.js";

// render (reuse the Rust reference renderer)
export { renderEnvelope } from "./render.js";
export type { RenderResult } from "./render.js";

// drive the loop + trace
export { runDispatch, aggregateTrace, DispatchSessionError } from "./run.js";
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
  prepareDisplayManifest,
  dispatch,
  resolveProjectCwd,
  UNAVAILABLE_COMPONENT_REASON,
} from "./dispatch.js";
export type {
  DispatchInput,
  PreparedDispatch,
  PreparedComponent,
  PreparedDisplayManifest,
  DisplayComponent,
  UnavailableDisplayComponent,
  DispatchRunConfig,
  DispatchOutcome,
  ComponentOutcome,
} from "./dispatch.js";

// codegen (emit a standalone TS agent module from the IR)
export { emitAgentModule } from "./codegen.js";
export type { EmitOptions } from "./codegen.js";

// display manifest (a structural snapshot of the resolved profile for this target — same shape as
// the vercel back-end's bundle, for a consumer that wants to display "what will run")
export { buildManifest, buildAgentManifest, buildUnavailableAgentManifest } from "./manifest.js";
export type {
  Manifest,
  AgentManifest,
  AvailableAgentManifest,
  UnavailableAgentManifest,
  StepManifest,
  StepRealization,
  ToolRef,
  GuardrailManifest,
  CompatibilityPolicy,
  WhenGuardOut,
} from "./manifest.js";
