#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TYPESCRIPT_PACKAGES = [
  ["dispatcher/claude-agent-sdk", "@warble/claude-agent-sdk"],
  ["dispatcher/codex-local", "@warble/codex-local"],
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceExactlyOnce(text, pattern, replacement, label) {
  const flags = [...new Set(`${pattern.flags}g`)].join("");
  const matches = [...text.matchAll(new RegExp(pattern.source, flags))];
  if (matches.length !== 1) {
    throw new Error(`${label}: expected exactly one match, found ${matches.length}`);
  }
  return text.replace(pattern, replacement);
}

function extractSection(text, sectionName, label) {
  const header = `[${sectionName}]`;
  const start = text.indexOf(`${header}\n`);
  if (start < 0) throw new Error(`${label}: missing ${header}`);
  const contentStart = start + header.length + 1;
  const remainder = text.slice(contentStart);
  const nextSection = remainder.search(/^\[/m);
  return remainder.slice(0, nextSection < 0 ? undefined : nextSection);
}

function discoverWorkspace(root, cargoToml) {
  const workspaceSection = extractSection(cargoToml, "workspace", "Cargo.toml");
  const membersMatch = workspaceSection.match(/^members\s*=\s*(\[[\s\S]*?\])\s*$/m);
  if (!membersMatch) throw new Error("Cargo.toml: workspace members must be an explicit array");
  let members;
  try {
    members = JSON.parse(membersMatch[1]);
  } catch {
    throw new Error("Cargo.toml: workspace members array must use quoted literal paths");
  }
  if (!Array.isArray(members) || members.length === 0 || members.some((member) => typeof member !== "string")) {
    throw new Error("Cargo.toml: workspace members must be a non-empty string array");
  }

  const packagesByPath = new Map();
  const names = new Set();
  for (const member of members) {
    if (member.includes("*")) throw new Error(`Cargo.toml: glob workspace member is unsupported: ${member}`);
    const memberRoot = path.resolve(root, member);
    const manifestPath = path.join(memberRoot, "Cargo.toml");
    const manifest = fs.readFileSync(manifestPath, "utf8");
    const packageSection = extractSection(manifest, "package", `${member}/Cargo.toml`);
    const nameMatch = packageSection.match(/^name = "([^"]+)"$/m);
    if (!nameMatch) throw new Error(`${member}/Cargo.toml: missing literal package name`);
    if (!/^version\.workspace = true$/m.test(packageSection)) {
      throw new Error(`${member}/Cargo.toml: package version must inherit from the workspace`);
    }
    if (names.has(nameMatch[1])) throw new Error(`Cargo.toml: duplicate workspace package ${nameMatch[1]}`);
    names.add(nameMatch[1]);
    packagesByPath.set(memberRoot, { member, manifest, manifestPath, name: nameMatch[1] });
  }
  return packagesByPath;
}

function bumpInternalPathDependencies(text, manifestRoot, packagesByPath, version, label) {
  let section = "";
  return text
    .split(/(?<=\n)/)
    .map((line) => {
      const sectionMatch = line.match(/^\[([^\]]+)\]/);
      if (sectionMatch) section = sectionMatch[1];
      const pathMatch = line.match(/\bpath = "([^"]+)"/);
      if (!pathMatch || !packagesByPath.has(path.resolve(manifestRoot, pathMatch[1]))) return line;
      const versionPattern = /(\bversion = ")[^"]+(")/;
      if (!versionPattern.test(line)) {
        if (section.endsWith("dev-dependencies")) return line;
        throw new Error(`${label}: internal path dependency ${pathMatch[1]} has no version requirement`);
      }
      return replaceExactlyOnce(line, versionPattern, `$1${version}$2`, `${label} dependency ${pathMatch[1]}`);
    })
    .join("");
}

