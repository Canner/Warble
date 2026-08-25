import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageDir = resolve(import.meta.dirname, "..");

const BINS = ["cli", "prepare-cli", "report-cli", "smoke-cli"] as const;

/**
 * Every bin guards `main()` with `import.meta.url === pathToFileURL(process.argv[1])`. Bundling the
 * shared code into a chunk moves that guard out of the entry file, and the comparison then never
 * matches: the CLI exits zero having done nothing at all.
 */
test("the bundler keeps every bin a single self-contained entry file", async () => {
  const config = await readFile(join(packageDir, "tsup.config.ts"), "utf8");
  assert.match(config, /splitting:\s*false/, "code splitting would break every direct-execution guard");
  for (const bin of BINS) {
    assert.ok(config.includes(`src/${bin}.ts`), `${bin} must be a build entry`);
  }
});

test("every declared bin points at a built entry that actually executes", async (t: TestContext) => {
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
  };
  const bins = manifest.bin ?? {};
  assert.deepEqual(Object.keys(bins).sort(), [
    "warble-bird-interact",
    "warble-bird-prepare",
    "warble-bird-report",
    "warble-bird-smoke",
  ]);

  for (const [name, relative] of Object.entries(bins)) {
    const built = resolve(packageDir, relative);
    if ((await lstat(built).catch(() => null)) === null) {
      t.diagnostic(`skipping ${name}: run 'npm run build' to cover the built entry`);
      continue;
    }
    const version = await execFileAsync(process.execPath, [built, "--version"]);
    assert.match(
      version.stdout.trim(),
      /^\d+\.\d+\.\d+$/,
      `${name} must print its version instead of exiting silently`,
    );
    const help = await execFileAsync(process.execPath, [built, "--help"]);
    assert.ok(help.stdout.includes("Usage:"), `${name} must print usage instead of exiting silently`);
  }
});
