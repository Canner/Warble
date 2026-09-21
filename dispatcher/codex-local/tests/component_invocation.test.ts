import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareComponentInvocation, normalizeInvocationRequest, normalizeInvocationResult, type ComponentBinding, type InvocationLimits} from '../src/component_invocation.js';
import {runComponentInvocation} from '../src/component_runtime.js';
import {prepareOrchestrate, prepareTurn, prepareExec} from '../src/index.js';
import type {WarbleIr, ComponentNode} from '../src/ir.js';

const fake=fileURLToPath(new URL('./fixtures/fake-component-app-server.mjs',import.meta.url));
function component(id:string, output:string, calls: Array<{alias:string;component:string}>=[]):ComponentNode {
 return {id,verb:id,entrypoint:id==='board',type:'analytical',realization_kind:'skill',trigger:{kind:'one_shot'},effect:{outcome:{kind:'none'},render_blocks:[]},context_binding:{binding_mode:'runtime_selected',project:'synthetic'},guardrails:[{name:'read_only_execution',locked:true}],required_capabilities:['llm:cheap',...(calls.length?['component_invocation']:[])],llm_calls:[{name:'execute',tier:'cheap',prompt:`Private behavior of ${id}.`,produces:output,consumes:[],conditional:false,when:null,component_calls:calls}]};
}
function fixture(){
 const ir:WarbleIr=JSON.parse(readFileSync(new URL('../../conformance-fixtures/component-invocation.json',import.meta.url),'utf8'));
 const binding=(context:string):ComponentBinding=>({transport:'orchestrate',context,models:{orchestrator:'driver',cheap:context,strong:context+'-strong'},mcp:{name:'data',command:process.execPath,args:[],toolsByStep:{execute:[]}}});
 const bindings:Record<string,ComponentBinding>={board:binding('parent-private-context'),probe:binding('child-private-context')};
 return {ir,bindings,component:'board'};
}
async function execute(scenario: Record<string,unknown>, customize?:(f:ReturnType<typeof fixture>)=>void, limits?:InvocationLimits, signal?:AbortSignal){
 const f=fixture();customize?.(f);const plan=prepareComponentInvocation({...f,...(limits?{limits}:{})});
 const dir=await mkdtemp(join(tmpdir(),'warble-composition-'));
 const cwd=join(dir,'project'),home=join(dir,'home'),log=join(dir,'events');
 await mkdir(cwd);await mkdir(home);const script=join(dir,'scenario.json');
 await writeFile(script,JSON.stringify({steps:scenario,log}));
 try {
  const result=await runComponentInvocation(plan,{request:'root-request',input:{root_secret:'not-inherited'}},{cwd,codexHome:home,externalAuthentication:'provisioned',codexBin:process.execPath,codexArgsPrefix:[fake,script],terminationGraceMs:30,...(signal?{signal}:{})});
  const events=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  return {result,events};
 } finally {
  const recorded=await readFile(log,'utf8').catch(()=> '');
  for(const pid of new Set(recorded.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line).pid))) {
   assert.throws(()=>process.kill(pid as number,0),/ESRCH/, 'every logged app-server process must be reaped');
  }
  await rm(dir,{recursive:true,force:true});
 }
}

