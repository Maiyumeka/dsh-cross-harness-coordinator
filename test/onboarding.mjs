import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {apply} from '../lib/index.js';
import {Coordinator} from '../lib/engine.js';
import {Invitations} from '../lib/onboarding.js';
import {probeHarness} from '../lib/runner.js';

const root=path.resolve('test-data','onboarding-'+Date.now()),cwd=path.join(root,'workspace');fs.mkdirSync(cwd,{recursive:true});
const fixture=path.resolve('test/acp-fixture.mjs'),effects=[],tools=new Map(),notifications=[],children=[];
let handler,rpc,denied=false,confinements=0,spawnCount=0;
const session={id:'owner',header:{cwd}},agent={id:session.id,session};
const launch=request=>{
 spawnCount++;const child=spawn(request.argv[0],request.argv.slice(1),{cwd:request.cwd,env:{...process.env,...request.env},windowsHide:true,stdio:'pipe'});children.push(child);
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(exitCode,signal)=>resolve({exitCode,signal}));});
 const abort=()=>child.kill();request.signal.addEventListener('abort',abort,{once:true});
 done.finally(()=>request.signal.removeEventListener('abort',abort)).catch(()=>{});
 return {stdin:child.stdin,stdout:child.stdout,stderr:child.stderr,done,terminate:()=>child.kill(),waitForExit:()=>done,stop:async()=>{child.kill();await done;}};
};
const server=http.createServer((req,res)=>{void handler(req,res);});await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const ctx={agents:{get:id=>id===agent.id?agent:undefined},sessions:{get:id=>id===session.id?session:undefined},sessionController:{prompt:async value=>{notifications.push(value);}},tools:{register:t=>{tools.set(t.name,t);return()=>tools.delete(t.name);}},systemPrompt:{section:()=>()=>{}},connection:{register:(_owner,_channel,fn)=>{rpc=fn;}},webServer:{port,register:value=>{handler=value.handler;return()=>{};}},on:()=>()=>{},effect:fn=>effects.push(fn()),sandboxPolicy:{resolve:()=>({mode:'workspace-write'})},sandbox:{confine:async argv=>{confinements++;if(denied)throw Error('隔离测试：宿主拒绝启动');return {argv};}},subprocess:{spawn:launch}};
const engine=apply(ctx,{dataDir:path.join(root,'state')});const signal=new AbortController().signal;
const definition=(name,mode='normal')=>({protocol:'acp',command:process.execPath,args:[fixture,name+'.jsonl',mode]});
const invite=async()=>{const r=await rpc('invite',{sessionId:session.id},signal);assert.equal(r.ok,true);return {...r.value,private:JSON.parse(fs.readFileSync(r.value.file))};};
const submit=async(v,def)=>{const r=await fetch(v.private.url,{method:'POST',headers:{host:'127.0.0.1:'+port,'x-coordinator-invite':v.private.token},body:JSON.stringify({label:'隔离ACP验证端',version:'fixture-1',definition:def})});return {status:r.status,value:await r.json()};};
const methods=name=>fs.readFileSync(path.join(cwd,name+'.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
try{
 assert.equal(tools.size,7);
 const v=await invite(),r=await submit(v,definition('ready','close'));assert.equal(r.status,202);assert.equal(r.value.connected,true);assert.equal(r.value.connection.state,'ready');
 assert.deepEqual(methods('ready').map(m=>m.method),['initialize','session/new','session/close']);assert.equal(fs.existsSync(path.join(cwd,'ready.jsonl.MODEL_PROMPT')),false);assert.equal(fs.existsSync(v.file),false);
 assert.equal((await submit(v,definition('used'))).status,400);assert.equal((await rpc('snapshot',{sessionId:session.id},signal)).value.invitation.state,'connected');
 // Registered data cannot forge a handshake result; failed endpoints cannot be planned.
 const bad=await invite(),failed=await submit(bad,{...definition('bad','version2'),connection:{state:'ready'}});assert.equal(failed.value.registered,true);assert.equal(failed.value.connected,false);assert.equal(failed.value.connection.state,'needs_agent');assert.match(failed.value.error,/版本不兼容/);assert.equal(failed.value.fallback.retryAllowed,true);assert.equal(fs.existsSync(bad.file),true);
 const task={id:'blocked',title:'不可派发',prompt:'不应执行',endpoint:failed.value.endpointId,outputs:['blocked.txt'],criteria:['不会执行'],reason:'检查门控'};
 assert.throws(()=>engine.plan({id:session.id,cwd},{title:'不可派发',tasks:[task]}),/ACP连接尚未验证/);
 assert.equal((await submit(bad,{protocol:'text',command:process.execPath,args:[]})).status,400);
 const fixed=await submit(bad,definition('fixed'));assert.equal(fixed.value.connected,true);assert.equal(fixed.value.endpointId,failed.value.endpointId);assert.equal(fs.existsSync(bad.file),false);assert.equal((await submit(bad,definition('again'))).status,400);
 // Only the registering session can diagnose/retry an endpoint, including with corrected data.
 await assert.rejects(()=>engine.connectEndpoint({id:'outsider',cwd},failed.value.endpointId),/会话|登记/);
 const control=tools.get('coordinator_control');const check=await control.execute({action:'connect',id:failed.value.endpointId},{agent,signal});assert.equal(check.connected,true);
 await assert.rejects(()=>control.execute({action:'connect',id:failed.value.endpointId,definition:JSON.stringify({connection:{state:'ready'}})},{agent,signal}),/调用定义/);
 for(const [mode,expected]of [['auth',/auth_required/],['missing-session',/sessionId/],['permission',/权限/]]){
  const i=await invite(),failure=await submit(i,definition(mode,mode));assert.equal(failure.value.connected,false);assert.match(failure.value.error,expected);assert.equal(failure.value.connection.stage,'session/new');assert.equal(fs.existsSync(path.join(cwd,mode+'.jsonl.MODEL_PROMPT')),false);
  if(mode==='permission')assert.deepEqual(methods(mode).find(m=>m.id===900).result,{outcome:{outcome:'cancelled'}});
 }
 // The host's confinement is used for every probe, with no fallback spawn on rejection.
 denied=true;const before=spawnCount,restricted=await invite(),refusal=await submit(restricted,definition('refusal'));assert.equal(refusal.value.connected,false);assert.match(refusal.value.error,/宿主拒绝/);assert.equal(spawnCount,before);denied=false;
 assert.equal(notifications.some(n=>n.content[0].text.includes('ACP连接验证失败')),true);
 const retry=await control.execute({action:'connect',id:refusal.value.endpointId,definition:JSON.stringify({args:definition('agent-fixed').args})},{agent,signal});assert.equal(retry.connected,true);assert.equal((await rpc('snapshot',{sessionId:session.id},signal)).value.invitation.state,'connected');assert.equal(fs.existsSync(restricted.file),false);
 // One automatic attempt plus one correction, then no unbounded onboarding retry.
 const limit=await invite();assert.equal((await submit(limit,definition('limit1','auth'))).value.connected,false);const second=await submit(limit,definition('limit2','auth'));assert.equal(second.value.fallback.retryAllowed,false);assert.equal((await submit(limit,definition('limit3'))).status,400);
 // In-flight invitations are reserved, cannot be removed/replaced, and cancel stops the child.
 const slow=await invite(),pending=submit(slow,definition('slow','silent'));for(let i=0;i<100&&!engine.connecting.size;i++)await new Promise(r=>setTimeout(r,10));assert.equal(engine.connecting.size,1);
 assert.equal((await submit(slow,definition('duplicate'))).status,400);assert.throws(()=>engine.removeEndpoint({id:session.id},'h_'+slow.id.slice(0,12)),/检查/);
 await rpc('reject',{sessionId:session.id},signal);const cancelled=await pending;assert.equal(cancelled.value.connected,false);assert.match(cancelled.value.error,/取消/);assert.equal(engine.connecting.size,0);
 // Timeout uses a real fixture process and releases it without submitting a prompt.
 const timed=launch({argv:[process.execPath,fixture,'timeout.jsonl','silent'],cwd,env:{},signal});
 await assert.rejects(()=>probeHarness({launch:async()=>timed},{endpoint:{...definition('timeout','silent'),args:[]},cwd,signal:new AbortController().signal,task:{}}).then(()=>{}),/超时/);
 // Legacy disk registration is not upgraded to a handshake pass, and restart does not launch it.
 const legacyDir=path.join(root,'legacy');fs.mkdirSync(legacyDir);fs.writeFileSync(path.join(legacyDir,'state.json'),JSON.stringify({schema:1,sessions:{},endpoints:{old:{id:'old',protocol:'acp',confirmed:true}},events:[]}));const legacy=new Coordinator({dir:legacyDir,run:()=>{throw Error('不能启动');}});assert.equal(legacy.state.endpoints.old.connection.state,'unverified');await legacy.close();
 assert.equal(confinements>0,true);assert.equal(children.every(c=>c.exitCode!==null||c.signalCode!==null),true);
 fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({passed:true,modelPrompts:0,coverage:['真实HTTP回传自动ACP握手','协议与sessionId验证','可选session/close','失败门控与一次修正','当前Agent连接工具与归属校验','权限拒绝不绕过宿主','邀请并发与取消','超时退出','旧登记保持未验证'],root},null,2));
 console.log(fs.readFileSync(path.join(root,'result.json'),'utf8'));
}finally{
 for(const cleanup of effects)await cleanup();await new Promise(r=>server.close(r));
 for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill();
}
