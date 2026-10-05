import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Coordinator} from '../lib/engine.js';
import {Invitations} from '../lib/onboarding.js';
import {apply} from '../lib/index.js';
import {runHarness,probeHarness} from '../lib/runner.js';

const root=path.resolve('test-data','mcp-'+Date.now()),cwd=path.join(root,'workspace');fs.mkdirSync(cwd,{recursive:true});
const fixture=path.resolve('test/mcp-fixture.mjs'),children=[];
const launch=r=>{
 const child=spawn(r.argv[0],r.argv.slice(1),{cwd:r.cwd,env:{...process.env,...r.env},stdio:'pipe',windowsHide:true});children.push(child);
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(exitCode,signal)=>resolve({exitCode,signal}));});
 const abort=()=>child.kill();r.signal.addEventListener('abort',abort,{once:true});done.finally(()=>r.signal.removeEventListener('abort',abort)).catch(()=>{});
 return {stdin:child.stdin,stdout:child.stdout,stderr:child.stderr,done,stop:async()=>{if(child.exitCode===null)child.kill();await done;},terminate:()=>child.kill(),waitForExit:()=>done};
};
const a={id:'mcp-owner',cwd};
const engine=new Coordinator({dir:path.join(root,'state'),run:r=>runHarness({launch},r),probe:r=>probeHarness({launch},r)}),invitations=new Invitations(engine);
const mapping={transport:'stdio',tool:'write_artifact',arguments:{prompt:'{prompt}',workdir:'{workdir}',output:'mcp-delivery.md',model:'{model}',reasoning:'{reasoning}',count:1}};
const definition=(id,mode='normal',mcp=mapping)=>({id,label:'隔离MCP执行端',protocol:'mcp',command:process.execPath,args:[fixture,id+'.jsonl',mode,id+'-control.json'],mcp,capabilities:{modelSelection:true,reasoningSelection:true}});
const messages=id=>fs.readFileSync(path.join(cwd,id+'.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
const until=async fn=>{for(let i=0;i<240;i++){if(fn())return;await new Promise(r=>setTimeout(r,25));}throw Error('等待MCP测试超时');};
const task=(endpoint,overrides={})=>({id:'delivery',title:'MCP隔离交付',prompt:'生成真实文件供当前Agent审查',endpoint,outputs:['mcp-delivery.md'],criteria:['真实产物包含MCP隔离执行内容'],reason:'验证仅MCP入口的执行端',...overrides});
const invitation=()=>{const v=invitations.create(a,'http://127.0.0.1:32180');return {...v,token:JSON.parse(fs.readFileSync(v.file)).token};};
let hosted,server;const effects=[];
try{
 const v=invitation(),reply=await invitations.submit(v.token,{label:'仅MCP可调用的测试端',definition:definition('main','pagination')});assert.equal(reply.connected,true);assert.equal(reply.connection.protocol,'mcp');assert.equal(reply.connection.handshakeVerified,true);assert.equal(reply.connection.tools.length,2);assert.equal(fs.existsSync(v.file),false);
 const id=reply.endpointId;assert.deepEqual(messages('main').map(m=>m.method),['initialize','notifications/initialized','tools/list','tools/list']);assert.equal(messages('main').some(m=>m.method==='tools/call'),false);
 engine.plan(a,{title:'MCP交付和审查闭环',tasks:[task(id,{prompt:'生成真实文件，保留用户原文中的{model}与{workdir}字样',model:'fixture-model',reasoning:'fixture-high'})]});await until(()=>engine.state.sessions[a.id].tasks[0].status==='awaiting_review');let t=engine.state.sessions[a.id].tasks[0];
 assert.equal(t.result.ok,true);assert.match(engine.read(a,{id:t.id,relative:t.outputs[0]}).text,/MCP隔离执行已完成/);
 engine.review(a,{id:t.id,revision:t.revision,version:t.result.version,verdict:'pass',checks:[{criterion:t.criteria[0],status:'pass',evidence:'当前测试Agent读取真实文件，确认包含MCP隔离执行内容'}],note:'隔离测试审查通过，不代表真实模型验收'});assert.equal(t.status,'passed');
 const call=messages('main').find(m=>m.method==='tools/call');assert.equal(call.params.name,'write_artifact');assert.equal(call.params.arguments.workdir,cwd);assert.equal(call.params.arguments.model,'fixture-model');assert.equal(call.params.arguments.reasoning,'fixture-high');assert.match(call.params.arguments.prompt,/验收条件/);assert.match(call.params.arguments.prompt,/原文中的\{model\}与\{workdir\}/);
 // Missing binding exposes discovered tools to the Agent without executing one.
 const missing=invitation(),discovered=await invitations.submit(missing.token,{label:'先发现工具',definition:definition('discovery','normal',{})});assert.equal(discovered.connected,false);assert.equal(discovered.connection.handshakeVerified,true);assert.equal(discovered.connection.stage,'binding');assert.equal(discovered.connection.tools[0].name,'write_artifact');assert.equal(messages('discovery').some(m=>m.method==='tools/call'),false);
 assert.throws(()=>engine.plan(a,{title:'不得提前执行',tasks:[task(discovered.endpointId)]}),/MCP连接尚未验证/);
 const corrected=await invitations.submit(missing.token,{label:'Agent已映射',definition:definition('discovery-fixed')});assert.equal(corrected.connected,true);assert.equal(corrected.endpointId,discovered.endpointId);
 // ACP failure may be corrected to a genuinely verified MCP entry, not text.
 const fallback=invitation(),acpFailure=await invitations.submit(fallback.token,{label:'协议转换',definition:{...definition('switch'),protocol:'acp'}});assert.equal(acpFailure.connected,false);const switched=await invitations.submit(fallback.token,{label:'MCP连接',definition:definition('switch-fixed')});assert.equal(switched.connected,true);assert.equal(switched.endpointId,acpFailure.endpointId);
 for(const [mode,expected]of [['bad-version',/协议版本/],['no-tools',/tools能力/],['duplicate',/名称重复/],['cursor-loop',/游标/],['list-changed',/列表.*变化/],['invalid-schema',/resolve reference/],['task-required',/异步task/]]){
  engine.endpoint(a,definition(mode,mode));const r=await engine.connectEndpoint(a,mode);assert.equal(r.connected,false,mode);assert.match(r.connection.error,expected);assert.equal(messages(mode).some(m=>m.method==='tools/call'),false);
 }
 engine.endpoint(a,definition('older','older'));assert.equal((await engine.connectEndpoint(a,'older')).connected,true);
 engine.endpoint(a,definition('callbacks','callbacks'));assert.equal((await engine.connectEndpoint(a,'callbacks')).connected,true);assert.equal(messages('callbacks').find(m=>m.id===901&&!m.method).result.roots[0].name,'当前工作区');assert.equal(messages('callbacks').find(m=>m.id===902&&!m.method).error.code,-32601);
 await assert.rejects(()=>engine.connectEndpoint({id:'other',cwd},id),/会话|登记/);
 assert.throws(()=>engine.endpoint(a,definition('http','normal',{...mapping,transport:'http'})),/stdio/);
 // Selection must match actual mapping, and concrete arguments are schema-checked before call.
 engine.endpoint(a,definition('invalid-static','normal',{...mapping,arguments:{...mapping.arguments,count:'not-an-integer'}}));assert.equal((await engine.connectEndpoint(a,'invalid-static')).connected,false);assert.match(engine.state.endpoints['invalid-static'].connection.error,/固定参数/);
 engine.endpoint(a,definition('invalid-args'));assert.equal((await engine.connectEndpoint(a,'invalid-args')).connected,true);
 engine.plan(a,{title:'参数拒绝',tasks:[task('invalid-args',{model:'unsupported-model'})]});await until(()=>engine.state.sessions[a.id].tasks[0].status==='failed');assert.match(engine.state.sessions[a.id].tasks[0].error,/inputSchema/);assert.equal(messages('invalid-args').some(m=>m.method==='tools/call'),false);
 // Missing model selection is omitted, allowing the server's real default; no model is guessed.
 engine.plan(a,{title:'不指定模型',tasks:[task('older')]});await until(()=>engine.state.sessions[a.id].tasks[0].status==='awaiting_review');assert.equal(Object.hasOwn(messages('older').find(m=>m.method==='tools/call').params.arguments,'model'),false);await engine.control(a,'cancel');await engine.control(a,'resume');
 // Protocol and tools are re-discovered per task; changed definitions are never invoked.
 engine.endpoint(a,definition('drift'));assert.equal((await engine.connectEndpoint(a,'drift')).connected,true);fs.writeFileSync(path.join(cwd,'drift-control.json'),'{}');engine.plan(a,{title:'工具漂移',tasks:[task('drift')]});await until(()=>engine.state.sessions[a.id].tasks[0].status==='failed');assert.match(engine.state.sessions[a.id].tasks[0].error,/已变化/);assert.equal(messages('drift').some(m=>m.method==='tools/call'),false);assert.equal(engine.state.endpoints.drift.connection.state,'needs_agent');
 for(const [mode,expected]of [['tool-error',/工具执行失败/],['wrong-output',/outputSchema/],['async-result',/异步task/]]){
  engine.endpoint(a,definition(mode,mode));assert.equal((await engine.connectEndpoint(a,mode)).connected,true);engine.plan(a,{title:mode,tasks:[task(mode)]});await until(()=>engine.state.sessions[a.id].tasks[0].status==='failed');assert.match(engine.state.sessions[a.id].tasks[0].error,expected);
 }
 engine.endpoint(a,definition('slow','slow'));assert.equal((await engine.connectEndpoint(a,'slow')).connected,true);engine.plan(a,{title:'取消MCP工作',tasks:[task('slow',{timeoutMs:5000})]});await until(()=>messages('slow').some(m=>m.method==='tools/call'));await engine.control(a,'pause');assert.equal(engine.live.size,0);const previous=fs.readFileSync(path.join(cwd,'mcp-delivery.md'),'utf8');await new Promise(r=>setTimeout(r,300));assert.equal(fs.readFileSync(path.join(cwd,'mcp-delivery.md'),'utf8'),previous);await engine.control(a,'cancel');
 await assert.rejects(()=>runHarness({launch},{endpoint:definition('silent','silent'),cwd,owner:a.id,signal:new AbortController().signal,probeOnly:true,prompt:'',task:{timeoutMs:200}}),/超时/);
 // A real HTTP callback/client and DSH tool layer both route MCP through confinement.
 let handler,rpc,denied=false,spawnCount=0;const agent={id:'host-mcp',session:{header:{cwd}}};
 server=http.createServer((req,res)=>{void handler(req,res);});await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 const ctx={agents:{get:id=>id===agent.id?agent:undefined},sessions:{get:id=>id===agent.id?agent.session:undefined},sessionController:{prompt:async()=>{}},tools:{register:t=>{ctx.registered.set(t.name,t);return()=>{};}},registered:new Map(),systemPrompt:{section:()=>()=>{}},connection:{register:(_ctx,_channel,fn)=>{rpc=fn;}},webServer:{port,register:v=>{handler=v.handler;return()=>{};}},on:()=>()=>{},effect:fn=>effects.push(fn()),sandboxPolicy:{resolve:()=>({mode:'workspace-write'})},sandbox:{confine:async argv=>{if(denied)throw Error('宿主拒绝MCP启动');return {argv};}},subprocess:{spawn:r=>{spawnCount++;return launch(r);}}};
 hosted=apply(ctx,{dataDir:path.join(root,'host-state')});const signal=new AbortController().signal;
 const hostInvite=(await rpc('invite',{sessionId:agent.id},signal)).value,response=path.join(cwd,'mcp-response.json');fs.writeFileSync(response,JSON.stringify({label:'HTTP回传MCP端',definition:definition('http-client')}));
 const client=await promisify(execFile)(process.execPath,[path.resolve('lib/invite-client.mjs'),'--invitation',hostInvite.file,'--response',response],{windowsHide:true,timeout:30000});assert.match(client.stdout,/MCP握手、工具发现和任务映射/);const snapshot=(await rpc('snapshot',{sessionId:agent.id},signal)).value;assert.equal(snapshot.invitation.state,'connected');const hostId=snapshot.endpoints[0].id;
 assert.equal((await ctx.registered.get('coordinator_control').execute({action:'connect',id:hostId},{agent,signal})).connected,true);assert.equal(ctx.registered.size,7);
 denied=true;const before=spawnCount;const refusal=await rpc('endpoint-connect',{sessionId:agent.id,endpointId:hostId},signal);assert.equal(refusal.value.connected,false);assert.match(refusal.value.connection.error,/宿主拒绝/);assert.equal(spawnCount,before);
 assert.equal(children.every(c=>c.exitCode!==null||c.signalCode!==null),true);
 const result={passed:true,version:engine.public(a).version,registrationToolCalls:0,coverage:['MCP stdio初始化/initialized/分页工具发现','无工具调用登记及Agent映射补救','ACP失败转为实际MCP验证','真实任务生成文件并经审查通过','模型/思考映射与默认参数省略','JSON Schema输入/输出验证','工具漂移阻断并失效连接','协议/能力/重复/游标/异步task失败','roots服务与拒绝sampling','暂停超时清理','真实HTTP客户端与宿主沙箱不绕过'],root};fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{
 invitations.close();await engine.close();for(const cleanup of effects)await cleanup();if(server)await new Promise(r=>server.close(r));for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill();
}
