import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Model, Api } from "@earendil-works/pi-ai";
import { streamSimple as openai } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { PolicyAuthority } from "./authorization.js";
import { DisclosureBoundary, jsonBytes } from "./disclosure.js";
import type { ArtifactHandle } from "./disclosure.js";
import { admitClosure } from "./admission.js";
import { createHybridSession } from "./hybrid.js";
import type { PrivateBinding } from "./hybrid.js";
import { createEgressTransport } from "./transport.js";
import { validateBundle, validateDocuments, sha256 } from "./launch-config.js";
import type { LaunchBundle, ProjectAdapter, ModelBinding } from "./launch-config.js";
import { METADATA_KINDS, selectionPolicies } from "./selection.js";
import type { MetadataSelection } from "./selection.js";
import { SessionEvidence } from "./evidence.js";
import type { EvidenceRecord } from "./evidence.js";

export type Choice = { policy: string; model: string; project: string; disclosure?: readonly MetadataSelection[] };
export interface PlannerStatus extends Choice {
  epoch: number; modelId: string; api: string; policyDigest: string; metadata: string[]; tools: string[];
  requestedMetadata: readonly MetadataSelection[]; availableMetadata: string[]; unavailableMetadata: string[];
}
interface Epoch {
  agent: Agent; stop(): void; status: PlannerStatus; evidence: SessionEvidence; turnReferences: number[];
}
/** Public API exposes only text input, bounded configured choices and status, never Agent state. */
export class HybridPlanner {
  #bundle: LaunchBundle; #adapter: ProjectAdapter; #credential: (name: string) => string;
  #current: Epoch | undefined; #epoch = 0; #generation = 0; #busy = false; #closed = false;
  #nextReference = 0;
  constructor(bundle: LaunchBundle, adapter: ProjectAdapter, credential: (name: string) => string) {
    this.#bundle = validateBundle(bundle); this.#adapter = adapter; this.#credential = credential;
  }
  get choices(): { policies: string[]; models: string[]; projects: string[] } {
    const c = this.#bundle.config;
    return { policies: Object.keys(c.selections), models: Object.keys(c.models), projects: Object.keys(c.projects) };
  }
  get status(): PlannerStatus | undefined { return this.#current ? structuredClone(this.#current.status) : undefined; }
  /** Local inspection only: never a model tool or part of model history. */
  evidence(reference?: number): EvidenceRecord[] {
    const ledger = this.#current?.evidence;
    if (!ledger) return [];
    if (reference === undefined) return ledger.list();
    const value = ledger.get(reference); return value ? [value] : [];
  }
  formatAnswer(answer: string): string {
    return this.#current?.evidence.format(answer, this.#current.turnReferences) ?? answer;
  }
  async reset(choice: Choice = this.#bundle.config.defaults): Promise<void> {
    if (this.#closed) throw new Error("closed");
    choice = { ...choice };
    const c = this.#bundle.config;
    if (!Object.hasOwn(c.selections, choice.policy) || !Object.hasOwn(c.models, choice.model)
      || !Object.hasOwn(c.projects, choice.project)) throw new Error("unknown_selection");
    // Metadata overrides cannot alter component or approved-answer permissions. Validate and
    // snapshot before the first await so caller mutation cannot race epoch initialization.
    const requested = { ...c.selections[choice.policy]!,
      ...(choice.disclosure !== undefined ? { metadata: choice.disclosure } : {}) };
    selectionPolicies(requested);
    const selection = JSON.parse(jsonBytes(requested));
    if (choice.disclosure !== undefined) choice.disclosure = structuredClone(selection.metadata);
    const generation = ++this.#generation;
    const old = this.#current; this.#current = undefined; old?.stop();
    if (old) await old.agent.waitForIdle();
    this.#busy = false;
    const loaded = await this.#adapter.loadProject(choice.project);
    if (generation !== this.#generation || this.#closed) throw new Error("stale_epoch");
    const authority = new PolicyAuthority(c.policy), boundary = new DisclosureBoundary(authority);
    const modelBinding = c.models[choice.model]!;
    const credential = (binding: ModelBinding) => {
      const key = this.#credential(binding.credentialEnv);
      if (typeof key !== "string" || !key || key.length > 16384) throw new Error("missing_credential");
      return key;
    };
    const key = credential(modelBinding);
    const publicRecipient = authority.registerRecipient({ project: choice.project, zone: "public", role: "planner", deployment: modelBinding.deployment });
    const publicSession = authority.openSession(publicRecipient, selection, true);
    const artifacts: ArtifactHandle[] = [], metadata: unknown[] = [], names: string[] = [], available: string[] = [];
    const docs = validateDocuments(loaded.metadata);
    // Operator display only: names authorized by the deployment ceiling. No catalog values
    // or rejected requests are added to the public prompt or model tool surfaces.
    const catalogSession = authority.openSession(publicRecipient, { components: [], approvedAnswers: false,
      metadata: METADATA_KINDS.map(kind => ({ kind, documents: "*" })) }, true);
    for (const doc of docs) {
      const h = boundary.metadata(choice.project, doc.kind, doc.document, doc.value);
      try { boundary.read(catalogSession, h); available.push(`${doc.kind}/${doc.document}`); } catch { /* Denied ceiling. */ }
      try { metadata.push({ kind: doc.kind, document: doc.document, value: boundary.read(publicSession, h) }); artifacts.push(h); names.push(`${doc.kind}/${doc.document}`); }
      catch { /* An unavailable category is omitted, never replaced by full context. */ }
    }
    authority.closeSession(catalogSession);
    const unavailable: string[] = [];
    for (const item of selection.metadata as MetadataSelection[]) {
      const targets = item.documents === "*" ? docs.filter(d => d.kind === item.kind).map(d => d.document) : item.documents;
      if (item.documents === "*" && !targets.length) unavailable.push(`${item.kind}/*`);
      for (const document of targets) if (!names.includes(`${item.kind}/${document}`)) unavailable.push(`${item.kind}/${document}`);
    }
    const closure = admitClosure(this.#bundle.ir, c.entry);
    const bindings: Record<string, Partial<Record<"cheap" | "strong", PrivateBinding>>> = {};
    const allowed = new Set<string>();
    for (const [alias, child] of closure.children) {
      const resource = authority.registerResource({ project: choice.project, kind: "component", document: child.id });
      if (authority.authorize({ session: publicSession, resource, action: "invoke_component" }).decision === "allow") allowed.add(alias);
      if (Object.hasOwn(bindings, child.id)) continue;
      const implementation = loaded.children[child.id];
      if (!implementation) throw new Error("missing_private_adapter");
      const binding = c.projects[choice.project]!.privateModels[child.id]![child.tier]!;
      const recipient = authority.registerRecipient({ project: choice.project, zone: "private", role: "worker", deployment: binding.deployment });
      const docs = validateDocuments(implementation.context);
      const context = docs.map(d => boundary.metadata(choice.project, d.kind, d.document, d.value));
      const session = authority.openSession(recipient, { components: [], approvedAnswers: false,
        metadata: METADATA_KINDS.map(kind => ({ kind, documents: docs.filter(d => d.kind === kind).map(d => d.document) })) }, true);
      bindings[child.id] = { [child.tier]: { recipient, session, context, tools: implementation.tools, projection: implementation.projection,
        model: { zone: "private", id: binding.model, baseUrl: binding.baseUrl, apiKey: credential(binding) } } };
    }
    const runtime = createHybridSession({ ir: this.#bundle.ir, entry: c.entry, project: choice.project, authority, boundary,
      publicRecipient, publicSession, bindings, onApproved: h => artifacts.push(h) });
    const endpoint = modelBinding.baseUrl.replace(/\/$/, "") + (modelBinding.api === "anthropic-messages" ? "/v1/messages?beta=true" : "/chat/completions");
    const transport = createEgressTransport({ boundary, session: publicSession, recipient: publicRecipient,
      endpoint, apiKey: key, authStyle: modelBinding.api === "anthropic-messages" ? "anthropic" : "bearer" });
    // Luna requires explicit non-reasoning mode for Chat Completions tool calls.
    // Let the pinned serializer produce this field before the complete body is authorized.
    // https://developers.openai.com/api/docs/models/gpt-6-luna
    const luna = modelBinding.api === "openai-completions" && modelBinding.model === "gpt-6-luna";
    const model: Model<Api> = { id: modelBinding.model, name: modelBinding.model, api: modelBinding.api,
      provider: modelBinding.api === "anthropic-messages" ? "anthropic" : "openai", baseUrl: modelBinding.baseUrl,
      reasoning: luna, ...(luna ? { thinkingLevelMap: { off: "none" } } : {}),
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 };
    const evidence = new SessionEvidence(() => ++this.#nextReference, {
      epoch: this.#epoch + 1, project: choice.project, policyDigest: sha256(c.policy), metadata: names });
    const turnReferences: number[] = [];
    const tools: AgentTool[] = runtime.tools.filter(t => allowed.has(t.name)).map(t => ({ name: t.name, label: t.name,
      description: `Invoke the compiled component alias ${t.name} with one explicit request.`,
      parameters: Type.Object({ request: Type.String() }, { additionalProperties: false }),
      execute: async (_id, args, signal) => {
        const result = await t.execute(args, signal);
        if (!stopped && !signal?.aborted && !result.isError) {
          turnReferences.push(evidence.add(t.name, (args as { request: string }).request, result.structuredContent));
        }
        return { content: result.content, details: {}, ...(result.isError ? { isError: true } : {}) };
      } }));
    let stopped = false, requests = 0;
    const agent = new Agent({ initialState: { model, tools,
      systemPrompt: closure.root.instructions + "\n\nAuthorized metadata:\n" + jsonBytes(metadata) },
      toolExecution: "sequential",
      streamFn: (_unused, sealedContext, options) => {
        if (stopped || ++requests > 128) throw new Error("planner_limit");
        // Only this host-owned Agent can supply context. No extensions, payload hooks, imports,
        // attachments or caller-provided stream options are installed. The pinned serializer
        // converts that sealed context; authorization is at its mandatory transport, not a hook.
        let attempted = false;
        const guardedFetch: typeof fetch = async (url, init) => {
          if (stopped || attempted || typeof init?.body !== "string") throw new Error("egress_denied");
          attempted = true; // SDK retries are unsupported and cannot acquire another permit.
          if (Buffer.byteLength(init.body) > 1048576) throw new Error("request_limit");
          for (const artifact of artifacts) boundary.read(publicSession, artifact);
          transport.permit(JSON.parse(init.body), artifacts);
          const response = await transport.fetch(url, init);
          if (!response.body) throw new Error("invalid_response");
          let size = 0;
          const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, sink) {
            size += chunk.length; if (size > 1048576) throw new Error("response_limit"); sink.enqueue(chunk);
          } }));
          return new Response(body, { status: response.status, headers: response.headers });
        };
        const streamOptions = { apiKey: key, maxTokens: 4096, fetch: guardedFetch, env: {}, maxRetries: 0, cacheRetention: "none" as const,
          ...(options?.signal ? { signal: options.signal } : {}) };
        return modelBinding.api === "anthropic-messages"
          ? anthropic(model as Model<"anthropic-messages">, sealedContext, streamOptions)
          : openai(model as Model<"openai-completions">, sealedContext, streamOptions);
      },
    });
    const stop = () => { stopped = true; evidence.clear(); turnReferences.length = 0; agent.abort(); transport.close(); runtime.close(); authority.closeSession(publicSession); };
    const status = { ...choice, epoch: ++this.#epoch, modelId: modelBinding.model, api: modelBinding.api,
      policyDigest: sha256(c.policy), metadata: names, tools: tools.map(t => t.name),
      requestedMetadata: selection.metadata, availableMetadata: available, unavailableMetadata: unavailable };
    if (generation !== this.#generation || this.#closed) { stop(); throw new Error("stale_epoch"); }
    this.#current = { agent, stop, status, evidence, turnReferences };
  }
  async prompt(text: string): Promise<string> {
    const epoch = this.#current;
    if (!epoch || this.#closed || this.#busy || typeof text !== "string" || !text.trim()
      || Buffer.byteLength(text) > 65536 || /^[!/]/.test(text.trimStart())) throw new Error("input_denied");
    this.#busy = true;
    epoch.turnReferences.length = 0;
    const timer = setTimeout(() => epoch.agent.abort(), 60000);
    try {
      await epoch.agent.prompt(text);
      if (this.#current !== epoch || this.#closed) return "Request cancelled.";
      const last = epoch.agent.state.messages.at(-1);
      if (!last || last.role !== "assistant" || last.stopReason !== "stop") {
        epoch.stop(); this.#current = undefined; return "Request unavailable. Reset the session to continue.";
      }
      return last.content.filter(p => p.type === "text").map(p => p.type === "text" ? p.text : "").join("");
    } catch {
      if (this.#current === epoch) { epoch.stop(); this.#current = undefined; }
      return "Request unavailable. Reset the session to continue.";
    }
    finally { clearTimeout(timer); if (this.#current === epoch) this.#busy = false; }
  }
  close(): void { this.#closed = true; this.#generation++; this.#current?.stop(); this.#current = undefined; }
}
