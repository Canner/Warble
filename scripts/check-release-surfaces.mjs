#!/usr/bin/env node
//
// Guards release-please-config.json's workspace (".") package against a version surface that
// silently has no bump target. release-please does not understand Cargo/npm structurally, so
// every place a workspace-shared version literally appears -- Cargo.toml's own version and its
// internal path-dependency version requirements, each workspace member's entry in Cargo.lock,
// and each dispatcher package's package.json/package-lock.json -- has to be named explicitly in
// `extra-files`. A newly added workspace crate, a newly added internal path dependency, or a
// newly added dispatcher package that nobody adds to that list would otherwise bump silently
// wrong (or not at all) the first time a release runs.
//
// This reuses the same [workspace].members -> per-member Cargo.toml package name discovery that
// scripts/release-bump.mjs used before release-please replaced it, so a newly added workspace
// member is discovered from the real Cargo.toml rather than re-hardcoded here.
//
// `packages/ir-spec` is deliberately out of scope: it is release-please's own separate
// component (see release-please-config.json), not one of this package's extra-files, and its
// version is intentionally *not* locked to the workspace version (decision: IR package binding
// via peerDependency, not a version pin).
//
// Known gaps, left open deliberately rather than half-closed:
//
// - This only checks that each expected jsonpath *string* is present in extra-files, never that
//   the jsonpath still *resolves* against the real file. release-please's own resolution walks
//   parsed TOML/JSON with a jsonpath-plus-flavored query engine; matching that behavior here would
//   mean vendoring a TOML parser and a compatible jsonpath evaluator into a script that currently
//   has zero runtime dependencies, to catch a failure mode (a jsonpath silently stops matching
//   after a file reshapes) that a release-please dry run's diff output would also surface --  later
//   than this check would, but before anything merges.
// - Internal path dependencies are only discovered from the root [workspace.dependencies] table
//   (see discoverWorkspacePathDependencyNames below), the pattern every crate in this workspace
//   currently uses (`foo.workspace = true` in each member's own [dependencies]). A member that
//   instead declared an inline `foo = { path = "../foo", version = "..." }` directly in its own
//   Cargo.toml would carry an unlisted, unguarded version string that this script does not look
//   for at all.
// - npm packages are discovered by scanning `dispatcher/` only. A future npm package that belongs
//   to the same version lockstep but lives elsewhere in the tree is invisible here -- it would be
//   added to release-please's extra-files by whoever introduces it, with nothing checking they
//   remembered. Widening the scan needs a rule for which packages are in the lockstep and which
//   are not (`packages/ir-spec` deliberately is not), which does not exist yet.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function extractSection(text, sectionName, label) {
  const header = `[${sectionName}]`;
  const start = text.indexOf(`${header}\n`);
  if (start < 0) throw new Error(`${label}: missing ${header}`);
  const contentStart = start + header.length + 1;
  const remainder = text.slice(contentStart);
  const nextSection = remainder.search(/^\[/m);
  return remainder.slice(0, nextSection < 0 ? undefined : nextSection);
}

function readWorkspaceMembers(root) {
  const cargoToml = fs.readFileSync(path.join(root, "Cargo.toml"), "utf8");
  const workspaceSection = extractSection(cargoToml, "workspace", "Cargo.toml");
  const membersMatch = workspaceSection.match(/^members\s*=\s*(\[[\s\S]*?\])\s*$/m);
  if (!membersMatch) throw new Error("Cargo.toml: workspace members must be an explicit array");
  let members;
  try {
    members = JSON.parse(membersMatch[1]);
  } catch {
    throw new Error("Cargo.toml: workspace members array must use quoted literal paths");
  }
  for (const member of members) {
    if (member.includes("*")) throw new Error(`Cargo.toml: glob workspace member is unsupported: ${member}`);
  }
  return members;
}

function readMemberPackage(root, member) {
  const manifest = fs.readFileSync(path.join(root, member, "Cargo.toml"), "utf8");
  const packageSection = extractSection(manifest, "package", `${member}/Cargo.toml`);
  const nameMatch = packageSection.match(/^name = "([^"]+)"$/m);
  if (!nameMatch) throw new Error(`${member}/Cargo.toml: missing literal package name`);
  return { name: nameMatch[1], packageSection };
}

function discoverWorkspaceCrateNames(root) {
  return readWorkspaceMembers(root).map((member) => readMemberPackage(root, member).name);
}

