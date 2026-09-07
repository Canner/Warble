/**
 * Landing a component's declared assets where the agent can find them.
 *
 * IR 0.7 lets a component declare `assets:` and compile records each file's identity, but nothing
 * consumed the manifest: a component declared the files it needs and the agent then ran in a
 * directory that did not contain them, with no error. Landing them is what makes the declaration
 * mean anything.
 *
 * **Content comes from a directory beside the IR**, written by `warble compile`. That is the only
 * place that has it: the compiler is sans-IO, so the host hashes the bytes there, and by dispatch
 * there is no component directory at all — a Hub component was resolved over the network at compile,
 * possibly on another machine. Re-reading a component directory here would work in a checkout and
 * fail everywhere else. See the asset-landing decision.
 *
 * **Where they land, and what that costs.** At the authored relative path inside the agent's working
 * directory, because that is what the author wrote and the only place it resolves. For this back-end
 * the working directory is the bound project, so landing writes into it — a real side effect, listed
 * here rather than buried: only files the manifest names are written, and a hash mismatch or a
 * missing file refuses before anything is written at all.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

import { DispatchError } from "./error.js";
import type { WarbleIr } from "./ir.js";

/** The directory an IR's assets travel in, derived from the IR's own path. Mirrors the Rust CLI's. */
export function assetDirForIr(irPath: string): string {
  const { dir, name } = parse(resolve(irPath));
  return join(dir, `${name}.assets`);
}

/**
 * Land every asset the IR's components declare into `cwd`, verifying each against its manifest.
 *
 * Returns the paths written, empty when no component declares an asset — a pre-0.7-shaped IR, or any
 * profile that does not use the feature, touches nothing.
 *
 * **Reads and verifies everything before writing anything.** A refusal partway through would leave a
 * directory holding some of a component's files, which is harder to diagnose than either outcome:
 * the whole set lands, or none of it does and the dispatch stops.
 */
export function landAssets(ir: WarbleIr, irPath: string, cwd: string): string[] {
  const sourceRoot = assetDirForIr(irPath);
  const pending: { target: string; data: Buffer }[] = [];

  for (const node of ir.components) {
    for (const asset of node.assets ?? []) {
      const source = join(sourceRoot, node.id, asset.path);
      let data: Buffer;
      try {
        data = readFileSync(source);
      } catch (e) {
        throw new DispatchError(
          `asset '${asset.path}' of component '${node.id}' is declared in the IR but missing from ` +
            `${sourceRoot} (${(e as Error).message}). An IR's assets travel in that directory; ` +
            `copying the IR without it leaves a component without the files it declared.`,
        );
      }
      const actual = `sha256:${createHash("sha256").update(data).digest("hex")}`;
      if (actual !== asset.hash) {
        throw new DispatchError(
          `asset '${asset.path}' of component '${node.id}' does not match its manifest (expected ` +
            `${asset.hash}, found ${actual}). The file changed after the IR was compiled; recompile ` +
            `rather than dispatching content the manifest does not name.`,
        );
      }
      pending.push({ target: join(cwd, asset.path), data });
    }
  }

  for (const { target, data } of pending) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  return pending.map(({ target }) => target);
}