test('fresh isolated child uses only its own context/model/tools and request; root owns aggregate usage',async()=>{
 const {result,events}=await execute({overview:{calls:[{alias:'inspect'}],returnCalls:true,early:true},measurement:{mcp:['lookup'],value:{reading:7,verified:true}}},f=>{f.bindings.probe!.mcp.toolsByStep.execute=['lookup'];f.bindings.probe!.mcp.requireTool=['execute'];});
 assert.equal(result.attempts,1);assert.equal(result.steps,2);assert.equal(result.usage.totalTokens,10);
 assert.deepEqual((result.value as any).results[0],{status:'ok',output:{kind:'value',value:{reading:7,verified:true}},provenance:{verified:true}});
 const threads=events.filter(e=>e.phase==='thread');assert.equal(threads.length,2);
 assert.equal(threads[0].params.ephemeral,true);assert.equal(threads[1].params.ephemeral,true);
 assert.deepEqual(threads[0].params.config['mcp_servers.data.enabled_tools'],[]);
 assert.deepEqual(threads[1].params.config['mcp_servers.data.enabled_tools'],['lookup']);
 assert.equal(threads[0].model,'parent-private-context');assert.equal(threads[1].model,'child-private-context');
 assert.notEqual(threads[0].pid,threads[1].pid);
 const child=events.find(e=>e.phase==='turn'&&e.produced==='measurement').prompt;
 assert.match(child,/child-private-context/);assert.match(child,/child-request/);assert.match(child,/explicit/);
 assert.doesNotMatch(child,/parent-private-context|root_secret|root-request|Private behavior of board/);
 assert.equal(events.filter(e=>e.phase==='closed').length,2);
 assert.doesNotMatch(JSON.stringify(result.componentCalls),/private-context|root_secret|reading|lookup|root-request/);
});

test('repeated and queued calls are serialized and consume a fresh attempt each',async()=>{
 const {result,events}=await execute({overview:{parallel:true,calls:[{alias:'inspect'},{alias:'inspect'}],returnCalls:true},measurement:{delay:10}});
 assert.equal(result.attempts,2);assert.equal(result.steps,3);
 const starts=events.filter(e=>e.phase==='thread');assert.equal(new Set(starts.map(e=>e.pid)).size,3);
 const childEvents=events.filter(e=>e.pid!==starts[0].pid);
 assert.deepEqual(childEvents.map(e=>e.phase),['thread','turn','closed','thread','turn','closed']);
});

test('transitive calls preserve ancestry and use one root ledger',async()=>{
 const {result}=await execute({overview:{calls:[{alias:'inspect'}],returnCalls:true},measurement:{calls:[{alias:'leaf'}],returnCalls:true},leafvalue:{value:{sample:3}}},f=>{
  f.ir.components[1]!.llm_calls[0]!.component_calls=[{alias:'leaf',component:'sensor'}];f.ir.components[1]!.required_capabilities.push('component_invocation');
  f.ir.components.push(component('sensor','leafvalue'));f.bindings.sensor=structuredClone(f.bindings.probe!);f.bindings.sensor.context='sensor-context';
 });
 assert.equal(result.attempts,2);assert.deepEqual(result.componentCalls.map(c=>c.depth),[1,2]);
 assert.equal(result.componentCalls[1]!.parentCallId,result.componentCalls[0]!.callId);
});

for(const field of ['forgeThread','forgeTurn','forgeId','forgeNamespace'])test(`rejects forged callback ${field}`,async()=>{
 await assert.rejects(execute({overview:{calls:[{alias:'inspect',[field]:true}]}}),/unauthorized_call/);
});
for(const native of ['commandExecution','fileChange','webSearch','collabAgentToolCall'])test(`caller cannot acquire native authority via ${native}`,async()=>{
 await assert.rejects(execute({overview:{native}}),/unauthorized_call/);
});
test('caller cannot call child-only MCP tool or an undeclared alias',async()=>{
 await assert.rejects(execute({overview:{mcp:['lookup']}},f=>{f.bindings.probe!.mcp.toolsByStep.execute=['lookup'];}),/unauthorized_call/);
 await assert.rejects(execute({overview:{calls:[{alias:'not_declared'}]}}),/unauthorized_call/);
});
test('attempt and step admission limits return budget failure without starting another child',async()=>{
 const {result}=await execute({overview:{calls:[{alias:'inspect'},{alias:'inspect'}],returnCalls:true},measurement:{}},undefined,{maxAttempts:1});
 assert.equal(result.attempts,1);assert.equal((result.value as any).results[1].code,'budget_exhausted');
 const limited=await execute({overview:{calls:[{alias:'inspect'}],returnCalls:true}},undefined,{maxSteps:1});
 assert.equal(limited.result.steps,1);assert.equal(limited.result.attempts,0);assert.equal(limited.events.filter(e=>e.phase==='thread').length,1);
});
test('deadline and root cancellation terminate parent and child',async()=>{
 await assert.rejects(execute({overview:{calls:[{alias:'inspect'}]},measurement:{delay:1000}},undefined,{timeoutMs:100}),/cancelled/);
 const abort=new AbortController();setTimeout(()=>abort.abort(),100);
 await assert.rejects(execute({overview:{calls:[{alias:'inspect'}]},measurement:{delay:1000}},undefined,undefined,abort.signal),/cancelled/);
});
test('invalid request cannot start child; refusal is sanitized',async()=>{
 const {result}=await execute({overview:{calls:[{alias:'inspect',payload:{request:'x',component:'other'}},{alias:'inspect'}],returnCalls:true},measurement:{value:{status:'refused',message:'SECRET_PROVIDER_PATH'}}});
 assert.equal(result.attempts,1);assert.equal((result.value as any).results[0].code,'invalid_request');
 assert.equal((result.value as any).results[1].status,'refused');assert.doesNotMatch(result.finalText,/SECRET_PROVIDER_PATH/);
});

