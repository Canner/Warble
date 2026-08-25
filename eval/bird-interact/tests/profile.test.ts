import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("the BIRD profile compiles to one external-context component without a schema digest", async () => {
  const repository = resolve(import.meta.dirname, "../../..");
  const profile = resolve(import.meta.dirname, "..", "agents", "baseline");
  const temporary = await mkdtemp(join(tmpdir(), "warble-bird-profile-"));
  const output = join(temporary, "ir.json");
  try {
    await execFileAsync(
      "cargo",
      [
        "run",
        "--quiet",
        "--locked",
        "-p",
        "warble-cli",
        "--",
        "compile",
        profile,
        "-o",
        output,
      ],
      { cwd: repository },
    );
    const ir = JSON.parse(await readFile(output, "utf8")) as {
      context_binding: { project: string; resolved?: unknown };
      components: Array<{
        id: string;
        context_binding: { project: string; resolved?: unknown };
        llm_calls: Array<{ tier: string }>;
        context_precondition: unknown[];
        required_capabilities: string[];
        borrowed_actions: string[];
      }>;
    };

    assert.equal(ir.context_binding.project, "bird-interact://runtime");
    assert.equal("resolved" in ir.context_binding, false);
    assert.equal(ir.components.length, 1);
    assert.equal(ir.components[0]?.id, "bird_interact");
    assert.equal(ir.components[0]?.context_binding.project, "bird-interact://runtime");
    assert.equal("resolved" in (ir.components[0]?.context_binding ?? {}), false);
    assert.deepEqual(ir.components[0]?.llm_calls.map((call) => call.tier), ["strong"]);
    assert.deepEqual(ir.components[0]?.context_precondition, []);
    assert.deepEqual(ir.components[0]?.borrowed_actions, []);
    assert.equal(
      ir.components[0]?.required_capabilities.some((capability) =>
        capability.includes("sql"),
      ),
      false,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
