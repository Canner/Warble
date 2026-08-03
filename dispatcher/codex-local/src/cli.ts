#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { CodexDispatchError } from "./error.js";
import { buildManifest, describeTarget } from "./manifest.js";
import { buildAskManifest, describeAskTarget } from "./manifest.js";
import { prepareAsk, type AskMcpServerConfig } from "./ask_prepare.js";
import { CodexAskRuntime } from "./ask_runtime.js";
import { prepareAllSetup, prepareSetup, type McpServerConfig } from "./prepare.js";
import { runSetup } from "./run.js";

const USAGE =
  "usage: warble-codex-local <dispatch|manifest|describe|dispatch-ask|manifest-ask|describe-ask> <ir.json> [request] " +
  "--server-command <absolute-path> --source-tool <name> --context-tool <name> [options]";

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
      "orchestrator-model": { type: "string" },
      "cheap-model": { type: "string" },
      "strong-model": { type: "string" },
      "codex-home": { type: "string" },
      "stream-json": { type: "boolean" },
    },
  });
  const [subcommand, irPathArg, request] = positionals;
  if (![
    "dispatch",
    "manifest",
    "describe",
    "dispatch-ask",
    "manifest-ask",
    "describe-ask",
  ].includes(subcommand ?? "")) fail(USAGE);
  if (!irPathArg) fail("missing <ir.json>");
  if (!values["server-command"]) fail("missing --server-command");

  const mcp: McpServerConfig = {
    name: values.server ?? "setup",
    command: resolve(values["server-command"]),
    args: valuesList(values["server-arg"]),
    toolsByCapability: {
      source_connect: valuesList(values["source-tool"]),
      context_build: valuesList(values["context-tool"]),
    },
  };
  const raw = readFileSync(resolve(irPathArg), "utf8");
  const model = values.model ?? "gpt-5.4";

  if (subcommand?.endsWith("-ask")) {
    const component = values.component;
    if (!component) fail(`${subcommand} requires --component`);
    for (const option of ["orchestrator-model", "cheap-model", "strong-model"] as const) {
      if (!values[option]) fail(`${subcommand} requires --${option}`);
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
    if (subcommand === "manifest-ask" || subcommand === "describe-ask") {
      const output =
        subcommand === "manifest-ask"
          ? buildAskManifest(preparedAsk)
          : describeAskTarget(preparedAsk);
      const text = `${JSON.stringify(output, null, 2)}\n`;
      if (values.out) writeFileSync(resolve(values.out), text);
      else process.stdout.write(text);
      return;
    }
    if (!request) fail("dispatch-ask requires a request");
    if (!values["codex-home"]) fail("dispatch-ask requires --codex-home");
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

  if (subcommand === "manifest" || subcommand === "describe") {
    const prepared = prepareAllSetup(raw, { model, mcp });
    const output =
      subcommand === "manifest" ? buildManifest(prepared) : describeTarget(prepared);
    const text = `${JSON.stringify(output, null, 2)}\n`;
    if (values.out) writeFileSync(resolve(values.out), text);
    else process.stdout.write(text);
    return;
  }

  if (!request) fail("dispatch requires a request");
  const component = values.component;
  if (!component) fail("dispatch requires --component connect_source|build_context");
  const prepared = prepareSetup({ ir: raw, component, model, mcp });
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
