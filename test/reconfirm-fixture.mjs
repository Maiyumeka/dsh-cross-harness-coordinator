import readline from 'node:readline';
import fs from 'node:fs';
if(process.argv.includes('--version')){console.log('0.1.2-rc.1');process.exit(0);}
const lines=readline.createInterface({input:process.stdin});
lines.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync('reconfirm-rpc.jsonl',line+'\n');const result=v=>console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:v}));
 if(m.method==='initialize')result({protocolVersion:1,agentInfo:{name:'isolated-acp-component',version:'0.0.1'},agentCapabilities:{sessionCapabilities:{close:{}}}});
 else if(m.method==='session/new')result({sessionId:'reconfirm-fixture'});
 else if(m.method==='session/close')result({});
 else if(m.method==='session/prompt'){fs.writeFileSync('MODEL_PROMPT_SUBMITTED','unexpected');result({stopReason:'end_turn'});}
});
