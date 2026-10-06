import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import express from 'express';
import {WebSocketServer} from 'ws';
import {Server,ServerCredentials} from '@grpc/grpc-js';
import {AgentCard,Task,TaskState} from '@a2a-js/sdk';
import {DefaultRequestHandler,InMemoryTaskStore,AgentEvent} from '@a2a-js/sdk/server';
import {jsonRpcHandler,restHandler,UserBuilder} from '@a2a-js/sdk/server/express';
import {grpcService,A2AService} from '@a2a-js/sdk/server/grpc';
import {Coordinator} from '../lib/engine.js';
import {Invitations} from '../lib/onboarding.js';
import {runHarness,probeHarness} from '../lib/runner.js';
import {validateServer} from '../lib/bridges.js';
import {deliver} from '../lib/delivery.js';
import {confinedFetch} from '../lib/network.js';

const root=path.resolve('test-data','mainstream-'+Date.now()),cwd=path.join(root,'中文工作目录');fs.mkdirSync(cwd,{recursive:true});
const pythonModules=path.join(root,'python-modules');fs.mkdirSync(pythonModules);fs.copyFileSync('test/claude-python-fixture.py',path.join(pythonModules,'claude_agent_sdk.py'));
const children=[],calls=[],host={launch:r=>{
 const child=spawn(r.argv[0],r.argv.slice(1),{cwd:r.cwd,env:{...process.env,...r.env,...(r.endpoint.sdk?.language==='python'?{PYTHONPATH:pythonModules}:{})},stdio:'pipe',windowsHide:true});children.push(child);
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(exitCode,signal)=>resolve({exitCode,signal}));});
 const abort=()=>child.kill();r.signal.addEventListener('abort',abort,{once:true});done.finally(()=>r.signal.removeEventListener('abort',abort)).catch(()=>{});
 return {stdin:child.stdin,stdout:child.stdout,stderr:child.stderr,done,stop:async()=>{if(child.exitCode===null)child.kill();await done;}};
}};
const actor={id:'bridge-owner',cwd},engine=new Coordinator({dir:path.join(root,'state'),run:r=>runHarness(host,r),probe:r=>probeHarness(host,r)});
const req=(endpoint,probeOnly=false,extra={})=>({endpoint,cwd,owner:actor.id,probeOnly,prompt:'隔离测试，交付delivery.md',task:{timeoutMs:10000,outputs:['delivery.md']},signal:new AbortController().signal,...extra});
const fixture=path.resolve('test/native-fixture.mjs'),base=(id,protocol,extra={})=>({id,label:id,protocol,command:process.execPath,args:[fixture,protocol],...extra});
async function connect(e){engine.endpoint(actor,e);const result=await engine.connectEndpoint(actor,e.id);assert.equal(result.connected,true,result.connection.error);return engine.state.endpoints[e.id];}
let server,grpcServer,wsServer;
try{
 const native=await connect(base('native','codex',{args:[fixture,'codex'],capabilities:{modelSelection:true,reasoningSelection:true}}));
 let log=fs.readFileSync(path.join(cwd,'native-messages.jsonl'),'utf8');assert(!log.includes('turn/start'));assert(!log.includes('thread/start'));
 let result=await runHarness(host,req(native));assert.equal(result.ok,true);assert.match(result.output,/native fixture/);
 assert.equal((await runHarness(host,req({...native,args:[fixture,'codex-fail']}))).ok,false);
 const cli=await connect(base('cli','cli',{args:[fixture,'cli-normal'],probe_args:[fixture,'--version'],cli:{preset:'codex',format:'ndjson'}}));
 assert.equal((await runHarness(host,req(cli))).ok,true);
 assert.equal((await runHarness(host,req({...cli,args:[fixture,'cli-fail']}))).ok,false);
 assert.equal((await runHarness(host,req({...cli,args:[fixture,'cli-missing']}))).ok,false);
 assert.equal((await runHarness(host,req({...cli,args:[fixture,'cli-json'],cli:{preset:'claude',format:'json'}}))).ok,true);
 assert.equal((await runHarness(host,req({...cli,cli:{preset:'generic',format:'ndjson',successField:'type',successValue:'turn.completed'}}))).ok,true);
 assert.equal((await runHarness(host,req({...cli,cli:{preset:'generic',format:'ndjson',successField:'constructor.name',successValue:'Object'}}))).ok,false);
 const sdk=await connect(base('sdk','claude-sdk',{args:[],sdk:{language:'node',module:path.resolve('test/claude-sdk-fixture.mjs')}}));
 assert.equal(fs.existsSync(path.join(cwd,'sdk-prompts.jsonl')),false);assert.equal((await runHarness(host,req(sdk))).ok,true);
 assert.match(fs.readFileSync(path.join(cwd,'delivery.md'),'utf8'),/Claude SDK/);
 const python=process.env.COORDINATOR_TEST_PYTHON;
 if(python){const endpoint=await connect(base('python-sdk','claude-sdk',{command:python,args:[],sdk:{language:'python'}}));assert.equal(fs.existsSync(path.join(cwd,'python-prompts.jsonl')),false);assert.equal((await runHarness(host,req(endpoint))).ok,true);assert.match(fs.readFileSync(path.join(cwd,'delivery.md'),'utf8'),/Python SDK/);}

 // Official A2A SDK server on all three transports, no model backend involved.
 const app=express();app.use(express.json());app.use((request,_response,next)=>{if(request.body?.method)calls.push('rpc-'+request.body.method);next();});server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
 grpcServer=new Server();const grpcPort=await new Promise((resolve,reject)=>grpcServer.bindAsync('127.0.0.1:0',ServerCredentials.createInsecure(),(e,p)=>e?reject(e):resolve(p)));
 const card=AgentCard.fromJSON({name:'isolated agent',version:'1.0',description:'fixture',supportedInterfaces:[{url:url+'/a2a',protocolBinding:'JSONRPC',protocolVersion:'1.0'},{url:url+'/rest',protocolBinding:'HTTP+JSON',protocolVersion:'1.0'},{url:'http://127.0.0.1:'+grpcPort,protocolBinding:'GRPC',protocolVersion:'1.0'}],capabilities:{},defaultInputModes:['text/plain'],defaultOutputModes:['text/plain'],skills:[]});
 const handler=new DefaultRequestHandler(card,new InMemoryTaskStore(),{execute:async(context,bus)=>{calls.push('a2a-send');const prompt=context.userMessage.parts[0].content.value,state=prompt.includes('wait')?'TASK_STATE_WORKING':prompt.includes('fail')?'TASK_STATE_FAILED':'TASK_STATE_COMPLETED';bus.publish(AgentEvent.task(Task.fromJSON({id:context.taskId,contextId:context.contextId,status:{state},artifacts:prompt.includes('missing')?[]:[{artifactId:'delivery',name:'delivery.md',parts:[{text:'A2A真实交付'}]}]})));},cancelTask:async(id,bus)=>{calls.push('a2a-cancel');bus.publish(AgentEvent.statusUpdate({taskId:id,contextId:'fixture',status:{state:TaskState.TASK_STATE_CANCELED},final:true}));}},undefined,undefined,undefined,undefined,undefined,{keepBusAliveStates:[TaskState.TASK_STATE_WORKING]});
 app.get('/.well-known/agent-card.json',(_req,res)=>{calls.push('agent-card');res.json(AgentCard.toJSON(card));});
 app.use('/a2a',jsonRpcHandler({requestHandler:handler,userBuilder:UserBuilder.noAuthentication}));app.use('/rest',restHandler({requestHandler:handler,userBuilder:UserBuilder.noAuthentication}));grpcServer.addService(A2AService,grpcService({requestHandler:handler,userBuilder:UserBuilder.noAuthentication}));
 for(const transport of ['JSONRPC','HTTP+JSON','GRPC']){
  const before=calls.filter(c=>c==='a2a-send').length;const endpoint=await connect(base('a2a-'+transport.replace(/[^A-Za-z]/g,''),'a2a',{server:{url,transport,...(transport==='GRPC'?{interfaceUrl:'http://127.0.0.1:'+grpcPort}:{})}}));assert.equal(calls.filter(c=>c==='a2a-send').length,before);
  const r=await runHarness(host,req(endpoint));assert.equal(r.ok,true,JSON.stringify(r));assert.equal(fs.readFileSync(path.join(cwd,'delivery.md'),'utf8'),'A2A真实交付');
 }
 const a2a=engine.state.endpoints['a2a-JSONRPC'];assert.equal((await runHarness(host,req(a2a,false,{prompt:'fail'}))).ok,false);
 await assert.rejects(runHarness(host,req(a2a,false,{prompt:'missing'})),/实际交付/);
 const beforeWait=calls.filter(c=>c==='a2a-send').length,controller=new AbortController(),waiting=runHarness(host,req(a2a,false,{prompt:'wait',signal:controller.signal}));
 for(let i=0;i<300&&calls.filter(c=>c==='a2a-send').length===beforeWait;i++)await new Promise(resolve=>setTimeout(resolve,10));
 await new Promise(resolve=>setTimeout(resolve,150));controller.abort(Error('fixture cancel'));await assert.rejects(waiting,/fixture cancel/);assert(calls.includes('a2a-cancel'),JSON.stringify(calls.slice(-18)));
 card.supportedInterfaces.push({url:url+'/a2a-legacy',protocolBinding:'JSONRPC',protocolVersion:'0.3'});
 app.get('/legacy-card',(_request,res)=>res.json({name:'legacy fixture',description:'fixture',version:'1',protocolVersion:'0.3.0',url:url+'/a2a-legacy',preferredTransport:'JSONRPC',capabilities:{},defaultInputModes:['text/plain'],defaultOutputModes:['text/plain'],skills:[]}));
 app.use('/a2a-legacy',jsonRpcHandler({requestHandler:handler,userBuilder:UserBuilder.noAuthentication,legacyCompat:{enabled:true}}));
 const legacyA2a=await connect(base('a2a-legacy','a2a',{server:{url,cardPath:'/legacy-card',legacyCompat:true,transport:'JSONRPC'}}));assert.equal((await runHarness(host,req(legacyA2a))).ok,true);
 wsServer=new WebSocketServer({server,path:'/codex'});wsServer.on('connection',socket=>socket.on('message',data=>{const m=JSON.parse(data);calls.push('ws-'+m.method);const reply=result=>socket.send(JSON.stringify({id:m.id,result}));
  if(m.method==='initialize')reply({userAgent:'fixture'});else if(m.method==='model/list')reply({data:[]});else if(m.method==='thread/start')reply({thread:{id:'ws-thread'}});else if(m.method==='turn/start'){fs.writeFileSync(path.join(cwd,'delivery.md'),'Codex WS交付');reply({turn:{id:'ws-turn'}});socket.send(JSON.stringify({method:'turn/completed',params:{threadId:'ws-thread',turn:{id:'ws-turn',status:'completed'}}}));}}));
 const codexWs=await connect(base('codex-ws','codex',{server:{url:url.replace('http:','ws:')+'/codex'}}));assert.equal(calls.includes('ws-turn/start'),false);assert.equal((await runHarness(host,req(codexWs))).ok,true);

 app.get('/global/health',(_req,res)=>{calls.push('health');res.json({healthy:true,version:'fixture'});});
 app.get('/config/providers',(_req,res)=>res.json({providers:[{id:'fixture',models:{model:{}}}],default:{fixture:'model'}}));
 app.post('/session',(_req,res)=>{calls.push('opencode-session');res.json({id:'session-fixture'});});
 app.post('/session/:id/message',(request,res)=>{calls.push('opencode-message');res.json({info:{role:'assistant',time:{completed:1},finish:'stop'},parts:[{type:'text',text:request.body.parts[0].text}]});});
 app.get('/file/content',(request,res)=>{assert.equal(request.query.path,'delivery.md');res.json({type:'text',content:'OpenCode远端实际文件'});});
 const opencode=await connect(base('opencode','opencode',{server:{url}}));assert.equal(calls.includes('opencode-session'),false);assert.equal((await runHarness(host,req(opencode))).ok,true);
 assert.equal(fs.readFileSync(path.join(cwd,'delivery.md'),'utf8'),'OpenCode远端实际文件');

 const tool={name:'delegate',inputSchema:{type:'object',properties:{prompt:{type:'string'}},required:['prompt']}};
 const mcpHandler=(request,res)=>{const m=request.body;calls.push(m.method);if(m.id===undefined){res.status(202).end();return;}
  let value;if(m.method==='server/discover')value={resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{tools:{}},_meta:{'io.modelcontextprotocol/serverInfo':{name:'fixture',version:'1'}},ttlMs:0,cacheScope:'public'};
  else if(m.method==='initialize')value={protocolVersion:'2025-11-25',serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{}}};
  else if(m.method==='tools/list')value={tools:[tool],resultType:'complete'};
  else if(m.method==='tools/call')value={resultType:'complete',content:[{type:'text',text:'fixture delivered'}],structuredContent:{files:[{path:'delivery.md',text:'MCP网络真实交付'}]}};
  else {res.json({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'unsupported'}});return;}res.json({jsonrpc:'2.0',id:m.id,result:value});};
 app.post('/mcp',mcpHandler);app.get('/mcp',(_req,res)=>res.status(405).end());
 const secret='isolated-fixture-token-not-a-real-credential';process.env.COORDINATOR_BRIDGE_TEST_TOKEN=secret;
 app.post('/mcp-auth',(request,res)=>{assert.equal(request.headers.authorization,'Bearer '+secret);if(request.body.method==='initialize'){res.json({jsonrpc:'2.0',id:request.body.id,result:{protocolVersion:'2025-11-25',serverInfo:{name:secret,version:'1'},capabilities:{tools:{}}}});}else mcpHandler(request,res);});
 const authEndpoint=await connect(base('mcp-auth','mcp',{server:{url:url+'/mcp-auth',auth:{bearerEnv:'COORDINATOR_BRIDGE_TEST_TOKEN'}},mcp:{transport:'streamable-http',tool:'delegate',arguments:{prompt:'{prompt}'},deliveryField:'files'}}));assert(!JSON.stringify(authEndpoint).includes(secret));assert.equal((await runHarness(host,req(authEndpoint))).ok,true);assert(!fs.readFileSync(engine.file,'utf8').includes(secret));delete process.env.COORDINATOR_BRIDGE_TEST_TOKEN;
 app.post('/mcp-version-error',(request,res)=>res.status(400).json({jsonrpc:'2.0',id:request.body.id,error:{code:-32022,message:'modern incompatible',data:{supported:['future-version']}}}));
 engine.endpoint(actor,base('mcp-version-error','mcp',{server:{url:url+'/mcp-version-error'},mcp:{transport:'streamable-http',era:'auto',tool:'delegate',arguments:{prompt:'{prompt}'}}}));const rejectedVersion=await engine.connectEndpoint(actor,'mcp-version-error');assert.equal(rejectedVersion.connected,false);assert.match(rejectedVersion.connection.error,/不能降级/);
 for(const era of ['legacy','auto','modern']){
  const before=calls.filter(c=>c==='tools/call').length;const endpoint=await connect(base('mcp-'+era,'mcp',{server:{url:url+'/mcp'},mcp:{transport:'streamable-http',era,tool:'delegate',arguments:{prompt:'{prompt}'},deliveryField:'files'}}));assert.equal(calls.filter(c=>c==='tools/call').length,before);
  const r=await runHarness(host,req(endpoint));assert.equal(r.ok,true);assert.equal(fs.readFileSync(path.join(cwd,'delivery.md'),'utf8'),'MCP网络真实交付');
 }
 let stream;app.get('/sse',(_request,res)=>{stream=res;res.setHeader('content-type','text/event-stream');res.write('event: endpoint\ndata: /sse-messages\n\n');});
 app.post('/sse-messages',(request,res)=>{mcpHandler(request,{json:m=>{stream.write('event: message\ndata: '+JSON.stringify(m)+'\n\n');res.status(202).end();},status:status=>res.status(status)});});
 const sse=await connect(base('mcp-sse','mcp',{server:{url:url+'/sse'},mcp:{transport:'sse',tool:'delegate',arguments:{prompt:'{prompt}'},deliveryField:'files'}}));assert.equal((await runHarness(host,req(sse))).ok,true);
 const modernFixture=path.resolve('test/modern-mcp-fixture.mjs');
 for(const mode of ['modern','legacy','unsupported','input']){
  const e=base('modern-'+mode,'mcp',{args:[modernFixture,mode],mcp:{transport:'stdio',era:'auto',tool:'delegate',arguments:{prompt:'{prompt}'}}});engine.endpoint(actor,e);const connection=await engine.connectEndpoint(actor,e.id);
  assert.equal(connection.connected,mode!=='unsupported');if(mode==='unsupported')continue;
  if(mode==='input')await assert.rejects(runHarness(host,req(engine.state.endpoints[e.id])),/额外输入/);else assert.equal((await runHarness(host,req(engine.state.endpoints[e.id]))).ok,true);
 }
 const modernLog=fs.readFileSync(path.join(cwd,'modern-messages.jsonl'),'utf8');assert(modernLog.includes('io.modelcontextprotocol/protocolVersion'));
 const invitations=new Invitations(engine),invitation=invitations.create(actor,'http://127.0.0.1:32180'),token=JSON.parse(fs.readFileSync(invitation.file)).token;
 const reply=await invitations.submit(token,{label:'自动登记OpenCode',definition:{protocol:'opencode',server:{url}}});assert.equal(reply.connected,true);invitations.close();
 // A fresh session must see shared candidates; revocation also takes effect at dispatch.
 assert(engine.public({id:'new-session'}).endpoints.some(e=>e.id==='native'));
 engine.prefs(actor,{sharePolicy:'session'});assert.equal(engine.public({id:'new-session'}).endpoints.length,0);
 const consumer={id:'consumer',cwd};engine.session(consumer,true).paused=true;engine.prefs(actor,{sharePolicy:'all'});
 engine.plan(consumer,{title:'排队后撤销共享',tasks:[{id:'revoked',title:'撤销',prompt:'fixture',endpoint:'native',outputs:['revoked.md'],criteria:['实际交付'],reason:'授权测试'}]});engine.prefs(actor,{sharePolicy:'session'});engine.start(engine.state.sessions.consumer,engine.state.sessions.consumer.tasks[0]);assert.equal(engine.state.sessions.consumer.tasks[0].status,'blocked');
 assert.throws(()=>validateServer({url:'http://example.com'}),/TLS/);assert.throws(()=>validateServer({url:url,auth:{token:'secret'}}),/环境变量/);
 assert.throws(()=>deliver(cwd,['delivery.md'],[]),/实际交付/);assert.throws(()=>deliver(cwd,['delivery.md'],[{path:'../outside',text:'evil'}]),/未声明/);
 const fetcher=confinedFetch({url},new AbortController().signal);await assert.rejects(fetcher('http://example.com'),/超出/);
 const beforeDenied=calls.length;await assert.rejects(runHarness({launch:async()=>{throw Error('fixture host sandbox denied');}},req(opencode)),/sandbox denied/);assert.equal(calls.length,beforeDenied);
 console.log(JSON.stringify({passed:true,pythonSdk:python?'passed':'skipped: set COORDINATOR_TEST_PYTHON',coverage:['Codex stdio/WebSocket及提前完成事件关联','结构化CLI成功/失败/缺终态','Claude SDK无任务初始化及交付','官方A2A SDK JSONRPC/REST/gRPC互通、失败及取消','OpenCode元数据和远端文件','MCP Streamable HTTP/SSE、legacy及现代stdio','现代MCP失败不伪装legacy与额外输入拒绝','邀请自动协议检查','新会话共享候选与排队后撤销','越界及缺失远端交付拒绝'],root},null,2));
}finally{await engine.close();for(const child of children)if(child.exitCode===null)child.kill();for(const socket of wsServer?.clients||[])socket.terminate();wsServer?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));if(grpcServer)grpcServer.forceShutdown();}
