import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { invocationAbortMs, parseLimits, planExecution } from "../dist/service-policy.js";

const all = 'permit(principal, action, resource);';
const EVIDENCE = JSON.stringify({ evidence: 'host-token' });
type Handler = (n: number, req: IncomingMessage, res: ServerResponse) => void;

async function fake(handle: Handler) {
  const requests: any[] = [], closed: boolean[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const n = requests.length - 1; closed[n] = false;
    req.socket.on('close', () => { closed[n] = true; });
    handle(n, req, res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { requests, closed, baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const sse = (res: ServerResponse, events: { delta?: unknown; finish?: string | null; usage?: unknown }[]) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const { delta = {}, finish = null, usage } of events) {
    res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) }) + '\n\n');
  }
  res.end('data: [DONE]\n\n');
};
const answer = (res: ServerResponse, usage?: unknown) => sse(res, [{ delta: { role: 'assistant' } }, { delta: { content: EVIDENCE } }, { finish: 'stop', usage }]);
const toolCall = (res: ServerResponse, n: number) => sse(res, [{ delta: { role: 'assistant' } },
  { delta: { tool_calls: [{ index: 0, id: 'call-' + n, type: 'function', function: { name: 'read_count', arguments: '{}' } }] } }, { finish: 'tool_calls' }]);

