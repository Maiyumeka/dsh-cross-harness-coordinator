import fs from 'node:fs';
import readline from 'node:readline';
const [protocol,relative,mode='normal']=process.argv.slice(2);
function work(){fs.writeFileSync(relative,'这是一份用于验证协调流程的测试产物。\n验收：真实文件已写入。\n');return '测试产物已生成';}
if(mode==='slow'){setInterval(()=>fs.appendFileSync(relative,'tick\n'),100);}
else if(protocol==='text'){let input='';for await(const b of process.stdin)input+=b;console.log(work());}
else{const rl=readline.createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);let result;if(m.method==='initialize')result={protocolVersion:1,agentCapabilities:{},agentInfo:{name:'isolated-test-fixture',version:'1'}};else if(m.method==='session/new')result={sessionId:'fixture'};else if(m.method==='session/prompt'){work();process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'产物已生成'}}}})+'\n');result={stopReason:'end_turn'};}else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');});}
