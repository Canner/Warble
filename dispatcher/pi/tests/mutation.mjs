// Synthetic conformance mutations run in disposable copies, never in production source.
import assert from 'node:assert/strict';
import { mkdtemp, cp, symlink, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const pkg = fileURLToPath(new URL('../', import.meta.url));
const mutations = [
  { name: 'session-selection-bypass', file: 'authorization.js',
    from: 'if (selection !== "allow")', to: 'if (false)',
    suite: 'authorization', pattern: 'deployment and session are separate' },
  { name: 'cedar-diagnostic-fail-open', file: 'cedar.js',
    from: ' || result.response.diagnostics.errors.length !== 0', to: '',
    suite: 'authorization', pattern: 'real Cedar erroneous forbid' },
  { name: 'skip-answer-validation', file: 'disclosure.js',
    from: 'if (projection.validate(JSON.parse(bytes)) !== true)', to: 'if (false)',
    suite: 'runtime', pattern: 'unprojectable result never becomes approved' },
  { name: 'release-raw-private-result', file: 'disclosure.js',
    from: 'jsonBytes(projection.project(raw), this.maxBytes)', to: 'jsonBytes(raw, this.maxBytes)',
    suite: 'runtime', pattern: 'real pinned pi loop' },
  { name: 'allow-endpoint-substitution', file: 'transport.js',
    from: 'request.url !== endpoint.href || ', to: '',
    suite: 'runtime', pattern: 'public transport checks exact body' },
  { name: 'allow-permit-replay', file: 'transport.js',
    from: 'permits.delete(key);', to: '/* deliberately replayable */',
    suite: 'runtime', pattern: 'public transport checks exact body' },
];
const report = [];
for (const mutation of mutations) {
  const copy = await mkdtemp(join(tmpdir(), 'pi-boundary-mutation-'));
  try {
    await cp(join(pkg, 'dist'), join(copy, 'dist'), { recursive: true });
    await mkdir(join(copy, 'tests'));
    for (const suite of ['authorization', 'runtime']) {
      // The policy suite normally tests TS source; the isolated mutation must exercise
      // the equivalent built module being changed, never the unmodified source.
      const test = (await readFile(join(pkg, 'tests', suite + '.test.ts'), 'utf8')).replaceAll('../src/', '../dist/');
      await writeFile(join(copy, 'tests', suite + '.test.ts'), test);
    }
    await cp(join(pkg, 'tests/fixtures'), join(copy, 'tests/fixtures'), { recursive: true });
    await symlink(join(pkg, 'node_modules'), join(copy, 'node_modules'), 'dir');
    await writeFile(join(copy, 'package.json'), '{"type":"module"}');
    const args = ['--import', 'tsx', '--test', '--test-name-pattern', mutation.pattern, join(copy, 'tests', mutation.suite + '.test.ts')];
    const run = () => spawnSync(process.execPath, args, { cwd: copy, encoding: 'utf8', timeout: 30000 });
    const baseline = run();
    assert.equal(baseline.status, 0, `Baseline failed for ${mutation.name}: ${baseline.stdout}\n${baseline.stderr}`);
    const path = join(copy, 'dist', mutation.file), source = await readFile(path, 'utf8');
    assert.equal(source.split(mutation.from).length, 2, `Mutation anchor drift: ${mutation.name}`);
    await writeFile(path, source.replace(mutation.from, mutation.to));
    assert.equal(spawnSync(process.execPath, ['--check', path]).status, 0, 'syntax errors are not killed mutants');
    const changed = run(), output = changed.stdout + changed.stderr;
    assert.notEqual(changed.status, 0, `SURVIVED: ${mutation.name}`);
    assert.ok(changed.status !== null && /(?:# fail |ℹ fail )[1-9]/.test(output), `not an assertion failure: ${mutation.name}\n${output}`);
    report.push({ mutation: mutation.name, baseline: 'pass', mutationResult: 'killed-by-test', witness: mutation.pattern });
    console.log(`Killed ${mutation.name}`);
  } finally { await rm(copy, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ mutations: report.length, killed: report.length, results: report }, null, 2));