// A member whose own [package] pins a literal `version = "..."` instead of inheriting
// `version.workspace = true` would not be bumped by any extra-files entry above -- the workspace
// Cargo.toml entry and the Cargo.lock entry both only cover the version release-please is told
// about, and a member ignoring workspace inheritance is invisible to that mechanism entirely.
function findVersionInheritanceGaps(root) {
  const gaps = [];
  for (const member of readWorkspaceMembers(root)) {
    const { name, packageSection } = readMemberPackage(root, member);
    if (!/^version\.workspace\s*=\s*true\s*$/m.test(packageSection)) {
      gaps.push(
        `${member}/Cargo.toml: package '${name}' does not declare version.workspace = true in [package] ` +
          "-- a member pinning its own literal version is not covered by any extra-files entry",
      );
    }
  }
  return gaps;
}

function discoverWorkspacePathDependencyNames(root) {
  const cargoToml = fs.readFileSync(path.join(root, "Cargo.toml"), "utf8");
  const section = extractSection(cargoToml, "workspace.dependencies", "Cargo.toml");
  const names = [];
  for (const line of section.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*\{[^}]*\bpath\s*=/);
    if (match) names.push(match[1]);
  }
  return names;
}

function discoverDispatcherTsPackageDirs(root) {
  const dispatcherRoot = path.join(root, "dispatcher");
  return fs
    .readdirSync(dispatcherRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `dispatcher/${entry.name}`)
    .filter((dir) => fs.existsSync(path.join(root, dir, "package.json")));
}

function loadWorkspaceExtraFiles(root) {
  const config = JSON.parse(fs.readFileSync(path.join(root, "release-please-config.json"), "utf8"));
  const pkg = config.packages?.["."];
  if (!pkg) throw new Error('release-please-config.json: missing the "." (workspace) package');
  return pkg["extra-files"] ?? [];
}

function hasTomlEntry(extraFiles, filePath, jsonpath) {
  return extraFiles.some((entry) => entry.path === filePath && entry.type === "toml" && entry.jsonpath === jsonpath);
}

function hasJsonEntry(extraFiles, filePath, jsonpath) {
  return extraFiles.some((entry) => entry.path === filePath && entry.type === "json" && entry.jsonpath === jsonpath);
}

export function checkReleaseSurfaces(root) {
  const problems = [];
  const extraFiles = loadWorkspaceExtraFiles(root);

  if (!hasTomlEntry(extraFiles, "Cargo.toml", "$.workspace.package.version")) {
    problems.push(
      "release-please-config.json: missing the Cargo.toml $.workspace.package.version extra-files entry",
    );
  }

  problems.push(...findVersionInheritanceGaps(root));

  for (const name of discoverWorkspaceCrateNames(root)) {
    const jsonpath = `$.package[?(@.name.value=='${name}')].version`;
    if (!hasTomlEntry(extraFiles, "Cargo.lock", jsonpath)) {
      problems.push(
        `release-please-config.json: missing a Cargo.lock extra-files entry for workspace crate '${name}' ` +
          "(add one when a new crate joins [workspace].members in Cargo.toml)",
      );
    }
  }

  for (const name of discoverWorkspacePathDependencyNames(root)) {
    const jsonpath = `$.workspace.dependencies.${name}.version`;
    if (!hasTomlEntry(extraFiles, "Cargo.toml", jsonpath)) {
      problems.push(
        `release-please-config.json: missing a Cargo.toml extra-files entry for workspace.dependencies.${name}.version ` +
          "(add one when a new internal path dependency joins [workspace.dependencies] in Cargo.toml)",
      );
    }
  }

  for (const dir of discoverDispatcherTsPackageDirs(root)) {
    if (!hasJsonEntry(extraFiles, `${dir}/package.json`, "$.version")) {
      problems.push(
        `release-please-config.json: missing a ${dir}/package.json extra-files entry ` +
          "(add one when a new dispatcher package joins the workspace-version lockstep)",
      );
    }
    if (fs.existsSync(path.join(root, dir, "package-lock.json"))) {
      const hasVersion = hasJsonEntry(extraFiles, `${dir}/package-lock.json`, "$.version");
      const hasRootPackage = hasJsonEntry(extraFiles, `${dir}/package-lock.json`, "$.packages[''].version");
      if (!hasVersion || !hasRootPackage) {
        problems.push(
          `release-please-config.json: missing ${dir}/package-lock.json extra-files entries ` +
            "($.version and $.packages[''].version)",
        );
      }
    }
  }

  return problems;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const problems = checkReleaseSurfaces(root);
  if (problems.length > 0) {
    console.error(
      "check-release-surfaces: release-please-config.json is missing version-bump coverage for the following surfaces:",
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(
      "check-release-surfaces: every discovered workspace crate, internal path dependency, and dispatcher " +
        "package is covered by release-please-config.json's extra-files list.",
    );
  }
}
