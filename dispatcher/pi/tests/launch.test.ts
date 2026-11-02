import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { HybridPlanner, loadLaunch, validateBundle } from '../dist/index.js';
import type { LaunchBundle, ProjectAdapter } from '../dist/index.js';
import { sha256, RUNTIME_VERSION } from '../dist/launch-config.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const adapterPath = join(repo, 'examples/hybrid-chat/adapter.mjs');
const ir = JSON.parse(readFileSync(join(repo, 'examples/hybrid-chat/ir.golden.json'), 'utf8'));
const binary = process.env.WARBLE_BIN ?? [join(repo,'target/release/warble'),join(repo,'target/debug/warble')].find(existsSync)!;
async function fixture(options: { privateError?: boolean; publicErrorAt?: number; toolName?: string; privateThinking?: boolean; privateText?: string; privateFinish?: string } = {}) {
  const requests: { path: string; body: any; headers: any }[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body); const path = req.url!;
    requests.push({ path, body: data, headers: req.headers });
    if (JSON.stringify(data).includes('HOLD_REQUEST')) return;
    const privateRequest = path.startsWith('/private');
    if (!privateRequest && requests.filter(r => !r.path.startsWith('/private')).length === options.publicErrorAt) { res.writeHead(500); res.end('unavailable'); return; }
    if (privateRequest && options.privateError) { res.writeHead(500); res.end('PRIVATE_ERROR_CANARY /private/path-canary'); return; }
    const ant = path.startsWith('/anthropic');
    const userTurns = data.messages.filter((m: any) => m.role === 'user' && (typeof m.content === 'string' || m.content.some((p: any) => p.type === 'text'))).length;
    const hasTool = data.messages.some((m: any) => m.role === 'tool' || Array.isArray(m.content) && m.content.some((p: any) => p.type === 'tool_result'));
    const tool = !privateRequest && !hasTool && data.tools?.length > 0;
    const answer = privateRequest ? options.privateText ?? JSON.stringify({ count: 7, sql: 'PRIVATE_SQL_CANARY', details: 'PRIVATE_DETAILS_CANARY' }) : userTurns > 1 ? 'FOLLOWUP_OK' : 'ANSWER_OK count=7';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (v: unknown, name?: string) => res.write((name ? `event: ${name}\n` : '') + `data: ${JSON.stringify(v)}\n\n`);
    if (ant) {
      send({ type: 'message_start', message: { id: 'msg-stub', type: 'message', role: 'assistant', model: data.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }, 'message_start');
      send({ type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'tool-stub', name: options.toolName ?? 'answer', input: {} } : { type: 'text', text: '' } }, 'content_block_start');
      send({ type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: '{"request":"private count"}' } : { type: 'text_delta', text: answer } }, 'content_block_delta');
      send({ type: 'content_block_stop', index: 0 }, 'content_block_stop');
      send({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }, 'message_delta');
      send({ type: 'message_stop' }, 'message_stop');
    } else {
      const chunk = (delta: unknown, finish_reason: string | null = null) => send({ id: 'stub', object: 'chat.completion.chunk', created: 1, model: data.model, choices: [{ index: 0, delta, finish_reason }] });
      chunk({ role: 'assistant' });
      if (privateRequest && options.privateThinking) chunk({ reasoning_content: 'PRIVATE_THINKING_CANARY /private/reasoning-path' });
      chunk(tool ? { tool_calls: [{ index: 0, id: 'tool-stub', type: 'function', function: { name: options.toolName ?? 'answer', arguments: '{"request":"private count"}' } }] } : { content: answer });
      chunk({}, tool ? 'tool_calls' : privateRequest ? options.privateFinish ?? 'stop' : 'stop'); res.write('data: [DONE]\n\n');
    }
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const publicModel = { zone: 'public' as const, deployment: 'cloud', api: 'openai-completions' as const, model: 'public-stub', baseUrl: base+'/public', credentialEnv: 'PUBLIC_FIXTURE_KEY' };
  const privateModel = { ...publicModel, zone: 'private' as const, deployment: 'local', model: 'private-stub', baseUrl: base+'/private', credentialEnv: 'PRIVATE_FIXTURE_KEY' };
  const bundle: LaunchBundle = { format: 'warble-pi-hybrid/1', runtimeVersion: RUNTIME_VERSION, piVersion: '1.0.4', ir: structuredClone(ir), config: {
    format: 'warble-pi-hybrid-config/1', entry: 'caller', policy: 'permit(principal, action, resource);',
    adapter: { path: adapterPath, sha256: sha256(readFileSync(adapterPath)) },
    selections: {
      blind: { metadata: [], components: ['callee'], approvedAnswers: true },
      schema: { metadata: [{ kind: 'schema.structure', documents: ['catalog'] }], components: ['callee'], approvedAnswers: true },
      business: { metadata: [{ kind: 'schema.structure', documents: ['catalog'] }, { kind: 'knowledge.rules', documents: ['rules'] }], components: ['callee'], approvedAnswers: true },
      none: { metadata: [], components: [], approvedAnswers: false },
    },
    models: { openai: publicModel, claude: { ...publicModel, api: 'anthropic-messages', model: 'claude-stub', baseUrl: base+'/anthropic' } },
    projects: { demo: { privateModels: { callee: { cheap: privateModel } } }, other: { privateModels: { callee: { cheap: privateModel } } } },
    defaults: { policy: 'blind', model: 'openai', project: 'demo' },
  } };
  const adapter = await import(new URL('../../../examples/hybrid-chat/adapter.mjs', import.meta.url).href) as ProjectAdapter;
  return { bundle, adapter, requests, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
async function until(check: () => boolean) { for(let i=0;i<400&&!check();i++) await new Promise(r=>setTimeout(r,10)); assert.ok(check()); }
for (const model of ['openai', 'claude']) test(`${model}: local evidence observes only approved results and cannot affect provider history`, async () => {
  const f = await fixture(); const p = new HybridPlanner(f.bundle, f.adapter, () => 'stub');
  try {
    let previous = 0;
    for (const policy of ['blind', 'schema', 'business']) {
      await p.reset({ ...f.bundle.config.defaults, model, policy });
      assert.deepEqual(p.evidence(), []); assert.deepEqual(p.evidence(previous), []);
      const answer = await p.prompt('count');
      const before = JSON.stringify(f.requests);
      const records = p.evidence(); assert.equal(records.length, 1);
      const record = records[0]!; assert.ok(record.reference > previous); previous = record.reference;
      assert.deepEqual(record.result, { count: 7 });
      assert.deepEqual(record.metadata, p.status!.metadata);
      assert.equal(record.request, 'private count'); assert.equal(record.tool, 'answer');
      assert.match(p.formatAnswer(answer), /Tool data: \[\d+\]/);
      assert.ok(!JSON.stringify(records).includes('PRIVATE_'));
      assert.equal(JSON.stringify(f.requests), before);
      await assert.rejects(p.reset({ ...f.bundle.config.defaults, disclosure: [{ kind: 'invalid' as any, documents: '*' }] }));
      assert.equal(p.evidence().length, 1);
      await p.prompt('follow up after local inspection');
      const pub = JSON.stringify(f.requests.filter(r => !r.path.startsWith('/private')));
      assert.ok(!pub.includes('completedAt')); assert.ok(!pub.includes('policyDigest'));
      assert.ok(!pub.includes('Tool data:')); assert.ok(!pub.includes('PRIVATE_'));
    }
    for (const choice of [
      { ...f.bundle.config.defaults, disclosure: [] },
      { ...f.bundle.config.defaults, model: 'claude' },
      { ...f.bundle.config.defaults, project: 'other' }, f.bundle.config.defaults,
    ]) {
      await p.reset(choice); assert.deepEqual(p.evidence(), []); assert.deepEqual(p.evidence(previous), []);
      await p.prompt('count'); assert.ok(p.evidence()[0]!.reference > previous); previous = p.evidence()[0]!.reference;
    }
    const pending = p.prompt('HOLD_REQUEST'); await until(() => JSON.stringify(f.requests).includes('HOLD_REQUEST'));
    await p.reset(); await pending; assert.deepEqual(p.evidence(), []);
    p.close(); assert.deepEqual(p.evidence(), []);
  } finally { p.close(); await f.close(); }
});
test('failed and policy-denied answers create no evidence', async () => {
  for (const failure of ['private', 'policy']) {
    const f = await fixture({ privateError: failure === 'private' });
    if (failure === 'policy') f.bundle.config.selections.blind = { ...f.bundle.config.selections.blind!, approvedAnswers: false };
    const p = new HybridPlanner(f.bundle, f.adapter, () => 'stub');
    try { await p.reset(); await p.prompt('count'); assert.deepEqual(p.evidence(), []); }
    finally { p.close(); await f.close(); }
  }
});
test('fatal public failure discards previously retained evidence', async () => {
  const f = await fixture({ publicErrorAt: 3 }); const p = new HybridPlanner(f.bundle, f.adapter, () => 'stub');
  try {
    await p.reset(); await p.prompt('count'); assert.equal(p.evidence().length, 1);
    assert.match(await p.prompt('follow up'), /Request unavailable/);
    assert.deepEqual(p.evidence(), []); assert.equal(p.status, undefined);
    await p.reset(); await p.prompt('new count'); assert.ok(p.evidence()[0]!.reference > 1);
  } finally { p.close(); await f.close(); }
});
for (const model of ['openai','claude']) test(`${model}: real pi public/private loop, follow-up, exact tool surface, blind context`, async () => {
  const f=await fixture(); const p=new HybridPlanner(f.bundle,f.adapter,ref=>ref === 'PRIVATE_FIXTURE_KEY' ? 'private-key':'public-key');
  try {
    await p.reset({ ...f.bundle.config.defaults, model });
    assert.match(await p.prompt('first question'), /ANSWER_OK/);
    assert.match(await p.prompt('follow up'), /FOLLOWUP_OK/);
    assert.deepEqual(p.status!.tools,['answer']); assert.deepEqual(p.status!.metadata,[]);
    const pub=f.requests.filter(r=>!r.path.startsWith('/private'));
    assert.equal(pub.length,3); assert.ok(!JSON.stringify(pub).includes('PRIVATE_'));
    assert.ok(!JSON.stringify(pub).includes('orders')); assert.ok(!JSON.stringify(pub).includes('Revenue excludes'));
    assert.ok(JSON.stringify(f.requests.find(r=>r.path.startsWith('/private'))).includes('PRIVATE_CONTEXT_CANARY'));
    assert.equal(pub[0]!.headers[model==='claude'?'x-api-key':'authorization'],model==='claude'?'public-key':'Bearer public-key');
  } finally {p.close();await f.close();}
});

for (const model of ['openai', 'claude']) test(`private thinking stays private while approved JSON survives: ${model}`, async () => {
  const f = await fixture({ privateThinking: true });
  const p = new HybridPlanner(f.bundle, f.adapter, () => 'stub');
  try {
    await p.reset({ ...f.bundle.config.defaults, model });
    await p.prompt('first question'); await p.prompt('follow up');
    const pub = f.requests.filter(r => !r.path.startsWith('/private'));
    assert.equal(pub.length, 3);
    assert.ok(!JSON.stringify(pub).includes('PRIVATE_'));
    const results = pub.flatMap(r => r.body.messages).flatMap((m: any) => m.role === 'tool' ? [m.content]
      : Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'tool_result').flatMap((b: any) => typeof b.content === 'string' ? [b.content] : b.content.filter((x: any) => x.type === 'text').map((x: any) => x.text)) : []);
    assert.ok(results.length > 0);
    for (const value of results) assert.deepEqual(JSON.parse(value), { count: 7 });
  } finally { p.close(); await f.close(); }
});

