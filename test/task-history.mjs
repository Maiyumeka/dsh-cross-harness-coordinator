import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Coordinator} from '../lib/engine.js';
import {apply} from '../lib/index.js';
const root=path.resolve('test-data','task-history-'+Date.now()),cwd=path.join(root,'中文工作目录');fs.mkdirSync(cwd,{recursive:true});
const actor={id:'owner',cwd},runs=[];let waiting;
const engine=new Coordinator({dir:path.join(root,'state'),run:async request=>{
 runs.push(request.task.id);if(request.task.id==='child')return new Promise(resolve=>{waiting=()=>{fs.writeFileSync(path.join(cwd,'child.md'),'child delivery');resolve({ok:true,output:'fixture'});};request.signal.addEventListener('abort',()=>resolve({ok:false,error:'fixture interrupted'}),{once:true});});
 fs.writeFileSync(path.join(cwd,request.task.outputs[0]),'real fixture delivery');return {ok:true,output:'fixture'};
}});
const endpoint={id:'fixture',label:'历史测试端',command:process.execPath,args:[],protocol:'text'};
const task=(id,dependencies=[])=>({id,title:id,prompt:'fixture',endpoint:endpoint.id,outputs:[id+'.md'],dependencies,criteria:['actual file'],reason:'closure test'});
const until=async check=>{for(let i=0;i<160;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('fixture timeout');};
const pass=id=>{const t=engine.state.sessions.owner.tasks.find(t=>t.id===id);engine.read(actor,{id,relative:t.outputs[0]});engine.review(actor,{id,revision:t.revision,version:t.result.version,verdict:'pass',checks:[{criterion:'actual file',status:'pass',evidence:'test Agent reads real fixture bytes'}],note:'fixture review'});return t;};
let second,hosted;const effects=[];
try{
 engine.endpoint(actor,endpoint);engine.plan(actor,{title:'闭环保留',tasks:[task('only')]});await until(()=>engine.public(actor).tasks[0].status==='awaiting_review');const completed=pass('only'),before=JSON.stringify({result:completed.result,reviews:completed.reviews,history:completed.history}),bytes=fs.readFileSync(path.join(cwd,'only.md'));
 const closed=await engine.control(actor,'close','only');assert.equal(closed.tasks.length,0);assert.equal(closed.closedTasks.length,1);assert.equal(closed.closedTasks[0].status,'passed');assert.equal(JSON.stringify({result:completed.result,reviews:completed.reviews,history:completed.history}),before);assert(fs.readFileSync(path.join(cwd,'only.md')).equals(bytes));assert.equal(engine.read(actor,{id:'only',relative:'only.md'}).text,'real fixture delivery');
 const firstClosedAt=completed.closedAt;await engine.control(actor,'close','only');assert.equal(completed.closedAt,firstClosedAt);
 engine.session({id:'outsider',cwd},true);await assert.rejects(engine.control({id:'outsider',cwd},'close','only'),/任务不存在/);
 // Fully ended history is no longer monitored as current work.
 fs.appendFileSync(path.join(cwd,'only.md'),' later edit');engine.guard(engine.state.sessions.owner);assert.equal(engine.public(actor).tasks.length,0);assert.equal(completed.status,'passed');assert.equal(runs.length,1);
 await engine.close();second=new Coordinator({dir:path.join(root,'state'),run:()=>{throw Error('history must not run');}});assert.equal(second.public(actor).closedTasks[0].closedAt,firstClosedAt);assert.equal(second.public(actor).tasks.length,0);await second.close();
 // Ended records survive replacement by a new plan; copied closure flags cannot hide a new task.
 engine.closed=false;engine.plan(actor,{title:'下一计划',tasks:[{...task('next'),closedAt:firstClosedAt,closedEndpointLabel:'copied'}]});assert.equal(engine.public(actor).tasks[0].id,'next');assert.equal(engine.public(actor).tasks[0].closedAt,undefined);assert.equal(engine.state.sessions.owner.previousPlans[0][0].closedAt,firstClosedAt);
 await engine.control(actor,'cancel','next');await engine.control(actor,'close','next');assert.equal(engine.public(actor).tasks.length,0);
 engine.state.sessions.owner.paused=false;engine.plan(actor,{title:'隐藏前置仍核对依赖',tasks:[task('parent'),task('child',['parent'])]});await until(()=>engine.public(actor).tasks[0].status==='awaiting_review');const parent=pass('parent');engine.closeTask(actor,'parent');await until(()=>engine.live.size===1&&runs.includes('child'));
 assert.equal(parent.status,'passed');assert.equal(engine.public(actor).tasks[0].id,'child');assert(parent.closedAt);await assert.rejects(engine.control(actor,'close','child'),/未完成/);
 fs.appendFileSync(path.join(cwd,'parent.md'),' changed dependency');engine.guard(engine.state.sessions.owner);await until(()=>engine.live.size===0);assert.equal(parent.closedAt,undefined);assert.equal(parent.status,'blocked');assert(engine.public(actor).tasks.some(t=>t.id==='parent'));assert(parent.history.some(h=>h.reviews.some(r=>r.verdict==='pass')));
 await engine.control(actor,'cancel');for(const t of engine.state.sessions.owner.tasks)engine.closeTask(actor,t.id);assert.equal(engine.removeEndpoint(actor,endpoint.id).removed,endpoint.id);
 // Public RPC and the existing tool expose closure, not just a frontend filter.
 let rpc;const tools=new Map(),agent={id:actor.id,session:{header:{cwd}}};hosted=apply({agents:{get:id=>id===actor.id?agent:undefined},sessions:{get:id=>id===actor.id?agent.session:undefined},sessionController:{prompt:async()=>{}},tools:{register:t=>{tools.set(t.name,t);return()=>{};}},systemPrompt:{section:()=>()=>{}},connection:{register:(_a,_c,fn)=>rpc=fn},webServer:{port:32180,register:()=>()=>{}},on:()=>()=>{},effect:fn=>effects.push(fn()),sandboxPolicy:{resolve:()=>({mode:'workspace-write'})},sandbox:{confine:async argv=>({argv})},subprocess:{spawn:()=>{throw Error('no model tasks');}}},{dataDir:path.join(root,'host')});
 const s=hosted.session(actor,true);s.tasks=['first','second'].map(id=>({...task(id),status:'passed',history:[],reviews:[{verdict:'pass'}],result:{ok:true,version:id}}));const signal=new AbortController().signal;
 const result=await rpc('control',{sessionId:actor.id,action:'close',id:'first'},signal);assert.equal(result.ok,true);assert.equal(result.value.tasks.length,1);assert.equal(result.value.closedTasks[0].status,'passed');await tools.get('coordinator_control').execute({action:'close',id:'second'},{agent,signal});assert.equal(hosted.public(actor).tasks.length,0);
 const report={passed:true,coverage:['已通过任务移出当前列表、保留文件和全部审查记录','闭合记录可读取、重启保留且不自动运行','新计划保留旧历史并清除复制的关闭标记','已关闭前置仍供下游派发和变更核对','未完成任务不能被假关闭','任务归属、重复关闭与结束后移除端点','公共工具和设置RPC都支持close'],modelPrompts:0,root};fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await engine.close();if(second)await second.close();for(const effect of effects)await effect();}
