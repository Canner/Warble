import { createHash } from "node:crypto";
import type { SessionHandle, RecipientHandle } from "./authorization.js";
import type { ArtifactHandle, DisclosureBoundary } from "./disclosure.js";
import { jsonBytes } from "./disclosure.js";

/** Exact request admission for a trusted host assembler. Never expose permit() to a model.
 * Hook mutations, compaction, retries and resume must each acquire a new permit or fail closed.
 * The host planner owns assembly of public input, root instructions and authorized artifacts.
 */
export function createEgressTransport(options: {
  boundary: DisclosureBoundary; session: SessionHandle; recipient: RecipientHandle;
  endpoint: string; apiKey: string; maxBytes?: number; authStyle?: "bearer" | "anthropic";
}): { permit(body: unknown, artifacts: readonly ArtifactHandle[]): void; fetch: typeof fetch; close(): void } {
  const { boundary, session, recipient, apiKey } = options;
  const endpoint = new URL(options.endpoint);
  if (endpoint.username || endpoint.password || (endpoint.search !== "" && !(options.authStyle === "anthropic" && endpoint.search === "?beta=true" && endpoint.pathname.endsWith("/v1/messages"))) || endpoint.hash
    || !(endpoint.protocol === "https:" || endpoint.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(endpoint.hostname))) throw new Error("invalid_endpoint");
  const headers = options.authStyle === "anthropic"
    ? { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    : { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
  const maxBytes = options.maxBytes ?? 1048576;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576) throw new Error("invalid_limits");
  const permits = new Map<string, readonly ArtifactHandle[]>();
  const controller = new AbortController();
  const digest = (s: string) => createHash("sha256").update(s).digest("hex");
  const current = () => {
    if (controller.signal.aborted || !boundary.authority.isSessionFor(session, recipient, "public")) throw new Error("egress_denied");
  };
  const unsubscribe = boundary.authority.onInvalidate(() => { permits.clear(); controller.abort(); });
  return {
    permit(body, artifacts) {
      current(); for (const artifact of artifacts) boundary.read(session, artifact);
      current();
      if (permits.size >= 32) throw new Error("permit_limit");
      permits.set(digest(jsonBytes(body, maxBytes)), [...artifacts]);
    },
    fetch: async (input, init) => {
      try {
        current();
        const request = new Request(input, init);
        if (request.url !== endpoint.href || request.method !== "POST") throw new Error("egress_denied");
        // Read a bounded body before authorization, not an unbounded request.text().
        const reader = request.body?.getReader();
        if (!reader) throw new Error("egress_denied");
        const chunks: Uint8Array[] = []; let size = 0;
        const signal = AbortSignal.any([controller.signal, request.signal]);
        const cancel = () => { void reader.cancel().catch(() => {}); };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          signal.throwIfAborted();
          while (true) {
            const next = await reader.read(); if (next.done) break;
            size += next.value.length;
            if (size > maxBytes) { await reader.cancel(); throw new Error("egress_denied"); }
            chunks.push(next.value);
          }
          signal.throwIfAborted();
        } finally { signal.removeEventListener("abort", cancel); }
        const bytes = Buffer.concat(chunks).toString("utf8");
        const key = digest(bytes);
        const artifacts = permits.get(key); permits.delete(key);
        if (!artifacts) throw new Error("egress_denied");
        for (const artifact of artifacts) boundary.read(session, artifact);
        current();
        // No await or extension callback between the final checks and initiating I/O.
        return await fetch(endpoint, { method: "POST", body: bytes, redirect: "error",
          headers: headers as Record<string, string>,
          signal: AbortSignal.any([controller.signal, request.signal]) });
      } catch { throw new Error("egress_denied"); }
    },
    close() { permits.clear(); controller.abort(); unsubscribe(); },
  };
}