for (const failure of ['thinking-only', 'invalid-json', 'truncated']) test(`private thinking cannot rescue invalid final output: ${failure}`, async () => {
  const f = await fixture({ privateThinking: true,
    ...(failure === 'thinking-only' ? { privateText: '' } : failure === 'invalid-json'
      ? { privateText: 'PRIVATE_INVALID_JSON_CANARY' } : { privateFinish: 'length' }) });
  const p = new HybridPlanner(f.bundle, f.adapter, () => 'stub');
  try {
    await p.reset(); await p.prompt('first question');
    const pub = f.requests.filter(r => !r.path.startsWith('/private'));
    const results = pub.flatMap(r => r.body.messages).filter((m: any) => m.role === 'tool');
    assert.equal(results.length, 1);
    assert.deepEqual(JSON.parse(results[0].content), { status: 'unavailable' });
    assert.ok(!JSON.stringify(pub).includes('PRIVATE_'));
  } finally { p.close(); await f.close(); }
});

test('Luna serializes explicit non-reasoning tool calls without changing other provider requests', async () => {
  const f = await fixture();
  f.bundle.config.models.luna = { ...f.bundle.config.models.openai!, model: 'gpt-6-luna' };
  const p = new HybridPlanner(f.bundle, f.adapter, () => 'stub');
  try {
    await p.reset({ ...f.bundle.config.defaults, model: 'luna' });
    assert.match(await p.prompt('first question'), /ANSWER_OK/);
    assert.match(await p.prompt('follow up'), /FOLLOWUP_OK/);
    const luna = f.requests.filter(r => r.body.model === 'gpt-6-luna');
    assert.equal(luna.length, 3);
    for (const r of luna) assert.equal(r.body.reasoning_effort, 'none');
    assert.ok(!JSON.stringify(luna).includes('PRIVATE_'));
    assert.equal(luna[0]!.body.tools[0].function.name, 'answer');
    await p.reset({ ...f.bundle.config.defaults, model: 'openai' });
    assert.match(await p.prompt('first question'), /ANSWER_OK/);
    for (const r of f.requests.filter(r => r.body.model !== 'gpt-6-luna')) {
      assert.ok(!Object.hasOwn(r.body, 'reasoning_effort'));
    }
  } finally { p.close(); await f.close(); }
});

