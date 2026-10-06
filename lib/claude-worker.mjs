import readline from 'node:readline';
import {pathToFileURL} from 'node:url';
const lines=readline.createInterface({input:process.stdin});let query,started=false,release;const controller=new AbortController();
lines.on('line',async line=>{
 let r;try{r=JSON.parse(line);}catch{return;}if(r.cancel){controller.abort();await query?.interrupt().catch(()=>{});query?.close();release?.();return;}if(started)return;started=true;
 const timer=setTimeout(()=>{controller.abort();query?.close();release?.();},r.task.timeoutMs);
 try{
  const sdk=await import(pathToFileURL(r.endpoint.sdk.module).href);if(typeof sdk.query!=='function')throw Error('未找到官方SDK query入口');
  const gate=new Promise(resolve=>{release=resolve;});
  async function* prompt(){if(!r.probeOnly)yield {type:'user',message:{role:'user',content:r.prompt},parent_tool_use_id:null,session_id:''};else await gate;}
  query=sdk.query({prompt:prompt(),options:{cwd:r.cwd,abortController:controller,...(r.endpoint.sdk.cliPath?{pathToClaudeCodeExecutable:r.endpoint.sdk.cliPath}:{}),canUseTool:async()=>({behavior:'deny',message:'协调器不自动批准额外权限'}),...(r.task.model?{model:r.task.model}:{})}});
  const init=await query.initializationResult();if(!init||typeof init!=='object')throw Error('SDK初始化失败');
  if(r.probeOnly){const models=await query.supportedModels();process.stdout.write(JSON.stringify({result:{protocol:'claude-sdk',handshakeVerified:true,methods:['initializationResult','supportedModels'],models:models.slice(0,200),executionVerified:false,checkedAt:new Date().toISOString()}})+'\n');return;}
  let result;for await(const message of query){if(message.type==='result'){result=message;break;}}if(!result)throw Error('Claude SDK缺少任务终态');
  process.stdout.write(JSON.stringify({result:{ok:result.subtype==='success'&&result.is_error!==true,output:String(result.result||'').slice(-256000),usage:result.usage||null,error:result.subtype==='success'&&result.is_error!==true?'':'Claude SDK任务失败：'+result.subtype}})+'\n');
 }catch(error){process.stdout.write(JSON.stringify({error:'Claude SDK调用失败：'+(controller.signal.aborted?'已取消或超时':'请核对SDK版本、既有配置和认证'),protocolStage:'sdk'})+'\n');}
 finally{clearTimeout(timer);query?.close();release?.();lines.close();process.stdin.pause();}
});
