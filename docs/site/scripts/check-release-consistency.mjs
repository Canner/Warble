#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_DOCS = [
  "docs/site/docs/getting-started/installation.md",
  "docs/site/docs/getting-started/quickstart.md",
];

const PINNED_RELEASE_PATTERNS = [
  /releases\/(?:download|tag)\/v\d+\.\d+\.\d+/,
  /\bwarble-cli-\d+\.\d+\.\d+\b/,
  /^warble \d+\.\d+\.\d+$/m,
];

function read(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function exactlyOne(text, pattern, label) {
  const matches = [...text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
  if (matches.length !== 1) {
    throw new Error(`${label}: expected exactly one match, found ${matches.length}`);
  }
  return matches[0][1];
}

export function checkReleaseConsistency(root) {
  const failures = [];

  for (const relativePath of RELEASE_DOCS) {
    const text = read(root, relativePath);
    for (const pattern of PINNED_RELEASE_PATTERNS) {
      if (pattern.test(text)) {
        failures.push(`${relativePath}: release-facing instructions pin ${pattern}`);
      }
    }
  }

  const compilerVersion = exactlyOne(
    read(root, "core/src/compile.rs"),
    /"warble_ir_version": "([^"]+)"/,
    "core/src/compile.rs emitted IR version",
  );
  const specVersion = exactlyOne(
    read(root, "docs/spec/ir-schema.md"),
    /^# Warble IR .*`warble_ir_version: ([^`]+)`/m,
    "docs/spec/ir-schema.md title IR version",
  );
  if (specVersion !== compilerVersion) {
    failures.push(
      `docs/spec/ir-schema.md: title says ${specVersion}, compiler emits ${compilerVersion}`,
    );
  }

  const generated = read(root, "docs/site/docs/reference/ir-schema.md");
  const frontmatter = generated.split("---", 3)[1] ?? "";
  const generatedVersion = frontmatter.match(/warble_ir_version\s+([0-9.]+)/)?.[1];
  if (generatedVersion && generatedVersion !== compilerVersion) {
    failures.push(
      `docs/site/docs/reference/ir-schema.md: metadata says ${generatedVersion}, compiler emits ${compilerVersion}`,
    );
  }

  if (failures.length > 0) {
    throw new Error(`release consistency check failed:\n- ${failures.join("\n- ")}`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    checkReleaseConsistency(path.resolve(here, "../../.."));
    console.log("release consistency check passed");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