test('policy/model/project changes cancel active request and create an empty epoch; forbidden histories cannot resume',async()=>{
  const f=await fixture();const p=new HybridPlanner(f.bundle,f.adapter,()=> 'stub');
  try {
    await p.reset(); const first=p.prompt('HOLD_REQUEST old data'); await until(()=>f.requests.length===1);
    await p.reset({policy:'schema',model:'claude',project:'other'}); await first;
    assert.equal(p.status!.epoch,2); assert.deepEqual(p.status!.metadata,['schema.structure/catalog']);
    assert.match(await p.prompt('new question'),/ANSWER_OK/);
    const next=f.requests.filter(r=>r.path.startsWith('/anthropic'));
    assert.ok(!JSON.stringify(next).includes('HOLD_REQUEST')); assert.ok(JSON.stringify(next).includes('orders'));
    assert.ok(!JSON.stringify(next).includes('PRIVATE_RAW_CANARY'));
    for(const input of ['/resume','/compact','/import x','/share','/export','!cat secret']) await assert.rejects(p.prompt(input),/input_denied/);
    await p.reset({policy:'none',model:'openai',project:'demo'});assert.deepEqual(p.status!.tools,[]);
    assert.match(await p.prompt('no tools question'),/ANSWER_OK/);
    assert.equal(f.requests.filter(r=>r.path.startsWith('/private')).length,1);
  }finally{p.close();await f.close();}
});