test('compiled plan is immutable and object/clone forgery is rejected',async()=>{
 const f=fixture(),plan=prepareComponentInvocation(f);f.bindings.probe!.mcp.toolsByStep.execute=['evil'];
 assert.deepEqual(plan.nodes.probe!.prepared.steps[0]!.enabledTools,[]);
 assert.throws(()=>{(plan.nodes.board!.aliases.execute as any).inspect='elsewhere';},TypeError);
 await assert.rejects(runComponentInvocation(structuredClone(plan),{request:'x'},{} as any),/immutable prepared/);
});
for(const kind of ['missing','cycle','duplicate','alias','capability','internal-root','guardrail','binding','unknown-step','write','slot','asset','action','precondition','hard-turns','hard-cost'])test(`preflight refuses ${kind} before any process`,()=>{
 const f=fixture();let limits:InvocationLimits|undefined;
 switch(kind){
  case 'missing':f.ir.components.pop();break;
  case 'cycle':f.ir.components[1]!.llm_calls[0]!.component_calls=[{alias:'back',component:'board'}];f.ir.components[1]!.required_capabilities.push('component_invocation');break;
  case 'duplicate':f.ir.components.push(structuredClone(f.ir.components[1]!));break;
  case 'alias':f.ir.components[0]!.llm_calls[0]!.component_calls.push({alias:'inspect',component:'probe'});break;
  case 'capability':f.ir.components[0]!.required_capabilities=['llm:cheap'];break;
  case 'internal-root':f.ir.components[0]!.entrypoint=false;break;
  case 'guardrail':f.ir.components[1]!.guardrails=[];break;
  case 'binding':delete f.bindings.probe;break;
  case 'unknown-step':f.bindings.probe!.mcp.toolsByStep.other=['read'];break;
  case 'write':f.ir.components[1]!.guardrails.push({name:'artifact_write',locked:true,scope:'.'});break;
  case 'slot':f.ir.components[1]!.slots=[{}];break;
  case 'asset':(f.ir.components[1] as any).assets=[{}];break;
  case 'action':(f.ir.components[1] as any).borrowed_actions=['notify'];break;
  case 'precondition':(f.ir.components[1] as any).context_precondition=[{predicate:'bound'}];break;
  case 'hard-turns':limits={maxModelTurns:12};break;
  case 'hard-cost':limits={maxCostUsd:1};break;
 }
 assert.throws(()=>prepareComponentInvocation({...f,...(limits?{limits}:{})}), kind==='cycle' ? /cyclic component-call graph/ : /unsupported_callee|unknown step|wall-hit/);
});
test('unreachable unsupported sibling does not block scoped executable closure',()=>{
 const f=fixture();const sibling=component('unreachable','bad',[{alias:'missing',component:'absent'}]);sibling.realization_kind='tool';f.ir.components.push(sibling);
 assert.deepEqual(Object.keys(prepareComponentInvocation(f).nodes).sort(),['board','probe']);
});
test('legacy transport preparation remains fail closed for composed roots',()=>{
 const f=fixture();const b=f.bindings.board!;
 assert.throws(()=>prepareOrchestrate({ir:f.ir,component:'board',models:b.models,mcp:b.mcp}),/wall-hit/);
 assert.throws(()=>prepareTurn({ir:f.ir,component:'board',model:'cheap',mcp:b.mcp}),/wall-hit/);
 assert.throws(()=>prepareExec({ir:f.ir,component:'board',model:'cheap',mcp:b.mcp}),/wall-hit/);
});
test('bounded request/result bytes and generic positional render contract',()=>{
 const f=fixture(),plan=prepareComponentInvocation(f);
 assert.equal(normalizeInvocationRequest({request:'😀'.repeat(10)},10),null);
 assert.equal((normalizeInvocationResult({x:'x'.repeat(100)},plan.nodes.probe!,30) as any).code,'invalid_result');
 f.ir.components[1]!.effect.render_blocks=[{type:'table',fields:{columns:'string[]',rows:'row[]'}}];f.ir.components[1]!.required_capabilities.push('render_contract');
 const node=prepareComponentInvocation(f).nodes.probe!;
 assert.equal(normalizeInvocationResult({blocks:[{type:'table',columns:['x'],rows:[[1]]}],verified:true},node,1000).status,'ok');
 assert.equal(normalizeInvocationResult({blocks:[{type:'table',columns:['x'],rows:[{x:1}]}],verified:true},node,1000).status,'error');
 assert.equal(normalizeInvocationResult({blocks:[{type:'unknown'}],verified:true},node,1000).status,'error');
});


