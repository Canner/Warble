import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runPrivate, DEFAULT_LIMITS } from '../dist/runner.js';

test('SSE transport budget is independent of final output budget and remains bounded', { timeout: 15000 }, async () => {
  const payloads: any[] = [];
  let final = '{"evidence":"host-token"}';
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk; payloads.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (delta: unknown, finish_reason: string | null = null) =>
      'data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'mock',
        choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
    let body = event({ role: 'assistant' });
    for (let i = 0; i < 1200; i++) body += event({ reasoning_content: 'x'.repeat(1024) });
    body += event({ content: final }) + event({}, 'stop') + 'data: [DONE]\n\n';
    res.end(body);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const input = { instructions: 'Return JSON.', context: [], request: 'test',
    model: { zone: 'private' as const, id: 'mock', apiKey: 'test', baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1` },
    tools: [], maxTurns: 2, maxRequestBytes: 65536, maxOutputBytes: 1048576 };
  try {
    await assert.rejects(runPrivate(input, [], DEFAULT_LIMITS, new AbortController().signal),
      (e: any) => e.code === 'response_limit');
    assert.deepEqual(await runPrivate({ ...input, model: { ...input.model, enableThinking: false }, maxResponseBytes: 2 * 1048576 }, [], DEFAULT_LIMITS, new AbortController().signal), { evidence: 'host-token' });
    assert.equal(payloads[0].chat_template_kwargs, undefined);
    assert.deepEqual(payloads[1].chat_template_kwargs, { enable_thinking: false });
    assert.equal(payloads[1].model, 'mock');
    final = JSON.stringify({ unapproved: 'x'.repeat(1024) });
    await assert.rejects(runPrivate({ ...input, maxResponseBytes: 2 * 1048576 }, [], { ...DEFAULT_LIMITS, maxOutputBytes: 256 }, new AbortController().signal),
      (e: any) => e.code === 'output_limit');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('service corrects final JSON once without re-executing tools; persistent malformed output fails closed', { timeout: 15000 }, async () => {
  const requests: any[] = []; let toolExecutions = 0, malformed = false;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const afterTool = body.messages.some((m: any) => m.role === 'tool');
    const repairing = body.response_format?.type === 'json_object';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (delta: unknown, finish_reason: string | null = null) => res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    event({ role: 'assistant' });
    if (!afterTool) {
      event({ tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'read', arguments: '{}' } }] }); event({}, 'tool_calls');
    } else { event({ content: repairing && !malformed ? '{"evidence":"token"}' : '```json\n{"evidence":"token"}\n```' }); event({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const tool = { name: 'read', capability: 'read_data', action: 'query', zone: 'private' as const, readOnly: true as const,
    description: 'read', parameters: { type: 'object', properties: {} }, validate: () => true,
    execute: async () => { toolExecutions++; return { evidence: 'token' }; } };
  const input = { instructions: 'Return only evidence JSON.', context: [], request: 'test', evidenceOutput: true,
    model: { zone: 'private' as const, id: 'mock', apiKey: 'test', baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1` },
    tools: [{ name: tool.name, description: tool.description, parameters: tool.parameters }], maxTurns: 4, maxRequestBytes: 65536, maxOutputBytes: 1048576 };
  try {
    assert.deepEqual(await runPrivate(input, [tool], DEFAULT_LIMITS, new AbortController().signal), { evidence: 'token' });
    assert.equal(requests.length, 3); assert.equal(toolExecutions, 1);
    assert.equal(requests[2].response_format.type, 'json_object');
    malformed = true; requests.length = 0; toolExecutions = 0;
    await assert.rejects(runPrivate(input, [tool], DEFAULT_LIMITS, new AbortController().signal), (e: any) => e.code === 'invalid_json');
    assert.equal(requests.length, 3); assert.equal(toolExecutions, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
