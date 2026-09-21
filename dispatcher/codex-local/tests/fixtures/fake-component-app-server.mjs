import {createInterface} from 'node:readline';
import {readFileSync,appendFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const scenario = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const threadId = randomUUID(), turnId = randomUUID();
let model, config, aliases, behavior, produced, results=[];
const send = (msg) => process.stdout.write(JSON.stringify(msg)+'\n');
const notify = (method, params) => send({method,params});
const item = (method, v) => notify(method,{threadId,turnId,item:v});
const log = (value) => {if(scenario.log)appendFileSync(scenario.log,JSON.stringify({pid:process.pid,...value})+'\n');};
const calls = new Map();
let sequence=0;
async function work() {
 if(behavior.crash)process.exit(1);
 if(behavior.delay)await new Promise(r=>setTimeout(r,behavior.delay));
 if(behavior.native){item('item/completed',{id:'forbidden',type:behavior.native});return;}
 for(const tool of behavior.mcp??[]){
  item('item/started',{id:tool,type:'mcpToolCall',server:behavior.server??'data',tool,status:'inProgress'});
  item('item/completed',{id:tool,type:'mcpToolCall',server:behavior.server??'data',tool,status:'completed',error:null});
 }
 const runCall = async (call) => {
  const id='call-'+sequence++;
  const v={id,type:'dynamicToolCall',tool:call.alias,namespace:'warble_components',arguments:call.payload??{request:'child-request',input:{explicit:'passed'}},status:'inProgress'};
  item('item/started',v);
  const result=await new Promise(resolve=>{
   calls.set(id,resolve);
   send({id,method:'item/tool/call',params:{threadId:call.forgeThread?'forged':threadId,turnId:call.forgeTurn?'forged':turnId,callId:call.forgeId?'forged':id,namespace:call.forgeNamespace?'forged':'warble_components',tool:call.alias,arguments:v.arguments}});
  });
  if(result.error){process.exitCode=1;return;}
  results.push(JSON.parse(result.result.contentItems[0].text));
  item('item/completed',{...v,status:'completed',success:result.result.success,contentItems:result.result.contentItems});
 };
 if(behavior.parallel)await Promise.all((behavior.calls??[]).map(runCall));
 else for(const call of behavior.calls??[])await runCall(call);
 if(behavior.afterDelay)await new Promise(r=>setTimeout(r,behavior.afterDelay));
 const value=behavior.returnCalls?{results}:behavior.value??{ok:true};
 const text=behavior.raw??JSON.stringify({[produced]:value});
 item('item/completed',{id:'answer',type:'agentMessage',text});
 const total={inputTokens:2,outputTokens:3,cachedInputTokens:0,reasoningOutputTokens:0,totalTokens:5};
 notify('thread/tokenUsage/updated',{threadId,turnId,tokenUsage:{total,last:total}});
 notify('turn/completed',{threadId,turn:{id:turnId,status:'completed'}});
}
createInterface({input:process.stdin}).on('line',async line=>{
 const msg=JSON.parse(line);
 if(calls.has(msg.id)){calls.get(msg.id)(msg);calls.delete(msg.id);return;}
 if(msg.method==='initialize'){send({id:msg.id,result:{codexHome:process.env.CODEX_HOME}});return;}
 if(msg.method==='initialized')return;
 if(msg.method==='thread/start'){
  model=msg.params.model;config=msg.params.config;aliases=msg.params.dynamicTools;
  if(aliases.some(namespace=>namespace.type!=='namespace'||namespace.tools.some(tool=>tool.type!=='function'||typeof tool.name!=='string'||typeof tool.description!=='string'||!tool.inputSchema))) {
   send({id:msg.id,error:{code:-32602,message:'Invalid dynamic tool schema'}});return;
  }
  log({phase:'thread',model,params:msg.params,args:process.argv.slice(3)});
  send({id:msg.id,result:{thread:{id:threadId}}});return;
 }
 if(msg.method==='turn/start'){
  const prompt=msg.params.input[0].text;
  produced=JSON.parse(prompt.match(/Produces key: ([^\n]+)/)[1]);
  behavior=scenario.steps[produced]??{};
  log({phase:'turn',model,prompt,produced});
  const started=()=>notify('turn/started',{threadId,turn:{id:turnId,status:'inProgress'}});
  if(behavior.early)started();
  send({id:msg.id,result:{turn:{id:turnId,status:'inProgress'}}});
  if(!behavior.early)started();
  await work();return;
 }
 send({id:msg.id,result:{}});
});
process.on('SIGTERM',()=>{log({phase:'closed'});process.exit(0);});