test('bundle validation refuses unsupported IR, missing bindings, secrets-as-config and wrong versions',async()=>{
  const f=await fixture();try{
    for(const mutate of [(b:any)=>b.piVersion='latest',(b:any)=>b.config.models.openai.zone='private',
      (b:any)=>b.config.models.openai.apiKey='secret',(b:any)=>delete b.config.projects.demo.privateModels.callee,
      (b:any)=>b.ir.components[1].llm_calls[0].produces='result']) {
      const b=structuredClone(f.bundle);mutate(b);assert.throws(()=>validateBundle(b));
    }
  }finally{await f.close();}
});

test('actual dispatch CLI emits launch artifacts; loader catches corruption and adapter mismatch',async()=>{
  assert.ok(binary,'build the warble binary before launch tests');const f=await fixture();const dir=await mkdtemp(join(tmpdir(),'pi-launch-'));
  try {
    const input=join(dir,'ir.json'),config=join(dir,'config.json'),out=join(dir,'session');
    writeFileSync(input,JSON.stringify(f.bundle.ir));writeFileSync(config,JSON.stringify(f.bundle.config));
    execFileSync(binary,['dispatch',input,'--target','pi:hybrid','--hybrid-config',config,'--out',out]);
    const loaded=await loadLaunch(out);assert.equal(loaded.bundle.format,'warble-pi-hybrid/1');
    writeFileSync(join(out,'launch.json'),'{}');await assert.rejects(loadLaunch(out),/launch_integrity/);
    const bytes=JSON.stringify({...f.bundle,config:{...f.bundle.config,adapter:{...f.bundle.config.adapter,sha256:'0'.repeat(64)}}});
    writeFileSync(join(out,'launch.json'),bytes);writeFileSync(join(out,'launch.sha256'),sha256(bytes));
    await assert.rejects(loadLaunch(out),/adapter_integrity/);
  }finally{await f.close();await rm(dir,{recursive:true,force:true});}
});

