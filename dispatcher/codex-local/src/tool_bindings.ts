import { CodexDispatchError } from "./error.js";

/** Tool authority is supplied by the caller, keyed by the IR step name. */
export interface StepToolBindings {
  toolsByStep: Record<string, string[]>;
  requireTool?: string[];
}

export function parseStepToolBindings(
  bindings: readonly string[],
  required: readonly string[],
): StepToolBindings {
  const toolsByStep: Record<string, string[]> = Object.create(null);
  for (const binding of bindings) {
    const separator = binding.indexOf("=");
    const step = binding.slice(0, separator);
    const tool = binding.slice(separator + 1);
    if (separator <= 0 || !step.trim() || !tool.trim() || tool.includes("=")) {
      throw new CodexDispatchError("--step-tool requires <step>=<tool>");
    }
    (toolsByStep[step] ??= []).push(tool);
  }
  return { toolsByStep, requireTool: [...new Set(required)] };
}

export function validateStepToolBindings(
  bindings: StepToolBindings,
  stepNames: readonly string[],
): void {
  const names = new Set(stepNames);
  for (const name of [...Object.keys(bindings.toolsByStep), ...(bindings.requireTool ?? [])]) {
    if (!names.has(name)) {
      throw new CodexDispatchError(`tool binding names unknown step '${name}'`);
    }
  }
  for (const [name, tools] of Object.entries(bindings.toolsByStep)) {
    if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string" || !tool.trim())) {
      throw new CodexDispatchError(`step '${name}' requires nonempty MCP tool names`);
    }
  }
  for (const name of bindings.requireTool ?? []) {
    if (toolsForStep(bindings, name).length === 0) {
      throw new CodexDispatchError(`step '${name}' requires a tool but has no allowlisted MCP tools`);
    }
  }
}

export function toolsForStep(bindings: StepToolBindings, name: string): string[] {
  return Object.hasOwn(bindings.toolsByStep, name)
    ? [...new Set(bindings.toolsByStep[name])]
    : [];
}
