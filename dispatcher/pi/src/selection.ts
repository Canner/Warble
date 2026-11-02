export const METADATA_KINDS = [
  "schema.structure", "schema.descriptions", "mdl.expressions", "knowledge.rules",
  "knowledge.sql", "data.samples", "data.raw",
] as const;
export type MetadataKind = typeof METADATA_KINDS[number];
export type ResourceKind = MetadataKind | "component" | "answer.approved";
export type Action = "invoke_component" | "receive_metadata" | "receive_answer";

export interface MetadataSelection {
  readonly kind: MetadataKind;
  /** Stable adapter-owned document IDs; "*" must be an explicit selection. */
  readonly documents: readonly string[] | "*";
}
export interface SessionSelection {
  readonly metadata: readonly MetadataSelection[];
  readonly approvedAnswers: boolean;
  readonly components: readonly string[];
}
/** Operator-only TUI syntax; document IDs are references, never paths or file contents. */
export function parseMetadataSelection(text: string): MetadataSelection[] {
  if (typeof text !== "string" || text.length > 4096 || !text.trim()) throw new Error("invalid_selection");
  if (text.trim() === "none") return [];
  const metadata = text.trim().split(/\s+/).map(part => {
    const pieces = part.split("=");
    if (pieces.length !== 2 || !pieces[1]) throw new Error("invalid_selection");
    return { kind: pieces[0] as MetadataKind, documents: pieces[1] === "*" ? "*" as const : pieces[1]!.split(",") };
  });
  selectionPolicies({ metadata, components: [], approvedAnswers: false });
  return metadata;
}
export type SelectionMode = "blind" | "schema-aware" | "business-aware";

/** Presets are editable starting points, not privilege-bearing roles. Answers remain opt-in. */
export function selectionPreset(mode: SelectionMode, schemaDocuments: readonly string[] = [],
  ruleDocuments: readonly string[] = []): SessionSelection {
  if (!["blind", "schema-aware", "business-aware"].includes(mode)) throw new Error("invalid_selection");
  return {
    metadata: [
      ...(mode === "blind" ? [] : [
        { kind: "schema.structure" as const, documents: [...schemaDocuments] },
        { kind: "schema.descriptions" as const, documents: [...schemaDocuments] },
      ]),
      ...(mode === "business-aware" ? [{ kind: "knowledge.rules" as const, documents: [...ruleDocuments] }] : []),
    ],
    approvedAnswers: false,
    components: [],
  };
}

export function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Reflect.ownKeys(value).every(k => typeof k === "string" && keys.includes(k)
      && Object.getOwnPropertyDescriptor(value, k)?.get === undefined);
  } catch {
    return false;
  }
}
export function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
}
function ids(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 128 && value.every(identifier)
    && new Set(value).size === value.length;
}
const quoted = (value: unknown) => JSON.stringify(value);

/** Generate a separate Cedar policy set; never merge it into the deployment policy set. */
export function selectionPolicies(value: unknown): string {
  if (!record(value, ["metadata", "approvedAnswers", "components"])
    || typeof value.approvedAnswers !== "boolean" || !ids(value.components)
    || !Array.isArray(value.metadata) || value.metadata.length > METADATA_KINDS.length) {
    throw new Error("invalid_selection");
  }
  const kinds = new Set<string>();
  const policies: string[] = [];
  for (const item of value.metadata) {
    if (!record(item, ["kind", "documents"]) || !METADATA_KINDS.includes(item.kind as MetadataKind)
      || (item.documents !== "*" && !ids(item.documents)) || kinds.has(item.kind as string)) {
      throw new Error("invalid_selection");
    }
    kinds.add(item.kind as string);
    // No grant for an empty document set. Emitting [].contains(...) would fail Cedar's
    // strict type validation instead of admitting a valid, default-deny selection.
    if (Array.isArray(item.documents) && item.documents.length === 0) continue;
    const docs = item.documents === "*" ? "true" : `${quoted(item.documents)}.contains(resource.document)`;
    policies.push(`permit(principal, action == Warble::Action::"receive_metadata", resource)
      when { resource.kind == ${quoted(item.kind)} && ${docs} };`);
  }
  if (value.approvedAnswers) policies.push(
    'permit(principal, action == Warble::Action::"receive_answer", resource) when { resource.kind == "answer.approved" };');
  if (value.components.length) policies.push(
    `permit(principal, action == Warble::Action::"invoke_component", resource)
      when { resource.kind == "component" && ${quoted(value.components)}.contains(resource.document) };`);
  return policies.join("\n");
}