// PTY driver exercises the shipped launcher and actual pi-tui rendering/input, not a readline substitute.
test('generated artifacts launch limited pi TUI in a PTY with no ambient discovery',async()=>{
  assert.ok(binary);const f=await fixture();const dir=await mkdtemp(join(tmpdir(),'pi-tui-'));
  try {
    const input=join(dir,'ir.json'),config=join(dir,'config.json'),out=join(dir,'session');
    writeFileSync(input,JSON.stringify(f.bundle.ir));writeFileSync(config,JSON.stringify(f.bundle.config));
    execFileSync(binary,['dispatch',input,'--target','pi:hybrid','--hybrid-config',config,'--out',out]);
    writeFileSync(join(dir,'AGENTS.md'),'AMBIENT_INSTRUCTION_CANARY');
    await mkdir(join(dir,'.pi','agent','extensions'),{recursive:true});
    writeFileSync(join(dir,'.pi','agent','extensions','ambient.mjs'), 'throw new Error("AMBIENT_EXTENSION_CANARY")');
    writeFileSync(join(dir,'.pi','agent','mcp.json'), JSON.stringify({mcpServers:{ambient:{command:'does-not-exist'}}}));
    await mkdir(join(dir,'.pi','agent','sessions'),{recursive:true});
    writeFileSync(join(dir,'.pi','agent','sessions','stale.jsonl'),'STALE_PRIVATE_HISTORY_CANARY');
    const files = (root: string, prefix = ''): Record<string,string> => Object.fromEntries(readdirSync(root,{withFileTypes:true}).flatMap(d => d.isDirectory() ? Object.entries(files(join(root,d.name),prefix+d.name+'/')) : [[prefix+d.name,sha256(readFileSync(join(root,d.name)))]]));
    const beforeFiles=files(dir);
    const ambientLog=join(dir,'ambient-tui.log');
    const script=fileURLToPath(new URL('./pty-smoke.py',import.meta.url));
    const output=await new Promise<string>((resolve,reject)=>{
      const child=spawn('python3',[script,process.execPath,fileURLToPath(new URL('../dist/cli.js',import.meta.url)),out],
        {cwd:dir,env:{...process.env,HOME:dir,PI_TUI_WRITE_LOG:ambientLog,PUBLIC_FIXTURE_KEY:'public-key',PRIVATE_FIXTURE_KEY:'private-key'}});
      let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
      child.on('error',reject);child.on('close',code=>code===0?resolve(stdout):reject(new Error(stderr)));
    });
    const screen = Buffer.from(output.split('SCREEN_BASE64:')[1]!.trim(),'base64').toString('utf8');
    for(const canary of ['PRIVATE_', 'AMBIENT_', 'STALE_']) assert.ok(!screen.includes(canary), 'terminal '+canary);
    assert.deepEqual(files(dir),beforeFiles,'no session/export/debug persistence or modified ambient files');
    assert.match(output,/PTY_OK/);assert.ok(!existsSync(ambientLog),'ambient terminal logging disabled');assert.ok(!JSON.stringify(f.requests).includes('AMBIENT_INSTRUCTION_CANARY'));
    assert.ok(!JSON.stringify(f.requests.filter(r=>!r.path.startsWith('/private'))).includes('PRIVATE_'));
    assert.ok(f.requests.some(r=>r.path.startsWith('/anthropic')),'TUI switched to Anthropic');
    assert.ok(JSON.stringify(f.requests).includes('Revenue excludes refunds.'),'business policy publishes selected rule');
  }finally{await f.close();await rm(dir,{recursive:true,force:true});}
});

