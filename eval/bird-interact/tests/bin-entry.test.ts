import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageDir = resolve(import.meta.dirname, "..");

const BINS = ["autopsy-cli", "cli", "prepare-cli", "report-cli", "smoke-cli"] as const;

/** The published `bin` map: every declared name, and the built file it points at. */
async function declaredBins(): Promise<Record<string, string>> {
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
  };
  return manifest.bin ?? {};
}

/**
 * Every module specifier a source imports: `import ... from "x"` and `export ... from "x"`,
 * side-effect `import "x"`, and dynamic `import("x")`.
 */
function importedSpecifiers(source: string): string[] {
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
  ];
  const specifiers: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

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

/**
 * The other half of the same guard, read straight off the sources.
 *
 * A bin that imports another bin inlines the imported entry's own
 * `import.meta.url === pathToFileURL(process.argv[1])` guard into the importing bundle, and both
 * `main()`s then run: the observed symptom was `--version` printing twice. The built-bin check
 * below sees that only after a build; this one needs nothing built, so it runs on every clone and
 * in every job. Shared code belongs in a module that is not itself an entry -- `cli-usage.ts`,
 * `report-html.ts`, `runtime-layout.ts` -- never in another bin.
 */
test("no bin entry imports another bin entry", async () => {
  const binModules = Object.values(await declaredBins()).map((built) => basename(built, ".js"));
  assert.deepEqual(
    [...binModules].sort(),
    [...BINS].sort(),
    "package.json's bins and this file's BINS must name the same entry modules",
  );

  for (const module of binModules) {
    const source = await readFile(join(packageDir, "src", `${module}.ts`), "utf8");
    for (const specifier of importedSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const imported = basename(specifier, ".js");
      assert.ok(
        !binModules.includes(imported),
        `src/${module}.ts imports src/${imported}.ts, which is itself a bin entry. Bundling inlines ` +
          `that entry's direct-execution guard into ${module}, so running ${module} runs both mains ` +
          `(the observed symptom: --version printed twice). Move the shared code into a non-bin module.`,
      );
    }
  }
});

/**
 * Builds the package, and says so plainly when the build is what failed.
 *
 * Nothing about a bin can be checked in a tree that does not build, and a raw bundler stack trace
 * in the middle of a test report reads like a broken test rather than a broken tree.
 */
async function buildPackage(): Promise<void> {
  try {
    await execFileAsync("npm", ["run", "build"], {
      cwd: packageDir,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const detail =
      typeof (error as { stderr?: unknown }).stderr === "string"
        ? String((error as { stderr?: unknown }).stderr)
        : String(error);
    assert.fail(
      "'npm run build' failed, so the built bins could not be checked. A package that does not " +
        "build ships no bins at all; `npm run check-types` names the same problems. Last of the " +
        `build output:\n${detail.trim().slice(-2000)}`,
    );
  }
}

/**
 * Builds before it looks, on purpose.
 *
 * Nothing else in `npm test` builds -- every other test runs the TypeScript through tsx -- so this
 * test builds the package itself. Without that, `dist/` is absent on a fresh clone and the check
 * has nothing to execute (it used to say so in a diagnostic and pass, which is how a doubled entry
 * guard reached a full review), or `dist/` is stale and the check blesses bytes no source in the
 * tree still produces. Building here keeps `npm test` one self-sufficient command rather than one
 * that silently depends on someone having run `npm run build` first.
 */
test("every declared bin points at a built entry that actually executes", async () => {
  const bins = await declaredBins();
  assert.deepEqual(Object.keys(bins).sort(), [
    "warble-bird-autopsy",
    "warble-bird-interact",
    "warble-bird-prepare",
    "warble-bird-report",
    "warble-bird-smoke",
  ]);

  await buildPackage();

  for (const [name, relative] of Object.entries(bins)) {
    const built = resolve(packageDir, relative);
    assert.ok(
      (await lstat(built).catch(() => null)) !== null,
      `${name} points at ${relative}, which 'npm run build' did not produce`,
    );
    const version = await execFileAsync(process.execPath, [built, "--version"]);
    assert.match(
      version.stdout.trim(),
      /^\d+\.\d+\.\d+$/,
      `${name} must print its version once instead of exiting silently or printing it twice`,
    );
    const help = await execFileAsync(process.execPath, [built, "--help"]);
    assert.ok(help.stdout.includes("Usage:"), `${name} must print usage instead of exiting silently`);
  }
});
