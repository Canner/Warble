import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { PolicyAuthority, DisclosureBoundary, createHybridSession, createEgressTransport } from "../dist/index.js";
import type { HybridOptions, PrivateTool, Projection, SessionSelection } from "../dist/index.js";
import { admitClosure } from "../dist/admission.js";
import { supervisePrivate, DEFAULT_LIMITS } from "../dist/runner.js";
import { jsonBytes } from "../dist/disclosure.js";

const permit = 'permit(principal, action, resource);';
const ir = () => JSON.parse(readFileSync(new URL('./fixtures/hybrid.ir.json', import.meta.url), 'utf8'));
const projection: Projection = {
  project: (raw: any) => ({ count: raw.count }),
  validate: (v: any) => Number.isSafeInteger(v.count) && v.count >= 0,
};
const tool: PrivateTool = { name: 'read_count', capability: 'read_data', action: 'query', zone: 'private', readOnly: true,
  description: 'Read the private count', parameters: { type: 'object', properties: {}, additionalProperties: false },
  validate: v => !!v && Object.keys(v).length === 0,
  execute: async () => ({ count: 7, sql: 'PRIVATE_SQL', details: 'PRIVATE_TOOL_DETAILS' }),
};
function setup(endpoint: string, selection?: SessionSelection) {
  const authority = new PolicyAuthority(permit);
  const boundary = new DisclosureBoundary(authority);
  const publicRecipient = authority.registerRecipient({ project: 'p', zone: 'public', role: 'planner', deployment: 'public' });
  const privateRecipient = authority.registerRecipient({ project: 'p', zone: 'private', role: 'worker', deployment: 'private' });
  const publicSession = authority.openSession(publicRecipient, selection ?? { metadata: [], approvedAnswers: true, components: ['callee'] }, true);
  const privateSession = authority.openSession(privateRecipient, { metadata: [{ kind: 'data.raw', documents: ['private-data'] }], approvedAnswers: false, components: [] }, true);
  const context = boundary.metadata('p', 'data.raw', 'private-data', { secret: 'PRIVATE_CONTEXT' });
  const options: HybridOptions = { ir: ir(), entry: 'caller', project: 'p', authority, boundary, publicRecipient, publicSession,
    bindings: { callee: { cheap: { recipient: privateRecipient, session: privateSession,
      model: { zone: 'private', id: 'private-fixture', baseUrl: endpoint, apiKey: 'private-stub-key' }, context: [context], tools: [], projection } } } };
  return { authority, boundary, options, publicSession, privateSession, publicRecipient, context };
}
async function provider(mode: 'ok' | 'tool' | 'invalid' | 'hold' | 'large' | 'loop' = 'ok') {
  const requests: any[] = [], headers: any[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body)); headers.push(req.headers);
    if (mode === 'hold') return;
    const request = requests.at(-1);
    const needsTool = mode === 'loop' || mode === 'tool' && !request.messages.some((m: any) => m.role === 'tool');
    const base = { id: 'stub', object: 'chat.completion.chunk', created: 1, model: 'private-fixture' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: unknown, finish_reason: string | null = null) => res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    chunk({ role: 'assistant' });
    if (needsTool) {
      chunk({ tool_calls: [{ index: 0, id: 'call-' + requests.length, type: 'function', function: { name: 'read_count', arguments: '{}' } }] });
      chunk({}, 'tool_calls');
    } else {
      chunk({ content: mode === 'invalid' ? 'PRIVATE_INVALID' : JSON.stringify({ count: 7, sql: 'PRIVATE_SQL', content: 'PRIVATE_TRANSCRIPT', details: 'PRIVATE_DETAILS',
        ...(mode === 'large' ? { raw: 'x'.repeat(50000) } : {}) }) });
      chunk({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { endpoint: `http://127.0.0.1:${port}/v1`, requests, headers,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
function withTool(options: HybridOptions) {
  const value = options.ir as any;
  value.components[1].required_capabilities.push('read_data');
  value.components[1].borrowed_actions.push('query');
  options.bindings.callee!.cheap!.tools = [tool];
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 300 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate(), 'condition reached');
}
const denied = (value: unknown) => {
  assert.equal(JSON.stringify(value), '{"content":[{"type":"text","text":"{\\"status\\":\\"unavailable\\"}"}],"structuredContent":{"status":"unavailable"},"details":{},"isError":true}');
};

test('real pinned pi loop: fresh processes, exact private tools/context, projected result and no auxiliary leaks', async () => {
  const p = await provider('tool'); const s = setup(p.endpoint); withTool(s.options);
  const before = readdirSync(tmpdir()).filter(n => n.startsWith('warble-private-')).sort();
  const h = createHybridSession(s.options);
  try {
    const first = await h.tools[0]!.execute({ request: 'FIRST_REQUEST' });
    assert.deepEqual(first.structuredContent, { count: 7 }); assert.deepEqual(first.details, {});
    const second = await h.tools[0]!.execute({ request: 'SECOND_REQUEST' });
    assert.deepEqual(second.structuredContent, { count: 7 });
    assert.equal(p.requests.length, 4);
    assert.ok(JSON.stringify(p.requests[0]).includes('PRIVATE_CONTEXT'));
    assert.ok(!JSON.stringify(p.requests[2]).includes('FIRST_REQUEST'));
    assert.deepEqual(p.requests[0].tools.map((t: any) => t.function.name), ['read_count']);
    assert.ok(JSON.stringify(p.requests[1]).includes('PRIVATE_TOOL_DETAILS'));
    assert.ok(!JSON.stringify([first, second]).includes('PRIVATE_'));
    assert.equal(p.headers[0].authorization, 'Bearer private-stub-key');
    assert.deepEqual(readdirSync(tmpdir()).filter(n => n.startsWith('warble-private-')).sort(), before);
  } finally { h.close(); await p.close(); }
});

test('model arguments cannot override step, alias, component, tools, model or endpoint', async () => {
  const p = await provider(); const s = setup(p.endpoint); const h = createHybridSession(s.options);
  try {
    for (const key of ['step', 'alias', 'component', 'model', 'provider', 'endpoint', 'tools', 'transcript']) denied(await h.tools[0]!.execute({ request: 'x', [key]: 'override' }));
    assert.equal(p.requests.length, 0);
  } finally { h.close(); await p.close(); }
});

test('private data bindings cannot be attached to a public worker; missing/excess tools fail before launch', () => {
  for (const mutation of [
    (s: ReturnType<typeof setup>) => { s.options.bindings.callee!.cheap!.model.zone = 'public' as any; },
    (s: ReturnType<typeof setup>) => { s.options.bindings.callee!.cheap!.session = s.publicSession; },
    (s: ReturnType<typeof setup>) => { withTool(s.options); s.options.bindings.callee!.cheap!.tools = []; },
    (s: ReturnType<typeof setup>) => { s.options.bindings.callee!.cheap!.tools = [tool]; },
  ]) {
    const s = setup('http://127.0.0.1:1/v1'); mutation(s); assert.throws(() => createHybridSession(s.options));
  }
});

test('snapshots bind IR, endpoint, instructions, tools and projection against later config mutation', async () => {
  const p = await provider(); const s = setup(p.endpoint); const h = createHybridSession(s.options);
  try {
    s.options.bindings.callee!.cheap!.model.baseUrl = 'http://127.0.0.1:1';
    (s.options.ir as any).components[1].llm_calls[0].prompt = 'OVERRIDE';
    assert.deepEqual((await h.tools[0]!.execute({ request: 'x' })).structuredContent, { count: 7 });
    assert.ok(!JSON.stringify(p.requests).includes('OVERRIDE'));
  } finally { h.close(); await p.close(); }
});

test('metadata permission and approved answer permission are independent', async () => {
  const p = await provider(); const s = setup(p.endpoint, { metadata: [{ kind: 'data.raw', documents: '*' }], components: ['callee'], approvedAnswers: false });
  const h = createHybridSession(s.options);
  try { denied(await h.tools[0]!.execute({ request: 'x' })); assert.equal(p.requests.length, 1); }
  finally { h.close(); await p.close(); }
  const s2 = setup('http://127.0.0.1:1'); assert.throws(() => s2.boundary.read(s2.publicSession, s2.context));
});

for (const mode of ['invalid', 'large', 'loop'] as const) test(`${mode} private output refuses without leaking errors`, async () => {
  const p = await provider(mode); const s = setup(p.endpoint);
  if (mode === 'loop') { withTool(s.options); s.options.limits = { maxTurns: 1 }; }
  if (mode === 'large') s.options.limits = { maxOutputBytes: 1024 };
  const h = createHybridSession(s.options);
  try { denied(await h.tools[0]!.execute({ request: 'x' })); }
  finally { h.close(); await p.close(); }
});

for (const judge of ['deny', 'throw', 'hang', 'mutate'] as const) test(`judge ${judge} cannot widen or stall disclosure`, async () => {
  const p = await provider(); const s = setup(p.endpoint);
  s.options.limits = { timeoutMs: 2000 };
  s.options.bindings.callee!.cheap!.projection = { ...projection, judge: async (value: any) => {
    if (judge === 'throw') throw new Error('PRIVATE_JUDGE_ERROR');
    if (judge === 'hang') await new Promise(() => {});
    if (judge === 'mutate') { value.sql = 'PRIVATE_SQL'; return true; }
    return false;
  } };
  const h = createHybridSession(s.options);
  try {
    const result = await h.tools[0]!.execute({ request: 'x' });
    if (judge === 'mutate') assert.deepEqual(result.structuredContent, { count: 7 }); else denied(result);
  } finally { h.close(); await p.close(); }
});

for (const stop of ['abort', 'policy', 'session', 'resource', 'timeout'] as const) test(`${stop} cancels child and refuses late output`, async () => {
  const p = await provider('hold'); const s = setup(p.endpoint); s.options.limits = { timeoutMs: 1500 };
  const h = createHybridSession(s.options), abort = new AbortController();
  try {
    const result = h.tools[0]!.execute({ request: 'x' }, abort.signal);
    await until(() => p.requests.length === 1);
    if (stop === 'abort') abort.abort();
    if (stop === 'policy') s.authority.replaceDeployment(permit);
    if (stop === 'session') s.authority.closeSession(s.publicSession);
    if (stop === 'resource') s.boundary.revoke(s.context);
    denied(await result);
  } finally { h.close(); await p.close(); }
});

test('one in-flight call and shared attempt budget; cancelled-before-start never launches', async () => {
  const p = await provider('hold'); const s = setup(p.endpoint); s.options.limits = { maxAttempts: 1 };
  const h = createHybridSession(s.options), abort = new AbortController();
  try {
    denied(await h.tools[0]!.execute({ request: 'x' }, AbortSignal.abort()));
    const first = h.tools[0]!.execute({ request: 'x' }, abort.signal);
    await until(() => p.requests.length === 1);
    denied(await h.tools[0]!.execute({ request: 'y' })); abort.abort(); denied(await first);
    denied(await h.tools[0]!.execute({ request: 'z' })); assert.equal(p.requests.length, 1);
  } finally { h.close(); await p.close(); }
});

test('IR admission refuses unsupported semantics rather than flattening them', () => {
  for (const mutate of [
    (v: any) => v.warble_ir_version = '0.10',
    (v: any) => v.components[1].llm_calls.push(v.components[1].llm_calls[0]),
    (v: any) => v.components[1].llm_calls[0].produces = 'result',
    (v: any) => v.components[1].llm_calls[0].conditional = true,
    (v: any) => v.components[1].llm_calls[0].component_calls = [{ alias: 'nested', component: 'caller' }],
    (v: any) => v.components[1].guardrails.push({ name: 'human_approval', locked: true }),
    (v: any) => v.components[1].context_precondition.push({ predicate: 'requires_check' }),
    (v: any) => v.components[1].effect.outcome.kind = 'artifact',
    (v: any) => v.components[1].type = 'mutating',
  ]) { const value = ir(); mutate(value); assert.throws(() => admitClosure(value, 'caller')); }
});

test('immutable payloads reject getters, non-JSON and forged artifact handles', () => {
  for (const value of [NaN, { toJSON: () => 'secret' }, { get count() { throw new Error('getter'); } }, new Date()]) assert.throws(() => jsonBytes(value));
  const s = setup('http://127.0.0.1:1'); assert.throws(() => s.boundary.read(s.publicSession, {} as any));
});

for (const code of [
  'process.exit(0)',
  'console.log("not-json")',
  'console.log(JSON.stringify({type:"result",value:{count:7},details:"PRIVATE"}))',
  'console.log(JSON.stringify({type:"result",value:{count:7}}));console.log(JSON.stringify({type:"result",value:{count:8}}))',
  'process.stdout.write(JSON.stringify({type:"result",value:7}))',
  'console.log(JSON.stringify({type:"tool_call",id:1,name:"missing",args:{}}));setInterval(()=>{},1000)',
  'process.stderr.write("PRIVATE".repeat(200));setInterval(()=>{},1000)',
]) test('hostile process protocol refuses: ' + code.slice(0, 55), async () => {
  const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: {} });
  await assert.rejects(supervisePrivate(child, '{}', [], { ...DEFAULT_LIMITS, timeoutMs: 1500, maxOutputBytes: 512 }, new AbortController().signal), /private_unavailable/);
  assert.notEqual(child.exitCode ?? child.signalCode, null);
});

test('public transport checks exact body, destination, one-shot permits and artifact authority at wire boundary', async () => {
  const p = await provider(); const s = setup(p.endpoint);
  const artifact = await s.boundary.answer('p', s.publicRecipient, { count: 7 }, projection, new AbortController().signal);
  const t = createEgressTransport({ boundary: s.boundary, session: s.publicSession, recipient: s.publicRecipient,
    endpoint: p.endpoint + '/chat/completions', apiKey: 'public-key' });
  const body = { messages: [{ role: 'tool', content: JSON.stringify(s.boundary.read(s.publicSession, artifact)) }] };
  const send = (value: unknown, endpoint = p.endpoint + '/chat/completions') => t.fetch(endpoint, { method: 'POST', body: JSON.stringify(value) });
  try {
    await assert.rejects(send(body), /egress_denied/);
    t.permit(body, [artifact]); await assert.rejects(send({ ...body, details: 'PRIVATE' }), /egress_denied/);
    await assert.rejects(send(body, p.endpoint + '/wrong'), /egress_denied/);
    await (await send(body)).text(); assert.equal(p.requests.length, 1);
    await assert.rejects(send(body), /egress_denied/);
    t.permit(body, [artifact]); s.boundary.revoke(artifact);
    await assert.rejects(send(body), /egress_denied/); assert.equal(p.requests.length, 1);
  } finally { t.close(); await p.close(); }
});

test('unprojectable result never becomes approved, even if judge would approve', async () => {
  const p = await provider(); const s = setup(p.endpoint); let judged = false;
  s.options.bindings.callee!.cheap!.projection = { project: () => ({ count: 'PRIVATE_SQL' }), validate: projection.validate,
    judge: async () => { judged = true; return true; } };
  const h = createHybridSession(s.options);
  try { denied(await h.tools[0]!.execute({ request: 'x' })); assert.equal(judged, false); }
  finally { h.close(); await p.close(); }
});

test('private context read denial prevents any provider request', async () => {
  const p = await provider(); const s = setup(p.endpoint);
  const recipient = s.options.bindings.callee!.cheap!.recipient;
  s.options.bindings.callee!.cheap!.session = s.authority.openSession(recipient, { metadata: [], components: [], approvedAnswers: false }, true);
  const h = createHybridSession(s.options);
  try { denied(await h.tools[0]!.execute({ request: 'x' })); assert.equal(p.requests.length, 0); }
  finally { h.close(); await p.close(); }
});

test('broker rejects invalid tool arguments and limits calls; late tool results stay private', async () => {
  for (const mode of ['invalid', 'budget', 'late'] as const) {
    const p = await provider('loop'); const s = setup(p.endpoint); withTool(s.options);
    let called = 0, released = false, aborted = false;
    const abort = new AbortController();
    s.options.bindings.callee!.cheap!.tools = [{ ...tool,
      validate: () => mode !== 'invalid',
      execute: async (_args, signal) => {
        called++; signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        if (mode === 'late') await new Promise(resolve => setTimeout(resolve, 100));
        released = true; return { secret: 'PRIVATE_LATE_RESULT' };
      },
    }];
    s.options.limits = { maxToolCalls: 1 };
    const h = createHybridSession(s.options);
    try {
      const result = h.tools[0]!.execute({ request: 'x' }, abort.signal);
      if (mode === 'late') { await until(() => called > 0); abort.abort(); }
      denied(await result);
      if (mode === 'late') { await until(() => released); assert.ok(aborted); assert.equal(p.requests.length, 1); }
      if (mode === 'invalid') assert.equal(called, 0);
      if (mode === 'budget') assert.equal(called, 1);
    } finally { h.close(); await p.close(); }
  }
});

test('descendants are terminated on successful protocol completion too', async () => {
  const code = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});c.unref();console.log(JSON.stringify({type:'result',value:{pid:c.pid}}));`;
  const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: {} });
  const result = await supervisePrivate(child, '{}', [], DEFAULT_LIMITS, new AbortController().signal) as { pid: number };
  await until(() => { try { process.kill(result.pid, 0); return false; } catch { return true; } });
});

test('public transport rejects duplicate-key wire bodies and unadmitted retry/compaction/resume', async () => {
  const p = await provider(); const s = setup(p.endpoint);
  const t = createEgressTransport({ boundary: s.boundary, session: s.publicSession, recipient: s.publicRecipient,
    endpoint: p.endpoint + '/chat/completions', apiKey: 'public-key' });
  try {
    t.permit({ messages: [] }, []);
    for (const bytes of ['{"messages":"PRIVATE_SQL","messages":[]}', '{"system":"PRIVATE_COMPACT"}', '{"messages":["PRIVATE_RESUME"]}']) {
      await assert.rejects(t.fetch(p.endpoint + '/chat/completions', { method: 'POST', body: bytes }), /egress_denied/);
    }
    assert.equal(p.requests.length, 0);
  } finally { t.close(); await p.close(); }
});

test('two compiled aliases receive only their component-owned prepared context', async () => {
  const p = await provider(); const s = setup(p.endpoint); const compiled = s.options.ir as any;
  const second = structuredClone(compiled.components[1]); second.id = 'second'; compiled.components.push(second);
  compiled.components[0].llm_calls[0].component_calls.push({ alias: 'other', component: 'second' });
  const publicSession = s.authority.openSession(s.publicRecipient, { metadata: [], components: ['callee', 'second'], approvedAnswers: true }, true);
  const secondContext = s.boundary.metadata('p', 'data.raw', 'private-data', { secret: 'SECOND_CONTEXT' });
  const h = createHybridSession({ ...s.options, publicSession,
    bindings: { ...s.options.bindings, second: { cheap: { ...s.options.bindings.callee!.cheap!, context: [secondContext] } } } });
  try {
    assert.deepEqual((await h.tools[0]!.execute({ request: 'first' })).structuredContent, { count: 7 });
    assert.deepEqual((await h.tools[1]!.execute({ request: 'second' })).structuredContent, { count: 7 });
    assert.ok(!JSON.stringify(p.requests[0]).includes('SECOND_CONTEXT'));
    assert.ok(!JSON.stringify(p.requests[1]).includes('PRIVATE_CONTEXT'));
  } finally { h.close(); await p.close(); }
});

test('actual pi provider serialization cannot bypass fetch with a mutated hook or hookless request', async () => {
  const { streamSimple } = await import('@earendil-works/pi-ai/api/openai-completions');
  const { normalizeContext } = await import('@earendil-works/pi-ai/utils/transcript');
  const p = await provider(); const s = setup(p.endpoint);
  const t = createEgressTransport({ boundary: s.boundary, session: s.publicSession, recipient: s.publicRecipient,
    endpoint: p.endpoint + '/chat/completions', apiKey: 'public-key' });
  const model = { id: 'public-fixture', name: 'public', provider: 'fixture', api: 'openai-completions' as const,
    baseUrl: p.endpoint, reasoning: false, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 };
  const context = normalizeContext({ messages: [{ role: 'user' as const, content: 'public request', timestamp: 1 }] });
  try {
    const mutated = await streamSimple(model, context, { apiKey: 'ignored', fetch: t.fetch,
      onPayload: payload => { t.permit(JSON.parse(JSON.stringify(payload)), []); return { ...payload as object, privateDetails: 'PRIVATE_SQL' }; } }).result();
    assert.equal(mutated.stopReason, 'error'); assert.equal(p.requests.length, 0);
    const hookless = await streamSimple(model, normalizeContext({ messages: [{ role: 'user', content: 'different compaction request', timestamp: 2 }] }), { apiKey: 'ignored', fetch: t.fetch }).result();
    assert.equal(hookless.stopReason, 'error'); assert.equal(p.requests.length, 0);
    const ok = await streamSimple(model, context, { apiKey: 'ignored', fetch: t.fetch,
      onPayload: payload => { t.permit(JSON.parse(JSON.stringify(payload)), []); } }).result();
    assert.equal(ok.stopReason, 'stop'); assert.equal(p.requests.length, 1);
    assert.equal(p.headers[0].authorization, 'Bearer public-key');
  } finally { t.close(); await p.close(); }
});

test('authority change aborts an in-flight public provider request', async () => {
  const p = await provider('hold'); const s = setup(p.endpoint);
  const t = createEgressTransport({ boundary: s.boundary, session: s.publicSession, recipient: s.publicRecipient,
    endpoint: p.endpoint + '/chat/completions', apiKey: 'public-key' });
  try {
    const body = { messages: [] }; t.permit(body, []);
    const result = t.fetch(p.endpoint + '/chat/completions', { method: 'POST', body: JSON.stringify(body) });
    const rejected = assert.rejects(result, /egress_denied/);
    await until(() => p.requests.length === 1); s.authority.replaceDeployment(permit);
    await rejected;
  } finally { t.close(); await p.close(); }
});

test('running child environment excludes ambient credentials and cleans its isolated home after abort', async () => {
  const previous = process.env.P2_AMBIENT_CREDENTIAL;
  process.env.P2_AMBIENT_CREDENTIAL = 'DO_NOT_INHERIT_P2';
  const p = await provider('hold'); const s = setup(p.endpoint); const h = createHybridSession(s.options);
  const before = readdirSync(tmpdir()).filter(n => n.startsWith('warble-private-')).sort();
  const abort = new AbortController();
  try {
    const result = h.tools[0]!.execute({ request: 'x' }, abort.signal);
    await until(() => p.requests.length === 1);
    const processes = execFileSync('/bin/ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' }).split('\n');
    const line = processes.find(line => {
      const parts = line.trim().split(/\s+/); return parts[1] === String(process.pid) && line.includes('/dist/child.js');
    });
    assert.ok(line, 'private child exists');
    const pid = Number(line.trim().split(/\s+/)[0]);
    const environment = execFileSync('/bin/ps', ['eww', '-p', String(pid)], { encoding: 'utf8' });
    assert.ok(!environment.includes('DO_NOT_INHERIT_P2'), 'ambient credential excluded');
    assert.ok(environment.includes('PI_OFFLINE=1') && environment.includes('PI_TELEMETRY=0'));
    assert.ok(!environment.includes('private-stub-key'), 'explicit credential is not in argv/environment');
    abort.abort(); denied(await result);
    assert.throws(() => process.kill(pid, 0));
    assert.deepEqual(readdirSync(tmpdir()).filter(n => n.startsWith('warble-private-')).sort(), before);
  } finally {
    abort.abort(); h.close(); await p.close();
    if (previous === undefined) delete process.env.P2_AMBIENT_CREDENTIAL; else process.env.P2_AMBIENT_CREDENTIAL = previous;
  }
});

test('host tool evidence survives normal child exit through projection and expires at invocation completion', async () => {
  const p = await provider('tool'); const s = setup(p.endpoint); withTool(s.options);
  const signals: AbortSignal[] = [];
  s.options.bindings.callee!.cheap!.tools = [{ ...tool, execute: async (_args, signal) => {
    signals.push(signal); return { count: 7 };
  } }];
  s.options.bindings.callee!.cheap!.projection = { project: raw => {
    assert.equal(signals.at(-1)!.aborted, false, 'query evidence must remain valid during projection');
    return projection.project(raw);
  }, validate: projection.validate };
  const h = createHybridSession(s.options);
  try {
    assert.deepEqual((await h.tools[0]!.execute({ request: 'one' })).structuredContent, { count: 7 });
    assert.equal(signals[0]!.aborted, true);
    assert.deepEqual((await h.tools[0]!.execute({ request: 'two' })).structuredContent, { count: 7 });
    assert.equal(signals[1]!.aborted, true); assert.notEqual(signals[0], signals[1]);
  } finally { h.close(); await p.close(); }
});

test('operator diagnostics distinguish deadline, model output failure and tool denial without private text', async () => {
  for (const [code, script] of [
    ['deadline', 'setInterval(()=>{},1000)'],
    ['invalid_json', 'console.log(JSON.stringify({type:"failure",code:"invalid_json"}))'],
    ['child_exit', 'console.log(JSON.stringify({type:"failure",code:"SECRET_PROVIDER_BODY"}))'],
    ['protocol', 'console.log(JSON.stringify({type:"failure",code:"invalid_json",body:"SECRET"}))'],
  ]) {
    const child = spawn(process.execPath, ['-e', script!], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: {} });
    await assert.rejects(supervisePrivate(child, '{}', [], { ...DEFAULT_LIMITS, timeoutMs: 200 }, new AbortController().signal),
      (error: any) => error.message === 'private_unavailable' && error.code === code && !JSON.stringify(error).includes('SECRET'));
  }
});

test('runner accepts a well-formed calls report and rejects any malformed or oversized one as protocol', async () => {
  const call = { turn: 1, elapsedMs: 5, input: 1, output: 2, reasoning: 0, cacheRead: 0, stopReason: 'stop', rawStopReason: 'stop', toolCalls: 0, status: 'ok' };
  const run = async (event: unknown, limits = DEFAULT_LIMITS) => {
    const child = spawn(process.execPath, ['-e', `console.log(JSON.stringify(${JSON.stringify(event)}))`], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: {} });
    const report = { calls: [] as any[], turns: 0, toolCalls: 0 };
    try { return { value: await supervisePrivate(child, '{}', [], limits, new AbortController().signal, report), report }; }
    catch (error: any) { return { code: error.code, report }; }
  };
  const ok = await run({ type: 'result', value: { evidence: 'x' }, calls: [call, { ...call, turn: 1 }, { ...call, turn: 2 }] });
  assert.deepEqual(ok.value, { evidence: 'x' }); assert.equal(ok.report.calls.length, 3); assert.equal(ok.report.turns, 2);
  const failed = await run({ type: 'failure', code: 'invalid_json', calls: [call] });
  assert.equal(failed.code, 'invalid_json'); assert.equal(failed.report.calls.length, 1);
  assert.deepEqual((await run({ type: 'result', value: 1 })).value, 1);
  for (const bad of [
    'nope', [{ ...call, body: 'SECRET' }], [{ ...call, turn: -1 }], [{ ...call, input: 1.5 }], [{ ...call, status: 'OK' }],
    [{ ...call, status: 'x'.repeat(33) }], [{ ...call, stopReason: 7 }], [{ turn: 1 }], [{ ...call, __proto__: { x: 1 } }, 5],
    Array.from({ length: DEFAULT_LIMITS.maxTurns + 1 }, () => call),
  ]) assert.equal((await run({ type: 'result', value: 1, calls: bad })).code, 'protocol', JSON.stringify(bad)?.slice(0, 60));
  assert.equal((await run({ type: 'result', value: 1, calls: [call], body: 'SECRET' })).code, 'protocol');
  assert.equal((await run({ type: 'result', value: 1, calls: Array.from({ length: 3 }, () => call) }, { ...DEFAULT_LIMITS, maxTurns: 1, providerMaxRetries: 2 } as any)).value, 1);
  assert.equal((await run({ type: 'result', value: 1, calls: Array.from({ length: 4 }, () => call) }, { ...DEFAULT_LIMITS, maxTurns: 1, providerMaxRetries: 2 } as any)).code, 'protocol');
});

test('a child failure reported while a host tool call is pending keeps its own code', async () => {
  const code = `console.log(JSON.stringify({type:'tool_call',id:1,name:'t',args:{}}));console.log(JSON.stringify({type:'failure',code:'deadline',calls:[]}));setInterval(()=>{},1000)`;
  const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: {} });
  const pendingTool: PrivateTool = { name: 't', capability: 'c', action: 'a', zone: 'private', readOnly: true, description: 'd',
    parameters: {}, validate: () => true, execute: (_args, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) };
  await assert.rejects(supervisePrivate(child, '{}', [pendingTool], DEFAULT_LIMITS, new AbortController().signal), (error: any) => error.code === 'deadline');
});