for (const model of ['openai', 'claude']) for (const policy of ['blind', 'schema', 'business']) {
  test(`boundary wire matrix: ${model}/${policy} exact resources, approved values and history`, async () => {
    const f = await fixture();
    const docs = [
      { kind: 'schema.structure', document: 'catalog', value: { name: 'SCHEMA_STRUCTURE_CANARY' } },
      { kind: 'schema.descriptions', document: 'descriptions', value: 'SCHEMA_DESCRIPTION_CANARY' },
      { kind: 'knowledge.rules', document: 'rules', value: 'BUSINESS_RULE_CANARY' },
      { kind: 'mdl.expressions', document: 'expressions', value: 'MDL_EXPRESSION_CANARY /private/path-canary' },
      { kind: 'knowledge.sql', document: 'sql', value: 'KNOWLEDGE_SQL_CANARY' },
      { kind: 'data.samples', document: 'samples', value: 'SAMPLE_CANARY' },
      { kind: 'data.raw', document: 'rows', value: 'RAW_ROWS_CANARY' },
    ];
    for (const key of ['schema', 'business']) f.bundle.config.selections[key] = { ...f.bundle.config.selections[key]!,
      metadata: [...f.bundle.config.selections[key]!.metadata, { kind: 'schema.descriptions', documents: ['descriptions'] }] };
    const adapter: ProjectAdapter = { async loadProject(project) {
      const loaded = await f.adapter.loadProject(project);
      return { ...loaded, metadata: docs as any };
    } };
    const p = new HybridPlanner(f.bundle, adapter, () => 'fixture-only');
    try {
      await p.reset({ model, policy, project: 'demo' });
      await p.prompt('question'); await p.prompt('follow-up');
      const pub = f.requests.filter(r => !r.path.startsWith('/private'));
      const bytes = JSON.stringify(pub);
      assert.equal(bytes.includes('SCHEMA_STRUCTURE_CANARY'), policy !== 'blind');
      assert.equal(bytes.includes('SCHEMA_DESCRIPTION_CANARY'), policy !== 'blind');
      assert.equal(bytes.includes('BUSINESS_RULE_CANARY'), policy === 'business');
      for (const canary of ['MDL_EXPRESSION_CANARY', 'KNOWLEDGE_SQL_CANARY', 'SAMPLE_CANARY', 'RAW_ROWS_CANARY', 'PRIVATE_', '/private/path-canary']) assert.ok(!bytes.includes(canary), canary);
      // Both provider serializers must preserve the approved scalar in tool results/history.
      const results = pub.flatMap(r => r.body.messages).flatMap((m: any) => m.role === 'tool' ? [m.content]
        : Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'tool_result').flatMap((b: any) => typeof b.content === 'string' ? [b.content] : b.content.filter((x: any) => x.type === 'text').map((x: any) => x.text)) : []);
      assert.ok(results.length > 0); for (const value of results) assert.deepEqual(JSON.parse(value), { count: 7 });
      const count = f.requests.length;
      for (const command of ['/compact', '/resume old', '/import file', '/export file', '/share', '/tree', '/reload', '!cat /private/file']) await assert.rejects(p.prompt(command), /input_denied/);
      assert.equal(f.requests.length, count, 'disabled surfaces must produce zero provider requests');
      await p.reset({ model, policy: 'blind', project: 'demo' });
      const before = f.requests.length; await p.prompt('fresh epoch');
      const fresh = JSON.stringify(f.requests.slice(before).filter(r => !r.path.startsWith('/private')));
      assert.ok(!fresh.includes('CANARY')); assert.ok(!fresh.includes('follow-up'));
    } finally { p.close(); await f.close(); }
  });
}

