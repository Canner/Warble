import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionEvidence } from '../src/evidence.js';

const context = { epoch: 1, project: 'demo', policyDigest: 'digest', metadata: [] };
const id = '11111111-1111-4111-8111-111111111111';
test('host references replace known UUIDs; omitted citations get a separate data footer', () => {
  let sequence = 0; const ledger = new SessionEvidence(() => ++sequence, context);
  const source = { value: 12, evidence: { id, verified: true } };
  ledger.add('answer', 'Count orders', source);
  assert.equal(source.evidence.id, id);
  assert.match(ledger.format(`12 orders. Evidence: \`${id}\``, [1]), /Evidence: \[1\]/);
  assert.match(ledger.format('12 orders.', [1]), /Tool data: \[1\]/);
  assert.match(ledger.format('Interpretation [1]', []), /Interpretation \[1\]/);
  assert.match(ledger.format('Fake [999] 22222222-2222-4222-8222-222222222222', []), /unavailable reference/);
  assert.ok(!JSON.stringify(ledger.list()).includes(id));
  assert.equal(ledger.get(1)!.result && (ledger.get(1)!.result as any).value, 12);
  assert.ok(Number.isFinite(Date.parse(ledger.get(1)!.completedAt)));
});
test('ledger bounds, detached snapshots, clear and monotonic epoch references', () => {
  let sequence = 0; const ledger = new SessionEvidence(() => ++sequence, context);
  for (let i = 0; i < 33; i++) ledger.add('tool', 'request', { count: i });
  assert.equal(ledger.list().length, 32); assert.equal(ledger.get(1), undefined);
  ledger.list()[0]!.metadata.push('mutated');
  assert.deepEqual(ledger.list()[0]!.metadata, []);
  ledger.clear(); assert.deepEqual(ledger.list(), []);
  const next = new SessionEvidence(() => ++sequence, { ...context, epoch: 2 });
  assert.equal(next.add('tool', 'new request', { count: 1 }), 34);
  assert.equal(next.get(1), undefined);
  for (let i = 0; i < 4; i++) next.add('tool', 'large', { text: 'x'.repeat(700000) });
  assert.equal(next.list().length, 2);
});
test('ambiguous duplicate adapter IDs never resolve to an arbitrary record', () => {
  let sequence = 0; const ledger = new SessionEvidence(() => ++sequence, context);
  ledger.add('tool', 'first', { value: 1, evidence: { id } });
  ledger.add('tool', 'second', { value: 2, evidence: { id } });
  assert.equal(ledger.format(id, []), '[unavailable reference]');
});
