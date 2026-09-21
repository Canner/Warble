#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { prepareOrchestrate, type OrchestrateMcpServerConfig } from "./orchestrate_prepare.js";
import { CodexOrchestrateRuntime } from "./orchestrate_runtime.js";
import { parseStepToolBindings, validateStepToolBindings } from "./tool_bindings.js";
import { CodexDispatchError } from "./error.js";
import {
  buildOrchestrateManifest,
  buildTurnManifest,
  buildManifest,
  describeOrchestrateTarget,
  describeTurnTarget,
  describeTarget,
} from "./manifest.js";
import { discoverCodexModels } from "./model_catalog.js";
import { prepareTurn, type TurnMcpServerConfig } from "./turn_prepare.js";
import { parseIr } from "./ir.js";
import { prepareAllExec, prepareExec, type McpServerConfig } from "./exec_prepare.js";
import { runTurn } from "./turn_run.js";
import { runExec } from "./exec_run.js";
import { prepareComponentInvocation, buildInvocationManifest, isRecord, type ComponentBinding, type InvocationLimits } from "./component_invocation.js";
import { runComponentInvocation } from "./component_runtime.js";

const USAGE =
  "usage: warble-codex-local <dispatch|manifest|describe> <ir.json> [request] " +
  "--component <id> --server-command <absolute-path> [options]\n" +
  "       warble-codex-local list-models [--project <dir>] [--codex-home <dir>] [--codex-bin <path>] [--timeout <ms>]";

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function valuesList(value: string[] | string | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      component: { type: "string" },
      model: { type: "string" },
      project: { type: "string" },
      out: { type: "string" },
      timeout: { type: "string" },
      "codex-bin": { type: "string" },
      server: { type: "string" },
      "server-command": { type: "string" },
      "server-arg": { type: "string", multiple: true },
      transport: { type: "string" },
      "step-tool": { type: "string", multiple: true },
      "component-bindings": { type: "string" },
      "require-tool": { type: "string", multiple: true },
      "orchestrator-model": { type: "string" },
      "cheap-model": { type: "string" },
      "strong-model": { type: "string" },
      "codex-home": { type: "string" },
      "stream-json": { type: "boolean" },
    },
  });
  const [subcommand, irPathArg, request] = positionals;
  if (subcommand === "list-models") {
    if (irPathArg !== undefined || request !== undefined) fail("list-models does not take an <ir.json> or request");
    const timeout = values.timeout === undefined ? undefined : Number(values.timeout);
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) fail("--timeout must be a positive number");
    const catalog = await discoverCodexModels({
      ...(values.project ? { cwd: values.project } : {}),
      ...(values["codex-home"] ? { codexHome: values["codex-home"] } : {}),
      ...(values["codex-bin"] ? { codexBin: values["codex-bin"] } : {}),
      ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
    });
    process.stdout.write(`${JSON.stringify(catalog)}\n`);
    return;
  }
  if (!["dispatch", "manifest", "describe"].includes(subcommand ?? "")) fail(USAGE);
  if (!irPathArg) fail("missing <ir.json>");
  if (!values["server-command"] && !values["component-bindings"]) fail("missing --server-command");
  const contract = values.transport;
  if (contract !== "exec" && contract !== "turn" && contract !== "orchestrate") {
    fail("--transport must explicitly select exec, turn, or orchestrate");
  }
  const bindings = parseStepToolBindings(valuesList(values["step-tool"]), valuesList(values["require-tool"]));
  const raw = readFileSync(resolve(irPathArg), "utf8");
  const ir = parseIr(raw);
  const model = values.model ?? "gpt-5.4";
  if (values["component-bindings"]) {
    if (contract !== "orchestrate" || !values.component) fail("component bindings require orchestrate and --component");
    if (values["step-tool"] || values["require-tool"] || values["server-command"] || values.server || values["server-arg"] || values.model || values["cheap-model"] || values["strong-model"] || values["orchestrator-model"]) fail("component bindings own all per-component tools and models; do not combine binding flags");
    const config: unknown = JSON.parse(readFileSync(resolve(values["component-bindings"]), "utf8"));
    if (!isRecord(config) || !isRecord(config.components) || Object.keys(config).some((key) => key !== "components" && key !== "limits")) fail("invalid component binding file");
    const prepared = prepareComponentInvocation({ir: raw, component: values.component, bindings: config.components as unknown as Record<string, ComponentBinding>, ...(config.limits === undefined ? {} : {limits: config.limits as InvocationLimits})});
    if (subcommand !== "dispatch") {
      const output = `${JSON.stringify(buildInvocationManifest(prepared), null, 2)}\n`;
      if (values.out) writeFileSync(resolve(values.out), output); else process.stdout.write(output);
      return;
    }
    if (!request || !values["codex-home"]) fail("composed dispatch requires request and --codex-home");
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try {
      const result = await runComponentInvocation(prepared, {request}, {
        codexHome: resolve(values["codex-home"]), cwd: resolve(values.project ?? "."), externalAuthentication: "provisioned", signal: abort.signal,
        ...(values["codex-bin"] ? {codexBin: resolve(values["codex-bin"])} : {}),
        ...(values.timeout ? {timeoutMs: Number(values.timeout)} : {}),
        ...(values["stream-json"] ? {onTrace: (trace) => process.stdout.write(`${JSON.stringify({t: "component_call", ...trace})}\n`)} : {}),
      });
      process.stdout.write(values["stream-json"] ? `${JSON.stringify({t: "answer", text: result.finalText})}\n` : `${result.finalText}\n`);
    } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
    return;
  }


  if (!values.component && subcommand !== "dispatch" && contract === "exec") {
    const mcp: McpServerConfig = {
      name: values.server ?? "setup",
      command: resolve(values["server-command"]!),
      args: valuesList(values["server-arg"]),
      ...bindings,
    };
    const prepared = prepareAllExec(raw, { model, mcp });
    const output = subcommand === "manifest" ? buildManifest(prepared) : describeTarget(prepared);
    const text = `${JSON.stringify(output, null, 2)}\n`;
    if (values.out) writeFileSync(resolve(values.out), text);
    else process.stdout.write(text);
    return;
  }

  const component = values.component;
  if (!component) fail(`${subcommand} requires --component for the selected component execution contract`);
  const selected = ir.components.find((node) => node.id === component);
  const validateSelectedBindings = () => {
    if (selected) validateStepToolBindings(bindings, selected.llm_calls.map((step) => step.name));
  };

  if (contract === "turn") {
    const enrichMcp: TurnMcpServerConfig = {
      name: values.server ?? "enrich",
      command: resolve(values["server-command"]!),
      args: valuesList(values["server-arg"]),
      ...bindings,
    };
    const preparedEnrich = prepareTurn({ ir: raw, component, model, mcp: enrichMcp });
    validateSelectedBindings();
    if (subcommand === "manifest" || subcommand === "describe") {
      const output =
        subcommand === "manifest"
          ? buildTurnManifest(preparedEnrich)
          : describeTurnTarget(preparedEnrich);
      const text = `${JSON.stringify(output, null, 2)}\n`;
      if (values.out) writeFileSync(resolve(values.out), text);
      else process.stdout.write(text);
      return;
    }
    if (!request) fail("dispatch requires a request");
    if (!values["codex-home"]) fail("selected component requires --codex-home");
    const result = await runTurn(preparedEnrich, request, {
      codexHome: resolve(values["codex-home"]),
      cwd: resolve(values.project ?? "."),
      externalAuthentication: "provisioned",
      ...(values["codex-bin"] ? { codexBin: resolve(values["codex-bin"]) } : {}),
      ...(values.timeout ? { timeoutMs: Number(values.timeout) } : {}),
      ...(values["stream-json"]
        ? { onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`) }
        : {}),
    });
    if (!values["stream-json"]) process.stdout.write(`${result.finalText}\n`);
    return;
  }

  if (contract === "orchestrate") {
    for (const option of ["orchestrator-model", "cheap-model", "strong-model"] as const) {
      if (!values[option]) fail(`selected component requires --${option}`);
    }
    const askMcp: OrchestrateMcpServerConfig = {
      name: values.server ?? "wren",
      command: resolve(values["server-command"]!),
      args: valuesList(values["server-arg"]),
      ...bindings,
    };
    const preparedAsk = prepareOrchestrate({
      ir: raw,
      component,
      models: {
        orchestrator: values["orchestrator-model"]!,
        cheap: values["cheap-model"]!,
        strong: values["strong-model"]!,
      },
      mcp: askMcp,
    });
    validateSelectedBindings();
    if (subcommand === "manifest" || subcommand === "describe") {
      const output =
        subcommand === "manifest"
          ? buildOrchestrateManifest(preparedAsk)
          : describeOrchestrateTarget(preparedAsk);
      const text = `${JSON.stringify(output, null, 2)}\n`;
      if (values.out) writeFileSync(resolve(values.out), text);
      else process.stdout.write(text);
      return;
    }
    if (!request) fail("dispatch requires a request");
    if (!values["codex-home"]) fail("selected component requires --codex-home");
    const runtime = await CodexOrchestrateRuntime.connect(preparedAsk, {
      codexHome: resolve(values["codex-home"]),
      cwd: resolve(values.project ?? "."),
      externalAuthentication: "provisioned",
      ...(values["codex-bin"] ? { codexBin: resolve(values["codex-bin"]) } : {}),
      ...(values.timeout ? { turnTimeoutMs: Number(values.timeout) } : {}),
      ...(values["stream-json"]
        ? { onAskEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`) }
        : {}),
    });
    try {
      const session = await runtime.start();
      const result = await runtime.run(session, request);
      if (values["stream-json"]) {
        process.stdout.write(`${JSON.stringify({ t: "answer", text: result.finalText })}\n`);
      } else {
        process.stdout.write(`${result.finalText}\n`);
      }
    } finally {
      await runtime.close();
    }
    return;
  }

  const mcp: McpServerConfig = {
    name: values.server ?? "setup",
    command: resolve(values["server-command"]!),
    args: valuesList(values["server-arg"]),
    ...bindings,
  };
  const prepared = prepareExec({ ir: raw, component, model, mcp });
  validateSelectedBindings();
  if (subcommand === "manifest" || subcommand === "describe") {
    const output = subcommand === "manifest" ? buildManifest([prepared]) : describeTarget([prepared]);
    const text = `${JSON.stringify(output, null, 2)}\n`;
    if (values.out) writeFileSync(resolve(values.out), text);
    else process.stdout.write(text);
    return;
  }

  if (!request) fail("dispatch requires a request");
  const result = await runExec(prepared, {
    cwd: resolve(values.project ?? "."),
    request,
    ...(values["codex-bin"] ? { codexBin: resolve(values["codex-bin"]) } : {}),
    ...(values.timeout ? { timeoutMs: Number(values.timeout) } : {}),
    ...(values["stream-json"]
      ? {
          onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
        }
      : {}),
  });
  if (!values["stream-json"]) process.stdout.write(`${result.finalText}\n`);
}

main().catch((error: unknown) => {
  if (error instanceof CodexDispatchError) fail(error.message);
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
});