test('host sequences multi-tier steps and marshals only declared artifacts',async()=>{
 const {result,events}=await execute({plan_value:{value:{plan:'declared'}},overview:{calls:[{alias:'inspect'}],returnCalls:true},measurement:{}},f=>{
  const node=f.ir.components[0]!;const final=structuredClone(node.llm_calls[0]!);
  node.llm_calls=[{...structuredClone(final),name:'plan',tier:'strong',produces:'plan_value',component_calls:[]}, {...final,name:'compose',consumes:['plan_value']}];
  f.bindings.board!.mcp.toolsByStep={plan:[],compose:[]};
 });
 assert.equal(result.steps,3);
 const composed=events.find(e=>e.phase==='turn'&&e.produced==='overview');
 assert.match(composed.prompt,/Declared inputs: \{"plan_value":\{"plan":"declared"\}\}/);
 assert.equal(events.find(e=>e.phase==='thread').model,'parent-private-context-strong');
});
test('child step cap counts own steps and blocks admission before next process',async()=>{
 const {result,events}=await execute({overview:{calls:[{alias:'inspect'}],returnCalls:true},measurement:{}},f=>{
  const n=f.ir.components[1]!;n.llm_calls.push({...structuredClone(n.llm_calls[0]!),name:'second',produces:'second_value',consumes:['measurement']});
  f.bindings.probe!.mcp.toolsByStep.second=[];
 },{maxStepsPerChild:1});
 assert.equal(result.steps,2);assert.equal((result.value as any).results[0].code,'budget_exhausted');
 assert.equal(events.filter(e=>e.phase==='thread').length,2);
});
test('callee repair gets sanitized failure and preserves its own tier',async()=>{
 const {result,events}=await execute({overview:{calls:[{alias:'inspect'}],returnCalls:true},measurement:{raw:'SECRET_BAD_OUTPUT'},repaired:{value:{recovered:true}}},f=>{
  const n=f.ir.components[1]!;n.llm_calls.push({...structuredClone(n.llm_calls[0]!),name:'repair',tier:'strong',produces:'repaired',consumes:['measurement'],conditional:true,when:{guard:'on_failure',target:'execute'}});
  f.bindings.probe!.mcp.toolsByStep.repair=[];
 });
 assert.equal((result.value as any).results[0].output.value.recovered,true);
 const repair=events.find(e=>e.phase==='turn'&&e.produced==='repaired');
 assert.doesNotMatch(repair.prompt,/SECRET_BAD_OUTPUT/);assert.match(repair.prompt,/callee_failed/);
 assert.equal(repair.model,'child-private-context-strong');
});
test('depth cap refuses descendant without spawning it',async()=>{
 const {result}=await execute({overview:{calls:[{alias:'inspect'}],returnCalls:true},measurement:{calls:[{alias:'leaf'}],returnCalls:true}},f=>{
  f.ir.components[1]!.llm_calls[0]!.component_calls=[{alias:'leaf',component:'sensor'}];f.ir.components[1]!.required_capabilities.push('component_invocation');
  f.ir.components.push(component('sensor','leafvalue'));f.bindings.sensor=structuredClone(f.bindings.probe!);
 },{maxDepth:1});
 assert.equal(result.attempts,1);assert.equal(result.steps,2);
 assert.equal((result.value as any).results[0].output.value.results[0].code,'budget_exhausted');
});
test('missing required successful tool is not a successful callee value',async()=>{
 const {result}=await execute({overview:{calls:[{alias:'inspect'}],returnCalls:true},measurement:{}},f=>{
  f.bindings.probe!.mcp.toolsByStep.execute=['lookup'];f.bindings.probe!.mcp.requireTool=['execute'];
 });
 assert.equal((result.value as any).results[0].status,'error');
});
test('CLI composed manifest validates bindings and rejects ambiguous flags without model work',async()=>{
 const f=fixture();const dir=await mkdtemp(join(tmpdir(),'warble-composed-cli-'));
 try {
  const ir=join(dir,'ir.json'),bindings=join(dir,'bindings.json');await writeFile(ir,JSON.stringify(f.ir));await writeFile(bindings,JSON.stringify({components:f.bindings}));
  const cli=fileURLToPath(new URL('../src/cli.ts',import.meta.url));
  const args=['--import','tsx',cli,'manifest',ir,'--component','board','--transport','orchestrate','--component-bindings',bindings];
  const good=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(good.status,0,good.stderr);
  const manifest=JSON.parse(good.stdout);assert.equal(manifest.entry,'board');assert.equal(manifest.modelTurnHardLimit,false);assert.equal(manifest.components.length,2);
  const bad=spawnSync(process.execPath,[...args,'--step-tool','execute=lookup'],{encoding:'utf8'});assert.equal(bad.status,1);assert.match(bad.stderr,/do not combine/);
 } finally {await rm(dir,{recursive:true,force:true});}
});