function bumpCargoToml(text, root, packagesByPath, version) {
  let next = replaceExactlyOnce(
    text,
    /(\[workspace\.package\]\nversion = ")[^"]+("\n)/,
    `$1${version}$2`,
    "Cargo.toml workspace version",
  );
  return bumpInternalPathDependencies(next, root, packagesByPath, version, "Cargo.toml");
}

function bumpCargoLock(text, packageNames, version) {
  let next = text;
  for (const packageName of packageNames) {
    next = replaceExactlyOnce(
      next,
      new RegExp(`(\\[\\[package\\]\\]\\nname = "${escapeRegExp(packageName)}"\\nversion = ")[^"]+(")`),
      `$1${version}$2`,
      `Cargo.lock package ${packageName}`,
    );
  }
  return next;
}

function bumpPackageManifest(text, expectedName, version, label) {
  const parsed = JSON.parse(text);
  if (parsed.name !== expectedName) {
    throw new Error(`${label}: expected package name ${expectedName}, found ${parsed.name}`);
  }
  return replaceExactlyOnce(
    text,
    /^(  "version": ")[^"]+(",?)$/m,
    `$1${version}$2`,
    `${label} version`,
  );
}

function bumpPackageLock(text, expectedName, version, label) {
  const parsed = JSON.parse(text);
  if (parsed.name !== expectedName || parsed.packages?.[""]?.name !== expectedName) {
    throw new Error(`${label}: root package name does not match ${expectedName}`);
  }
  parsed.version = version;
  parsed.packages[""].version = version;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function bumpChangelog(text, version, date) {
  let next = text;
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\] - ([0-9]{4}-[0-9]{2}-[0-9]{2})$`, "m");
  const existingHeading = next.match(heading);
  if (existingHeading && existingHeading[1] !== date) {
    throw new Error(`CHANGELOG.md: ${version} already exists with date ${existingHeading[1]}`);
  }
  if (!existingHeading) {
    next = replaceExactlyOnce(
      next,
      /^## \[Unreleased\]\n/m,
      `## [Unreleased]\n\n## [${version}] - ${date}\n`,
      "CHANGELOG.md Unreleased heading",
    );
  }

  const unreleasedPattern = /^\[Unreleased\]: (.+\/compare\/v([^\s]+)\.\.\.HEAD)$/m;
  const unreleased = next.match(unreleasedPattern);
  if (!unreleased) {
    throw new Error("CHANGELOG.md: missing Unreleased compare link");
  }
  const previousVersion = unreleased[2];
  const releaseLinkPattern = new RegExp(`^\\[${escapeRegExp(version)}\\]: `, "m");
  if (previousVersion !== version) {
    if (releaseLinkPattern.test(next)) {
      throw new Error(`CHANGELOG.md: ${version} link exists before Unreleased points to it`);
    }
    const base = unreleased[1].slice(0, -`v${previousVersion}...HEAD`.length);
    next = next.replace(
      unreleasedPattern,
      `[Unreleased]: ${base}v${version}...HEAD\n[${version}]: ${base}v${previousVersion}...v${version}`,
    );
  } else if (!releaseLinkPattern.test(next)) {
    throw new Error(`CHANGELOG.md: missing ${version} compare link`);
  }
  return next;
}

function assertInputs(version, date) {
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/;
  if (!semver.test(version)) {
    throw new Error(`invalid release version: ${version}`);
  }
  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(parsedDate.valueOf()) ||
    parsedDate.toISOString().slice(0, 10) !== date
  ) {
    throw new Error(`invalid release date: ${date}`);
  }
}

export function bumpWorkspace(root, version, date) {
  assertInputs(version, date);
  const updates = [];
  const rootCargoPath = path.join(root, "Cargo.toml");
  const rootCargo = fs.readFileSync(rootCargoPath, "utf8");
  const packagesByPath = discoverWorkspace(root, rootCargo);
  const queue = (relativePath, transform) => {
    const absolutePath = path.join(root, relativePath);
    const current = fs.readFileSync(absolutePath, "utf8");
    const next = transform(current);
    if (next !== current) updates.push([relativePath, absolutePath, next]);
  };

  queue("Cargo.toml", (text) => bumpCargoToml(text, root, packagesByPath, version));
  queue("Cargo.lock", (text) => bumpCargoLock(text, [...packagesByPath.values()].map(({ name }) => name), version));
  for (const { member, manifest, manifestPath } of packagesByPath.values()) {
    const next = bumpInternalPathDependencies(manifest, path.dirname(manifestPath), packagesByPath, version, `${member}/Cargo.toml`);
    if (next !== manifest) updates.push([`${member}/Cargo.toml`, manifestPath, next]);
  }
  for (const [directory, packageName] of TYPESCRIPT_PACKAGES) {
    queue(`${directory}/package.json`, (text) =>
      bumpPackageManifest(text, packageName, version, `${directory}/package.json`),
    );
    queue(`${directory}/package-lock.json`, (text) =>
      bumpPackageLock(text, packageName, version, `${directory}/package-lock.json`),
    );
  }
  queue("CHANGELOG.md", (text) => bumpChangelog(text, version, date));

  for (const [, absolutePath, next] of updates) fs.writeFileSync(absolutePath, next);
  return updates.map(([relativePath]) => relativePath);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const [version, date] = process.argv.slice(2);
    if (!version || !date) throw new Error("usage: release-bump.mjs <version> <YYYY-MM-DD>");
    const changed = bumpWorkspace(process.cwd(), version, date);
    console.log(
      changed.length === 0
        ? `release-bump: ${version} is already synchronized`
        : `release-bump: synchronized ${version} in ${changed.join(", ")}`,
    );
  } catch (error) {
    console.error(`release-bump: ${error.message}`);
    process.exitCode = 1;
  }
}
