import readline from 'node:readline';
import fs from 'node:fs';
const mode=process.argv[2],log=process.argv[3];
// Consume queued requests only after startup, like the reported gateway.
if(process.argv[4])await new Promise(resolve=>setTimeout(resolve,Number(process.argv[4])));
const lines=readline.createInterface({input:process.stdin});let probed=false;
lines.on('line',line=>{
 const request=JSON.parse(line);fs.appendFileSync(log,JSON.stringify({pid:process.pid,method:request.method,params:request.params})+'\n');if(request.id===undefined)return;
 const result=value=>console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:value}));
 const error=(code,message,data)=>console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code,message,...(data?{data}:{})}}));
 if(request.method==='server/discover'){
  probed=true;
  if(mode==='silent')return;
  if(mode==='modern-unsupported'){error(-32022,'unsupported version',{supported:['future-version']});return;}
  error(-32601,'Method not found','server/discover');
 }else if(request.method==='initialize'){
  if(mode==='legacy-failure'){error(-32002,'fixture initialize refused');return;}
  if(probed){error(-32022,'connection is serving the 2026-07-28 protocol',{supported:['2026-07-28']});return;}
  result({protocolVersion:'2025-06-18',serverInfo:{name:'isolated legacy gateway',version:'fixture'},capabilities:{tools:{}}});
 }else if(request.method==='tools/list')result({tools:[{name:'messages_send',inputSchema:{type:'object',properties:{message:{type:'string'},key:{type:'string'}},required:['message','key']}}]});
 else if(request.method==='tools/call'){fs.writeFileSync('MODEL_TASK_SUBMITTED','unexpected');result({content:[{type:'text',text:'not allowed during probe'}]});}
});
