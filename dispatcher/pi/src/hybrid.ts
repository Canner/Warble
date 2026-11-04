import { admitClosure } from "./admission.js";
import { PolicyAuthority } from "./authorization.js";
import type { RecipientHandle, SessionHandle } from "./authorization.js";
import { DisclosureBoundary, jsonBytes, unavailable } from "./disclosure.js";
import type { ArtifactHandle, Projection, PublicResult } from "./disclosure.js";
import { DEFAULT_LIMITS, runPrivate } from "./runner.js";
import type { Limits, PrivateModel, PrivateTool } from "./runner.js";
import { identifier, record } from "./selection.js";

export interface PrivateBinding {
  recipient: RecipientHandle; session: SessionHandle;
  model: PrivateModel; context: readonly ArtifactHandle[]; tools: readonly PrivateTool[];
  projection: Projection;
}
export interface HybridOptions {
  ir: unknown; entry: string; project: string;
  authority: PolicyAuthority; boundary: DisclosureBoundary;
  publicRecipient: RecipientHandle; publicSession: SessionHandle;
  /** Component-owned tier binding, supplied by trusted host only. */
  bindings: Readonly<Record<string, Partial<Record<"cheap" | "strong", PrivateBinding>>>>;
  limits?: Partial<Limits>;
  onApproved?: (artifact: ArtifactHandle) => void;
}
export interface HybridTool {
  readonly name: string;
  execute(args: unknown, signal?: AbortSignal): Promise<PublicResult>;
}

/** One immutable root step/epoch. Changes require close() and a new instance/context. */
export function createHybridSession(options: HybridOptions): { tools: readonly HybridTool[]; close(): void } {
  const { authority, boundary, publicRecipient, publicSession, project } = options;
  if (boundary.authority !== authority || !identifier(project)
    || !authority.isSessionFor(publicSession, publicRecipient, "public")) throw new Error("invalid_public_binding");
  const closure = admitClosure(options.ir, options.entry);
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[name as keyof Limits]) throw new Error("invalid_limits");
  }
  let closed = false, busy = false, attempts = 0;
  let active: AbortController | undefined;
  const invalidate = () => { closed = true; active?.abort(); };
  const unsubscribe = authority.onInvalidate(invalidate);
  const artifacts = new Set<ArtifactHandle>();
  const close = () => {
    invalidate(); unsubscribe();
    for (const artifact of artifacts) boundary.revoke(artifact);
    artifacts.clear();
  };
  try {
    const tools = [...closure.children].map(([alias, component]): HybridTool => {
      const source = options.bindings[component.id]?.[component.tier];
      if (!source || !authority.isSessionFor(source.session, source.recipient, "private")
        || source.model.zone !== "private") throw new Error("invalid_private_binding");
      const model = JSON.parse(jsonBytes(source.model)) as PrivateModel;
      const url = new URL(model.baseUrl);
      if (url.username || url.password || url.search || url.hash
        || !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))
        || typeof model.id !== "string" || !model.id || typeof model.apiKey !== "string") throw new Error("invalid_private_binding");
      const context = [...source.context];
      const session = source.session, recipient = source.recipient;
      const projection: Projection = { project: source.projection.project, validate: source.projection.validate,
        ...(source.projection.judge ? { judge: source.projection.judge } : {}) };
      const privateTools = source.tools.map(tool => ({ ...tool, parameters: JSON.parse(jsonBytes(tool.parameters)) }));
      const capabilities = component.capabilities.filter(c => c !== `llm:${component.tier}`);
      if (new Set(privateTools.map(t => t.name)).size !== privateTools.length
        || privateTools.some(t => !identifier(t.name) || t.zone !== "private" || t.readOnly !== true
          || !capabilities.includes(t.capability) || !component.actions.includes(t.action))
        || capabilities.some(c => !privateTools.some(t => t.capability === c))
        || component.actions.some(a => !privateTools.some(t => t.action === a))) throw new Error("missing_or_excess_tools");
      const componentResource = authority.registerResource({ project, kind: "component", document: component.id });
      const authorized = () => !closed && authority.isSessionFor(publicSession, publicRecipient, "public")
        && authority.isSessionFor(session, recipient, "private")
        && authority.authorize({ session: publicSession, resource: componentResource, action: "invoke_component" }).decision === "allow";
      return Object.freeze({ name: alias, async execute(args: unknown, signal?: AbortSignal): Promise<PublicResult> {
        if (busy || !record(args, ["request"]) || typeof args.request !== "string" || signal?.aborted
          || Buffer.byteLength(args.request) > limits.maxRequestBytes || !authorized() || attempts >= limits.maxAttempts) return unavailable();
        busy = true; attempts++;
        const controller = new AbortController(); active = controller;
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        const timer = setTimeout(abort, limits.timeoutMs);
        let artifact: ArtifactHandle | undefined;
        try {
          const preparedContext = context.map(h => boundary.read(session, h));
          if (!authorized()) return unavailable();
          const raw = await runPrivate({ request: args.request, instructions: component.instructions,
            context: preparedContext, model, tools: privateTools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })),
            maxTurns: limits.maxTurns, maxRequestBytes: limits.maxRequestBytes,
            maxOutputBytes: limits.maxOutputBytes }, privateTools.map(tool => ({ ...tool,
              // Host evidence lives through projection, then expires with this invocation.
              // The subprocess supervisor also aborts its own signal on normal child exit;
              // exposing that shorter lifetime would discard evidence before validation.
              execute: (args: unknown) => tool.execute(args, controller.signal),
            })), limits, controller.signal);
          const aborted = new Promise<never>((_, reject) => {
            if (controller.signal.aborted) reject(new Error("cancelled"));
            else controller.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          });
          artifact = await Promise.race([boundary.answer(project, publicRecipient, raw, projection, controller.signal), aborted]);
          artifacts.add(artifact);
          controller.signal.throwIfAborted();
          if (!authorized()) return unavailable();
          // Nothing private was emitted as progress, errors, details or transcripts. This is the
          // first public observation, and authority is checked synchronously with the projection.
          const result = boundary.result(publicSession, artifact);
          options.onApproved?.(artifact);
          controller.signal.throwIfAborted();
          if (!authorized()) return unavailable();
          return result;
        } catch { return unavailable(); }
        finally {
          clearTimeout(timer); signal?.removeEventListener("abort", abort);
          controller.abort(); active = undefined; busy = false;
        }
      } });
    });
    return Object.freeze({ tools: Object.freeze(tools), close });
  } catch (error) { close(); throw error; }
}
