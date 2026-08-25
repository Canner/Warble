/**
 * Target capability profiles — the declarative side of the capability model
 * (`docs/spec/capability-model.md`), owned by THIS back-end in TypeScript.
 *
 * A runtime target is `engine × mode`. This back-end declares one target, `claude-agent-sdk:local`:
 * the local `@anthropic-ai/claude-agent-sdk` `query()` loop (subscription login, compute on the
 * user's machine). The shared thing across back-ends is the IR + the capability-model
 * *semantics* (native / realize-via / degrade / fail, criticality, provided_by); the profile *data*
 * is target-specific and each back-end writes its own. So this file is the TS sibling of
 * the Rust file target's `targets.rs`, not a shared table.
 *
 * How `local` differs from the Rust file target's `claude-code:headless` (the point of the second
 * back-end):
 *   - `llm:per_step_tier`        native (in-loop per-call model)   ← headless: realize-via(subagents)
 *   - `structured_output_capture` native (message stream)          ← headless: native(stream-json)
 *   - `render_contract`          realize-via(warble-render)         ← headless: realize-via(html-file)
 * The rest match headless, including the safety-critical loud-fails (human_approval, blast_radius).
 */

/** One of the four resolution outcomes a capability can take on a target. */
export type CapabilityOutcome = "native" | "realize-via" | "degrade" | "fail";

/** Who supplies a resolved capability. */
export type ProvidedBy = "runtime" | "warble" | "none";

/**
 * safety-critical capabilities must never silently degrade — unsupported means the resolution pass
 * aborts. required/best-effort may degrade with a warning recorded in the report.
 */
export type Criticality = "safety-critical" | "required" | "best-effort";

export interface CapabilityEntry {
  outcome: CapabilityOutcome;
  via: string | null;
  provided_by: ProvidedBy;
  criticality: Criticality;
  note: string | null;
}

export type CapabilityProfile = Record<string, CapabilityEntry>;

/** The one target this back-end declares (engine × mode). */
export type TargetId = "claude-agent-sdk:local";

export const DEFAULT_TARGET: TargetId = "claude-agent-sdk:local";

const KNOWN_TARGETS: readonly TargetId[] = ["claude-agent-sdk:local"];

export function isKnownTarget(value: string): value is TargetId {
  return (KNOWN_TARGETS as readonly string[]).includes(value);
}

export function knownTargetNames(): readonly string[] {
  return KNOWN_TARGETS;
}

function entry(
  outcome: CapabilityOutcome,
  via: string | null,
  provided_by: ProvidedBy,
  criticality: Criticality,
  note: string | null,
): CapabilityEntry {
  return { outcome, via, provided_by, criticality, note };
}

/** Capability profile for `claude-agent-sdk:local`. */
export function localProfile(): CapabilityProfile {
  return {
    "sql_execution:read_only": entry("native", "bash-wren", "runtime", "required", null),
    genbi_build: entry("native", "bash-wren", "runtime", "required", null),
    // Reading the semantic model's structure (models/metrics/lineage) is borrowed from the `wren`
    // CLI (`wren context show`), same mechanism as sql_execution/genbi_build — realize-via bash-wren.
    // Matches the file target's headless/interactive profiles (not a differentiator across back-ends).
    semantic_introspection: entry("realize-via", "bash-wren", "runtime", "required", null),
    // Reading bound-project raw material is natively available through the SDK's cwd-scoped Read
    // tool. This does not grant Bash, network access, or writes; the read_only_execution guardrail
    // still confines every filesystem access to the resolved project root.
    raw_material_read: entry("native", "sdk-read", "runtime", "required", null),
    // +Constitutive: reading the semantic model's structure to propose a context edit (models/
    // metrics/knowledge) — realized the same way as semantic_introspection, via the `wren` CLI.
    // Matches the file target (not a differentiator across back-ends).
    schema_introspection: entry("realize-via", "bash-wren", "runtime", "required", null),
    // genbi-setup: onboarding a NEW wren project (no pre-bound context yet). Realized the same way as
    // the other `wren`-CLI-backed capabilities — bash-setup covers `wren` onboarding/context-build
    // commands plus (under setup_execution's broadened Bash) connector CLIs like `dlt`. `required`,
    // not safety-critical: unlike human_approval, a target without it should just wall-hit the
    // specific setup component, not gate every other capability.
    source_connect: entry("realize-via", "bash-setup", "runtime", "required", null),
    context_build: entry("realize-via", "bash-setup", "runtime", "required", null),
    "llm:strong": entry("native", null, "runtime", "required", null),
    "llm:cheap": entry("native", null, "runtime", "required", null),
    // The differentiator vs the file target: the SDK varies the model per call in-loop, so per-step
    // tier is NATIVE here — no static subagent files, no isolated-invocation marshaling required.
    "llm:per_step_tier": entry("native", "in-loop-model", "runtime", "required", null),
    // Per-step PROVIDER routing (cloud+local mixed in one run) — the hybrid capability, distinct from
    // per_step_tier (same-provider model selection). Warble realizes it two ways (WARBLE_HYBRID_MODE):
    // `staged-executor` (the back-end drives the steps) or `in-process-mcp` (an orchestrator query()
    // calls a dispatch_step tool). provided_by warble because Warble supplies the executor/tool; the
    // model runtimes (Claude SDK loop, ollama) are borrowed.
    "llm:per_step_provider": entry(
      "realize-via",
      "staged-executor|in-process-mcp",
      "warble",
      "required",
      null,
    ),
    // Reuse the Warble reference renderer (shell out to `warble render`) — realize-via, same
    // deterministic HTML the file target produces.
    render_contract: entry("realize-via", "warble-render", "runtime", "best-effort", null),
    // Captured directly from the query() message stream (usage/cost per step) — no --output-format
    // plumbing needed; it is inherent to the in-loop runtime.
    structured_output_capture: entry("native", "message-stream", "runtime", "required", null),
    // MVP is read-only, so no component requires approval; keep it a safety-critical loud-fail so a
    // future mutating component targeting this profile fails loudly rather than running unapproved.
    human_approval: entry(
      "fail",
      null,
      "none",
      "safety-critical",
      "no approval channel wired for the programmatic local run in MVP",
    ),
    write_authz: entry("realize-via", "fs", "runtime", "safety-critical", null),
    artifact_write: entry("realize-via", "fs", "runtime", "safety-critical", null),
    // +Assertive borrows the scheduling / event / notify transports from the runtime (OS cron,
    // pub/sub, MCP). The IR names the capability + criticality only; the mechanism is legalized here,
    // never in the IR (capability-model §6/§7). A target with no mechanism wired keeps these `fail`.
    scheduler: entry("realize-via", "os-cron", "runtime", "required", null),
    event_bus: entry("realize-via", "pub-sub", "runtime", "required", null),
    notify_channel: entry("realize-via", "mcp-notify", "runtime", "required", null),
    blast_radius: entry(
      "fail",
      null,
      "warble",
      "safety-critical",
      "requires fine_grained_binding",
    ),
    // +Mutating borrows checkpoint/rollback from version control (git), the same mechanism the
    // workspace conventions already require before a mutating apply. This single SDK target has no
    // human/approval channel wired (see human_approval/blast_radius above), so a mutating component
    // that also requires those still correctly loud-fails here — version_control alone does not
    // authorize the apply.
    version_control: entry("realize-via", "git", "runtime", "required", null),
  };
}

/** Resolve a target id to its capability profile, or `null` if unknown. */
export function profileFor(targetId: string): CapabilityProfile | null {
  return isKnownTarget(targetId) ? localProfile() : null;
}