for (const failure of ['private-http', 'judge-throw', 'judge-false', 'judge-timeout', 'unknown-alias']) {
  test(`boundary wire refusal: ${failure}`, async () => {
    const f = await fixture({ privateError: failure === 'private-http', ...(failure === 'unknown-alias' ? { toolName: 'unregistered_alias' } : {}) });
    const adapter: ProjectAdapter = { async loadProject(project) {
      const loaded = await f.adapter.loadProject(project);
      if (failure.startsWith('judge-')) loaded.children.callee!.projection.judge = async (_value, signal) => {
        if (failure === 'judge-throw') throw new Error('PRIVATE_JUDGE_CANARY');
        if (failure === 'judge-false') return false;
        return await new Promise<boolean>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('PRIVATE_TIMEOUT_CANARY')), { once: true }));
      };
      return loaded;
    } };
    const p = new HybridPlanner(f.bundle, adapter, () => 'fixture-only');
    try {
      await p.reset(); const pending = p.prompt('question');
      await pending;
      const pub = f.requests.filter(r => !r.path.startsWith('/private'));
      assert.ok(!JSON.stringify(pub).includes('PRIVATE_')); assert.ok(!JSON.stringify(pub).includes('/private/path-canary'));
      if (failure === 'unknown-alias') assert.equal(f.requests.filter(r => r.path.startsWith('/private')).length, 0);
      else assert.ok(JSON.stringify(pub).includes('unavailable'));
    } finally { p.close(); await f.close(); }
  });
}

for (const model of ['openai', 'claude']) test(`custom metadata: document selection, ceiling and tightening at actual wire: ${model}`, async () => {
  const f = await fixture();
  f.bundle.config.policy = `permit(principal, action, resource) when { principal.zone == "private" };
    permit(principal, action, resource) when { resource.kind == "component" || resource.kind == "answer.approved" };
    permit(principal, action == Warble::Action::"receive_metadata", resource)
      when { resource.kind == "schema.structure" || resource.kind == "knowledge.rules" && resource.document == "rules" };`;
  const adapter: ProjectAdapter = { async loadProject(project) {
    const loaded = await f.adapter.loadProject(project);
    loaded.metadata.push({ kind: 'knowledge.rules', document: 'denied-rule', value: 'DENIED_RULE_CANARY' });
    return loaded;
  } };
  const p = new HybridPlanner(f.bundle, adapter, () => 'fixture-only');
  try {
    await p.reset({ model, project: 'demo', policy: 'blind', disclosure: [
      { kind: 'knowledge.rules', documents: ['rules', 'denied-rule', 'missing'] },
      { kind: 'data.raw', documents: '*' },
    ] });
    assert.deepEqual(p.status!.metadata, ['knowledge.rules/rules']);
    assert.deepEqual(p.status!.availableMetadata, ['schema.structure/catalog', 'knowledge.rules/rules']);
    assert.deepEqual(p.status!.unavailableMetadata, ['knowledge.rules/denied-rule', 'knowledge.rules/missing', 'data.raw/rows']);
    await p.prompt('OLD_HISTORY_CANARY'); await p.prompt('old follow-up');
    let publicRequests = f.requests.filter(r => !r.path.startsWith('/private'));
    assert.ok(JSON.stringify(publicRequests).includes('Revenue excludes refunds.'));
    for (const forbidden of ['DENIED_RULE_CANARY', 'PRIVATE_', 'denied-rule', 'missing']) assert.ok(!JSON.stringify(publicRequests).includes(forbidden));
    const start = f.requests.length;
    await p.reset({ model, project: 'demo', policy: 'business', disclosure: [] });
    assert.deepEqual(p.status!.metadata, []);
    await p.prompt('fresh question');
    publicRequests = f.requests.slice(start).filter(r => !r.path.startsWith('/private'));
    for (const forbidden of ['OLD_HISTORY_CANARY', 'old follow-up', 'Revenue excludes', 'FOLLOWUP_OK']) assert.ok(!JSON.stringify(publicRequests).includes(forbidden));
    // The first outbound body has no assistant/tool history; any later tool result is fresh.
    assert.ok(publicRequests[0]!.body.messages.every((m: any) => ['system', 'user'].includes(m.role)));
    await p.reset({ model, project: 'demo', policy: 'blind', disclosure: [{ kind: 'knowledge.rules', documents: '*' }] });
    assert.deepEqual(p.status!.metadata, ['knowledge.rules/rules']);
    assert.deepEqual(p.status!.unavailableMetadata, ['knowledge.rules/denied-rule']);
    await p.reset({ model, project: 'demo', policy: 'schema' });
    assert.equal(p.status!.disclosure, undefined); assert.deepEqual(p.status!.metadata, ['schema.structure/catalog']);
    const epoch = p.status!.epoch;
    for (const bad of [[{ kind: 'unknown', documents: '*' }], [{ kind: 'knowledge.rules', documents: ['../../secret'] }],
      [{ kind: 'knowledge.rules', documents: ['rules'], value: 'injected' }], [{ kind: 'knowledge.rules', documents: ['rules', 'rules'] }]]) {
      await assert.rejects(p.reset({ model, project: 'demo', policy: 'blind', disclosure: bad as any }), /invalid_selection/);
      assert.equal(p.status!.epoch, epoch);
    }
  } finally { p.close(); await f.close(); }
});

