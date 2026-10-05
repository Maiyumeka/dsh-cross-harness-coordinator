import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Coordinator} from '../lib/engine.js';
import {runHarness,probeHarness} from '../lib/runner.js';
import {Invitations} from '../lib/onboarding.js';
import {apply} from '../lib/index.js';
const root=path.resolve('test-data','run-'+Date.now()),cwd=path.join(root,'workspace');fs.mkdirSync(cwd,{recursive:true});
const fixture=fileURLToPath(new URL('./fixture.mjs',import.meta.url));
export function launch(request){const child=spawn(request.argv[0],request.argv.slice(1),{cwd:request.cwd,env:{...process.env,...request.env},windowsHide:true,stdio:'pipe'});const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(exitCode,signal)=>resolve({exitCode,signal}));});request.signal.addEventListener('abort',()=>child.kill(),{once:true});return {...Object.fromEntries(['stdin','stdout','stderr'].map(k=>[k,child[k]])),done,stop:async()=>{if(child.exitCode===null)child.kill();await done;}};}
const engine=new Coordinator({dir:path.join(root,'state'),run:r=>runHarness({launch},r),probe:r=>probeHarness({launch},r)}),a={id:'test-session',cwd};
const definition=(id,protocol,output,mode)=>({id,label:'隔离'+protocol+'测试端',protocol,command:process.execPath,args:[fixture,protocol,output,...(mode?[mode]:[])],prompt_mode:'stdin'});
engine.endpoint(a,definition('text','text','first.txt'));engine.endpoint(a,definition('acp','acp','final.txt'));await engine.connectEndpoint(a,'acp');
const tasks=[{id:'first',title:'生成初稿',prompt:'生成测试文件',endpoint:'text',outputs:['first.txt'],criteria:['真实内容存在'],reason:'验证text接口'},{id:'final',title:'整合',prompt:'生成最终测试文件',endpoint:'acp',dependencies:['first'],outputs:['final.txt'],criteria:['真实内容存在'],reason:'验证ACP接口'}];
const until=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,25));}throw Error('测试等待超时');};
const task=id=>engine.state.sessions[a.id].tasks.find(t=>t.id===id);
// 宿主对工具返回值按 output.schema:{type:'json'} 校验：JSON.stringify 会静默丢弃的
// undefined/函数/symbol 一律拒绝（“value is not lossless JSON”）。这里递归断言。
const assertJsonSafe=(value,where)=>{const seen=new WeakSet();const walk=(v,p)=>{
 if(v===undefined||typeof v==='function'||typeof v==='symbol')throw new Error(`${where} 含不可无损往返 JSON 的值：${p}（${typeof v}）`);
 if(v===null||typeof v!=='object')return;
 if(seen.has(v))throw new Error(`${where} 含循环引用：${p}`);
 seen.add(v);
 if(Array.isArray(v)){v.forEach((x,i)=>walk(x,`${p}[${i}]`));return;}
 for(const [k,x] of Object.entries(v))walk(x,`${p}.${k}`);
};walk(value,where.length?where:'(root)');};
const reviewArgs=id=>({id,revision:task(id).revision,version:task(id).result.version,verdict:'pass',checks:[{criterion:'真实内容存在',status:'pass',evidence:'读取文件，包含中文验收内容'}],note:'已核对真实文本'});
assert.throws(()=>engine.plan(a,{title:'cycle',tasks:tasks.map(t=>({...t,dependencies:[t.id]}))}),/循环/);
engine.plan(a,{title:'两个协议的隔离闭环',tasks});await until(()=>task('first').status==='awaiting_review');assert.equal(task('final').status,'queued');
engine.read(a,{id:'first',relative:'first.txt'},false);assert.throws(()=>engine.review(a,reviewArgs('first')),/需读取/);
engine.read(a,{id:'first',relative:'first.txt'});engine.review(a,reviewArgs('first'));await until(()=>task('final').status==='awaiting_review');
engine.read(a,{id:'final',relative:'final.txt'});const stale=reviewArgs('final');fs.appendFileSync(path.join(cwd,'first.txt'),'external change');assert.throws(()=>engine.review(a,stale),/前置/);
await engine.control(a,'pause');engine.rework(a,{id:'first',note:'用户要求重写前置'});assert.equal(task('final').revision,2);assert.equal(task('final').result,null);assert.ok(task('first').history.length);await engine.control(a,'resume');
await until(()=>task('first').status==='awaiting_review');engine.read(a,{id:'first',relative:'first.txt'});engine.review(a,reviewArgs('first'));await until(()=>task('final').status==='awaiting_review');assert.throws(()=>engine.review(a,stale),/旧版本/);engine.read(a,{id:'final',relative:'final.txt'});engine.review(a,reviewArgs('final'));assert.equal(task('final').status,'passed');
// 产物"缺失 / 恢复 / 真改写"三条不变量的完整回归在 test/artifact-guard.mjs（独立会话，避免与本文件中
// 已被改写为 cancelled 的任务状态互相干扰）。这里只留一句说明，不再重复。
const invitations=new Invitations(engine);const invitation=invitations.create(a,'http://127.0.0.1:32180'),privateInvite=JSON.parse(fs.readFileSync(invitation.file));await assert.rejects(()=>invitations.submit('wrong',{}),/邀请/);await assert.rejects(()=>invitations.submit(privateInvite.token,{label:'坏定义',definition:{command:'not-absolute'}}),/启动/);
// 回归：登记执行端之后，public() 曾对执行端写 fingerprints:undefined，
// 使 coordinator_candidates / coordinator_status 被宿主判为“非无损 JSON”而整体失败。
assertJsonSafe(engine.public(a),'engine.public(已有执行端)');
assert.equal(engine.public(a).endpoints.length,2);
assert.equal(engine.public(a).endpoints.every(e=>!('fingerprints' in e)),true);
// 执行端跨会话共享（用户宣言）：默认全局共享，可切回会话私有。
assert.equal(engine.prefs({id:'other-session',cwd}).sharePolicy,'all');
assert.equal(engine.prefs({id:'other-session',cwd}).declaration.source,'system');
assert.equal(engine.public({id:'other-session',cwd}).endpoints.length,2);
assert.equal(engine.public({id:'other-session',cwd}).endpoints.every(e=>e.ownerHere===false),true);
// 移除执行端：只能移除本会话登记的；仍有未终结任务引用时拒绝（已取消的不再锁住）。
const spare=engine.endpoint(a,definition('spare','text','spare.txt'));
assert.throws(()=>engine.removeEndpoint({id:'other-session',cwd},'spare'),/本会话登记/);
assert.throws(()=>engine.removeEndpoint(a,'text'),/未终结任务/);
const cancelledTask=engine.state.sessions[a.id].tasks.find(t=>t.endpoint==='text');
cancelledTask.status='cancelled';
assert.equal(engine.removeEndpoint(a,'text').remaining,2);
assert.equal(engine.state.endpoints.text,undefined);
assert.equal(engine.removeEndpoint(a,'spare').remaining,1);
assert.equal(engine.state.endpoints.spare,undefined);
assertJsonSafe(engine.prefs(a),'engine.prefs()');
assert.equal(engine.prefs(a,{sharePolicy:'session'}).sharePolicy,'session');
assert.equal(engine.public({id:'other-session',cwd}).endpoints.length,0);
assert.throws(()=>engine.plan({id:'other-session',cwd},{title:'跨会话被拒',tasks:[{...tasks[0],endpoint:'text',outputs:['x.txt']}]}),/共享|未由用户接入/);
assert.equal(engine.prefs(a,{sharePolicy:'all'}).sharePolicy,'all');
assert.equal(engine.public({id:'other-session',cwd}).endpoints.length,1);   // 此刻只有 acp（text 与 spare 已移除；回传登记发生在本行之后）
assert.equal(engine.public(a).endpoints.every(e=>e.ownerHere===true),true);
const reply=await invitations.submit(privateInvite.token,{label:'用户测试回传',definition:definition('ignored','text','first.txt')});assert.equal(reply.connected,true);assert.equal(invitations.visible(a.id).state,'connected');assertJsonSafe(engine.public(a),'engine.public(回传后)');assert.equal(engine.public(a).endpoints.length,2);await assert.rejects(()=>invitations.submit(privateInvite.token,{}),/邀请/);assert.equal(fs.existsSync(invitation.file),false);invitations.close();
engine.endpoint(a,definition('slow','text','tick.txt','slow'));engine.plan(a,{title:'暂停测试',tasks:[{...tasks[0],endpoint:'slow',outputs:['tick.txt']}]});await until(()=>fs.existsSync(path.join(cwd,'tick.txt')));await engine.control(a,'pause');assert.equal(engine.live.size,0);const before=fs.readFileSync(path.join(cwd,'tick.txt'),'utf8');await new Promise(r=>setTimeout(r,250));assert.equal(fs.readFileSync(path.join(cwd,'tick.txt'),'utf8'),before);assert.equal(task('first').status,'paused');
const restarted=new Coordinator({dir:path.join(root,'state'),run:()=>{throw Error('禁止自动启动');}});assert.equal(restarted.public(a).paused,true);assert.equal(restarted.public(a).tasks[0].status,'paused');await restarted.close();await engine.close();
// Real DSH defineTool schema validation and plugin registration, without real accounts.
const tools=new Map(),effects=[];let rpc;const agent={id:'host-session',session:{header:{cwd}}};
const ctx={agents:{get:id=>id===agent.id?agent:undefined},sessions:{get:id=>id===agent.id?agent.session:undefined},sessionController:{prompt:async()=>{}},tools:{register:t=>{tools.set(t.name,t);return()=>tools.delete(t.name);}},systemPrompt:{section:()=>()=>{}},connection:{register:(_owner,_channel,handler)=>{rpc=handler;}},webServer:{port:32180,register:()=>()=>{}},on:()=>()=>{},effect:fn=>effects.push(fn()),sandboxPolicy:{resolve:()=>({mode:'workspace-write'})},sandbox:{confine:async()=>{throw Error('模拟宿主明确拒绝执行');}},subprocess:{spawn:()=>{throw Error('不应越过宿主拒绝');}}};
const hosted=apply(ctx,{dataDir:path.join(root,'host-state')});assert.equal(tools.size,7);await assert.rejects(()=>tools.get('coordinator_status').execute({}, {agent:{...agent}}),/真实/);assert.equal((await rpc('settings-save',{concurrency:3},new AbortController().signal)).ok,true);assert.equal(hosted.concurrency,3);await assert.rejects(()=>tools.get('coordinator_plan').execute({title:'缺少参数'}, {agent}),/tasks/);
// RPC 层回归：界面走的这两条路径过去会因 index.js 未定义 requireValue 而失败
// （语法检查看不见未定义标识符，必须真的调用一次）。
const sp=hosted.endpoint({id:agent.id,cwd},definition('spare2','text','spare2.txt'));
const rpcRemoveBad=await rpc('endpoint-remove',{sessionId:agent.id},new AbortController().signal);
assert.equal(rpcRemoveBad.ok,false);assert.match(rpcRemoveBad.error.message,/缺少执行端编号/);
const rpcRemoveOk=await rpc('endpoint-remove',{sessionId:agent.id,endpointId:'spare2'},new AbortController().signal);
assert.equal(rpcRemoveOk.ok,true);assert.equal(rpcRemoveOk.value.removed,'spare2');
// 改派回归：端点坏了不必取消整条计划，rework 可直接换执行端（走界面同一条 RPC 路径）。
// 计划只能由 coordinator_plan 工具提交（RPC 层没有 plan 端点），故用工具建计划、用 RPC 改派。
hosted.endpoint({id:agent.id,cwd},definition('spare3','text','spare3.txt'));
hosted.endpoint({id:agent.id,cwd},definition('spare4','text','spare4.txt'));
await rpc('control',{sessionId:agent.id,action:'pause'},new AbortController().signal);
await tools.get('coordinator_plan').execute({title:'改派回归',tasks:JSON.stringify([{id:'repoint',title:'原端点不可用',prompt:'写文件',endpoint:'spare3',outputs:['spare3.txt'],criteria:['文件存在'],reason:'改派回归'}])},{agent});
const rpcReworkBad=await rpc('control',{sessionId:agent.id,action:'rework',id:'repoint',note:'换到不存在的端',endpoint:'nope'},new AbortController().signal);
assert.equal(rpcReworkBad.ok,false);assert.match(rpcReworkBad.error.message,/尚未由用户接入/);
const rpcRework=await rpc('control',{sessionId:agent.id,action:'rework',id:'repoint',note:'原端点不可用，改派到本会话另一个已接入的端',endpoint:'spare4'},new AbortController().signal);
assert.equal(rpcRework.ok,true);
const repointed=hosted.public({id:agent.id,cwd}).tasks.find(t=>t.id==='repoint');
assert.equal(repointed.endpoint,'spare4');assert.equal(repointed.status,'paused');
const rpcPrefs=await rpc('prefs-save',{sessionId:agent.id,sharePolicy:'session'},new AbortController().signal);
assert.equal(rpcPrefs.ok,true);assert.equal(rpcPrefs.value.sharePolicy,'session');
const rpcPrefsBad=await rpc('prefs-save',{sessionId:agent.id,sharePolicy:'nope'},new AbortController().signal);
assert.equal(rpcPrefsBad.ok,false);assert.match(rpcPrefsBad.error.message,/共享策略无效/);
// 失败建议：执行端被底层拒绝时，必须给出"该改什么"的可执行项，而不是只报一句错误。
{
  const ws=path.join(root,'remedy-ws');fs.mkdirSync(ws,{recursive:true});
  const sim=new Coordinator({dir:path.join(root,'remedy-state'),run:async()=>({ok:false,exitCode:1,output:'',stderr:'',error:'FATAL: Not inside a trusted directory and --skip-git-repo-check was not specified.'})});
  const actor2={id:'s1',cwd:ws};
  sim.endpoint(actor2,definition('e1','text','remedy.txt'));
  sim.plan(actor2,{title:'失败建议',tasks:[{id:'rt',title:'必然失败的任务',prompt:'写文件',endpoint:'e1',outputs:['remedy.txt'],criteria:['文件存在'],reason:'验证失败建议'}]});
  const t2=()=>sim.state.sessions.s1.tasks.find(t=>t.id==='rt');
  for(let i=0;i<200&&t2().status!=='failed';i++)await new Promise(r=>setTimeout(r,25));
  assert.equal(t2().status,'failed');
  assert.ok(Array.isArray(t2().remedy)&&t2().remedy.length>0,'失败任务应带可执行建议');
  assert.equal(t2().remedy.some(x=>/skip-git-repo-check/.test(x)),true,'应指出目录信任的修正参数');
  assert.equal(t2().remedy.some(x=>/rework/.test(x)),true,'应指出改派路径');
  assertJsonSafe(sim.public(actor2),'sim.public(含 remedy)');
  await sim.close();
}
const signal=new AbortController().signal;
for(const origin of ['dsh-app://app','null','https://other.example']){const r=await rpc('invite',{sessionId:agent.id,origin},signal);assert.equal(r.ok,true);assert.equal(JSON.parse(fs.readFileSync(r.value.file)).url,'http://127.0.0.1:32180/coordinator-invite/submit');}
const invalid=await rpc('settings-save',{concurrency:0},signal);assert.equal(invalid.ok,false);assert.deepEqual(invalid.error.details,{});assert.match(invalid.error.message,/并发/);
const noSession=await rpc('invite',{},signal);assert.equal(noSession.ok,false);assert.deepEqual(noSession.error.details,{});assert.match(noSession.error.message,/工作会话/);
for(const cleanup of effects)await cleanup();
console.log(JSON.stringify({passed:true,coverage:['text/ACP真实测试进程','审查前阻止下游','用户预览不算Agent阅读','旧输入/旧审查拒绝','返工联动及历史','暂停后写入停止','重启不自动执行','回传自动接入与一次性令牌','查询结果满足无损JSON（含已登记执行端）','执行端跨会话共享与用户宣言','执行端移除的权限与引用保护','RPC层移除与共享策略路径（界面真实调用）','任务改派到其他执行端（端点不可用时的恢复路径）','失败任务带可执行修复建议','DSH工具注册及结构校验'],root},null,2));
