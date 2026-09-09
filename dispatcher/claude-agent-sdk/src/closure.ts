import { DispatchError } from "./error.js";
import type { ComponentNode, WarbleIr } from "./ir.js";

/** One statically-authorized caller-step edge in the materialized profile. */
export interface ComponentDependency {
  caller: string;
  step: string;
  alias: string;
  component: string;
}

/** The deterministic transitive closure for one selectable root. */
export interface EntryClosure {
  root: string;
  components: readonly string[];
}

/**
 * Preparation selection before target legalization. `roots` are the only nodes an operation may
 * start; `callees` are addressable only through an edge in `dependencies`.
 */
export interface ComponentClosurePlan {
  roots: readonly ComponentNode[];
  callees: readonly ComponentNode[];
  components: readonly ComponentNode[];
  entries: readonly EntryClosure[];
  dependencies: readonly ComponentDependency[];
}

function freezeArray<T>(values: T[]): readonly T[] {
  return Object.freeze(values);
}

/** Return all declared edges in profile/step/declaration order. */
export function componentDependencies(ir: WarbleIr): readonly ComponentDependency[] {
  const dependencies: ComponentDependency[] = [];
  for (const node of ir.components) {
    const declaresCalls = node.llm_calls.some((step) => step.component_calls.length > 0);
    if (declaresCalls && !node.required_capabilities.includes("component_invocation")) {
      throw new DispatchError(
        `invalid IR: component '${node.id}' declares component calls but does not require ` +
          "component_invocation, so the target capability wall could be bypassed",
      );
    }
    for (const step of node.llm_calls) {
      const aliases = new Set<string>();
      for (const call of step.component_calls) {
        if (aliases.has(call.alias)) {
          throw new DispatchError(
            `invalid IR: duplicate component call alias '${call.alias}' on '${node.id}.${step.name}'`,
          );
        }
        aliases.add(call.alias);
        dependencies.push(
          Object.freeze({ caller: node.id, step: step.name, alias: call.alias, component: call.component }),
        );
      }
    }
  }
  return freezeArray(dependencies);
}

/**
 * Resolve exactly the requested roots and their transitive callees. The reader rechecks the graph
 * rather than trusting compiler provenance so a forged object IR cannot widen or cycle authority.
 */
export function resolveComponentClosure(
  ir: WarbleIr,
  requestedRoots?: readonly string[],
): ComponentClosurePlan {
  const byId = new Map<string, ComponentNode>();
  for (const node of ir.components) {
    if (byId.has(node.id)) {
      throw new DispatchError(`invalid IR: duplicate mounted component id '${node.id}'`);
    }
    byId.set(node.id, node);
  }

  const roots = requestedRoots ?? ir.components.filter((node) => node.entrypoint).map((node) => node.id);
  const rootNodes = roots.map((id) => {
    const node = byId.get(id);
    if (!node) {
      throw new DispatchError(
        `component '${id}' not found in IR (available: ${ir.components.map((candidate) => candidate.id).join(", ")})`,
      );
    }
    if (!node.entrypoint) {
      throw new DispatchError(
        `component '${id}' is entrypoint:false and cannot be selected as a root entry`,
      );
    }
    return node;
  });

  const dependencies = componentDependencies(ir);
  const outgoing = new Map<string, readonly ComponentDependency[]>();
  for (const node of ir.components) {
    outgoing.set(
      node.id,
      dependencies.filter((dependency) => dependency.caller === node.id),
    );
  }

  const entries: EntryClosure[] = [];
  const union = new Set<string>();
  for (const root of rootNodes) {
    const visited = new Set<string>();
    const active: string[] = [];
    const walk = (id: string): void => {
      if (active.includes(id)) {
        const start = active.indexOf(id);
        throw new DispatchError(
          `invalid IR: component call cycle detected: ${[...active.slice(start), id].join(" -> ")}`,
        );
      }
      if (visited.has(id)) return;
      const node = byId.get(id);
      if (!node) {
        const edge = dependencies.find((dependency) => dependency.component === id);
        throw new DispatchError(
          `invalid IR: component '${edge?.caller ?? root.id}' step '${edge?.step ?? "?"}' alias ` +
            `'${edge?.alias ?? "?"}' references missing mounted component '${id}'`,
        );
      }
      active.push(id);
      visited.add(id);
      union.add(id);
      for (const edge of outgoing.get(id) ?? []) {
        if (edge.component === id) {
          throw new DispatchError(
            `invalid IR: component '${id}' step '${edge.step}' alias '${edge.alias}' cannot call itself`,
          );
        }
        walk(edge.component);
      }
      active.pop();
    };
    walk(root.id);
    entries.push(Object.freeze({ root: root.id, components: freezeArray([...visited]) }));
  }

  const components = ir.components.filter((node) => union.has(node.id));
  const scopedDependencies = dependencies.filter(
    (dependency) => union.has(dependency.caller) && union.has(dependency.component),
  );
  const calleeIds = new Set(scopedDependencies.map((dependency) => dependency.component));
  // A selectable mount can also be a shared callee. Keep it in both collections: entry
  // eligibility and call eligibility are independent contracts.
  const callees = components.filter((node) => calleeIds.has(node.id));
  return Object.freeze({
    roots: freezeArray([...rootNodes]),
    callees: freezeArray(callees),
    components: freezeArray(components),
    entries: freezeArray(entries),
    dependencies: freezeArray([...scopedDependencies]),
  });
}
