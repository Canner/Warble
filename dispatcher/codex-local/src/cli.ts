#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { prepareAsk, type AskMcpServerConfig } from "./ask_prepare.js";
import { CodexAskRuntime } from "./ask_runtime.js";
import { prepareAssertion } from "./assertion_prepare.js";
import { runAssertion } from "./assertion_run.js";
import { classifyDispatchContract, supportsSetupAggregate } from "./dispatch_contract.js";
import { CodexDispatchError } from "./error.js";
import {
  buildAskManifest,
  buildAssertionManifest,
  buildEnrichManifest,
  buildManifest,
  describeAskTarget,
  describeAssertionTarget,
  describeEnrichTarget,
  describeTarget,
} from "./manifest.js";
import { discoverCodexModels } from "./model_catalog.js";
import { prepareEnrich, type EnrichMcpServerConfig } from "./enrich_prepare.js";
import { parseIr } from "./ir.js";
import { prepareAllSetup, prepareSetup, type McpServerConfig } from "./prepare.js";
import { runEnrich } from "./enrich_run.js";
import { runSetup } from "./run.js";

const USAGE =
  "usage: warble-codex-local <dispatch|manifest|describe> <ir.json> [request] " +
  "--component <id> [--server-command <absolute-path>] [options]\n" +
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
      "source-tool": { type: "string", multiple: true },
      "context-tool": { type: "string", multiple: true },
      "inspect-tool": { type: "string", multiple: true },
      "query-tool": { type: "string", multiple: true },
      "semantic-tool": { type: "string", multiple: true },
      "raw-material-tool": { type: "string", multiple: true },
      "orchestrator-model": { type: "string" },
      "cheap-model": { type: "string" },
      "strong-model": { type: "string" },
      "codex-home": { type: "string" },
      "stream-json": { type: "boolean" },
      invocation: { type: "string" },
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
  const raw = readFileSync(resolve(irPathArg), "utf8");
  const ir = parseIr(raw);
  const model = values.model ?? "gpt-5.4";

  if (!values.component && subcommand !== "dispatch" && supportsSetupAggregate(ir)) {
    if (!values["server-command"]) fail("selected component requires --server-command");
    const mcp: McpServerConfig = {
      name: values.server ?? "setup",
      command: resolve(values["server-command"]),
      args: valuesList(values["server-arg"]),
      toolsByCapability: {
        source_connect: valuesList(values["source-tool"]),
        context_build: valuesList(values["context-tool"]),
      },
    };
    const prepared = prepareAllSetup(raw, { model, mcp });
    const output = subcommand === "manifest" ? buildManifest(prepared) : describeTarget(prepared);
    const text = `${JSON.stringify(output, null, 2)}\n`;
    if (values.out) writeFileSync(resolve(values.out), text);
    else process.stdout.write(text);
    return;
  }

  const component = values.component;
  if (!component) fail(`${subcommand} requires --component for the selected component execution contract`);
  const contract = classifyDispatchContract(ir, component);

  if (contract === "assertion") {
    if (!values["cheap-model"]) fail("selected component requires --cheap-model");
    if (values.invocation !== undefined && request !== undefined) {
      fail("assertion dispatch accepts the invocation either as [request] JSON or --invocation, not both");
    }
    const preparedAssertion = prepareAssertion({
      ir: raw,
      component,
      model: values["cheap-model"],
    });
    if (subcommand === "manifest" || subcommand === "describe") {
      const output =
        subcommand === "manifest"
          ? buildAssertionManifest(preparedAssertion)
          : describeAssertionTarget(preparedAssertion);
      const text = `${JSON.stringify(output, null, 2)}\n`;
      if (values.out) writeFileSync(resolve(values.out), text);
      else process.stdout.write(text);
      return;
    }
    const rawInvocation = values.invocation ?? request;
    if (!rawInvocation) fail("assertion dispatch requires a JSON invocation envelope");
    let invocation: unknown;
    try {
      invocation = JSON.parse(rawInvocation);
    } catch {
      fail("assertion dispatch invocation must be valid JSON");
    }
    const result = await runAssertion(preparedAssertion, invocation, {
      cwd: resolve(values.project ?? "."),
      ...(values["codex-bin"] ? { codexBin: resolve(values["codex-bin"]) } : {}),
      ...(values.timeout ? { timeoutMs: Number(values.timeout) } : {}),
      ...(values["stream-json"]
        ? { onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`) }
        : {}),
    });
    if (!values["stream-json"]) process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (contract === "enrich") {
    if (!values["server-command"]) fail("selected component requires --server-command");
    const enrichMcp: EnrichMcpServerConfig = {
      name: values.server ?? "enrich",
      command: resolve(values["server-command"]),
      args: valuesList(values["server-arg"]),
      toolsByCapability: {
        semantic_introspection: valuesList(values["semantic-tool"]),
        raw_material_read: valuesList(values["raw-material-tool"]),
      },
    };
    const preparedEnrich = prepareEnrich({ ir: raw, component, model, mcp: enrichMcp });
    if (subcommand === "manifest" || subcommand === "describe") {
      const output =
        subcommand === "manifest"
          ? buildEnrichManifest(preparedEnrich)
          : describeEnrichTarget(preparedEnrich);
      const text = `${JSON.stringify(output, null, 2)}\n`;
      if (values.out) writeFileSync(resolve(values.out), text);
      else process.stdout.write(text);
      return;
    }
    if (!request) fail("dispatch requires a request");
    if (!values["codex-home"]) fail("selected component requires --codex-home");
    const result = await runEnrich(preparedEnrich, request, {
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

  if (contract === "ask") {
    if (!values["server-command"]) fail("selected component requires --server-command");
    for (const option of ["orchestrator-model", "cheap-model", "strong-model"] as const) {
      if (!values[option]) fail(`selected component requires --${option}`);
    }
    const askMcp: AskMcpServerConfig = {
      name: values.server ?? "wren",
      command: resolve(values["server-command"]),
      args: valuesList(values["server-arg"]),
      toolsByStep: {
        resolve_intent: valuesList(values["inspect-tool"]),
        generate_sql: valuesList(values["query-tool"]),
        repair_sql: valuesList(values["query-tool"]),
        plan_dashboard: valuesList(values["inspect-tool"]),
        compose_layout: valuesList(values["query-tool"]),
      },
    };
    const preparedAsk = prepareAsk({
      ir: raw,
      component,
      models: {
        orchestrator: values["orchestrator-model"]!,
        cheap: values["cheap-model"]!,
        strong: values["strong-model"]!,
      },
      mcp: askMcp,
    });
    if (subcommand === "manifest" || subcommand === "describe") {
      const output =
        subcommand === "manifest"
          ? buildAskManifest(preparedAsk)
          : describeAskTarget(preparedAsk);
      const text = `${JSON.stringify(output, null, 2)}\n`;
      if (values.out) writeFileSync(resolve(values.out), text);
      else process.stdout.write(text);
      return;
    }
    if (!request) fail("dispatch requires a request");
    if (!values["codex-home"]) fail("selected component requires --codex-home");
    const runtime = await CodexAskRuntime.connect(preparedAsk, {
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
    command: resolve(values["server-command"] ?? fail("selected component requires --server-command")),
    args: valuesList(values["server-arg"]),
    toolsByCapability: {
      source_connect: valuesList(values["source-tool"]),
      context_build: valuesList(values["context-tool"]),
    },
  };
  const prepared = prepareSetup({ ir: raw, component, model, mcp });
  if (subcommand === "manifest" || subcommand === "describe") {
    const output = subcommand === "manifest" ? buildManifest([prepared]) : describeTarget([prepared]);
    const text = `${JSON.stringify(output, null, 2)}\n`;
    if (values.out) writeFileSync(resolve(values.out), text);
    else process.stdout.write(text);
    return;
  }

  if (!request) fail("dispatch requires a request");
  const result = await runSetup(prepared, {
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