test('CLI dispatch reaches the real parser and composed runtime with a fake app-server',async()=>{
 const f=fixture(),dir=await mkdtemp(join(tmpdir(),'warble-composed-dispatch-'));
 try {
  const ir=join(dir,'ir.json'),bindings=join(dir,'bindings.json'),scenario=join(dir,'scenario.json'),wrapper=join(dir,'codex.mjs');
  const cwd=join(dir,'project'),home=join(dir,'home');await mkdir(cwd);await mkdir(home);
  await writeFile(ir,JSON.stringify(f.ir));await writeFile(bindings,JSON.stringify({components:f.bindings}));
  await writeFile(scenario,JSON.stringify({steps:{overview:{calls:[{alias:'inspect'}],returnCalls:true},measurement:{value:{reading:9}}}}));
  await writeFile(wrapper,`#!/usr/bin/env node\nprocess.argv.splice(2,0,${JSON.stringify(scenario)});\nawait import(${JSON.stringify(new URL('./fixtures/fake-component-app-server.mjs',import.meta.url).href)});\n`,{mode:0o755});
  const cli=fileURLToPath(new URL('../src/cli.ts',import.meta.url));
  const result=spawnSync(process.execPath,['--import','tsx',cli,'dispatch',ir,'show measurements','--component','board','--transport','orchestrate','--component-bindings',bindings,'--project',cwd,'--codex-home',home,'--codex-bin',wrapper],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).results[0].output.value.reading,9);
 } finally {await rm(dir,{recursive:true,force:true});}
});


