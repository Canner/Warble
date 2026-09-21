import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function validateRequest(tag, workflowRef, publishIrSpec) {
  assert.equal(tag, tag.trim(), 'release tag must not contain surrounding whitespace');
  assert.match(tag, /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/, 'recovery requires a stable release tag');
  assert.equal(workflowRef, 'refs/heads/main', 'run recovery from main');
  assert.equal(publishIrSpec, 'false', 'IR prepublication and dispatcher recovery are separate operations');
}

export function validateRelease(tag, release, sha, manifest, packages, spec) {
  assert.equal(release.tagName, tag, 'release tag mismatch');
  assert.equal(release.isDraft, false, 'release must be published');
  assert.equal(release.isPrerelease, false, 'release must be stable');
  assert.match(sha, /^[0-9a-f]{40}$/, 'release must resolve to a commit');
  const version = tag.slice(1);
  assert.equal(manifest['.'], version, 'release manifest version mismatch');
  assert.equal(spec.name, '@warble/ir-spec');
  assert.match(spec.version, /^\d+\.\d+\.0$/);
  const ir = spec.version.slice(0, -2);
  for (const [name, pkg] of packages) {
    assert.equal(pkg.name, name, 'dispatcher name mismatch');
    assert.equal(pkg.version, version, 'dispatcher version mismatch');
    assert.notEqual(pkg.private, true, 'dispatcher must be publishable');
    assert.equal(pkg.warble?.irVersion, ir, 'dispatcher IR mismatch');
    assert.equal(pkg.peerDependencies?.['@warble/ir-spec'], `${ir}.x`, 'dispatcher peer mismatch');
  }
  return sha;
}

async function main() {
  const tag = process.env.RECOVERY_TAG ?? '';
  validateRequest(tag, process.env.RECOVERY_WORKFLOW_REF, process.env.PUBLISH_IR_SPEC);
  const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', timeout: 30_000 }).trim();
  const release = JSON.parse(run('gh', ['release', 'view', tag, '--repo', 'Canner/Warble', '--json', 'tagName,isDraft,isPrerelease']));
  // checkout fetch-depth: 0 fetches tags. Resolve once, then use only the immutable commit.
  const sha = run('git', ['rev-parse', `refs/tags/${tag}^{commit}`]);
  run('git', ['merge-base', '--is-ancestor', sha, 'origin/main']);
  const read = (file) => JSON.parse(run('git', ['show', `${sha}:${file}`]));
  const spec = read('packages/ir-spec/package.json');
  const packages = ['claude-agent-sdk', 'codex-local'].map((name) => [`@warble/${name}`, read(`dispatcher/${name}/package.json`)]);
  validateRelease(tag, release, sha, read('.release-please-manifest.json'), packages, spec);
  // Do not repair or publish the peer as a side effect of dispatcher recovery.
  const response = await fetch(`https://registry.npmjs.org/@warble%2fir-spec/${spec.version}`, { signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, 'required IR peer is not published');
  const published = await response.json();
  assert.equal(published.name, spec.name);
  assert.equal(published.version, spec.version);
  appendFileSync(process.env.GITHUB_OUTPUT, `ref=${sha}\n`);
  console.log(`Validated dispatcher recovery for ${tag} at ${sha}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
