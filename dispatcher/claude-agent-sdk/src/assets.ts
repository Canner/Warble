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
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

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
      // The manifest is re-validated here, not trusted. Compile checks the *authored* reference
      // against the component directory, but an IR is a document that can arrive from anywhere and
      // nothing has looked at this path since. Without the check, a manifest entry of
      // `../../../etc/whatever` is an arbitrary file write.
      assertContainedRelativePath(asset.path, node.id);
      const source = join(sourceRoot, node.id, asset.path);
      // Everything about the source is decided before it is opened. Ordering here has bitten twice:
      // checking containment first masked an absent travelling directory with a resolution error,
      // and reading first let a FIFO planted at a declared path hang the read forever — before any
      // check could refuse it, and for an in-root path the symlink check cannot help with. So:
      // existence, then location, then file kind, then read.
      try {
        lstatSync(source);
      } catch (e) {
        throw new DispatchError(
          `asset '${asset.path}' of component '${node.id}' is declared in the IR but missing from ` +
            `${sourceRoot} (${(e as Error).message}). An IR's assets travel in that directory; ` +
            `copying the IR without it leaves a component without the files it declared.`,
        );
      }
      assertResolvesInside(sourceRoot, source, "asset source");
      if (!statSync(source).isFile()) {
        throw new DispatchError(
          `asset '${asset.path}' of component '${node.id}' is not a regular file. Reading a pipe ` +
            `or device would block the dispatch indefinitely instead of failing, so anything that ` +
            `is not a plain file is refused.`,
        );
      }
      const data = readFileSync(source);
      const actual = `sha256:${createHash("sha256").update(data).digest("hex")}`;
      if (actual !== asset.hash) {
        throw new DispatchError(
          `asset '${asset.path}' of component '${node.id}' does not match its manifest (expected ` +
            `${asset.hash}, found ${actual}). The file changed after the IR was compiled; recompile ` +
            `rather than dispatching content the manifest does not name.`,
        );
      }
      const target = join(cwd, asset.path);
      assertResolvesInside(cwd, target, "asset target");
      pending.push({ target, data });
    }
  }

  for (const { target, data } of pending) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  return pending.map(({ target }) => target);
}

/**
 * Refuse a manifest path that is absolute or that climbs out of the directory it is joined to.
 *
 * Mirrors the compiler's rule for an authored file reference, and for the same reason: `join` alone
 * allows both escapes — an absolute path replaces the base entirely, and `..` segments are never
 * normalized away. Both sides need the check because compile validates what an author wrote while
 * this validates what a manifest says, and those are different documents.
 */
function assertContainedRelativePath(relative: string, componentId: string): void {
  const climbs = relative.split(/[\\/]/).includes("..");
  if (isAbsolute(relative) || climbs || relative.startsWith(sep)) {
    throw new DispatchError(
      `asset path '${relative}' of component '${componentId}' must be a relative path with no '..' ` +
        `segments. A manifest naming a path outside the directory it lands in would be an arbitrary ` +
        `file write, so it is refused rather than resolved.`,
    );
  }
}

/**
 * Confirm a path still resolves inside `root` once the filesystem has had its say.
 *
 * The string check is not enough on its own, and this is the second half of the same lesson: it
 * inspects what the manifest *says*, and a syntactically clean relative path — no `..`, not absolute
 * — still escapes when a component of it is a symlink pointing elsewhere. That is reachable here in
 * particular: this back-end's working directory is the bound project, a real directory somebody else
 * may have written to.
 *
 * `target` need not exist: the nearest existing ancestor is resolved and checked, and the segments
 * below it cannot be a symlink because nothing has created them.
 */
function assertResolvesInside(root: string, target: string, what: string): void {
  const canonicalRoot = realpathSync(root);
  let existing = resolve(target);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      throw new DispatchError(`${what} '${target}' has no resolvable ancestor`);
    }
    existing = parent;
  }
  const anchor = realpathSync(existing);
  const contained = anchor === canonicalRoot || anchor.startsWith(canonicalRoot + sep);
  if (!contained) {
    throw new DispatchError(
      `${what} '${target}' resolves outside ${canonicalRoot} once symlinks are followed. A path ` +
        `that looks contained but is not is refused rather than followed, because the manifest is ` +
        `data and the filesystem is what decides where a write actually lands.`,
    );
  }
}
