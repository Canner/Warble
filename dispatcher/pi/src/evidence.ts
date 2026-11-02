import { jsonBytes } from "./disclosure.js";

export const EVIDENCE_NOTICE = "References identify adapter-validated, policy-approved tool data only. Model interpretation is not verified. Completion time is not data freshness. Memory only; settings changes clear this history.";
export interface EvidenceRecord {
  reference: number; completedAt: string; tool: string; request: string;
  epoch: number; project: string; policyDigest: string; metadata: string[]; result: unknown;
}
type Context = Pick<EvidenceRecord, "epoch" | "project" | "policyDigest" | "metadata">;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Host-only display ledger. It receives only successful public projections, never raw
 * child output or an adapter's private evidence lookup. Nothing here enters Agent state. */
export class SessionEvidence {
  #records = new Map<number, { record: EvidenceRecord; bytes: number; id?: string }>();
  #bytes = 0;
  constructor(private allocate: () => number, private context: Context) {}
  clear(): void { this.#records.clear(); this.#bytes = 0; }
  add(tool: string, request: string, approved: unknown): number {
    const result = JSON.parse(jsonBytes(approved));
    const reference = this.allocate();
    let id: string | undefined;
    // This is an optional adapter convention, not proof obtained from model prose.
    if (object(result) && object(result.evidence) && typeof result.evidence.id === "string" && uuid.test(result.evidence.id)) {
      id = result.evidence.id.toLowerCase();
      delete result.evidence.id;
      result.evidence.reference = `[${reference}]`;
    }
    const record: EvidenceRecord = { ...structuredClone(this.context), reference,
      completedAt: new Date().toISOString(), tool, request, result };
    const bytes = Buffer.byteLength(jsonBytes(record, 2 * 1048576));
    // Evicted numbers are never reused in the process, including across epochs.
    while (this.#records.size && (this.#records.size >= 32 || this.#bytes + bytes > 2 * 1048576)) {
      const oldest = this.#records.keys().next().value!;
      this.#bytes -= this.#records.get(oldest)!.bytes; this.#records.delete(oldest);
    }
    this.#records.set(reference, { record, bytes, ...(id ? { id } : {}) }); this.#bytes += bytes;
    return reference;
  }
  list(): EvidenceRecord[] { return [...this.#records.values()].map(v => structuredClone(v.record)); }
  get(reference: number): EvidenceRecord | undefined {
    const value = this.#records.get(reference); return value ? structuredClone(value.record) : undefined;
  }
  format(answer: string, turnReferences: readonly number[]): string {
    // Only display text changes. The provider's original history and opaque IDs remain intact.
    let text = answer.replace(/\[(\d+)\]/g, (whole, n: string) => this.#records.has(Number(n)) ? whole : "[unavailable reference]");
    text = text.replace(/`?\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b`?/gi, value => {
      const id = value.replace(/`/g, "").toLowerCase();
      const matches = [...this.#records.values()].filter(r => r.id === id);
      return matches.length === 1 ? `[${matches[0]!.record.reference}]` : "[unavailable reference]";
    });
    const references = [...new Set([...turnReferences, ...[...text.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1]))])]
      .filter(n => this.#records.has(n));
    return text + (references.length ? `\nTool data: ${references.map(n => `[${n}]`).join(" ")} — /evidence <number>. Model interpretation is not verified.` : "");
  }
}
