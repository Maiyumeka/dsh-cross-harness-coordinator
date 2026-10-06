import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {probeHarness} from '../lib/runner.js';
import {Coordinator} from '../lib/engine.js';
import {Invitations} from '../lib/onboarding.js';
import {validateMcpDefinition} from '../lib/mcp.js';
import {runMcp} from '../lib/mcp.js';
const root=path.resolve('test-data','mcp-negotiation-'+Date.now());fs.mkdirSync(root,{recursive:true});
const children=[],launched=[];let refuseSecond=false,abortSecond;
const launch=request=>{
 launched.push(request);if(refuseSecond&&launched.length===2)throw Error('host rejected new connection');
 const p=spawn(request.argv[0],request.argv.slice(1),{cwd:request.cwd,stdio:'pipe',windowsHide:true}),done=new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',(exitCode,signal)=>resolve({exitCode,signal}));});children.push(p);
 const abort=()=>p.kill();request.signal.addEventListener('abort',abort,{once:true});done.finally(()=>request.signal.removeEventListener('abort',abort)).catch(()=>{});if(abortSecond&&launched.length===2)abortSecond.abort(Error('cancel during reconnect'));
 return {stdin:p.stdin,stdout:p.stdout,stderr:p.stderr,done,stop:async()=>{if(p.exitCode===null&&p.signalCode===null)p.kill();await done;}};
};
const actor={id:'owner',cwd:root},fixture=path.resolve('test/mcp-negotiation-fixture.mjs'),definition=(id,mode='polluted',era='auto')=>({id,label:id,protocol:'mcp',command:process.execPath,args:[fixture,mode,id+'.jsonl'],mcp:{transport:'stdio',era,tool:'messages_send',arguments:{message:'{prompt}',key:'agent:main:main'}}});
const request=e=>({endpoint:e,cwd:root,owner:actor.id,signal:new AbortController().signal}),messages=id=>fs.readFileSync(path.join(root,id+'.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
const engine=new Coordinator({dir:path.join(root,'state'),run:()=>{throw Error('no model tasks');},probe:r=>probeHarness({launch},r)}),invitations=new Invitations(engine);
try{
 assert.throws(()=>validateMcpDefinition({era:'2025-06-18'}),/日期.*不是era/);assert.equal(validateMcpDefinition({era:'legacy'}).era,'legacy');
 for(const mode of ['polluted','silent']){
  launched.length=0;const id=mode,e=definition(id,mode);engine.endpoint(actor,e);const result=await engine.connectEndpoint(actor,id);assert.equal(result.connected,true,result.connection.error);assert.equal(result.connection.protocolVersion,'2025-06-18');assert.equal(launched.length,2);
  const lines=messages(id),discovery=lines.find(m=>m.method==='server/discover'),initialization=lines.find(m=>m.method==='initialize');assert.notEqual(discovery.pid,initialization.pid);assert(!initialization.params._meta);assert.equal(result.connection.negotiationAttempts.length,2);assert.equal(result.connection.negotiationAttempts[0].ok,false);assert.equal(result.connection.negotiationAttempts[1].ok,true);assert.equal(lines.some(m=>m.method==='tools/call'),false);
  assert.equal(result.connection.diagnostics.requestedEra,'auto');assert.equal(result.connection.diagnostics.fallbackDecision.attempted,true);assert.equal(result.connection.diagnostics.abortSource,'none');assert(result.connection.diagnostics.connectionBudgetMs>0&&result.connection.diagnostics.connectionBudgetMs<=15000);
 }
 // A server needing more than the old 1.5s allowance must report its actual discover response.
 launched.length=0;const slow=definition('slow-start');slow.args.push('2100');const boot=await runMcp({launch},{...request(slow),task:{timeoutMs:12000},prompt:'',probeOnly:true});assert.equal(boot.protocolVersion,'2025-06-18');assert.equal(boot.negotiationAttempts[0].kind,'rpc_error');assert.equal(boot.negotiationAttempts[0].rpcError.code,-32601);assert.equal(launched.length,2);assert.equal(messages('slow-start').some(m=>m.method==='tools/call'),false);
 launched.length=0;engine.endpoint(actor,definition('strict','polluted','modern'));const strict=await engine.connectEndpoint(actor,'strict');assert.equal(strict.connected,false);assert.equal(strict.connection.stage,'server/discover');assert.equal(launched.length,1);assert.equal(messages('strict').some(m=>m.method==='initialize'),false);
 assert.equal(strict.connection.diagnostics.requestedEra,'modern');assert.equal(strict.connection.diagnostics.fallbackDecision.reason,'explicit_modern');
 launched.length=0;engine.endpoint(actor,definition('known-modern','modern-unsupported'));const known=await engine.connectEndpoint(actor,'known-modern');assert.equal(known.connected,false);assert.match(known.connection.error,/不能降级/);assert.equal(launched.length,1);assert.equal(messages('known-modern').some(m=>m.method==='initialize'),false);
 assert.equal(known.connection.diagnostics.fallbackDecision.reason,'modern_version_error');
 engine.endpoint(actor,definition('both-fail','legacy-failure'));const failure=await engine.connectEndpoint(actor,'both-fail');assert.equal(failure.connected,false);assert.equal(failure.connection.stage,'initialize');assert.deepEqual(failure.connection.negotiationAttempts.map(a=>({era:a.era,code:a.rpcError.code})),[{era:'modern',code:-32601},{era:'legacy',code:-32002}]);
 launched.length=0;refuseSecond=true;await assert.rejects(probeHarness({launch},request(definition('host-refusal'))),/host rejected/);refuseSecond=false;assert.equal(launched.length,2);
 launched.length=0;abortSecond=new AbortController();await assert.rejects(probeHarness({launch},{...request(definition('abort')),signal:abortSecond.signal}),/cancel during reconnect/);abortSecond=undefined;
 // Exhausted invitations direct the owner to connect without renewing the token.
 const visible=invitations.create(actor,'http://127.0.0.1:32180'),token=JSON.parse(fs.readFileSync(visible.file)).token;
 const first=await invitations.submit(token,{label:'strict gateway',definition:definition('invite-1','polluted','modern')});assert.equal(first.connected,false);assert.equal(first.fallback.retryAllowed,true);
 const second=await invitations.submit(token,{label:'strict gateway',definition:definition('invite-2','polluted','modern')});assert.equal(second.connected,false);assert.equal(second.fallback.retryAllowed,false);assert.equal(second.fallback.action,'owner_connect_or_new_invite');assert.match(second.fallback.instruction,/不能继续提交/);
 await assert.rejects(invitations.submit(token,{label:'no third retry',definition:definition('invite-3')}),/coordinator_control action=connect/);
 const endpointId=second.endpointId;const corrected=await engine.connectEndpoint(actor,endpointId,{definition:{mcp:{...engine.state.endpoints[endpointId].mcp,era:'legacy'}}});assert.equal(corrected.connected,true);assert.equal(corrected.connection.protocolVersion,'2025-06-18');assert.equal(invitations.visible(actor.id).state,'connected');assert.equal(fs.existsSync(path.join(root,'MODEL_TASK_SUBMITTED')),false);
 engine.removeEndpoint(actor,'strict');assert(engine.state.events.some(event=>event.kind==='endpoint_removed'&&event.session===actor.id&&event.message.includes('strict')));
 assert(children.every(child=>child.exitCode!==null||child.signalCode!==null));const report={passed:true,coverage:['era模式与日期版本分开','Method not found与超时均在新受管连接降级','慢启动2.1秒网关得到真实discover响应后重连成功','实际模式与禁止降级原因可追溯','老进程退出不影响新连接响应','legacy协商2025-06-18和工具映射','modern严格模式与现代版本拒绝不降级','两条路径错误均保留','重建连接仍由宿主启动且可拒绝或取消','邀请两次上限、耗尽提示及登记会话connect修正'],modelPrompts:0,root};fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{invitations.close();await engine.close();for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill();}