function start() {
  const child = spawn(process.execPath, ['dist/service.js'], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
  const iterator = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return { child, send: (x: unknown) => child.stdin.write(JSON.stringify(x) + '\n'),
    read: async () => { const next = await iterator.next(); assert.equal(next.done, false); return JSON.parse(next.value!); },
    close: async () => { if (child.exitCode !== null) return; const done = once(child, 'close'); child.stdin.end(); await done; } };
}
const readTool = { name: 'read_count', action: 'query', capability: 'read_data', zone: 'private', readOnly: true, description: 'read', parameters: { type: 'object', properties: {} } };
function init(baseUrl: string, extra: Record<string, unknown> = {}, withTool = false, model: Record<string, unknown> = {}) {
  const ir = JSON.parse(readFileSync(new URL('./fixtures/hybrid.ir.json', import.meta.url), 'utf8'));
  if (withTool) { ir.components[0].borrowed_actions.push('query'); ir.components[0].required_capabilities.push('read_data'); }
  return { id: 'i', op: 'init', protocol: 'warble-private-service/1', policies: [all, all], ir, entry: 'caller',
    model: { zone: 'private', id: 'fixture', apiKey: 'stub', baseUrl, ...model }, tools: withTool ? [readTool] : [], ...extra };
}
/** Read until the invocation's own response, answering host tool callbacks. */
async function invoke(p: ReturnType<typeof start>, id = 'work') {
  p.send({ id, op: 'invoke', request: 'go' });
  for (;;) {
    const m = await p.read();
    if (m.type === 'tool_call') p.send({ type: 'tool_result', id: m.id, owner: m.owner, value: { count: 1 } });
    else if (m.id === id) return m;
  }
}
async function session(baseUrl: string, limits: unknown, opts: { withTool?: boolean; model?: Record<string, unknown> } = {}) {
  const p = start();
  p.send(init(baseUrl, limits === undefined ? {} : { limits }, opts.withTool, opts.model));
  const ready = await p.read();
  return { p, ready };
}

test('provider 429 is retried within providerMaxRetries without consuming the turn budget', { timeout: 30000 }, async () => {
  const srv = await fake((n, _req, res) => {
    if (n === 0) { res.writeHead(429, { 'retry-after-ms': '50', 'content-type': 'application/json' }); res.end('{"error":{"message":"SECRET_BODY"}}'); }
    else answer(res, { prompt_tokens: 10, completion_tokens: 2 });
  });
  const { p, ready } = await session(srv.baseUrl, { maxTurns: 1, providerMaxRetries: 2 });
  try {
    assert.ok(ready.value);
    const r = await invoke(p);
    assert.deepEqual(r.value, { evidence: 'host-token' });
    assert.equal(srv.requests.length, 2);
    assert.deepEqual(r.calls.map((c: any) => [c.turn, c.status]), [[1, 'http_429'], [1, 'ok']]);
    assert.ok(!JSON.stringify(r).includes('SECRET_BODY'));
  } finally { await p.close(); await srv.close(); }
});

test('without retries a provider 429 fails as provider_http and reports the attempt', { timeout: 30000 }, async () => {
  for (const limits of [undefined, { providerMaxRetries: 0 }]) {
    const srv = await fake((_n, _req, res) => { res.writeHead(429, { 'retry-after-ms': '50' }); res.end('{}'); });
    const { p } = await session(srv.baseUrl, limits);
    try {
      const r = await invoke(p);
      assert.equal(r.error, 'service_unavailable'); assert.equal(r.diagnostic, 'provider_http');
      assert.equal(srv.requests.length, 1);
      assert.deepEqual(r.calls.map((c: any) => c.status), ['http_429']);
      assert.equal(r.turns, 1); assert.equal(r.toolCalls, 0);
    } finally { await p.close(); await srv.close(); }
  }
});

test('retries are bounded by maxTurns x (providerMaxRetries + 1) and local denials are never retried', { timeout: 30000 }, async () => {
  const srv = await fake((_n, _req, res) => { res.writeHead(503, { 'retry-after-ms': '10' }); res.end('{}'); });
  const { p } = await session(srv.baseUrl, { providerMaxRetries: 2 });
  try {
    const r = await invoke(p);
    assert.equal(r.diagnostic, 'provider_http');
    assert.equal(srv.requests.length, 3); assert.equal(r.calls.length, 3);
  } finally { await p.close(); await srv.close(); }
  const empty = await fake((_n, _req, res) => { res.writeHead(204); res.end(); });
  const second = await session(empty.baseUrl, { providerMaxRetries: 8 });
  try {
    // A local policy denial must not look retryable to the provider retry loop.
    const t0 = Date.now(), r = await invoke(second.p);
    assert.equal(r.diagnostic, 'missing_response');
    assert.equal(empty.requests.length, 1);
    assert.ok(Date.now() - t0 < 3000, 'no backoff sleeps');
  } finally { await second.p.close(); await empty.close(); }
});

test('deadlineMs aborts a hung provider request and reports deadline, not cancelled', { timeout: 30000 }, async () => {
  const srv = await fake(() => { /* never answer */ });
  const { p } = await session(srv.baseUrl, { deadlineMs: 5000 });
  try {
    const t0 = Date.now();
    const r = await invoke(p);
    const elapsed = Date.now() - t0;
    assert.equal(r.error, 'service_unavailable'); assert.equal(r.diagnostic, 'deadline');
    assert.ok(elapsed >= 4900 && elapsed < 5600, `deadline fired after ${elapsed} ms`);
    for (let i = 0; i < 100 && !srv.closed[0]; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(srv.closed[0], true, 'provider connection closed');
    assert.ok(r.calls.length === 1 && r.calls[0].status === 'aborted', JSON.stringify(r.calls));
  } finally { await p.close(); await srv.close(); }
});

test('deadlineMs also ends an invocation stuck waiting on a host tool, before the runner backstop', { timeout: 30000 }, async () => {
  const srv = await fake((n, _req, res) => toolCall(res, n));
  const { p } = await session(srv.baseUrl, { deadlineMs: 5000 }, { withTool: true });
  try {
    const t0 = Date.now();
    p.send({ id: 'work', op: 'invoke', request: 'go' });
    const call = await p.read(); assert.equal(call.type, 'tool_call');
    const r = await p.read(); // the host never answers the tool call
    const elapsed = Date.now() - t0;
    assert.equal(r.id, 'work'); assert.equal(r.diagnostic, 'deadline');
    assert.ok(elapsed >= 4900 && elapsed < 7000, `deadline fired after ${elapsed} ms`);
    assert.equal(r.calls.length, 1); assert.equal(r.calls[0].toolCalls, 1); assert.equal(r.toolCalls, 1);
  } finally { await p.close(); await srv.close(); }
});

test('host cancel stays cancelled even when a deadline is configured', { timeout: 30000 }, async () => {
  const srv = await fake(() => { /* never answer */ });
  const { p } = await session(srv.baseUrl, { deadlineMs: 10000 });
  try {
    p.send({ id: 'work', op: 'invoke', request: 'go' });
    for (let i = 0; i < 200 && srv.requests.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
    p.send({ id: 'stop', op: 'cancel', owner: 'work' });
    const both = [await p.read(), await p.read()];
    assert.equal(both.find(m => m.id === 'work').diagnostic, 'cancelled');
    assert.ok(Array.isArray(both.find(m => m.id === 'work').calls));
  } finally { await p.close(); await srv.close(); }
});

test('calls carry the provider usage as bounded numbers and short tokens, never content', { timeout: 30000 }, async () => {
  const srv = await fake((_n, _req, res) => answer(res, { prompt_tokens: 123, completion_tokens: 45,
    completion_tokens_details: { reasoning_tokens: 6 }, prompt_tokens_details: { cached_tokens: 20 } }));
  const { p } = await session(srv.baseUrl, undefined);
  try {
    const r = await invoke(p);
    assert.deepEqual(r.value, { evidence: 'host-token' });
    assert.equal(r.calls.length, 1);
    const { elapsedMs, ...rest } = r.calls[0];
    assert.ok(Number.isSafeInteger(elapsedMs) && elapsedMs >= 0);
    assert.deepEqual(rest, { turn: 1, input: 103, output: 45, reasoning: 6, cacheRead: 20, stopReason: 'stop', rawStopReason: 'stop', toolCalls: 0, status: 'ok' });
    assert.deepEqual(Object.keys(r).sort(), ['calls', 'id', 'value']);
    assert.ok(!JSON.stringify(r.calls).includes('host-token'));
  } finally { await p.close(); await srv.close(); }
});

test('an omitted limits object keeps today\'s constants and provider payload', { timeout: 30000 }, async () => {
  assert.deepEqual(parseLimits(undefined), {});
  assert.equal(planExecution({}, false).runnerTimeoutMs, 60000);
  assert.equal(planExecution({}, true).runnerTimeoutMs, 90000);
  assert.equal(planExecution({}, true).childDeadlineMs, undefined);
  assert.equal(invocationAbortMs({}), 90000);
  assert.deepEqual([planExecution({}, true).maxTurns, planExecution({}, true).maxToolCalls, planExecution({}, true).providerMaxRetries], [12, 16, 0]);
  assert.equal(planExecution({ deadlineMs: 20000 }, false).runnerTimeoutMs, 25000);
  assert.equal(planExecution({ deadlineMs: 20000 }, true).runnerTimeoutMs, 25000);
  assert.equal(invocationAbortMs({ deadlineMs: 20000 }), 50000);
  const srv = await fake((_n, _req, res) => answer(res));
  const { p } = await session(srv.baseUrl, undefined);
  try {
    const r = await invoke(p);
    assert.deepEqual(r.value, { evidence: 'host-token' }); assert.equal(r.calls.length, 1);
    const payload = srv.requests[0];
    assert.equal(payload.max_tokens ?? payload.max_completion_tokens, 4096);
    assert.ok(!('chat_template_kwargs' in payload));
  } finally { await p.close(); await srv.close(); }
});

test('maxTokens and enableThinking from limits reach the provider payload; limits wins over the model field', { timeout: 30000 }, async () => {
  const srv = await fake((_n, _req, res) => answer(res));
  const { p } = await session(srv.baseUrl, { maxTokens: 8192, enableThinking: true }, { model: { enableThinking: false } });
  try {
    await invoke(p);
    const payload = srv.requests[0];
    assert.equal(payload.max_tokens ?? payload.max_completion_tokens, 8192);
    assert.deepEqual(payload.chat_template_kwargs, { enable_thinking: true });
  } finally { await p.close(); await srv.close(); }
  const legacy = await fake((_n, _req, res) => answer(res));
  const second = await session(legacy.baseUrl, { maxTokens: 256 }, { model: { enableThinking: false } });
  try {
    await invoke(second.p);
    assert.equal(legacy.requests[0].max_tokens ?? legacy.requests[0].max_completion_tokens, 256);
    assert.deepEqual(legacy.requests[0].chat_template_kwargs, { enable_thinking: false });
  } finally { await second.p.close(); await legacy.close(); }
});

test('maxTurns and maxToolCalls from limits bound the model loop', { timeout: 30000 }, async () => {
  const turns = await fake((n, _req, res) => toolCall(res, n));
  const a = await session(turns.baseUrl, { maxTurns: 2 }, { withTool: true });
  try {
    const r = await invoke(a.p);
    assert.equal(r.diagnostic, 'turn_limit');
    assert.equal(turns.requests.length, 2); assert.equal(r.calls.length, 2);
    assert.equal(r.turns, 2); assert.equal(r.toolCalls, 2);
    assert.deepEqual(r.calls.map((c: any) => c.toolCalls), [1, 1]);
  } finally { await a.p.close(); await turns.close(); }
  const tools = await fake((n, _req, res) => toolCall(res, n));
  const b = await session(tools.baseUrl, { maxToolCalls: 1 }, { withTool: true });
  try {
    const r = await invoke(b.p);
    assert.equal(r.error, 'service_unavailable'); assert.equal(r.diagnostic, 'protocol');
    assert.equal(tools.requests.length, 2); assert.equal(r.toolCalls, 1);
  } finally { await b.p.close(); await tools.close(); }
});

test('invalid limits are rejected at init with a bounded diagnostic and leave the service uninitialised', { timeout: 30000 }, async () => {
  const cases: [unknown, string][] = [
    [{ deadlineMs: 4999 }, 'deadlineMs'], [{ deadlineMs: 600001 }, 'deadlineMs'], [{ deadlineMs: '5000' }, 'deadlineMs'],
    [{ deadlineMs: 5000.5 }, 'deadlineMs'], [{ maxTokens: 255 }, 'maxTokens'], [{ maxTokens: 65537 }, 'maxTokens'],
    [{ maxTurns: 0 }, 'maxTurns'], [{ maxTurns: 65 }, 'maxTurns'], [{ maxToolCalls: 0 }, 'maxToolCalls'], [{ maxToolCalls: 257 }, 'maxToolCalls'],
    [{ providerMaxRetries: -1 }, 'providerMaxRetries'], [{ providerMaxRetries: 9 }, 'providerMaxRetries'],
    [{ providerMaxRetryDelayMs: 99 }, 'providerMaxRetryDelayMs'], [{ providerMaxRetryDelayMs: 60001 }, 'providerMaxRetryDelayMs'],
    [{ enableThinking: null }, 'enableThinking'], [{ enableThinking: 'yes' }, 'enableThinking'],
    [null, 'limits'], [[], 'limits'], ['x', 'limits'], [{ SECRET_FIELD: 1 }, 'unknown_limit'],
  ];
  for (const [raw, field] of cases) assert.deepEqual(parseLimits(raw), { error: field }, JSON.stringify(raw));
  assert.deepEqual(parseLimits({ deadlineMs: 5000, maxTokens: 256, maxTurns: 64, maxToolCalls: 256, providerMaxRetries: 8,
    providerMaxRetryDelayMs: 60000, enableThinking: false }), { deadlineMs: 5000, maxTokens: 256, maxTurns: 64, maxToolCalls: 256,
    providerMaxRetries: 8, providerMaxRetryDelayMs: 60000, enableThinking: false });
  const p = start();
  try {
    for (const [raw, field] of [[{ deadlineMs: 100 }, 'deadlineMs'], [null, 'limits'], [{ SECRET_FIELD: 1 }, 'unknown_limit']] as [unknown, string][]) {
      p.send(init('http://127.0.0.1:1/v1', { limits: raw }));
      assert.deepEqual(await p.read(), { id: 'i', error: 'invalid_limits', diagnostic: field });
      p.send({ id: 'early', op: 'authorize', request: { caller: 'c' } });
      assert.deepEqual(await p.read(), { id: 'early', error: 'service_unavailable' });
    }
    p.send(init('http://127.0.0.1:1/v1', { limits: { deadlineMs: 5000 } }));
    assert.ok((await p.read()).value);
  } finally { await p.close(); }
});

test('reasoningBudgetTokens is a reserved field the service refuses', { timeout: 30000 }, async () => {
  assert.deepEqual(parseLimits({ reasoningBudgetTokens: 1024 }), { error: 'unsupported_limit:reasoningBudgetTokens' });
  const p = start();
  try {
    p.send(init('http://127.0.0.1:1/v1', { limits: { reasoningBudgetTokens: 1024 } }));
    assert.deepEqual(await p.read(), { id: 'i', error: 'invalid_limits', diagnostic: 'unsupported_limit:reasoningBudgetTokens' });
  } finally { await p.close(); }
});

test('each component is offered only the declarations matching its own capabilities', { timeout: 30000 }, async () => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); requests.push(input);
    const root = input.tools?.some((t: any) => t.function.name === 'answer');
    if (root && !input.messages.some((m: any) => m.role === 'tool')) {
      sse(res, [{ delta: { role: 'assistant' } }, { delta: { tool_calls: [{ index: 0, id: 'd', type: 'function', function: { name: 'answer', arguments: '{"request":"look"}' } }] } }, { finish: 'tool_calls' }]);
    } else answer(res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const p = start();
  try {
    const ir = JSON.parse(readFileSync(new URL('./fixtures/hybrid.ir.json', import.meta.url), 'utf8'));
    ir.components[0].borrowed_actions.push('query'); ir.components[0].required_capabilities.push('read_data');
    ir.components[1].borrowed_actions.push('query'); ir.components[1].required_capabilities.push('read_schema');
    const declare = (name: string, capability: string) => ({ ...readTool, name, capability });
    p.send({ id: 'i', op: 'init', protocol: 'warble-private-service/1', policies: [all, all], ir, entry: 'caller',
      model: { zone: 'private', id: 'fixture', apiKey: 'stub', baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1` },
      tools: [declare('read_rows', 'read_data'), declare('read_schema', 'read_schema')] });
    assert.ok((await p.read()).value);
    p.send({ id: 'work', op: 'invoke', request: 'go' });
    for (;;) {
      const m = await p.read();
      if (m.type === 'tool_call') { p.send({ type: 'tool_result', id: m.id, owner: m.owner, value: true }); continue; }
      assert.deepEqual(m.value, { evidence: 'host-token' }); break;
    }
    const advertised = (r: any) => r.tools.map((t: any) => t.function.name).sort();
    const rootRequests = requests.filter(r => r.tools.some((t: any) => t.function.name === 'answer'));
    const leafRequests = requests.filter(r => !r.tools.some((t: any) => t.function.name === 'answer'));
    assert.ok(rootRequests.length > 0 && leafRequests.length > 0);
    for (const r of rootRequests) assert.deepEqual(advertised(r), ['answer', 'read_rows']);
    for (const r of leafRequests) assert.deepEqual(advertised(r), ['read_schema']);
  } finally { await p.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('a failed init leaves no execution state for a later init to inherit', { timeout: 30000 }, async () => {
  const srv = await fake((_n, _req, res) => answer(res));
  const p = start();
  try {
    const rejected = init(srv.baseUrl, {}, true);
    (rejected.ir as any).components[0].borrowed_actions.push('read');
    (rejected.ir as any).components[0].required_capabilities.push('read_schema');
    p.send(rejected);
    assert.deepEqual(await p.read(), { id: 'i', error: 'service_unavailable' });
    p.send({ id: 'i2', op: 'init', protocol: 'warble-private-service/1', policies: [all, all], ir: null });
    assert.ok((await p.read()).value);
    p.send({ id: 'work', op: 'invoke', request: 'go' });
    assert.deepEqual(await p.read(), { id: 'work', error: 'service_unavailable' });
    assert.equal(srv.requests.length, 0, 'no provider request from a rejected closure');
  } finally { await p.close(); await srv.close(); }
});

test('providerMaxRetryDelayMs also caps the backoff between attempts when the provider sends no Retry-After', { timeout: 30000 }, async () => {
  const arrivals: number[] = [];
  const srv = await fake((_n, _req, res) => { arrivals.push(Date.now()); res.writeHead(503); res.end('{}'); });
  const { p } = await session(srv.baseUrl, { maxTurns: 1, providerMaxRetries: 2, providerMaxRetryDelayMs: 100 });
  try {
    const r = await invoke(p);
    assert.equal(r.diagnostic, 'provider_http');
    assert.equal(srv.requests.length, 3); assert.equal(r.calls.length, 3);
    const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]!);
    for (const gap of gaps) assert.ok(gap <= 250, `retry waited ${gap} ms against a 100 ms ceiling`);
  } finally { await p.close(); await srv.close(); }
});

test('a provider-requested delay above providerMaxRetryDelayMs fails at once instead of waiting', { timeout: 30000 }, async () => {
  const srv = await fake((_n, _req, res) => { res.writeHead(429, { 'retry-after-ms': '5000' }); res.end('{}'); });
  const { p } = await session(srv.baseUrl, { providerMaxRetries: 2, providerMaxRetryDelayMs: 100 });
  try {
    const t0 = Date.now(), r = await invoke(p);
    assert.equal(r.diagnostic, 'provider_http');
    assert.equal(srv.requests.length, 1);
    assert.ok(Date.now() - t0 < 2000, 'no wait for the oversized delay');
  } finally { await p.close(); await srv.close(); }
});