test('effective step capabilities are retained and invocation cannot be forged outside them',()=>{
 const f=fixture();f.ir.components[0]!.llm_calls[0]!.capabilities=['llm:cheap'];
 assert.throws(()=>prepareComponentInvocation(f),/effective step component_invocation/);
 f.ir.components[0]!.llm_calls[0]!.capabilities=['llm:cheap','component_invocation'];
 assert.deepEqual(prepareComponentInvocation(f).nodes.board!.prepared.node.llm_calls[0]!.capabilities,['llm:cheap','component_invocation']);
 f.ir.components[0]!.llm_calls[0]!.capabilities=['component_invocation','unknown'];
 assert.throws(()=>prepareComponentInvocation(f),/step capabilities must narrow/);
});


test('malformed callee output has invalid_result, transport loss alone is retryable',async()=>{
 const bad=await execute({overview:{calls:[{alias:'inspect'}],returnCalls:true},measurement:{raw:'PRIVATE_MALFORMED'}});
 assert.equal((bad.result.value as any).results[0].code,'invalid_result');assert.equal((bad.result.value as any).results[0].retryable,false);
 const crashed=await execute({overview:{calls:[{alias:'inspect'}],returnCalls:true},measurement:{crash:true}});
 assert.equal((crashed.result.value as any).results[0].code,'transient_transport');assert.equal((crashed.result.value as any).results[0].retryable,true);
});
test('narrowed MCP authority and incomplete precondition evidence fail closed',()=>{
 const f=fixture();f.ir.components[1]!.required_capabilities.push('semantic_introspection');f.ir.components[1]!.llm_calls[0]!.capabilities=['llm:cheap'];f.bindings.probe!.mcp.toolsByStep.execute=['lookup'];
 assert.throws(()=>prepareComponentInvocation(f),/narrowed step MCP authority/);
 const g=fixture();(g.ir.components[1] as any).context_precondition=[{predicate:'bound'}];(g.ir.components[1] as any).precondition_result={status:'pass',checks:[]};
 assert.throws(()=>prepareComponentInvocation(g),/context precondition/);
 (g.ir.components[1] as any).precondition_result.checks=[{predicate:'different',outcome:'pass'}];assert.throws(()=>prepareComponentInvocation(g),/context precondition/);
});

for (const target of ['board', 'probe']) for (const serialized of [false, true]) {
 test(`precondition passes cannot attest changed arguments or context for ${target} (${serialized ? 'JSON' : 'object'})`,()=>{
  const f=fixture();const node=f.ir.components.find(node=>node.id===target)! as any;
  const prepare=()=>prepareComponentInvocation({...f,ir:serialized?JSON.stringify(f.ir):f.ir});
  node.context_precondition=[{predicate:'model_has_timestamp',args:{model:'original_model'}}];
  node.precondition_result={status:'pass',checks:[{predicate:'model_has_timestamp',outcome:'pass'}]};
  node.context_precondition[0].args.model='unattested_model';
  assert.throws(prepare,/context preconditions require unsupported runtime attestation/);
  // Even matching arguments in caller-supplied evidence do not attest the bound runtime context.
  node.precondition_result.checks[0].args={model:'unattested_model'};
  assert.throws(prepare,/context preconditions require unsupported runtime attestation/);
  delete node.context_precondition[0].args;
  delete node.precondition_result.checks[0].args;
  assert.throws(prepare,/context preconditions require unsupported runtime attestation/);
  for(const malformed of [null,{},'model_has_timestamp',[null]]) {
   node.context_precondition=malformed;
   assert.throws(prepare,/context preconditions require unsupported runtime attestation/);
  }
  node.context_precondition=[];
  assert.doesNotThrow(prepare);
  delete node.context_precondition;
  assert.doesNotThrow(prepare);
 });
}

test('unreachable preconditions do not change the selected invocation closure',()=>{
 const f=fixture();const sibling=component('unreachable','unused') as any;
 sibling.context_precondition=[{predicate:'model_has_timestamp',args:{model:'unattested'}}];
 sibling.precondition_result={status:'pass',checks:[{predicate:'model_has_timestamp',outcome:'pass'}]};
 f.ir.components.push(sibling);
 assert.deepEqual(Object.keys(prepareComponentInvocation(f).nodes).sort(),['board','probe']);
});
