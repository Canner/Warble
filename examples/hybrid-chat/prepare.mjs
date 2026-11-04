// Write a synthetic runtime template; no network or model execution.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--out') throw new Error('Usage: node prepare.mjs --out runtime.json');
const path=fileURLToPath(new URL('./adapter.mjs',import.meta.url));
const model=(zone,api,baseUrl,credentialEnv)=>({zone,deployment:zone==='public'?'cloud':'private',api,model:'REPLACE_WITH_TESTED_MODEL_ID',baseUrl,credentialEnv});
const selection=metadata=>({metadata,components:['callee'],approvedAnswers:true});
const config={format:'warble-pi-hybrid-config/1',entry:'caller',policy:'permit(principal, action, resource);',
  adapter:{path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')},
  selections:{blind:selection([]),schema:selection([{kind:'schema.structure',documents:['catalog']}]),
    business:selection([{kind:'schema.structure',documents:['catalog']},{kind:'knowledge.rules',documents:['rules']}])},
  models:{openai:model('public','openai-completions','http://127.0.0.1:8001/v1','PUBLIC_MODEL_KEY'),
    claude:model('public','anthropic-messages','http://127.0.0.1:8003','ANTHROPIC_MODEL_KEY')},
  projects:{demo:{privateModels:{callee:{cheap:model('private','openai-completions','http://127.0.0.1:8002/v1','PRIVATE_MODEL_KEY')}}}},
  defaults:{policy:'blind',model:'openai',project:'demo'}};
writeFileSync(resolve(args[1]),JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
console.log('Created template. Replace model IDs/endpoints before launching; no provider has been contacted.');
