#!/usr/bin/env node
import { loadLaunch } from "./launch-config.js";
import { HybridPlanner } from "./planner.js";
import { runTui } from "./tui.js";

const args = process.argv.slice(2);
if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
  console.log("Usage: warble-pi launch <generated-directory>\nRequires Node >=22.19 and a TTY. No resume/import/discovery options.");
} else if (args.length !== 2 || args[0] !== "launch" || args[1]!.startsWith("-")) {
  console.error("Usage: warble-pi launch <generated-directory>"); process.exitCode = 2;
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("pi:hybrid requires an interactive terminal."); process.exitCode = 2;
} else {
  let planner: HybridPlanner | undefined;
  try {
    const { bundle, adapter } = await loadLaunch(args[1]!);
    // Snapshot only explicitly named credential references; no catalog/auth/proxy discovery.
    const credentials = new Map<string, string>();
    for (const binding of Object.values(bundle.config.models)) credentials.set(binding.credentialEnv, process.env[binding.credentialEnv] ?? "");
    for (const project of Object.values(bundle.config.projects)) for (const tiers of Object.values(project.privateModels)) {
      for (const binding of Object.values(tiers)) credentials.set(binding.credentialEnv, process.env[binding.credentialEnv] ?? "");
    }
    planner = new HybridPlanner(bundle, adapter, name => credentials.get(name) ?? "");
    await runTui(planner);
  } catch { console.error("Hybrid launch unavailable: verify artifact integrity, bindings and explicit credentials."); process.exitCode = 1; }
  finally { planner?.close(); }
}
