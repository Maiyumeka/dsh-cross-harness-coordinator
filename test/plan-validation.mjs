import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {apply} from '../lib/index.js';
import {PLAN_PARAMETERS,explainSchemaError} from '../lib/validation.js';
const root=path.resolve('test-data','plan-validation-'+Date.now()),cwd=path.join(root,'workspace');fs.mkdirSync(cwd,{recursive:true});
const tools=new Map(),effects=[],agent={id:'fixture-owner',session:{header:{cwd}}};let launches=0;
const ctx={agents:{get:id=>id===agent.id?agent:undefined},sessions:{get:()=>agent.session},sessionController:{prompt:async()=>{}},tools:{register:t=>{tools.set(t.name,t);return()=>{};}},systemPrompt:{section:()=>()=>{}},connection:{register:()=>{}},webServer:{port:32180,register:()=>()=>{}},on:()=>()=>{},effect:fn=>effects.push(fn()),sandboxPolicy:{resolve:()=>({mode:'workspace-write'})},sandbox:{confine:async()=>assert.fail('no model task')},subprocess:{spawn:()=>{launches++;assert.fail('no model task');}}};
const engine=apply(ctx,{dataDir:path.join(root,'state')}),actor={id:agent.id,cwd},exec={agent,signal:new AbortController().signal};
const task={id:'a1',title:'scene1',prompt:'Create an anime illustration with imagegen and save it to video/art/scene1.png. Reply file_ok=yes.',endpoint:'peer',dependencies:[],outputs:['video/art/scene1.png'],criteria:['file exists'],reason:'test'},coverage=[];
try{
 engine.endpoint(actor,{id:'peer',label:'fixture',command:process.execPath,args:[],probe_args:[],protocol:'text'});await engine.control(actor,'pause');
 const plan=tools.get('coordinator_plan'),missing={...task};delete missing.title;
 async function reject(args,field,type,length,{layer='engine',maxLength}={}){
  const before=JSON.stringify(engine.state),disk=fs.readFileSync(engine.file,'utf8');let error;
  try{await plan.execute(args,exec);}catch(e){error=e;}
  assert(error,'input must reject');assert(error.message.includes('字段='+field),error.message);assert(!error.message.includes(task.prompt));
  const detail=error.validation?.fields?.find(d=>d.field===field)||error.validation;
  assert.equal(detail.field,field);assert.equal(detail.received.type,type);assert.equal(detail.received.length,length);assert.equal(detail.layer,layer);if(maxLength!==undefined)assert.equal(detail.maxLength,maxLength);
  assert.equal(JSON.stringify(engine.state),before,'invalid plan changed state');assert.equal(fs.readFileSync(engine.file,'utf8'),disk,'invalid plan wrote state');return error;
 }
 const absentTitle=await reject({title:'test',tasks:JSON.stringify([missing])},'tasks[0].title','undefined',null,{maxLength:200});
 await reject({title:'test',tasks:[missing]},'tasks[0].title','undefined',null,{maxLength:200});
 coverage.push('工单短JSON与结构化数组都明确指出缺少tasks[0].title，类型、长度、限制及引擎层可见');
 for(const [field,value,type,length,maxLength] of [['title',null,'null',null,200],['title',3,'number',null,200],['title',' ','string',1,200],['title','x'.repeat(201),'string',201,200],['prompt','x'.repeat(16001),'string',16001,16000],['prompt','😀'.repeat(8001),'string',16002,16000],['reason',{},'object',null,2000]]){
  await reject({title:'test',tasks:[{...task,[field]:value}]},'tasks[0].'+field,type,length,{maxLength});
 }
 const noPrompt={...task};delete noPrompt.prompt;await reject({title:'test',tasks:[noPrompt]},'tasks[0].prompt','undefined',null,{maxLength:16000});
 coverage.push('空白、null、错类型、缺字段和超限的文字诊断；UTF-16长度与UTF-8字节分别标示');
 for(const [tasks,field,type,length] of [[[], 'tasks','array',0],[Array.from({length:31},()=>task),'tasks','array',31],[[null],'tasks[0]','null',null],[[{...task,id:'bad id'}],'tasks[0].id','string',6],[[Object.fromEntries(Object.entries(task).filter(([key])=>key!=='outputs'))],'tasks[0].outputs','undefined',null],[[{...task,outputs:[null]}],'tasks[0].outputs[0]','null',null],[[{...task,criteria:[' ']}],'tasks[0].criteria[0]','string',1],[[{...task,dependencies:null}],'tasks[0].dependencies','null',null],[[{...task,dependencies:[false]}],'tasks[0].dependencies[0]','boolean',null]])await reject({title:'test',tasks},field,type,length);
 coverage.push('数组根、任务项、编号、依赖、产物和验收条件的定位且拒绝不改状态');
 await reject({title:'test'},'tasks','undefined',null,{layer:'tool/schema'});
 await reject({title:4,tasks:[task]},'title','number',null,{layer:'tool/schema',maxLength:200});
 await reject({title:'test',tasks:{}},'tasks','object',null,{layer:'tool/schema'});
 await reject({title:'test',tasks:'{}'},'tasks','object',null,{layer:'tool/json'});
 const secretMarker='PRIVATE_PROMPT_MARKER',badJSON='[{"prompt":"'+secretMarker;
 const malformed=await reject({title:'test',tasks:badJSON},'tasks','string',badJSON.length,{layer:'tool/json'});assert(!malformed.message.includes(secretMarker));
 coverage.push('宿主schema、JSON解码、engine三个错误层分别报告；解析错误不回显原始JSON正文');
 // A valid title used to be checked after assigning s.tasks; preserve the complete old plan.
 await plan.execute({title:'valid',tasks:[task]},exec);await engine.control(actor,'cancel');
 await reject({title:' ',tasks:[{...task,id:'replacement'}]},'title','string',1,{maxLength:200});
 assert.equal(engine.public(actor).tasks[0].id,'a1');
 coverage.push('计划总标题失败不覆盖旧任务、不添加previousPlans、不创建plan事件或启动执行');
 const unicode={...task,title:'😀'.repeat(100),prompt:'😀'.repeat(8000)};
 await plan.execute({title:'unicode limits',tasks:JSON.stringify([unicode])},exec);assert.equal(engine.public(actor).tasks[0].prompt.length,16000);await engine.control(actor,'cancel');
 const optional={...task};delete optional.dependencies;await plan.execute({title:'structured',tasks:[optional]},exec);assert.deepEqual(engine.public(actor).tasks[0].dependencies,[]);await engine.control(actor,'cancel');
 await plan.execute({title:'legacy',tasks:JSON.stringify([optional])},exec);assert.equal(engine.public(actor).tasks[0].id,'a1');
 coverage.push('中英文/emoji边界有效；结构化数组与旧JSON字符串都可建计划，省略dependencies默认为[]');
 const schemaModule=process.env.COORDINATOR_TEST_SCHEMA_MODULE?pathToFileURL(path.resolve(process.env.COORDINATOR_TEST_SCHEMA_MODULE)).href:'@deepseek-ai/dsh-tools',host=await import(schemaModule);
 let entered=0;const legacy=host.defineTool({name:'host_length_check',parameters:{tasks:{type:'string',required:true}},output:{schema:{type:'json'},render:()=>[]},execute:()=>{entered++;return {};}});
 await legacy.execute({tasks:JSON.stringify([{...task,prompt:'x'.repeat(32000)}])},exec);assert.equal(entered,1);
 const real=host.defineTool({name:'coordinator_plan',parameters:PLAN_PARAMETERS,output:{schema:{type:'json'},render:()=>[]},execute:(args,execution)=>plan.execute(args,execution)});
 await engine.control(actor,'cancel');await real.execute({title:'actual schema',tasks:[task]},exec);await engine.control(actor,'cancel');await real.execute({title:'actual schema legacy',tasks:JSON.stringify([task])},exec);
 await assert.rejects(()=>real.execute({title:'test',tasks:[missing]},exec),e=>e.validation.field==='tasks[0].title');
 try{await real.execute({title:'test',tasks:42},exec);assert.fail('invalid type');}catch(e){const enriched=explainSchemaError(e,{title:'test',tasks:42},'coordinator_plan');assert.equal(enriched.code,'INVALID_ARGS');assert.equal(enriched.validation.fields[0].received.type,'number');}
 coverage.push('DSH真实defineTool兼容oneOf数组/字符串，旧string schema无隐含16000长度上限；严格类型校验仍保留');
 assert.equal(launches,0);const result={passed:true,coverage,schemaModule,hostSchemaVersion:process.env.COORDINATOR_TEST_SCHEMA_MODULE?'0.2.0-rc.2':'dependency package',missingTitleDiagnostic:absentTitle.message,modelPrompts:0,productionModified:false,root};fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{for(const dispose of effects)await dispose();await engine.close();}
