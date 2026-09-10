import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { ModelConfig, prepareDispatch } from "@warble/claude-agent-sdk";

import { BIRD_MCP_TOOL_NAMES, buildBirdAgentOptions } from "../src/agent.js";

const execFileAsync = promisify(execFile);

const repository = resolve(import.meta.dirname, "../../..");
const packageRoot = resolve(import.meta.dirname, "..");
const baseline = join(packageRoot, "agents", "baseline");

// Scratch profiles live under the package's ignored `data/` tree rather than the system temp
// directory: a profile the smoke will accept has to sit inside the repository, so a mutation that
// only ever compiles from outside it would be testing a shape the real command refuses.
const scratchRoot = join(packageRoot, "data");

/** Compile a profile the way the smoke does -- its first child process, same binary, same flags. */
async function compile(profile: string, output: string): Promise<string> {
  await execFileAsync(
    "cargo",
    ["run", "--quiet", "--locked", "-p", "warble-cli", "--", "compile", profile, "-o", output],
    { cwd: repository },
  );
  return readFile(output, "utf8");
}

/** The lookup `src/agent.ts` performs, reproduced exactly, reporting absence instead of throwing. */
function dispatchComponent(ir: string, irPath: string) {
  const prepared = prepareDispatch({
    ir,
    irPath,
    project: packageRoot,
    componentId: "bird_interact",
    question: "how many rows are there",
    models: ModelConfig.fromFlags("sonnet", "sonnet", "sonnet"),
    maxTurns: 60,
  });
  return prepared.components.find((candidate) => candidate.id === "bird_interact");
}

test("the baseline profile, really compiled, prepares a dispatch inside the fixed BIRD envelope", async () => {
  const temporary = await mkdtemp(join(scratchRoot, "dispatch-baseline-"));
  const irPath = join(temporary, "agent-ir.json");
  try {
    const ir = await compile(baseline, irPath);
    const component = dispatchComponent(ir, irPath);
    assert.ok(component, "compiled IR has no bird_interact component");

    // The step file on disk is the assertion -- not a paraphrase of it, and not a fixture that can
    // drift away from the profile being measured. Note what dispatch actually hands the model: the
    // step's body is verbatim, but a `## <step name>` header is prepended even for a single step,
    // so the system prompt is NOT byte-identical to the file. Pinning the header too is the point:
    // renaming the step silently rewrites the model's first line.
    const solve = await readFile(
      join(baseline, "components", "bird_interact", "steps", "solve.md"),
      "utf8",
    );
    assert.equal(component.node.prompt_fragment.trim(), `## solve\n\n${solve.trim()}`);

    const options = buildBirdAgentOptions({
      baseOptions: component.plan.options,
      cwd: packageRoot,
      mcpServer: { type: "sdk", name: "fake" } as never,
      systemPrompt: component.node.prompt_fragment,
    });

    // Discriminating: the declared surface is NOT already the harness's, so the assertions below
    // describe an override that really happens rather than constants that would hold for any input.
    // Worth reading once -- what the profile's locked `read_only_execution` guardrail compiles to is
    // a three-pattern Bash deny-list, not a ban on Bash.
    const declared = component.plan.options;
    assert.notDeepEqual(declared.tools, [], "nothing to override: the profile declared no tools");
    assert.ok(!declared.disallowedTools?.includes("Bash"), "the profile already banned Bash outright");
    assert.notEqual(declared.permissionMode, "dontAsk");

    // Whatever the profile declared, the harness's surface is what the model gets.
    assert.deepEqual(options.tools, []);
    assert.deepEqual([...(options.allowedTools ?? [])].sort(), [...BIRD_MCP_TOOL_NAMES].sort());
    for (const built_in of ["Bash", "Read", "Write", "WebFetch", "AskUserQuestion"]) {
      assert.ok(options.disallowedTools?.includes(built_in), `${built_in} must stay disallowed`);
    }
    assert.equal(options.systemPrompt, component.node.prompt_fragment);
    assert.equal(options.permissionMode, "dontAsk");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

// The discriminating half. Without it the test above cannot distinguish reading the compiled IR
// from asserting constants the harness would produce for any input at all.
test("a profile whose component is not bird_interact fails the lookup the harness performs", async () => {
  const temporary = await mkdtemp(join(scratchRoot, "dispatch-mutated-"));
  const profile = join(temporary, "renamed");
  const irPath = join(temporary, "agent-ir.json");
  try {
    await cp(baseline, profile, { recursive: true });
    await rename(
      join(profile, "components", "bird_interact"),
      join(profile, "components", "other_component"),
    );
    const componentYml = join(profile, "components", "other_component", "component.yml");
    await writeFile(
      componentYml,
      (await readFile(componentYml, "utf8"))
        .replace(/^id: bird_interact$/m, "id: other_component")
        .replace(/^verb: bird_interact$/m, "verb: other_component"),
    );
    const profileYml = join(profile, "profile.yml");
    await writeFile(
      profileYml,
      (await readFile(profileYml, "utf8")).replace("- use: bird_interact", "- use: other_component"),
    );

    const ir = await compile(profile, irPath);
    assert.match(ir, /other_component/, "the mutation did not reach the compiled IR");

    let found: unknown;
    try {
      found = dispatchComponent(ir, irPath);
    } catch {
      found = undefined;
    }
    assert.equal(found, undefined, "the lookup accepted an IR with no bird_interact component");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
