import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Coordinator} from '../lib/engine.js';
import {probeHarness} from '../lib/runner.js';
import {apply} from '../lib/index.js';
import {Invitations} from '../lib/onboarding.js';
const root=path.resolve('test-data','defects-'+Date.now()),cwd=path.join(root,'workspace');fs.mkdirSync(cwd,{recursive:true});
const actor={id:'owner',cwd},fixture=path.join(root,'entry.mjs');fs.copyFileSync('test/reconfirm-fixture.mjs',fixture);
const children=[];let launches=0;
const launch=request=>{
 launches++;const p=spawn(request.argv[0],request.argv.slice(1),{cwd:request.cwd,env:{...process.env,...request.env},stdio:'pipe',windowsHide:true});children.push(p);
 const done=new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',(exitCode,signal)=>resolve({exitCode,signal}));});
 const abort=()=>p.kill();request.signal.addEventListener('abort',abort,{once:true});done.finally(()=>request.signal.removeEventListener('abort',abort)).catch(()=>{});
 return {stdin:p.stdin,stdout:p.stdout,stderr:p.stderr,done,terminate:()=>p.kill(),waitForExit:()=>done,stop:async()=>{if(p.exitCode===null&&p.signalCode===null)p.kill();await done;}};
};
const definition={id:'registered',label:'入口与桌面版本不同的夹具',protocol:'acp',command:process.execPath,args:[fixture],probe_args:[fixture,'--version'],version:'0.2.0-rc.2'};
const engine=new Coordinator({dir:path.join(root,'state'),run:()=>{throw Error('不提交真实任务');},probe:r=>probeHarness({launch},r)});
const json=v=>JSON.stringify(v),pause=r=>new Promise(resolve=>setTimeout(resolve,r));
let tasksEngine,hosted;const effects=[];
try{
 engine.endpoint(actor,definition);assert.equal((await engine.connectEndpoint(actor,definition.id)).connected,true);
 const e=engine.state.endpoints[definition.id];assert.equal(e.version,'0.1.2-rc.1');assert.equal(e.reportedVersion,'0.2.0-rc.2');assert.equal(e.versionSource,'entry_probe');assert.equal(e.connection.agentInfo.version,'0.0.1');
 const invitations=new Invitations(engine),invitation=invitations.create(actor,'http://127.0.0.1:32180'),token=JSON.parse(fs.readFileSync(invitation.file)).token;
 const received=await invitations.submit(token,{label:'同入口版本回执',version:'0.2.0-rc.2',definition});assert.equal(received.version,'0.1.2-rc.1');assert.equal(received.reportedVersion,'0.2.0-rc.2');assert.equal(received.versionSource,'entry_probe');assert.equal(invitations.visible(actor.id).endpoint.version,'0.1.2-rc.1');invitations.close();
 const s=engine.state.sessions.owner;s.paused=true;s.tasks=Array.from({length:3},(_,i)=>({id:'passed-'+i,endpoint:e.id,status:'passed',revision:1,result:{ok:true,version:'historical-'+i},reviews:[{verdict:'pass',note:'历史验收记录'}]}));engine.save();const oldTasks=json(s.tasks),baseline=json(e.fingerprints);
 fs.appendFileSync(fixture,'\n// installed entry changed\n');const before=launches;
 const blocked=await engine.connectEndpoint(actor,e.id);assert.equal(blocked.connected,false);assert.equal(blocked.connection.stage,'fingerprint');assert.equal(blocked.connection.fingerprintReport.differences.length,1);assert.equal(launches,before);assert.equal(json(e.fingerprints),baseline);
 const difference=blocked.connection.fingerprintReport.differences[0];assert.equal(difference.file,fixture);assert(difference.previous&&difference.current&&difference.mtime);assert.notEqual(difference.previous,difference.current);
 assert.throws(()=>engine.endpoint(actor,{...definition}),error=>error.protocolStage==='fingerprint'&&error.fingerprintReport.changed);assert.equal(json(e.fingerprints),baseline);
 await assert.rejects(engine.reconfirmEndpoint({id:'outsider',cwd},e.id),/会话|登记/);
 const preview=await engine.reconfirmEndpoint(actor,e.id);assert.equal(preview.confirmed,false);assert.equal(launches,before);assert.equal(json(e.fingerprints),baseline);
 await assert.rejects(engine.reconfirmEndpoint(actor,e.id,{confirmationVersion:preview.confirmationVersion}),error=>error.validation?.field==='note'&&error.validation?.maxLength===8000);
 fs.appendFileSync(fixture,'// changed after inspection\n');await assert.rejects(engine.reconfirmEndpoint(actor,e.id,{confirmationVersion:preview.confirmationVersion,note:'过期确认'}),/又发生变化/);assert.equal(json(e.fingerprints),baseline);
 const abort=new AbortController();abort.abort(Error('取消确认'));await assert.rejects(engine.reconfirmEndpoint(actor,e.id,{signal:abort.signal}),/取消确认/);
 const fresh=await engine.reconfirmEndpoint(actor,e.id),confirmed=await engine.reconfirmEndpoint(actor,e.id,{confirmationVersion:fresh.confirmationVersion,note:'核对真实同路径入口更新，保留历史通过任务'});
 assert.equal(confirmed.confirmed,true);assert.equal(confirmed.connected,true);assert.equal(json(s.tasks),oldTasks);assert.notEqual(json(e.fingerprints),baseline);assert.equal(json(e.fingerprintHistory[0].previous),baseline);assert.equal(e.version,'0.1.2-rc.1');assert.equal(fs.existsSync(path.join(cwd,'MODEL_PROMPT_SUBMITTED')),false);
 await assert.rejects(engine.reconfirmEndpoint(actor,e.id,{confirmationVersion:fresh.confirmationVersion,note:'重复旧确认'}),/又发生变化/);
 // A post-handshake mutation remains blocked, even after explicit confirmation.
 const probe=engine.probe;engine.probe=async r=>{const receipt=await probe(r);fs.appendFileSync(fixture,'// mutated during check\n');return receipt;};
 const race=await engine.connectEndpoint(actor,e.id);assert.equal(race.connected,false);assert.equal(race.connection.stage,'fingerprint');engine.probe=probe;
 engine.live.set('busy',{t:{endpoint:e.id},cwd,controller:new AbortController(),promise:Promise.resolve()});await assert.rejects(engine.reconfirmEndpoint(actor,e.id),/仍有任务运行/);engine.live.delete('busy');
 // Correcting a different entry requires the same explicit difference approval.
 const first=path.join(root,'first.mjs'),second=path.join(root,'second.mjs');fs.copyFileSync('test/reconfirm-fixture.mjs',first);fs.copyFileSync('test/reconfirm-fixture.mjs',second);
 engine.endpoint(actor,{...definition,id:'correction',args:[first],probe_args:[first,'--version']});const correction=engine.state.endpoints.correction;
 const replacement={args:[second],probe_args:[second,'--version']},pending=await engine.connectEndpoint(actor,correction.id,{definition:replacement});assert.equal(pending.connected,false);assert.equal(pending.connection.stage,'fingerprint');assert.equal(correction.args[0],first);
 const shown=await engine.reconfirmEndpoint(actor,correction.id,{definition:replacement});assert.equal((await engine.reconfirmEndpoint(actor,correction.id,{definition:replacement,confirmationVersion:shown.confirmationVersion,note:'已核对新的同用途入口'})).connected,true);assert.equal(correction.args[0],second);

 // Single cancellation of a queued task must not await or abort another live task.
 const started=[],signals=new Map(),release=new Map();tasksEngine=new Coordinator({dir:path.join(root,'tasks'),run:r=>new Promise(resolve=>{started.push(r.task.id);signals.set(r.task.id,r.signal);release.set(r.task.id,()=>resolve({ok:true,output:'isolated'}));r.signal.addEventListener('abort',()=>setTimeout(()=>resolve({ok:true,output:'late result after cancel'}),20),{once:true});})});
 tasksEngine.endpoint(actor,{id:'text',label:'隔离任务',protocol:'text',command:process.execPath,args:[]});
 const task=(id,dependencies=[])=>({id,title:id,prompt:'fixture',endpoint:'text',dependencies,outputs:[id+'.txt'],criteria:['实际产物'],reason:'隔离取消测试'});
 tasksEngine.plan(actor,{title:'只取消单项',tasks:[task('running'),task('queued'),task('dependent',['running'])]});await pause(0);const session=tasksEngine.state.sessions.owner;
 assert.equal(session.tasks[0].status,'running');const began=Date.now();await tasksEngine.control(actor,'cancel','queued');assert(Date.now()-began<500);assert.equal(session.tasks[1].status,'cancelled');assert.equal(session.tasks[0].status,'running');assert.equal(signals.get('running').aborted,false);assert.equal(session.paused,false);
 session.tasks[0].invalidated=true;session.tasks[0].revision++;await tasksEngine.control(actor,'cancel','running');assert.equal(signals.get('running').aborted,true);assert.equal(session.tasks[0].status,'cancelled');await pause(30);assert.equal(session.tasks[0].status,'cancelled');assert.equal(session.tasks[2].status,'queued');assert.equal(started.includes('dependent'),false);
 for(const status of ['blocked','paused','awaiting_review']){session.tasks[2].status=status;delete session.tasks[2].cancelRequested;await tasksEngine.control(actor,'cancel','dependent');assert.equal(session.tasks[2].status,'cancelled');}
 await assert.rejects(tasksEngine.control(actor,'cancel','missing'),/任务不存在/);await assert.rejects(tasksEngine.control(actor,'cancel','running'),/已经结束/);
 session.tasks[2].status='queued';await tasksEngine.control(actor,'cancel');assert.equal(session.paused,true);assert.equal(session.tasks[2].status,'cancelled');

 // Exercise the public tool and settings RPC, not just engine methods.
 let rpc;const tools=new Map(),agent={id:actor.id,session:{header:{cwd}}};hosted=apply({agents:{get:id=>id===actor.id?agent:undefined},sessions:{get:id=>id===actor.id?agent.session:undefined},sessionController:{prompt:async()=>{}},tools:{register:t=>{tools.set(t.name,t);return()=>{};}},systemPrompt:{section:()=>()=>{}},connection:{register:(_o,_c,fn)=>rpc=fn},webServer:{port:32180,register:()=>()=>{}},on:()=>()=>{},effect:fn=>effects.push(fn()),sandboxPolicy:{resolve:()=>({mode:'workspace-write'})},sandbox:{confine:async argv=>({argv})},subprocess:{spawn:launch}},{dataDir:path.join(root,'host')});
 hosted.endpoint(actor,{...definition,id:'hosted',args:[second],probe_args:[second,'--version']});fs.appendFileSync(second,'// update for tool/RPC check\n');
 const control=tools.get('coordinator_control'),exec={agent,signal:new AbortController().signal};const toolPreview=await control.execute({action:'reconfirm',id:'hosted'},exec);assert.equal(toolPreview.confirmed,false);
 const rpcConfirmation=await rpc('endpoint-reconfirm',{sessionId:actor.id,endpointId:'hosted',confirmationVersion:toolPreview.confirmationVersion,note:'用户确认夹具更新'},exec.signal);assert.equal(rpcConfirmation.ok,true);assert.equal(rpcConfirmation.value.connected,true);
 const hs=hosted.state.sessions.owner;hs.paused=true;hs.tasks=[{id:'one',title:'one',status:'blocked',dependencies:[]},{id:'two',title:'two',status:'blocked',dependencies:[]}];assert.equal((await rpc('control',{sessionId:actor.id,action:'cancel',id:'one'},exec.signal)).ok,true);assert.equal(hs.tasks[0].status,'cancelled');assert.equal(hs.tasks[1].status,'blocked');await control.execute({action:'cancel',id:'two'},exec);assert.equal(hs.tasks[1].status,'cancelled');
 const report={passed:true,coverage:['真实文件哈希变化和fingerprint阶段','重登记不能静默覆盖基线','预览不更新、旧确认与竞态拒绝','明确重确认保留三个passed任务和旧基线','同一入口实测版本与原申报分开','调用定义换文件的显式确认','单任务取消不等待或中止其他任务','运行、排队、blocked、paused与待审查取消','返工中的取消不复活','工具与RPC确认和单任务取消'],modelPrompts:0,root};fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{engine.live.clear();await engine.close();if(tasksEngine)await tasksEngine.close();for(const effect of effects)await effect();for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill();}
