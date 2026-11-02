import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";

const all = 'permit(principal, action, resource);';
const request = { caller: 'c', project: 'p', role: 'worker', session: 's', epoch: 1,
  action: 'execute_query', kind: 'query', name: 'orders', columns: ['date'], recipient: '' };
function start() {
  const child = spawn(process.execPath, ['dist/service.js'], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
  const iterator = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return { child, send: (x: unknown) => child.stdin.write(JSON.stringify(x) + '\n'),
    read: async () => { const next = await iterator.next(); assert.equal(next.done, false); return JSON.parse(next.value!); },
    close: async () => { if (child.exitCode !== null) return; const done = once(child, 'close'); child.stdin.end(); await done; } };
}
test('service handshake and unknown operations fail closed without raw diagnostics', { timeout: 15000 }, async () => {
  const p = start();
  try {
    p.send({ id: 'early', op: 'authorize', request });
    assert.deepEqual(await p.read(), { id: 'early', error: 'service_unavailable' });
    p.send({ id: 'wrong', op: 'init', protocol: 'future', policies: [all, all], ir: null });
    assert.equal((await p.read()).error, 'service_unavailable');
    p.send({ id: 'init', op: 'init', protocol: 'warble-private-service/1', policies: [all, all], ir: null });
    assert.deepEqual((await p.read()).value, { protocol: 'warble-private-service/1', ir: '0.9', schema: '1' });
    p.send({ id: 'auth', op: 'authorize', request });
    assert.equal((await p.read()).value, true);
    p.send({ id: 'unknown', op: 'replace_policy', policies: [all, all] });
    assert.deepEqual(await p.read(), { id: 'unknown', error: 'service_unavailable' });
    p.send({ id: 'invoke', op: 'invoke', request: 'x' });
    assert.equal((await p.read()).error, 'service_unavailable');
  } finally { await p.close(); }
});
test('unsupported IR and missing declared tools fail before model requests', { timeout: 15000 }, async () => {
  for (const mutation of ['version', 'tool']) {
    const p = start();
    try {
      const ir = JSON.parse(readFileSync(new URL('./fixtures/hybrid.ir.json', import.meta.url), 'utf8'));
      if (mutation === 'version') ir.warble_ir_version = '99';
      else { ir.components[1].borrowed_actions.push('read'); ir.components[1].required_capabilities.push('read_data'); }
      p.send({ id: 'i', op: 'init', protocol: 'warble-private-service/1', policies: [all, all], ir, entry: 'caller',
        model: { zone: 'private', id: 'fixture', apiKey: 'stub', baseUrl: 'http://127.0.0.1:1/v1' }, tools: [] });
      assert.equal((await p.read()).error, 'service_unavailable');
    } finally { await p.close(); }
  }
});
test('cancelled invocation rejects late completion and preserves the next IPC request', { timeout: 15000 }, async () => {
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain request */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (delta: unknown, finish_reason: string | null = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    event({ role: 'assistant' });
    event({ tool_calls: [{ index: 0, id: 't', type: 'function', function: { name: 'read_count', arguments: '{}' } }] });
    event({}, 'tool_calls'); res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const p = start();
  try {
    const ir = JSON.parse(readFileSync(new URL('./fixtures/hybrid.ir.json', import.meta.url), 'utf8'));
    ir.components[0].borrowed_actions.push('query'); ir.components[0].required_capabilities.push('read_data');
    p.send({ id: 'i', op: 'init', protocol: 'warble-private-service/1', policies: [all, all], ir, entry: 'caller',
      model: { zone: 'private', id: 'fixture', apiKey: 'stub', baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1` },
      tools: [{ name: 'read_count', action: 'query', capability: 'read_data', zone: 'private', readOnly: true, description: 'read', parameters: { type: 'object', properties: {} } }] });
    assert.ok((await p.read()).value);
    p.send({ id: 'work', op: 'invoke', request: 'read' });
    const call = await p.read(); assert.equal(call.type, 'tool_call'); assert.equal(call.owner, 'work');
    p.send({ id: 'stop', op: 'cancel', owner: 'work' });
    const responses = [await p.read(), await p.read()];
    assert.equal(responses.find(r => r.id === 'stop').value, true);
    assert.equal(responses.find(r => r.id === 'work').error, 'service_unavailable');
    p.send({ type: 'tool_result', id: call.id, owner: call.owner, value: { count: 9999 } });
    p.send({ id: 'after', op: 'authorize', request });
    assert.deepEqual(await p.read(), { id: 'after', value: true });
  } finally { await p.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('unsolicited tool result terminates the private IPC channel', { timeout: 15000 }, async () => {
  const p = start(); const done = once(p.child, 'close');
  p.send({ type: 'tool_result', id: 1, owner: 'forged', value: true });
  assert.equal((await done)[0], 1);
});

test('private delegation retains the host task when the coordinator omits context', { timeout: 15000 }, async () => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); requests.push(input);
    const root = input.tools?.some((t: any) => t.function.name === 'answer');
    const delegate = root && !input.messages.some((m: any) => m.role === 'tool');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (delta: unknown, finish_reason: string | null = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    event({ role: 'assistant' });
    if (delegate) { event({ tool_calls: [{ index: 0, id: 'd', type: 'function', function: { name: 'answer', arguments: '{"request":"brief paraphrase"}' } }] }); event({}, 'tool_calls'); }
    else { event({ content: '{"evidence":"host-token"}' }); event({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const p = start();
  try {
    const ir = JSON.parse(readFileSync(new URL('./fixtures/hybrid.ir.json', import.meta.url), 'utf8'));
    p.send({ id: 'i', op: 'init', protocol: 'warble-private-service/1', policies: [all, all], ir, entry: 'caller', tools: [],
      model: { zone: 'private', id: 'fixture', apiKey: 'stub', baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1` } });
    assert.ok((await p.read()).value);
    p.send({ id: 'work', op: 'invoke', request: 'ORIGINAL_HOST_CONTEXT' });
    const call = await p.read(); assert.equal(call.name, '__delegate');
    p.send({ type: 'tool_result', owner: call.owner, id: call.id, value: true });
    assert.deepEqual(await p.read(), { id: 'work', value: { evidence: 'host-token' } });
    const leaf = requests.find(r => !r.tools?.some((t: any) => t.function.name === 'answer'));
    assert.ok(JSON.stringify(leaf.messages).includes('ORIGINAL_HOST_CONTEXT'));
    assert.ok(JSON.stringify(leaf.messages).includes('brief paraphrase'));
  } finally { await p.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
