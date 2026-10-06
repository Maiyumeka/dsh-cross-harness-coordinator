import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const mode=process.argv[2],log='codex-approval.jsonl',out='codex-probe.txt';let approval=900;
const emit=value=>console.log(JSON.stringify(value)),notify=(method,params)=>emit({method,params}),base={threadId:'fixture-thread',turnId:'fixture-turn'};
const lines=readline.createInterface({input:process.stdin});
function ask(){
 const itemId='item-'+approval,params={...base,itemId,startedAtMs:Date.now(),reason:'在当前工作区创建声明文件'};
 if(mode==='file')notify('item/started',{...base,item:{type:'fileChange',id:itemId,changes:[{path:path.resolve(out),kind:{type:'add'},diff:'*** Add File: codex-probe.txt\n+OK'}],status:'inProgress'}});
 else{notify('item/started',{...base,item:{type:'commandExecution',id:itemId,command:'write declared file '+out,cwd:process.cwd(),commandActions:[],status:'inProgress'}});Object.assign(params,{command:'write declared file '+out,cwd:process.cwd()});}
 if(mode==='wrong-thread')params.threadId='another-thread';if(mode==='wrong-turn')params.turnId='another-turn';if(mode==='extra')params.additionalPermissions={network:{enabled:true}};
 emit({id:approval,method:mode==='file'?'item/fileChange/requestApproval':'item/commandExecution/requestApproval',params});
}
lines.on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(m)+'\n');const reply=result=>emit({id:m.id,result});
 if(m.method==='initialize')reply({userAgent:'isolated approval fixture'});
 else if(m.method==='model/list'){reply({data:[]});if(mode==='probe-approval')ask();}
 else if(m.method==='thread/start')reply({thread:{id:base.threadId}});
 else if(m.method==='turn/start'){
  notify('turn/started',{threadId:base.threadId,turn:{id:base.turnId,status:'inProgress'}});
  notify('item/agentMessage/delta',{...base,delta:'已有输出：准备写文件'});notify('item/commandExecution/outputDelta',{...base,delta:'命令诊断片段'});console.error('fixture stderr diagnostic');
  if(mode==='exit'){reply({turn:{id:base.turnId}});process.stdout.write('',()=>process.exit(7));return;}
  if(mode==='before-ack')ask();reply({turn:{id:base.turnId}});if(mode!=='before-ack')ask();
 }else if(m.id===approval&&m.result){
  if(mode==='hang')return;
  if(m.result.decision==='accept'){
   if(mode==='twice'&&approval===900){approval++;ask();return;}
   fs.writeFileSync(out,'OK');notify('item/agentMessage/delta',{...base,delta:'；已交付'});notify('turn/completed',{threadId:base.threadId,turn:{id:base.turnId,status:'completed'}});
  }else if(mode!=='probe-approval'){process.stdout.write('',()=>process.exit(3));}
 }else if(m.method==='turn/interrupt')reply({});
});
