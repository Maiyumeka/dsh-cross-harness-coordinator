import readline from 'node:readline';
import fs from 'node:fs';
const mode=process.argv[2]||'modern',lines=readline.createInterface({input:process.stdin});
lines.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync('modern-messages.jsonl',JSON.stringify(m)+'\n');if(m.id===undefined)return;
 const response=result=>console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
 if(m.method==='server/discover'){
  if(mode==='legacy')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32602,message:'legacy unknown request'}}));
  else if(mode==='unsupported')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32022,message:'unsupported modern',data:{supported:['future-version']}}}));
  else response({resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{tools:{}},ttlMs:0,cacheScope:'public'});
 }else if(m.method==='initialize')response({protocolVersion:'2025-11-25',serverInfo:{name:'legacy',version:'1'},capabilities:{tools:{}}});
 else if(m.method==='tools/list')response({resultType:'complete',tools:[{name:'delegate',inputSchema:{type:'object',properties:{prompt:{type:'string'}},required:['prompt']}}]});
 else if(m.method==='tools/call'){
  if(mode==='input')response({resultType:'input_required',requestState:'opaque',inputRequests:{elicitation:[]}});
  else{fs.writeFileSync('delivery.md','现代MCP stdio交付');response({resultType:'complete',content:[{type:'text',text:'delivered'}]});}
 }
});
