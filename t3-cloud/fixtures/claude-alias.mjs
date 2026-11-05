import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, writeFile, readFile, access, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {AllocationStore} from '../allocations.mjs';
import {ScopedBriq, scopedBriqTools} from '../scoped-briq.mjs';
import {BriqCloud} from '../briq-cloud.mjs';
import {createScopedClaudeMcpServer} from '../claude-runtime.mjs';
import {ScopedMcpTransport} from '../scoped-mcp-transport.mjs';
import {startAppServer} from '../broker.mjs';
const SDK='/opt/t3/node_modules/@anthropic-ai/claude-agent-sdk';
const source=JSON.parse(await readFile('/opt/t3/source.json','utf8'));
const manifest=JSON.parse(await readFile(join(SDK,'manifest.json'),'utf8'));
const pkg=JSON.parse(await readFile(join(SDK,'package.json'),'utf8'));
assert.equal(source.claude,'2.1.276');assert.equal(source.claudeSdk,'0.3.276');
assert.equal(manifest.version,source.claude);assert.equal(pkg.version,source.claudeSdk);
const expected=manifest.platforms[`${process.platform}-${process.arch}`].checksum;
const managed=JSON.parse(await readFile('/etc/claude-code/managed-settings.json','utf8'));
assert.deepEqual(managed,{disableAllHooks:true,disableAgentView:true,disableRemoteControl:true,env:{DISABLE_AUTOUPDATER:'1',DISABLE_UPDATES:'1'}});
const cli=process.argv[2];
const receiptPath=process.argv[3];
assert.equal(cli,'/usr/local/bin/claude');assert.equal(receiptPath,'/tmp/claude-image-result.json');
const {execFileSync}=await import('node:child_process');
assert.equal(execFileSync(cli,['--version'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin'}}).trim(),`${source.claude} (Claude Code)`);
assert.equal(createHash('sha256').update(await readFile(cli)).digest('hex'),expected);
assert.equal(process.env.HOME,process.env.CLAUDE_CONFIG_DIR?.replace(/\/config$/,''));
assert.deepEqual(await readdir(process.env.HOME).catch(e=>{if(e.code==='ENOENT')return [];throw e;}),[]);
await mkdir(process.env.HOME,{recursive:true});
const {query,createSdkMcpServer,tool}=await import(pathToFileURL(join(SDK,'sdk.mjs')));
const require=createRequire(join(SDK,'sdk.mjs'));
const {z}=require('zod');
const root=await mkdtemp(join(tmpdir(),'claude-alias-case-'));
const denied=['Bash','Read','Write','Edit','MultiEdit','Glob','Grep','NotebookEdit','Agent','Task','TaskOutput','TaskStop','EnterWorktree','ExitWorktree','Skill','CronCreate','CronDelete','CronList','WebFetch','WebSearch','Computer','ToolSearch'];
const state={caseRequests:{alias:0,denied:0,scoped:0},caseMessageRequests:{alias:0,denied:0,scoped:0},caseTokenRequests:{alias:0,denied:0,scoped:0},caseHelloRequests:{alias:0,denied:0,scoped:0},requests:0,bodyBytes:0,scopedCliCalls:0,scopedSuccess:false,scopedRejections:0,guidanceObserved:false,callbackCount:0,aliasReturned:false,deniedResults:0,unexpectedRoutes:0,unexpectedRequestPaths:[],stderrBytes:0,timeout:false};
let current,active;
const exists=async p=>access(p).then(()=>true,()=>false);
function response(res,content,stop='end_turn',stream=false) {
 const msg={id:`msg_local_${state.requests}`,type:'message',role:'assistant',model:'claude-sonnet-4-6',content,stop_reason:stop,stop_sequence:null,usage:{input_tokens:1,output_tokens:1}};
 if(!stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(msg));return;}
 res.writeHead(200,{'content-type':'text/event-stream'});
 const emit=(event,value)=>res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
 emit('message_start',{type:'message_start',message:{...msg,content:[],stop_reason:null}});
 content.forEach((block,index)=>{emit('content_block_start',{type:'content_block_start',index,content_block:{type:'text',text:''}});emit('content_block_delta',{type:'content_block_delta',index,delta:{type:'text_delta',text:block.text}});emit('content_block_stop',{type:'content_block_stop',index});});
 emit('message_delta',{type:'message_delta',delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:1}});emit('message_stop',{type:'message_stop'});res.end();
}
const server=createServer(async(req,res)=>{
 try {
  if(++state.requests>12||!Object.hasOwn(state.caseRequests,current)||++state.caseRequests[current]>4)throw Error('bound');
  let body='';for await(const chunk of req){state.bodyBytes+=chunk.length;if(state.bodyBytes>1024*1024)throw Error('bound');body+=chunk;}
  const pathname=new URL(req.url,'http://127.0.0.1').pathname;
  if(req.method==='HEAD'&&pathname==='/api/hello'){
   if(++state.caseHelloRequests[current]>1)throw Error('bound');
   res.writeHead(200);res.end();return;
  }
  if(req.method==='POST'&&pathname==='/v1/messages/count_tokens'){
   if(++state.caseTokenRequests[current]>2)throw Error('bound');
   JSON.parse(body);res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":1}');return;
  }
  if(req.method!=='POST'||pathname!=='/v1/messages') {state.unexpectedRoutes++;if(state.unexpectedRequestPaths.length<8)state.unexpectedRequestPaths.push({method:/^[A-Z]{1,12}$/.test(req.method??'')?req.method:'OTHER',pathname:pathname.slice(0,120).replace(/[^A-Za-z0-9/_.-]/g,'_')});res.writeHead(404);res.end('{}');return;}
  if(++state.caseMessageRequests[current]>2)throw Error('bound');
  const data=JSON.parse(body);
  const results=data.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(c=>c.type==='tool_result');
  if(results.length) {
   assert.deepEqual(results.map(r=>r.tool_use_id).sort(),current==='alias'?['call_alias']:current==='denied'?['call_agent','call_bash','call_read']:['call_catalog','call_cross','call_unknown']);
   if(current==='alias')state.aliasReturned=results.some(r=>r.tool_use_id==='call_alias'&&JSON.stringify(r.content).includes('FIXED_CALLBACK_OK'));
   else if(current==='scoped'){state.scopedSuccess=results.some(r=>r.tool_use_id==='call_catalog'&&!r.is_error&&JSON.stringify(r.content).includes('FIXED_SCOPED_CATALOG'));state.scopedRejections=results.filter(r=>['call_cross','call_unknown'].includes(r.tool_use_id)&&r.is_error===true).length;}
   else state.deniedResults=results.filter(r=>['call_bash','call_read','call_agent'].includes(r.tool_use_id)&&r.is_error===true).length;
   response(res,[{type:'text',text:'LOCAL_PROBE_COMPLETE'}],'end_turn',data.stream);return;
  }
  if(current==='scoped'){
   const system=Array.isArray(data.system)?data.system.map(block=>block.text??'').join('\n'):data.system;
   state.guidanceObserved=typeof system==='string'&&system.includes(guidance);assert.equal(state.guidanceObserved,true);
   assert(data.tools.some(tool=>tool.name==='mcp__briq__briq_catalog'));
  }
  const uses=current==='scoped'?[
   {type:'tool_use',id:'call_catalog',name:'mcp__briq__briq_catalog',input:{}},
   {type:'tool_use',id:'call_unknown',name:'mcp__briq__briq_run',input:{recipe:'sandbox',file:'/central/auth'}},
   {type:'tool_use',id:'call_cross',name:'mcp__briq__briq_status',input:{id:'other-thread-resource'}}
  ]:current==='alias'?[{type:'tool_use',id:'call_alias',name:'Bash',input:{command:'FIXED_ALIAS_COMMAND',timeout:1000}}]:[
   {type:'tool_use',id:'call_bash',name:'Bash',input:{command:`printf forbidden > '${join(root,'native-marker')}'`}},
   {type:'tool_use',id:'call_read',name:'Read',input:{file_path:join(root,'canary')}},
   {type:'tool_use',id:'call_agent',name:'Agent',input:{description:'local denial probe',prompt:'LOCAL_DENY',subagent_type:'general-purpose'}}];
  if(data.stream) {
   res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
   const emit=(event,value)=>res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
   emit('message_start',{type:'message_start',message:{id:`msg_local_${state.requests}`,type:'message',role:'assistant',model:'claude-sonnet-4-6',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}});
   uses.forEach((u,index)=>{emit('content_block_start',{type:'content_block_start',index,content_block:{type:'tool_use',id:u.id,name:u.name,input:{}}});emit('content_block_delta',{type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:JSON.stringify(u.input)}});emit('content_block_stop',{type:'content_block_stop',index});});
   emit('message_delta',{type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:1}});emit('message_stop',{type:'message_stop'});res.end();
  } else response(res,uses,'tool_use');
 }catch {res.writeHead(400);res.end('{}');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
const env={HOME:process.env.HOME,CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',TMPDIR:root,ANTHROPIC_API_KEY:'FAKE_LOCAL_ONLY',ANTHROPIC_BASE_URL:`http://127.0.0.1:${port}`,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY:'1',CLAUDE_CODE_ENABLE_TELEMETRY:'0'};
await writeFile(join(root,'canary'),'FIXED_LOCAL_CANARY');
const homeHook=join(root,'home-hook-marker'),projectHook=join(root,'project-hook-marker');
await mkdir(process.env.CLAUDE_CONFIG_DIR,{recursive:true});
await mkdir(join(root,'.claude'),{recursive:true});
for(const [where,marker]of[[process.env.CLAUDE_CONFIG_DIR,homeHook],[join(root,'.claude'),projectHook]])await writeFile(join(where,'settings.json'),JSON.stringify({hooks:{SessionStart:[{hooks:[{type:'command',command:`/usr/bin/touch '${marker}'`}]}]}}));
const trusted=createSdkMcpServer({name:'workspace',version:'1.0.0',tools:[tool('bash','Fixed local conformance callback',{command:z.string(),timeout:z.number().optional()},async args=>{state.callbackCount++;assert.equal(current,'alias');assert.deepEqual(args,{command:'FIXED_ALIAS_COMMAND',timeout:1000});return {content:[{type:'text',text:'FIXED_CALLBACK_OK'}]};})]});
const scopedStore=new AllocationStore(join(root,'scoped-store'));await scopedStore.initialize();
const scopedNativeId='11111111-1111-4111-8111-111111111111';
await scopedStore.save({threadId:'scoped',allocationId:'allocation-scoped',briqId:'protected-root',state:'ready',claudeNativeSessionId:scopedNativeId});
const scopedCloud=new BriqCloud({directory:join(root,'fake-cli'),env:{},run:async args=>{
 state.scopedCliCalls++;assert.deepEqual(args,['catalog']);return[{name:'sandbox',description:'FIXED_SCOPED_CATALOG'}];
}});
const scopedBriq=new ScopedBriq({store:scopedStore,cloud:scopedCloud});
const scopedOwner={threadId:'scoped',allocationId:'allocation-scoped',nativeId:scopedNativeId,turnId:'turn-scoped',openRecord:{key:'open-scoped'},closed:false};
const scopedServer=createScopedClaudeMcpServer({createSdkMcpServer,z},scopedOwner,scopedBriq);
const guidance=await readFile(new URL('../skills/briq/SKILL.md',import.meta.url),'utf8');
let failureTag=null;
const timer=setTimeout(()=>{state.timeout=true;active?.close();},90000);
try {
 for(current of ['alias','denied','scoped']) {
  assert.equal(state.timeout,false);
  active=query({prompt:'Run the supplied local fixture tool and finish.',options:{pathToClaudeCodeExecutable:cli,cwd:root,env,model:'claude-sonnet-4-6',maxTurns:3,tools:[],disallowedTools:denied,allowedTools:['mcp__workspace__bash',...(current==='scoped'?scopedBriqTools.map(tool=>`mcp__briq__${tool.name}`):[])],mcpServers:{workspace:trusted,...(current==='scoped'?{briq:scopedServer}:{})},...(current==='scoped'?{sessionId:scopedNativeId,systemPrompt:`Use only the workspace MCP shell for repository files, commands and tests.\n\n${guidance}`}:{}),toolAliases:current!=='denied'?{Bash:'mcp__workspace__bash'}:{},strictMcpConfig:true,settingSources:[],skills:[],plugins:[],agents:{},permissionMode:'dontAsk',settings:{disableAllHooks:true,enableAllProjectMcpServers:false},managedSettings:{disableAllHooks:true,disableAgentView:true,disableRemoteControl:true},stderr:chunk=>{state.stderrBytes+=Buffer.byteLength(chunk);}}});
  let result=false;
  try {for await(const message of active){if(message.type==='result'){assert.equal(message.is_error,false);result=true;}}assert(result);}finally{active.close();active=null;}
 }
 assert.deepEqual(state.caseMessageRequests,{alias:2,denied:2,scoped:2});assert.deepEqual(state.caseHelloRequests,{alias:1,denied:1,scoped:1});assert(state.requests>=9&&state.requests<=12);assert.equal(state.unexpectedRoutes,0);
 assert.equal(state.scopedCliCalls,1);assert.equal(state.scopedSuccess,true);assert.equal(state.scopedRejections,2);assert.equal(state.guidanceObserved,true);
 assert.equal(state.callbackCount,1);assert.equal(state.aliasReturned,true);assert.equal(state.deniedResults,3);
 assert.equal(await exists(join(root,'native-marker')),false);
 assert.equal(await exists(homeHook),false);assert.equal(await exists(projectHook),false);
 assert.equal(state.timeout,false);
}catch(error){failureTag=error.code==='ERR_ASSERTION'?'assertion-failed':'native-query-failed';}
finally{clearTimeout(timer);active?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
const codexProof={passed:false,threadStarts:0,threadResumes:0,inventories:0,acceptedScopeResponses:{},oldCapabilitiesRejected:0,modelTurns:0,remoteWorkspaceQualified:false};
async function codexScopedConfiguration() {
 const store=new AllocationStore(join(root,'codex-bindings'));await store.initialize();
 for(const threadId of ['a','b'])await store.save({threadId,allocationId:`codex-${threadId}`,state:'ready',nativeThreadId:null});
 const observations=new Map();let app,transport;
 const listener=createServer((req,res)=>{
  const label=observations.get(req.headers.authorization);
  res.once('finish',()=>{if(label&&res.statusCode===200)codexProof.acceptedScopeResponses[label]=(codexProof.acceptedScopeResponses[label]??0)+1;});
  void transport.handle(req,res).catch(()=>{if(!res.headersSent)res.writeHead(503);res.end();});
 });
 await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
 transport=new ScopedMcpTransport({store,scopedBriq:{call:async()=>{throw Error('No native tool execution in Codex config probe');}},endpoint:`http://127.0.0.1:${listener.address().port}/_cloud/briq/mcp`});
 const timer=setTimeout(()=>{state.timeout=true;void app?.close();listener.closeAllConnections();},30000);
 try {
  app=await startAppServer({binary:'/usr/local/bin/codex',home:join(root,'codex-native-home')});
  assert.equal(app.briqMcp,'allocation-scoped');
  const configs=[];
  for(const threadId of ['a','b']){
   const binding=await store.load(threadId);const scoped=transport.bind(binding);configs.push(scoped.config);
   observations.set(scoped.config['mcp_servers.briq'].http_headers.Authorization,`${threadId}-start`);
   const result=await app.request('thread/start',{cwd:root,approvalPolicy:'on-request',sandbox:'workspace-write',config:scoped.config});
   assert.equal(typeof result.thread?.id,'string');codexProof.threadStarts++;
   binding.nativeThreadId=result.thread.id;await store.save(binding);scoped.activate(binding.nativeThreadId);
   const inventory=await app.request('mcpServerStatus/list',{threadId:binding.nativeThreadId,serverName:'briq',detail:'toolsAndAuthOnly'});
   const server=inventory.data.find(value=>value.name==='briq');
   assert.deepEqual(Object.keys(server?.tools??{}).sort(),scopedBriqTools.map(tool=>tool.name).sort());codexProof.inventories++;
   assert((codexProof.acceptedScopeResponses[`${threadId}-start`]??0)>0);
   const resumed=transport.bind(binding);observations.set(resumed.config['mcp_servers.briq'].http_headers.Authorization,`${threadId}-resume`);
   const response=await app.request('thread/resume',{threadId:binding.nativeThreadId,excludeTurns:true,config:resumed.config});
   assert.equal(response.thread?.id,binding.nativeThreadId);codexProof.threadResumes++;
   const resumedInventory=await app.request('mcpServerStatus/list',{threadId:binding.nativeThreadId,serverName:'briq',detail:'toolsAndAuthOnly'});
   assert.deepEqual(Object.keys(resumedInventory.data.find(value=>value.name==='briq')?.tools??{}).sort(),scopedBriqTools.map(tool=>tool.name).sort());codexProof.inventories++;
   assert((codexProof.acceptedScopeResponses[`${threadId}-resume`]??0)>0);
   const old=await fetch(transport.endpoint,{method:'POST',headers:{Authorization:scoped.config['mcp_servers.briq'].http_headers.Authorization}});
   assert.equal(old.status,401);await old.text();codexProof.oldCapabilitiesRejected++;
  }
  assert.notDeepEqual(configs[0],configs[1]);
  for(const label of ['a-start','a-resume','b-start','b-resume'])assert((codexProof.acceptedScopeResponses[label]??0)>0);
  assert.equal(state.timeout,false);codexProof.passed=true;
 }finally{clearTimeout(timer);transport.close();await app?.close();listener.closeAllConnections();await new Promise(resolve=>listener.close(resolve));}
}
if(failureTag===null){try{await codexScopedConfiguration();}catch{failureTag='native-codex-config-failed';}}
const receipt={passed:failureTag===null,failureTag,state,codexProof,sdk:source.claudeSdk,cli:source.claude,cliSha256:expected,scope:'pinned Claude SDK alias/denial/scoped-tool fake-provider conformance and pinned Codex per-thread MCP start/resume inventory only',noCloudProof:true,noSubscriptionProof:true,scopedClaudeFakeCliOnly:true,codexNativePerThreadConfigurationOnly:true,compositionLimitation:'Codex uses the production startAppServer and per-thread config builder with a local fixture cwd; full CapabilityBroker frames are covered separately by unit tests. Remote workspace execution, native tool mutation, provider subscriptions and cloud resources are not qualified.',internalDirectDispatchProved:false,managedPolicyExactMatch:true,managedHookLimitation:'Only this image managed policy and fresh user/project hook canaries are covered; deployment policy, internal direct dispatch and subscription execution remain unqualified.',networkPolicy:'Entire probe must run in Docker --network none; fake provider uses only same-container loopback; no host credential/config mounts',nativeFallbackMarkerPresent:await exists(join(root,'native-marker')),controlledHookMarkersPresent:await exists(homeHook)||await exists(projectHook)};
await writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(receipt));process.exitCode=receipt.passed?0:1;