test('custom tightening cancels active epoch and snapshots selection before adapter await', async () => {
  const f = await fixture(); let release: (() => void) | undefined;
  let wait = false;
  const adapter: ProjectAdapter = { async loadProject(project) {
    if (wait) await new Promise<void>(resolve => { release = resolve; });
    return f.adapter.loadProject(project);
  } };
  const p = new HybridPlanner(f.bundle, adapter, () => 'fixture-only');
  try {
    await p.reset({ ...f.bundle.config.defaults, policy: 'business' });
    const old = p.prompt('HOLD_REQUEST OLD_PRIVATE_HISTORY'); await until(() => f.requests.length === 1);
    wait = true;
    const choice = { ...f.bundle.config.defaults, disclosure: [{ kind: 'schema.structure' as const, documents: ['catalog'] }] };
    const reset = p.reset(choice); await until(() => release !== undefined);
    choice.disclosure[0]!.documents.push('injected'); release!(); await reset; await old;
    assert.deepEqual(p.status!.requestedMetadata, [{ kind: 'schema.structure', documents: ['catalog'] }]);
    assert.equal(p.status!.epoch, 2); await p.prompt('fresh question');
    const fresh = JSON.stringify(f.requests.slice(1).filter(r => !r.path.startsWith('/private')));
    assert.ok(!fresh.includes('OLD_PRIVATE_HISTORY')); assert.ok(!fresh.includes('Revenue excludes'));
  } finally { release?.(); p.close(); await f.close(); }
});

test('operator metadata command parser accepts only bounded category/document references', async () => {
  const { parseMetadataSelection } = await import('../dist/selection.js');
  assert.deepEqual(parseMetadataSelection('none'), []);
  assert.deepEqual(parseMetadataSelection('schema.structure=catalog knowledge.rules=rules,second'), [
    { kind: 'schema.structure', documents: ['catalog'] }, { kind: 'knowledge.rules', documents: ['rules', 'second'] },
  ]);
  assert.deepEqual(parseMetadataSelection('knowledge.rules=*'), [{ kind: 'knowledge.rules', documents: '*' }]);
  for (const bad of ['', 'none schema.structure=catalog', 'context=*', 'schema.structure=', 'knowledge.rules=a,,b',
    'knowledge.rules=../../private', 'knowledge.rules=a knowledge.rules=b', 'knowledge.rules=*,rules', 'x'.repeat(4097)]) {
    assert.throws(() => parseMetadataSelection(bad), /invalid_selection/);
  }
});
