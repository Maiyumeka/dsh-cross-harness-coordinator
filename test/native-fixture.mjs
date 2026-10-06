import fs from 'node:fs';
import readline from 'node:readline';
const mode=process.argv[2],log=m=>fs.appendFileSync('native-messages.jsonl',JSON.stringify(m)+'\n');
if(process.argv.includes('--version')){log({method:'version'});console.log('isolated fixture 1.0');process.exit(0);}
if(mode.startsWith('cli')){
 const lines=readline.createInterface({input:process.stdin});lines.on('line',()=>{});lines.on('close',()=>{
  fs.writeFileSync('delivery.md','结构化CLI真实交付');
  if(mode==='cli-json')console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'delivered'}));
  else if(mode==='cli-fail')console.log(JSON.stringify({type:'turn.failed',error:{message:'fixture failed'}}));
  else if(mode==='cli-missing')console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'claimed completion'}}));
  else console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1}}));
 });
}else{
 const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{const m=JSON.parse(line);log(m);const result=v=>console.log(JSON.stringify({id:m.id,result:v}));
  if(m.method==='initialize')result({userAgent:'isolated'});
  else if(m.method==='model/list')result({data:[{id:'fixture',supportedReasoningEfforts:[]}],nextCursor:null});
  else if(m.method==='thread/start')result({thread:{id:'thread-fixture'}});
  else if(m.method==='turn/start'){
   fs.writeFileSync('delivery.md','Codex原生接口真实交付');
   console.log(JSON.stringify({id:999,method:'item/permissions/requestApproval',params:{threadId:'thread-fixture',turnId:'turn-fixture'}}));
   console.log(JSON.stringify({method:'turn/completed',params:{threadId:'other',turn:{id:'other',status:'completed'}}}));
   console.log(JSON.stringify({method:'item/agentMessage/delta',params:{threadId:'thread-fixture',turnId:'turn-fixture',delta:'native fixture'}}));
   // Completion can arrive before the turn/start response.
   console.log(JSON.stringify({method:'turn/completed',params:{threadId:'thread-fixture',turn:{id:'turn-fixture',status:mode==='codex-fail'?'failed':'completed'}}}));result({turn:{id:'turn-fixture'}});
  }else if(m.method==='turn/interrupt')result({});
 });
}
