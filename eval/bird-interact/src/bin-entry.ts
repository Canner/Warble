import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Whether the calling module is the file node was actually asked to run.
 *
 * Node's ESM loader resolves the main module through `realpath` before it records
 * `import.meta.url`, while `process.argv[1]` keeps whatever path the shell handed over. npm
 * publishes every `bin` as a symlink under `node_modules/.bin`, so comparing the two verbatim is
 * false for `npx`, `npm exec`, `npm link` and workspace installs -- precisely the invocations the
 * `bin` field exists for -- and `main()` never runs: the process exits zero having printed nothing.
 * Resolving `argv[1]` through the same `realpath` the loader applied makes the two comparable.
 *
 * A path that cannot be resolved (deleted between spawn and this call, or a broken link) falls
 * back to the absolute form, which is what the comparison used before symlinks were handled.
 */
export function isDirectExecution(moduleUrl: string): boolean {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) return false;
  const absolute = resolve(invokedPath);
  let resolved: string;
  try {
    resolved = realpathSync(absolute);
  } catch {
    resolved = absolute;
  }
  return moduleUrl === pathToFileURL(resolved).href;
}
