import { jsonBytes } from "./disclosure.js";
import { identifier } from "./selection.js";

export interface AdmittedComponent {
  id: string; step: string; tier: "cheap" | "strong"; instructions: string;
  capabilities: string[]; actions: string[];
}
export interface AdmittedClosure { root: AdmittedComponent; children: ReadonlyMap<string, AdmittedComponent> }
const empty = (v: unknown) => Array.isArray(v) && v.length === 0;
const fail = (): never => { throw new Error("unsupported_hybrid_ir"); };

/** Internal bounded IR executor, NOT an implementation claim for warble-component-host/1. */
export function admitClosure(input: unknown, entry: string, privateRoot = false): AdmittedClosure {
  // Compiler output must be trusted by the host. A JSON snapshot prevents later caller mutation.
  const ir = JSON.parse(jsonBytes(input));
  if (ir.warble_ir_version !== "0.9" || !Array.isArray(ir.components)
    || (ir.slots !== undefined && !empty(ir.slots)) || Object.keys(ir.config ?? {}).length) fail();
  const nodes = new Map<string, any>();
  for (const c of ir.components) {
    if (!identifier(c.id) || nodes.has(c.id)) fail();
    nodes.set(c.id, c);
  }
  const root = nodes.get(entry);
  const parse = (c: any, isRoot: boolean): AdmittedComponent => {
    if (!c || c.entrypoint !== isRoot || c.realization_kind !== "skill" || c.type !== "analytical"
      || c.trigger?.kind !== "one_shot" || c.effect?.outcome?.kind !== "none"
      || !empty(c.effect.render_blocks) || c.llm_calls?.length !== 1
      || !empty(c.context_precondition) || !empty(c.context_requirements)
      || c.precondition_result?.status !== "pass" || !empty(c.precondition_result.checks)
      || !empty(c.params) || (c.slots !== undefined && !empty(c.slots))
      || !Array.isArray(c.guardrails) || !c.guardrails.every((g: any) => g.name === "read_only_execution" && g.locked === true && Object.keys(g).length === 2)) fail();
    const s = c.llm_calls[0];
    if (!identifier(s.name) || !["cheap", "strong"].includes(s.tier) || typeof s.prompt !== "string"
      || s.conditional !== false || s.when !== null || !empty(s.consumes) || s.produces !== null
      || Object.keys(s).some(k => !["name", "tier", "prompt", "conditional", "when", "consumes", "produces", "component_calls"].includes(k))
      || (!isRoot && !empty(s.component_calls ?? []))) fail();
    if (!Array.isArray(c.required_capabilities) || !c.required_capabilities.every((v: unknown) => typeof v === "string")
      || !Array.isArray(c.borrowed_actions) || !c.borrowed_actions.every(identifier)
      || new Set(c.required_capabilities).size !== c.required_capabilities.length
      || new Set(c.borrowed_actions).size !== c.borrowed_actions.length) fail();
    if (!c.required_capabilities.includes(`llm:${s.tier}`)
      || c.required_capabilities.some((v: string) => v.startsWith("llm:") && v !== `llm:${s.tier}`)) fail();
    if (isRoot && !privateRoot && (c.borrowed_actions.length || c.required_capabilities.some((v: string) => ![`llm:${s.tier}`, "component_invocation"].includes(v)))) fail();
    return Object.freeze({ id: c.id, step: s.name, tier: s.tier,
      instructions: [c.brief, s.prompt].filter(Boolean).join("\n\n"),
      capabilities: Object.freeze([...c.required_capabilities]) as unknown as string[], actions: Object.freeze([...c.borrowed_actions]) as unknown as string[] });
  };
  const caller = parse(root, true);
  const children = new Map<string, AdmittedComponent>();
  if (!Array.isArray(root.llm_calls[0].component_calls) || !root.llm_calls[0].component_calls.length
    || !root.required_capabilities.includes("component_invocation")) fail();
  for (const edge of root.llm_calls[0].component_calls) {
    if (!identifier(edge.alias) || Object.keys(edge).length !== 2 || children.has(edge.alias)) fail();
    children.set(edge.alias, parse(nodes.get(edge.component), false));
  }
  // Extra unreachable declarations are not accidentally available to this runtime.
  return { root: caller, children };
}
