import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {runHarness,probeHarness} from '../lib/runner.js';
import {Coordinator} from '../lib/engine.js';
import {apply} from '../lib/index.js';
import {codexApproval,recheckCodexApproval} from '../lib/codex-approval.js';
import http from 'node:http';
import {WebSocketServer} from 'ws';
const root=path.resolve('test-data','codex-approval-'+Date.now());fs.mkdirSync(root,{recursive:true});
const fixture=path.resolve('test/codex-approval-fixture.mjs'),children=[],coverage=[];
const launch=r=>{const child=spawn(r.argv[0],r.argv.slice(1),{cwd:r.cwd,env:{...process.env,...r.env},stdio:'pipe',windowsHide:true});children.push(child);const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(exitCode,signal)=>resolve({exitCode,signal}));});const abort=()=>child.kill();r.signal.addEventListener('abort',abort,{once:true});done.finally(()=>r.signal.removeEventListener('abort',abort)).catch(()=>{});return {stdin:child.stdin,stdout:child.stdout,stderr:child.stderr,done,stop:async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await done;},terminate:abort,waitForExit:()=>done};};
const endpoint=mode=>({id:'peer',label:'Codex fixture',protocol:'codex',command:process.execPath,args:[fixture,mode]});
const workspace=name=>{const cwd=path.join(root,name);fs.mkdirSync(cwd);return cwd;};
const req=(mode,cwd,extra={})=>({endpoint:endpoint(mode),cwd,owner:'owner',signal:new AbortController().signal,task:{timeoutMs:10000,outputs:['codex-probe.txt']},prompt:'交付codex-probe.txt',...extra});
const until=async predicate=>{const end=Date.now()+10000;while(!predicate()){assert(Date.now()<end,'operation did not reach expected state');await new Promise(resolve=>setTimeout(resolve,10));}};
let web,ws;
try{
 const pathCwd=workspace('paths'),outside=workspace('outside'),params={threadId:'t',turnId:'u',itemId:'i'},patch={type:'fileChange',changes:[{path:path.join(pathCwd,'a.txt'),kind:{type:'update',move_path:path.join(outside,'b.txt')},diff:'move'}]};
 assert.throws(()=>codexApproval('item/fileChange/requestApproval',params,patch,pathCwd),/超出/);patch.changes[0].kind.move_path=path.join(pathCwd,'b.txt');const approvedPatch=codexApproval('item/fileChange/requestApproval',params,patch,pathCwd);assert.equal(approvedPatch.changes[0].kind.move_path,path.join(pathCwd,'b.txt'));
 const link=path.join(pathCwd,'link');fs.symlinkSync(outside,link,'junction');assert.throws(()=>codexApproval('item/commandExecution/requestApproval',{...params,command:'write file',cwd:link},null,pathCwd),/链接超出/);
 approvedPatch.changes[0].path=path.join(link,'out.txt');assert.throws(()=>recheckCodexApproval(approvedPatch,pathCwd),/链接超出/);coverage.push('改动和移动目标都检查工作区/链接边界，批准前再次核对');
 for(const mode of ['command','file','before-ack']){
  const cwd=workspace(mode);let release,proposal;const gate=new Promise(resolve=>release=resolve);
  const running=runHarness({launch},req(mode,cwd,{requestApproval:p=>{proposal=p;return gate;}}));await until(()=>proposal);
  assert.equal(fs.existsSync(path.join(cwd,'codex-probe.txt')),false);assert.equal(proposal.threadId,'fixture-thread');assert.equal(proposal.turnId,'fixture-turn');release({decision:'accept',reason:'test user approved once'});
  const r=await running;assert.equal(r.ok,true,r.error);assert.equal(fs.readFileSync(path.join(cwd,'codex-probe.txt'),'utf8'),'OK');assert.equal(r.native.approvals[0].decision,'accept');
 }
 coverage.push('命令/文件审批批准前不写文件，accept后同一回合交付OK（2字节）','审批早于turn/start响应仍须确认真实turnId');
 const twiceCwd=workspace('twice');let count=0,releaseSecond;const second=new Promise(resolve=>releaseSecond=resolve);const twice=runHarness({launch},req('twice',twiceCwd,{requestApproval:()=>++count===1?'accept':second}));await until(()=>count===2);assert.equal(fs.existsSync(path.join(twiceCwd,'codex-probe.txt')),false);releaseSecond('cancel');const twiceResult=await twice;assert.equal(twiceResult.ok,false);assert.deepEqual(twiceResult.native.approvals.map(a=>a.decision),['accept','cancel']);coverage.push('第一次accept不批准第二次请求，不使用会话级批准');
 for(const mode of ['command','wrong-thread','wrong-turn','extra']){
  const cwd=workspace('denied-'+mode);let asked=0;const r=await runHarness({launch},req(mode,cwd,{requestApproval:()=>{asked++;return {decision:'cancel',reason:'test user declined'};}}));
  assert.equal(r.ok,false);assert.equal(fs.existsSync(path.join(cwd,'codex-probe.txt')),false);assert.equal(asked,mode==='command'?1:0);assert.match(r.error,/审批/);assert.match(r.output,/已有输出/);assert.match(r.stderr,/fixture stderr/);assert.equal(r.native.lastNotification,'item/started');
 }
 coverage.push('拒绝、跨线程/回合及额外权限均不批准，错误包含审批原因、已有输出和stderr');
 const premature=await runHarness({launch},req('exit',workspace('exit')));assert.equal(premature.ok,false);assert.match(premature.output,/已有输出/);assert.match(premature.native.commandOutput,/命令诊断/);assert.equal(premature.native.exit.exitCode,7);assert.match(premature.stderr,/fixture stderr/);coverage.push('提前退出保留输出、命令输出、stderr、阶段、最后通知和退出码');
 let probes=0;const cwdProbe=workspace('probe');const probe=await probeHarness({launch},req('probe-approval',cwdProbe,{requestApproval:()=>{probes++;return 'accept';}}));assert.equal(probe.handshakeVerified,true);assert.equal(probes,0);assert(!fs.readFileSync(path.join(cwdProbe,'codex-approval.jsonl'),'utf8').includes('turn/start'));coverage.push('登记检查不调用审批或模型任务');
 const wsCwd=workspace('websocket');let wsAsked=0,accepted=0;
 web=http.createServer();ws=new WebSocketServer({server:web});await new Promise(resolve=>web.listen(0,'127.0.0.1',resolve));
 ws.on('connection',socket=>socket.on('message',data=>{const m=JSON.parse(data),reply=result=>socket.send(JSON.stringify({id:m.id,result}));if(m.method==='initialize')reply({userAgent:'isolated WS'});else if(m.method==='model/list')reply({data:[]});else if(m.method==='thread/start')reply({thread:{id:'ws-thread'}});else if(m.method==='turn/start'){reply({turn:{id:'ws-turn'}});socket.send(JSON.stringify({id:900,method:'item/commandExecution/requestApproval',params:{threadId:'ws-thread',turnId:'ws-turn',itemId:'ws-item',command:'write declared file codex-probe.txt',cwd:wsCwd}}));}else if(m.id===900&&m.result?.decision==='accept'){accepted++;fs.writeFileSync(path.join(wsCwd,'codex-probe.txt'),'OK');socket.send(JSON.stringify({method:'turn/completed',params:{threadId:'ws-thread',turn:{id:'ws-turn',status:'completed'}}}));}}));
 const wsResult=await runHarness({launch},req('command',wsCwd,{endpoint:{...endpoint('command'),server:{url:'ws://127.0.0.1:'+web.address().port}},requestApproval:()=>{wsAsked++;return {decision:'accept',reason:'origin WS user approval'};}}));assert.equal(wsResult.ok,true,wsResult.error);assert.equal(wsAsked,1);assert.equal(accepted,1);assert.equal(fs.readFileSync(path.join(wsCwd,'codex-probe.txt'),'utf8'),'OK');coverage.push('WebSocket经受管工作进程转接同一原会话审批，只回单次accept');

 // Same host tools and approval boundary as the plugin, with a composed answerer double.
 const cwd=workspace('host'),agent={id:'owner',session:{header:{cwd}}},tools=new Map(),effects=[],rpc={};let outcome='allowed-once',asks=0;
 const ctx={tools:{register:t=>{tools.set(t.name,t);return()=>{};}},agents:{get:id=>id===agent.id?agent:null},sessions:{get:()=>agent.session},sandboxPolicy:{resolve:()=>({mode:'workspace-write',workspaceRoot:cwd})},sandbox:{confine:async argv=>({argv})},subprocess:{spawn:launch},approval:{config:{policy:'ask'},overrideOf:()=>undefined,request:async q=>{asks++;assert.equal(q.agent,agent);assert.equal(q.callId,'approval-control');assert.match(q.reason,/write declared file/);return outcome;}},systemPrompt:{section:()=>()=>{}},connection:{register:(_c,_path,handler)=>rpc.call=handler},webServer:{port:32180,register:()=>()=>{}},sessionController:{prompt:async()=>{}},on:()=>()=>{},effect:f=>effects.push(f())};
 const engine=apply(ctx,{dataDir:path.join(root,'host-state')}),actor={id:agent.id,cwd};
 const plan=async(mode,id)=>{engine.endpoint(actor,endpoint(mode));assert.equal((await engine.connectEndpoint(actor,'peer')).connected,true);engine.plan(actor,{title:id,tasks:[{id,title:id,prompt:'写入codex-probe.txt',endpoint:'peer',outputs:['codex-probe.txt'],criteria:['2字节OK'],reason:'isolated approval regression'}]});await until(()=>engine.state.sessions.owner.tasks[0].approvals?.some(a=>a.state==='pending'));return engine.state.sessions.owner.tasks[0];};
 const args=t=>{const a=t.approvals.find(a=>a.state==='pending');return {action:'approval',id:t.id,approval_id:a.id,approval_version:a.version,decision:'accept'};};
 const exec={agent,signal:new AbortController().signal,callId:'approval-control'};
 let t=await plan('command','allow'),a=args(t);
 assert.throws(()=>engine.decideApproval(actor,{id:t.id,approvalId:a.approval_id,approvalVersion:a.approval_version,decision:'accept'}),/Agent不能自行批准/);
 assert.throws(()=>engine.decideApproval({id:'other'}, {id:t.id,approvalId:a.approval_id,approvalVersion:a.approval_version,decision:'accept'},{trustedHuman:true}));
 assert.throws(()=>engine.decideApproval(actor,{id:t.id,approvalId:a.approval_id,approvalVersion:'stale',decision:'accept'},{trustedHuman:true}),/版本不一致/);
 await tools.get('coordinator_control').execute(a,exec);await until(()=>t.status==='awaiting_review');assert.equal(asks,1);assert.equal(t.approvals[0].state,'accepted');assert.equal(t.result.native.approvals[0].decision,'accept');assert.equal(t.status,'awaiting_review');
 assert.throws(()=>engine.decideApproval(actor,{id:t.id,approvalId:a.approval_id,approvalVersion:a.approval_version,decision:'accept'},{trustedHuman:true}),/已失效/);
 engine.read(actor,{id:t.id,relative:'codex-probe.txt'});engine.review(actor,{id:t.id,revision:t.revision,version:t.result.version,verdict:'pass',checks:[{criterion:'2字节OK',status:'pass',evidence:'read OK'}],note:'fixture reviewed'});
 coverage.push('原会话DSH allowed-once才能批准，跨会话/旧版本/重复批准拒绝，交付后仍须原Agent审查');
 outcome='rejected';t=await plan('command','reject');await tools.get('coordinator_control').execute(args(t),exec);await until(()=>t.status==='failed');assert.equal(t.approvals[0].state,'rejected');assert.match(t.result.output,/已有输出/);assert.match(t.result.error,/DSH审批结果：rejected/);coverage.push('DSH策略拒绝时不放权且result保存诊断');
 outcome='unavailable';t=await plan('command','unavailable');await tools.get('coordinator_control').execute(args(t),exec);await until(()=>t.status==='failed');assert.match(t.result.error,/unavailable/);assert.equal(t.approvals[0].state,'unavailable');coverage.push('原生答复渠道不可用时明确失败，不放宽权限');
 t=await plan('hang','cancel');a=args(t);await engine.control(actor,'cancel',t.id);assert.equal(t.status,'cancelled');assert.equal(engine.pendingApprovals.size,0);assert.equal(t.approvals[0].state,'withdrawn');assert.throws(()=>engine.decideApproval(actor,{id:t.id,approvalId:a.approval_id,approvalVersion:a.approval_version,decision:'accept'},{trustedHuman:true}));coverage.push('取消撤回待处理审批，迟到批准不执行');
 const rebootDir=path.join(root,'reboot');fs.mkdirSync(rebootDir);fs.writeFileSync(path.join(rebootDir,'state.json'),JSON.stringify({schema:1,sessions:{owner:{id:'owner',cwd,tasks:[{id:'stale',status:'running',approvals:[{id:'old',state:'reviewing'}]}],pendingEvents:[]}},endpoints:{},events:[]}));const reboot=new Coordinator({dir:rebootDir,run:()=>assert.fail('no replay')});assert.equal(reboot.state.sessions.owner.tasks[0].approvals[0].state,'withdrawn');assert.equal(reboot.state.sessions.owner.tasks[0].status,'paused');await reboot.close();coverage.push('重启撤回旧审批并暂停任务，不复活执行');
 for(const effect of effects)await effect();assert.equal(engine.pendingApprovals.size,0);
 const report={passed:true,coverage,modelPrompts:0,productionModified:false,root};fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill();for(const socket of ws?.clients||[])socket.terminate();await new Promise(resolve=>ws?ws.close(resolve):resolve());await new Promise(resolve=>web?web.close(resolve):resolve());}
