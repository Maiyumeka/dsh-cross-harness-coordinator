import path from 'node:path';
import {systemClock} from './time.js';
// Optional version evidence comes from the same executable and wrapper script.
// No arbitrary probe command or model prompt is accepted here.
export async function probeEntryVersion({launch,clock=systemClock},request){
 const e=request.endpoint,args=e.probe_args||[],base={source:'entry_probe',checkedAt:new Date(clock.now()).toISOString()};
 if(!['acp','codex','mcp'].includes(e.protocol)||e.server||!args.length)return {state:'not_checked',reason:'没有本机版本探测入口'};
 const startup=(e.args||[]).filter(a=>path.isAbsolute(a)&&/\.(?:[cm]?js|py)$/i.test(a));
 const flags=new Set(['--version','-V']);
 if(!args.some(a=>flags.has(a))||!startup.every(file=>args.includes(file))||!args.every(a=>flags.has(a)||startup.includes(a)||/^[A-Za-z][A-Za-z0-9_-]*$/.test(a)||a==='-m'&&e.args.includes(a)))return {state:'not_checked',reason:'版本参数未满足同入口、无任务检查规则'};
 const h=await launch({...request,argv:[e.command,...args],env:e.launch_env||{}});let output='',overflow=false;
 h.stdout.on('data',b=>{output+=b.toString();if(Buffer.byteLength(output)>4096){overflow=true;void h.stop().catch(()=>{});}});h.stderr.on('data',()=>{});h.stdin.on('error',()=>{});h.stdin.end();
 const timer=clock.setTimeout(()=>void h.stop().catch(()=>{}),3000);
 try{
  const result=await h.done;request.signal.throwIfAborted();
  const line=output.trim(),match=line.match(/^(?:[A-Za-z][A-Za-z0-9 _.()-]*\s+)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/);
  if(overflow||result.exitCode!==0||!match)return {...base,state:'unverified',reason:'同入口版本检查未返回确定版本'};
  return {...base,state:'verified',version:match[1],command:e.command,args};
 }finally{clock.clearTimeout(timer);await h.stop();}
}
