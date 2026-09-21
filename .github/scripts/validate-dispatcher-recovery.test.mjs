import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateRequest, validateRelease } from './validate-dispatcher-recovery.mjs';

const tag = 'v0.13.0', sha = 'a'.repeat(40);
function fixture() {
  return [tag, { tagName: tag, isDraft: false, isPrerelease: false }, sha, { '.': '0.13.0' },
    ['claude-agent-sdk', 'codex-local'].map(name => [`@warble/${name}`, {
      name: `@warble/${name}`, version: '0.13.0', warble: { irVersion: '0.8' }, peerDependencies: { '@warble/ir-spec': '0.8.x' },
    }]), { name: '@warble/ir-spec', version: '0.8.0' }];
}
test('recovery requires an explicit stable tag from main without another publication request', () => {
  validateRequest(tag, 'refs/heads/main', 'false');
  for (const value of ['', 'main', 'v0.13.0-rc.1', 'v01.13.0', 'v0.13.0\n', '--help']) {
    assert.throws(() => validateRequest(value, 'refs/heads/main', 'false'));
  }
  assert.throws(() => validateRequest(tag, 'refs/heads/feature', 'false'));
  assert.throws(() => validateRequest(tag, 'refs/heads/main', 'true'));
});
test('published stable release and every dispatcher/IR version must agree', () => {
  assert.equal(validateRelease(...fixture()), sha);
  for (const change of [
    f => { f[1].isDraft = true; }, f => { f[1].isPrerelease = true; },
    f => { f[1].tagName = 'v0.12.0'; }, f => { f[2] = 'main'; },
    f => { f[3]['.'] = '0.12.0'; }, f => { f[5].version = '0.6.0'; },
    ...[0, 1].flatMap(i => [
      f => { f[4][i][1].version = '0.12.0'; },
      f => { f[4][i][1].name = '@other/package'; },
      f => { f[4][i][1].private = true; },
      f => { f[4][i][1].warble.irVersion = '0.6'; },
      f => { f[4][i][1].peerDependencies['@warble/ir-spec'] = '*'; },
    ]),
  ]) {
    const f = fixture(); change(f); assert.throws(() => validateRelease(...f));
  }
});
