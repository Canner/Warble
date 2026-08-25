import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bumpWorkspace } from "./release-bump.mjs";

const WORKSPACE_PACKAGES = [
  ["core", "warble"],
  ["dispatcher/claude-code-cli", "warble-claude-code"],
  ["cli", "warble-cli"],
  ["eval/compare", "warble-eval-compare"],
  ["eval/runner", "warble-eval-runner"],
  ["bindings/mdl-context", "warble-mdl-context"],
  ["dispatcher/vercel", "warble-vercel"],
];

function write(root, relativePath, content) {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function fixture({ extraPackage = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "warble-release-bump-"));
  const packages = extraPackage ? [...WORKSPACE_PACKAGES, ["extra", "warble-extra"]] : WORKSPACE_PACKAGES;
  const dependencyPackages = packages.filter(([, name]) => name !== "warble-cli");
  write(
    root,
    "Cargo.toml",
    `[workspace]\nmembers = ${JSON.stringify(packages.map(([directory]) => directory))}\n\n[workspace.package]\nversion = "0.1.0"\n\n[workspace.dependencies]\n${dependencyPackages.map(
      ([directory, name]) => `${name} = { path = "${directory}", version = "0.1.0" }`,
    ).join("\n")}\n`,
  );
  for (const [directory, name] of packages) {
    const internalDependency = name === "warble-extra"
      ? `\n[dependencies]\nwarble = { path = "../core", version = "0.1.0" }\n`
      : "";
    write(
      root,
      `${directory}/Cargo.toml`,
      `[package]\nname = "${name}"\nversion.workspace = true\n${internalDependency}`,
    );
  }
  write(
    root,
    "Cargo.lock",
    packages.map(([, name]) => `[[package]]\nname = "${name}"\nversion = "0.1.0"\n`).join("\n"),
  );
  for (const [directory, name] of [
    ["dispatcher/claude-agent-sdk", "@warble/claude-agent-sdk"],
    ["dispatcher/codex-local", "@warble/codex-local"],
  ]) {
    write(root, `${directory}/package.json`, `${JSON.stringify({ name, version: "0.1.0" }, null, 2)}\n`);
    write(
      root,
      `${directory}/package-lock.json`,
      `${JSON.stringify({ name, version: "0.1.0", lockfileVersion: 3, packages: { "": { name, version: "0.1.0" } } }, null, 2)}\n`,
    );
  }
  write(
    root,
    "CHANGELOG.md",
    `# Changelog\n\n## [Unreleased]\n\n### Added\n\n- New behavior.\n\n## [0.1.0] - 2026-07-30\n\n[Unreleased]: https://github.com/Canner/Warble/compare/v0.1.0...HEAD\n[0.1.0]: https://github.com/Canner/Warble/releases/tag/v0.1.0\n`,
  );
  write(
    root,
    "core/src/lib.rs",
    "//! https://github.com/Canner/Warble/blob/main/docs/spec/ir-schema.md\n",
  );
  return root;
}

test("synchronizes every release surface and is idempotent", () => {
  const root = fixture();
  const changed = bumpWorkspace(root, "0.2.0", "2026-08-16");
  assert.deepEqual(changed, [
    "Cargo.toml",
    "Cargo.lock",
    "dispatcher/claude-agent-sdk/package.json",
    "dispatcher/claude-agent-sdk/package-lock.json",
    "dispatcher/codex-local/package.json",
    "dispatcher/codex-local/package-lock.json",
    "CHANGELOG.md",
  ]);

  const cargoToml = fs.readFileSync(path.join(root, "Cargo.toml"), "utf8");
  assert.equal((cargoToml.match(/0\.2\.0/g) ?? []).length, WORKSPACE_PACKAGES.length);
  const cargoLock = fs.readFileSync(path.join(root, "Cargo.lock"), "utf8");
  assert.equal((cargoLock.match(/version = "0\.2\.0"/g) ?? []).length, WORKSPACE_PACKAGES.length);
  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-08-16\n\n### Added/);
  assert.match(changelog, /\[Unreleased\]: .*\/compare\/v0\.2\.0\.\.\.HEAD/);
  assert.match(changelog, /\[0\.2\.0\]: .*\/compare\/v0\.1\.0\.\.\.v0\.2\.0/);
  assert.match(
    fs.readFileSync(path.join(root, "core/src/lib.rs"), "utf8"),
    /blob\/main\/docs\/spec/,
  );

  const beforeSecondRun = new Map(changed.map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]));
  assert.deepEqual(bumpWorkspace(root, "0.2.0", "2026-08-16"), []);
  for (const [file, content] of beforeSecondRun) {
    assert.equal(fs.readFileSync(path.join(root, file), "utf8"), content);
  }
});

test("discovers a newly added workspace package and dependency", () => {
  const root = fixture({ extraPackage: true });
  bumpWorkspace(root, "0.2.0", "2026-08-16");
  assert.match(fs.readFileSync(path.join(root, "Cargo.toml"), "utf8"), /warble-extra = .*version = "0\.2\.0"/);
  assert.match(
    fs.readFileSync(path.join(root, "Cargo.lock"), "utf8"),
    /name = "warble-extra"\nversion = "0\.2\.0"/,
  );
  assert.match(
    fs.readFileSync(path.join(root, "extra/Cargo.toml"), "utf8"),
    /warble = .*version = "0\.2\.0"/,
  );
});

test("validates every expected surface before writing anything", () => {
  const root = fixture();
  const cargoTomlPath = path.join(root, "Cargo.toml");
  const original = fs.readFileSync(cargoTomlPath, "utf8");
  fs.appendFileSync(
    path.join(root, "dispatcher/vercel/Cargo.toml"),
    "\n[dependencies]\nwarble = { path = \"../../core\" }\n",
  );
  assert.throws(() => bumpWorkspace(root, "0.2.0", "2026-08-16"), /internal path dependency.*has no version requirement/);
  assert.equal(fs.readFileSync(cargoTomlPath, "utf8"), original);
  assert.match(fs.readFileSync(path.join(root, "Cargo.lock"), "utf8"), /version = "0\.1\.0"/);
});

test("rejects invalid versions and dates", () => {
  const root = fixture();
  assert.throws(() => bumpWorkspace(root, "v0.2", "2026-08-16"), /invalid release version/);
  assert.throws(() => bumpWorkspace(root, "01.2.3", "2026-08-16"), /invalid release version/);
  assert.throws(() => bumpWorkspace(root, "0.2.0-..", "2026-08-16"), /invalid release version/);
  assert.throws(() => bumpWorkspace(root, "0.2.0", "16-08-2026"), /invalid release date/);
  assert.throws(() => bumpWorkspace(root, "0.2.0", "2026-02-30"), /invalid release date/);
});
