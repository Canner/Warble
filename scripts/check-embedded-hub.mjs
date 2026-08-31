#!/usr/bin/env node
//
// `cli/embedded-hub/` is a checked-in copy of `hub/components/`, baked into the `warble` binary
// by `cli/build.rs` via `include_bytes!` so every distribution channel (npm, the shell installer,
// GitHub Release archives, `cargo install warble-cli`) carries a working Hub component library
// even on a machine with no Warble checkout at all -- see `cli/src/lib.rs`'s `hub_source_dir` and
// `extract_embedded_hub`. `hub/components/` stays the single source of truth (it's what the
// in-repo dev loop, CI, and the eval suites actually compile against); `cli/embedded-hub/` only
// has to track it.
//
// Nothing else catches the two drifting apart: a `cargo build` of `warble-cli` bakes in whatever
// `cli/embedded-hub/` happens to contain at that moment, with no error and no warning, even if
// it's stale, a component behind, or missing one outright. This walks both trees byte-for-byte
// and fails loudly on any difference -- an edit to a component under `hub/components/` that
// doesn't also update `cli/embedded-hub/` (or vice versa) is exactly the drift this exists to
// catch, following the same "diff-guard a checked-in snapshot against its source" pattern as
// `just publish-check`'s `packages/ir-spec/ir-schema.md` check.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function listFilesRelative(root, dir = root) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRelative(root, full));
    } else if (entry.isFile()) {
      out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  return out;
}

export function checkEmbeddedHub(root) {
  const sourceDir = path.join(root, "hub", "components");
  const embeddedDir = path.join(root, "cli", "embedded-hub");
  const problems = [];

  if (!fs.existsSync(sourceDir)) {
    return [`hub/components: does not exist at ${sourceDir}`];
  }
  if (!fs.existsSync(embeddedDir)) {
    return [
      `cli/embedded-hub: does not exist at ${embeddedDir} -- every distribution channel would ship ` +
        "with an empty Hub",
    ];
  }

  const sourceFiles = new Set(listFilesRelative(sourceDir));
  const embeddedFiles = new Set(listFilesRelative(embeddedDir));

  for (const rel of sourceFiles) {
    if (!embeddedFiles.has(rel)) {
      problems.push(`hub/components/${rel} has no counterpart at cli/embedded-hub/${rel}`);
      continue;
    }
    const sourceBytes = fs.readFileSync(path.join(sourceDir, rel));
    const embeddedBytes = fs.readFileSync(path.join(embeddedDir, rel));
    if (!sourceBytes.equals(embeddedBytes)) {
      problems.push(`cli/embedded-hub/${rel} has drifted from hub/components/${rel}`);
    }
  }

  for (const rel of embeddedFiles) {
    if (!sourceFiles.has(rel)) {
      problems.push(
        `cli/embedded-hub/${rel} has no counterpart under hub/components/${rel} -- ` +
          "a stale file left behind after hub/components/ removed or renamed it",
      );
    }
  }

  return problems;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = path.resolve(fileURLToPath(import.meta.url), "..", "..");
  const problems = checkEmbeddedHub(root);
  if (problems.length > 0) {
    console.error("check-embedded-hub: cli/embedded-hub/ has drifted from hub/components/:");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("  fix: re-copy the affected file(s) from hub/components/ into cli/embedded-hub/");
    process.exitCode = 1;
  } else {
    console.log("check-embedded-hub: cli/embedded-hub/ matches hub/components/ byte-for-byte.");
  }
}
