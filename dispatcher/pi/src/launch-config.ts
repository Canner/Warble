import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { admitClosure } from "./admission.js";
import { jsonBytes } from "./disclosure.js";
import type { Projection } from "./disclosure.js";
import type { PrivateTool } from "./runner.js";
import { identifier, METADATA_KINDS, record, selectionPolicies } from "./selection.js";
import type { MetadataKind, SessionSelection } from "./selection.js";
import { validatePolicies } from "./cedar.js";

export interface ModelBinding {
  zone: "public" | "private"; deployment: string; api: "openai-completions" | "anthropic-messages";
  model: string; baseUrl: string; credentialEnv: string;
}
export interface LaunchConfig {
  format: "warble-pi-hybrid-config/1"; entry: string; policy: string;
  adapter: { path: string; sha256: string };
  selections: Record<string, SessionSelection>;
  models: Record<string, ModelBinding>;
  projects: Record<string, { privateModels: Record<string, Partial<Record<"cheap" | "strong", ModelBinding>>> }>;
  defaults: { policy: string; model: string; project: string };
}
export interface MetadataDocument { kind: MetadataKind; document: string; value: unknown }
export interface ProjectAdapter {
  loadProject(project: string): Promise<{ metadata: MetadataDocument[];
    children: Record<string, { context: MetadataDocument[]; tools: PrivateTool[]; projection: Projection }> }>;
}
export const RUNTIME_VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
export interface LaunchBundle {
  format: "warble-pi-hybrid/1"; runtimeVersion: string; piVersion: "1.0.4";
  ir: unknown; config: LaunchConfig;
}
export const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
function table(value: unknown): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length
    || Object.keys(value).length > 64 || !Object.keys(value).every(identifier)) throw new Error("invalid_config");
}
export function validateBundle(input: unknown): LaunchBundle {
  const b = JSON.parse(jsonBytes(input, 4 * 1048576));
  if (!record(b, ["format", "runtimeVersion", "piVersion", "ir", "config"]) || b.format !== "warble-pi-hybrid/1"
    || b.runtimeVersion !== RUNTIME_VERSION || b.piVersion !== "1.0.4") throw new Error("invalid_launch");
  const c = b.config;
  if (!record(c, ["format", "entry", "policy", "adapter", "selections", "models", "projects", "defaults"])
    || c.format !== "warble-pi-hybrid-config/1" || !identifier(c.entry)
    || typeof c.policy !== "string" || !validatePolicies(c.policy)
    || !record(c.adapter, ["path", "sha256"]) || typeof c.adapter.path !== "string" || !isAbsolute(c.adapter.path)
    || !/^[a-f0-9]{64}$/.test(c.adapter.sha256 as string)) throw new Error("invalid_config");
  const closure = admitClosure(b.ir, c.entry);
  table(c.selections); table(c.models); table(c.projects);
  for (const selection of Object.values(c.selections)) selectionPolicies(selection);
  const model = (v: any, zone: string) => {
    if (!record(v, ["zone", "deployment", "api", "model", "baseUrl", "credentialEnv"])
      || v.zone !== zone || !identifier(v.deployment) || !["openai-completions", "anthropic-messages"].includes(v.api as string)
      || zone === "private" && v.api !== "openai-completions" || typeof v.model !== "string" || !v.model || v.model.length > 256
      || typeof v.baseUrl !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(v.credentialEnv as string)) throw new Error("invalid_model_binding");
    const url = new URL(v.baseUrl);
    if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)
      || url.protocol === "http:" && !["127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("invalid_endpoint");
  };
  for (const m of Object.values(c.models)) model(m, "public");
  for (const p of Object.values(c.projects)) {
    if (!record(p, ["privateModels"])) throw new Error("invalid_project"); table(p.privateModels);
    const ids = new Set([...closure.children.values()].map(child => child.id));
    if (Object.keys(p.privateModels).some(id => !ids.has(id))) throw new Error("excess_binding");
    for (const child of closure.children.values()) {
      const tiers = p.privateModels[child.id];
      if (!record(tiers, [child.tier]) || !tiers[child.tier]) throw new Error("missing_binding");
      model(tiers[child.tier], "private");
    }
  }
  if (!record(c.defaults, ["policy", "model", "project"]) || typeof c.defaults.policy !== "string"
    || typeof c.defaults.model !== "string" || typeof c.defaults.project !== "string"
    || !Object.hasOwn(c.selections, c.defaults.policy) || !Object.hasOwn(c.models, c.defaults.model)
    || !Object.hasOwn(c.projects, c.defaults.project)) throw new Error("invalid_defaults");
  return b as unknown as LaunchBundle;
}
export function validateDocuments(value: MetadataDocument[]): MetadataDocument[] {
  const docs = JSON.parse(jsonBytes(value));
  if (!Array.isArray(docs) || docs.length > 128) throw new Error("invalid_metadata");
  const keys = new Set<string>();
  for (const doc of docs) {
    if (!record(doc, ["kind", "document", "value"]) || !METADATA_KINDS.includes(doc.kind as MetadataKind)
      || !identifier(doc.document) || !("value" in doc) || keys.has(`${doc.kind}/${doc.document}`)) throw new Error("invalid_metadata");
    keys.add(`${doc.kind}/${doc.document}`);
  }
  return docs;
}
export async function loadLaunch(directory: string): Promise<{ bundle: LaunchBundle; adapter: ProjectAdapter }> {
  const dir = await realpath(directory);
  const bytes = await readFile(join(dir, "launch.json"));
  if (bytes.length > 4 * 1048576 || sha256(bytes) !== (await readFile(join(dir, "launch.sha256"), "utf8")).trim()) throw new Error("launch_integrity");
  const bundle = validateBundle(JSON.parse(bytes.toString("utf8")));
  const source = await readFile(bundle.config.adapter.path);
  if (source.length > 1048576 || sha256(source) !== bundle.config.adapter.sha256) throw new Error("adapter_integrity");
  // Explicit trusted adapter only; no scanning, extension discovery or model-controlled paths.
  const adapter = await import(pathToFileURL(bundle.config.adapter.path).href) as ProjectAdapter;
  if (typeof adapter.loadProject !== "function") throw new Error("invalid_adapter");
  return { bundle, adapter };
}
