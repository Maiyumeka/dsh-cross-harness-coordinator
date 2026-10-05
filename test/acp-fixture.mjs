import fs from 'node:fs';
import readline from 'node:readline';
const [log,mode='normal']=process.argv.slice(2);
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
let waiting;
for await(const line of readline.createInterface({input:process.stdin})){
 const m=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(m)+'\n');
 if(!m.method){if(waiting){send({id:waiting,error:{code:-32000,message:'额外权限已拒绝'}});waiting=null;}continue;}
 if(mode==='silent')continue;
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:mode==='version2'?2:1,agentInfo:{name:'isolated-acp',version:'fixture-1'},agentCapabilities:{promptCapabilities:{image:true},sessionCapabilities:mode==='close'?{close:{}}:{}}}});
 else if(m.method==='session/new'){
  if(mode==='auth')send({id:m.id,error:{code:-32000,message:'auth_required'}});
  else if(mode==='permission'){waiting=m.id;send({id:900,method:'session/request_permission',params:{sessionId:'fixture',options:[]}});}
  else send({id:m.id,result:mode==='missing-session'?{}:{sessionId:'fixture'}});
 }else if(m.method==='session/close')send({id:m.id,result:{}});
 else if(m.method==='session/prompt'){fs.writeFileSync(log+'.MODEL_PROMPT','禁止在握手检查中出现');send({id:m.id,result:{stopReason:'end_turn'}});}
 else send({id:m.id,error:{code:-32601,message:'unsupported'}});
}
