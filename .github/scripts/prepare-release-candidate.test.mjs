import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { applyEntry, applyVersion, nextCandidate, validateBase, validateRequest } from './prepare-release-candidate.mjs';

test('candidates are cut from main and never combined with another manual operation', () => {
  validateRequest('refs/heads/main', 'false', '');
  assert.throws(() => validateRequest('refs/heads/feature', 'false', ''));
  assert.throws(() => validateRequest('refs/tags/v0.19.0', 'false', ''));
  assert.throws(() => validateRequest('refs/heads/main', 'true', ''));
  assert.throws(() => validateRequest('refs/heads/main', 'false', 'v0.19.0'));
});

test('the release PR version must be a stable version ahead of the last release', () => {
  validateBase('0.20.0', '0.19.0');
  validateBase('0.19.1', '0.19.0');
  validateBase('1.0.0', '0.19.3');
  validateBase('0.20.0', '0.9.0');
  for (const [base, current] of [['0.19.0', '0.19.0'], ['0.18.5', '0.19.0'], ['0.20.0-rc.1', '0.19.0'], ['v0.20.0', '0.19.0'], ['', '0.19.0']]) {
    assert.throws(() => validateBase(base, current), `${base} over ${current}`);
  }
});

test('candidate numbers start at 1 and continue past the highest existing candidate', () => {
  assert.equal(nextCandidate('0.20.0', ['']), '0.20.0-rc.1');
  assert.equal(nextCandidate('0.20.0', ['v0.20.0-rc.1', 'v0.20.0-rc.2']), '0.20.0-rc.3');
  assert.equal(nextCandidate('0.20.0', ['v0.20.0-rc.10', 'v0.20.0-rc.9']), '0.20.0-rc.11');
  assert.equal(nextCandidate('0.20.0', ['v0.19.0-rc.4', 'v0.20.0-rc.x', 'v0.20.0-rc.01']), '0.20.0-rc.1');
  assert.throws(() => nextCandidate('0.20', []));
});

test('every extra-files surface in the real config is rewritten, and nothing else', () => {
  const config = JSON.parse(readFileSync('release-please-config.json', 'utf8'));
  const from = JSON.parse(readFileSync('.release-please-manifest.json', 'utf8'))['.'];
  const read = (f) => readFileSync(f, 'utf8');
  const files = applyVersion(config, read, from, '9.9.9-rc.1');
  assert.deepEqual([...files.keys()].sort(), [...new Set(config.packages['.']['extra-files'].map((e) => e.path))].sort());
  for (const [file, text] of files) {
    const before = read(file).split('\n'), after = text.split('\n');
    assert.equal(after.length, before.length, `${file}: line count changed`);
    const changed = after.filter((line, i) => line !== before[i]);
    assert.ok(changed.length > 0, `${file}: nothing changed`);
    for (const line of changed) {
      assert.ok(line.includes('"9.9.9-rc.1"'), `${file}: unexpected change ${line}`);
    }
  }
  const surfaces = config.packages['.']['extra-files'].length;
  const total = [...files.values()].reduce((n, text) => n + text.split('"9.9.9-rc.1"').length - 1, 0);
  assert.equal(total, surfaces, 'one rewritten literal per extra-files entry');
});

test('a surface that is missing, duplicated or of an unknown shape fails loudly', () => {
  const dep = { path: 'Cargo.toml', type: 'toml', jsonpath: '$.workspace.dependencies.warble.version' };
  assert.throws(() => applyEntry('warble = { path = "core", version = "0.1.0" }\n', dep, '0.2.0', '0.3.0-rc.1'));
  assert.throws(() => applyEntry('warble = { path = "core", version = "0.2.0" }\nwarble = { path = "x", version = "0.2.0" }\n', dep, '0.2.0', '0.3.0-rc.1'));
  const pkg = { path: 'Cargo.toml', type: 'toml', jsonpath: '$.workspace.package.version' };
  assert.throws(() => applyEntry('[package]\nversion = "0.2.0"\n', pkg, '0.2.0', '0.3.0-rc.1'));
  assert.equal(applyEntry('[workspace.package]\nversion = "0.2.0"\n\n[other]\nversion = "0.2.0"\n', pkg, '0.2.0', '0.3.0-rc.1'),
    '[workspace.package]\nversion = "0.3.0-rc.1"\n\n[other]\nversion = "0.2.0"\n');
  assert.throws(() => applyEntry('{"version":"0.1.0"}', { path: 'p.json', type: 'json', jsonpath: '$.version' }, '0.2.0', '0.3.0-rc.1'));
  assert.throws(() => applyEntry('{}', { path: 'p.json', type: 'json', jsonpath: '$.other' }, '0.2.0', '0.3.0-rc.1'));
  assert.throws(() => applyEntry('', { path: 'x.yaml', type: 'yaml', jsonpath: '$.version' }, '0.2.0', '0.3.0-rc.1'));
});
