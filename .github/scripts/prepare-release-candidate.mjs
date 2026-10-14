import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_PR_BRANCH = 'release-please--branches--main';

export function validateRequest(workflowRef, publishIrSpec, recoveryTag) {
  assert.equal(workflowRef, 'refs/heads/main', 'cut release candidates from main');
  assert.equal(publishIrSpec, 'false', 'a release candidate already publishes the IR spec it needs');
  assert.equal(recoveryTag, '', 'dispatcher recovery and a release candidate are separate operations');
}

function parseStable(version) {
  const match = STABLE.exec(version);
  assert.ok(match, `not a stable version: ${JSON.stringify(version)}`);
  return match.slice(1).map(Number);
}

// The candidate is for the version the open release PR proposes, so it is always ahead of
// the last stable release and never names a version that has already shipped.
export function validateBase(base, current) {
  const [a, b] = [parseStable(base), parseStable(current)];
  const order = a.findIndex((n, i) => n !== b[i]);
  assert.ok(order !== -1 && a[order] > b[order], `release PR version ${base} is not ahead of ${current}`);
}

export function nextCandidate(base, tags) {
  parseStable(base);
  const prefix = `v${base}-rc.`;
  const taken = tags
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => tag.slice(prefix.length))
    .filter((n) => /^[1-9]\d*$/.test(n))
    .map(Number);
  return `${base}-rc.${Math.max(0, ...taken) + 1}`;
}

function replaceExactlyOnce(text, pattern, replacement, what) {
  const hits = text.match(new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g'));
  assert.equal(hits?.length ?? 0, 1, `${what}: expected exactly one match`);
  return text.replace(pattern, replacement);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Applies one release-please extra-files entry. Only the jsonpath shapes the config uses today
// are understood; a new shape fails here instead of being skipped, so the candidate can never
// ship a surface release-please would have bumped.
export function applyEntry(text, entry, from, to) {
  const { path, type, jsonpath } = entry;
  const v = escape(from);
  if (type === 'toml' && path === 'Cargo.toml' && jsonpath === '$.workspace.package.version') {
    const block = /^\[workspace\.package\]\n(?:(?!\[)[^\n]*\n)*/m.exec(text);
    assert.ok(block, 'Cargo.toml: no [workspace.package] section');
    const body = replaceExactlyOnce(block[0], new RegExp(`^version = "${v}"$`, 'm'), `version = "${to}"`, `${path} ${jsonpath}`);
    return text.slice(0, block.index) + body + text.slice(block.index + block[0].length);
  }
  let m = /^\$\.workspace\.dependencies\.([\w-]+)\.version$/.exec(jsonpath);
  if (type === 'toml' && path === 'Cargo.toml' && m) {
    const re = new RegExp(`^(${escape(m[1])} = \\{[^}\\n]*\\bversion = )"${v}"`, 'm');
    return replaceExactlyOnce(text, re, `$1"${to}"`, `${path} ${jsonpath}`);
  }
  m = /^\$\.package\[\?\(@\.name\.value=='([\w-]+)'\)\]\.version$/.exec(jsonpath);
  if (type === 'toml' && path === 'Cargo.lock' && m) {
    const re = new RegExp(`^(\\[\\[package\\]\\]\\nname = "${escape(m[1])}"\\nversion = )"${v}"$`, 'm');
    return replaceExactlyOnce(text, re, `$1"${to}"`, `${path} ${jsonpath}`);
  }
  if (type === 'json' && (jsonpath === '$.version' || jsonpath === "$.packages[''].version")) {
    const doc = JSON.parse(text);
    const target = jsonpath === '$.version' ? doc : doc.packages?.[''];
    assert.equal(target?.version, from, `${path} ${jsonpath}: expected ${from}`);
    target.version = to;
    return JSON.stringify(doc, null, 2) + '\n';
  }
  assert.fail(`${path} ${jsonpath}: unsupported extra-files entry -- teach prepare-release-candidate.mjs about it`);
}

export function applyVersion(config, read, from, to) {
  const entries = config.packages['.']['extra-files'];
  const files = new Map();
  for (const entry of entries) {
    files.set(entry.path, applyEntry(files.get(entry.path) ?? read(entry.path), entry, from, to));
  }
  return files;
}

function main() {
  validateRequest(process.env.WORKFLOW_REF, process.env.PUBLISH_IR_SPEC, process.env.RECOVERY_TAG ?? '');
  const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', timeout: 60_000 }).trim();
  const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
  const repo = process.env.GITHUB_REPOSITORY;

  const current = readJson('.release-please-manifest.json')['.'];
  const prs = JSON.parse(run('gh', ['pr', 'list', '--repo', repo, '--base', 'main', '--head', RELEASE_PR_BRANCH,
    '--state', 'open', '--json', 'number,headRefOid']));
  assert.equal(prs.length, 1, 'no open release PR: main has nothing unreleased to cut a candidate from');
  const proposed = JSON.parse(run('gh', ['api', '-H', 'Accept: application/vnd.github.raw',
    `repos/${repo}/contents/.release-please-manifest.json?ref=${prs[0].headRefOid}`]));
  const base = proposed['.'];
  validateBase(base, current);
  assert.equal(run('git', ['tag', '-l', `v${base}`]), '', `v${base} is already tagged`);

  const version = nextCandidate(base, run('git', ['tag', '-l', `v${base}-rc.*`]).split('\n'));
  const files = applyVersion(readJson('release-please-config.json'), (f) => readFileSync(f, 'utf8'), current, version);
  for (const [file, text] of files) writeFileSync(file, text);

  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=v${version}\nprevious_tag=v${current}\nrelease_pr=${prs[0].number}\n`);
  console.log(`Prepared release candidate v${version} (release PR #${prs[0].number} proposes ${base})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
