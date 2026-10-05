import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
const [log,mode='normal',control='mcp-control.json']=process.argv.slice(2);
let initialized=false;
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
const tool=()=>{
 const schema={type:'object',properties:{prompt:{type:'string'},workdir:{type:'string'},output:{type:'string'},model:{type:'string',enum:['fixture-model']},reasoning:{type:'string',enum:['fixture-high']},count:{type:'integer'}},required:['prompt','workdir','output'],additionalProperties:false};
 if(fs.existsSync(control))schema.properties.count.type='string';
 if(mode==='invalid-schema')schema.$ref='https://invalid.example/schema';
 return {name:'write_artifact',description:'生成隔离测试产物',inputSchema:schema,outputSchema:{type:'object',properties:{file:{type:'string'}},required:['file']},...(mode==='task-required'?{execution:{taskSupport:'required'}}:{})};
};
const answer=async m=>{
 fs.appendFileSync(log,JSON.stringify(m)+'\n');
 if(!m.method)return;
 if(mode==='silent')return;
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:mode==='bad-version'?'2099-01-01':mode==='older'?'2024-11-05':'2025-11-25',serverInfo:{name:'isolated-mcp-harness',version:'1'},capabilities:mode==='no-tools'?{}:{tools:{listChanged:true}}}});
 else if(m.method==='notifications/initialized'){
  initialized=true;
  if(mode==='callbacks'){send({id:901,method:'roots/list',params:{}});send({id:902,method:'sampling/createMessage',params:{messages:[]}});}
 }else if(m.method==='tools/list'){
  if(!initialized){send({id:m.id,error:{code:-32000,message:'未发送initialized'}});return;}
  if(mode==='list-changed')send({method:'notifications/tools/list_changed'});
  const helper={name:'version_info',inputSchema:{type:'object',properties:{}}};
  if(mode==='duplicate')send({id:m.id,result:{tools:[tool(),tool()]}});
  else if(mode==='cursor-loop')send({id:m.id,result:{tools:[],nextCursor:'repeat'}});
  else if(mode==='pagination'&&!m.params.cursor)send({id:m.id,result:{tools:[helper],nextCursor:'page2'}});
  else send({id:m.id,result:{tools:[tool()]}});
 }else if(m.method==='tools/call'){
  if(mode==='slow'){await new Promise(r=>setTimeout(r,4000));}
  if(mode==='tool-error'){send({id:m.id,result:{isError:true,content:[{type:'text',text:'隔离工具执行失败'}]}});return;}
  if(mode==='async-result'){send({id:m.id,result:{task:{taskId:'unsupported'}}});return;}
  const a=m.params.arguments;const file=path.resolve(a.workdir,a.output);fs.writeFileSync(file,'MCP隔离执行已完成。\n'+a.prompt+'\n');
  send({id:m.id,result:{content:[{type:'text',text:'真实文件已写入'}],structuredContent:mode==='wrong-output'?{}:{file:a.output},isError:false}});
 }
};
const rl=readline.createInterface({input:process.stdin});rl.on('line',line=>{void answer(JSON.parse(line));});
