// Opt-in read-only protocol check. Never included in the default test runner.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {runMcp} from '../lib/mcp.js';
const stateFile=process.env.COORDINATOR_LIVE_MCP_STATE,id=process.env.COORDINATOR_LIVE_MCP_ID;
if(!stateFile||!id)throw Error('explicit live state path and endpoint ID required');
const state=JSON.parse(fs.readFileSync(stateFile,'utf8')),original=state.endpoints?.[id];
if(original?.protocol!=='mcp'||original.mcp?.transport!=='stdio')throw Error('registered stdio MCP endpoint required');
const cwd=state.sessions[original.owner]?.cwd;if(!cwd)throw Error('registered workspace missing');
const root=path.resolve('test-data','live-mcp-'+Date.now());fs.mkdirSync(root,{recursive:true});
const results=[];let modelToolCalls=0;
for(const era of ['auto','legacy']){
 const start=Date.now(),launches=[],children=[];
 const launch=async request=>{
  const launchedAt=Date.now(),p=spawn(request.argv[0],request.argv.slice(1),{cwd:request.cwd,env:{...process.env,...request.env},windowsHide:true,stdio:'pipe'}),trace={startedMs:launchedAt-start,messages:[],stderrBytes:0};launches.push(trace);children.push(p);
  const done=new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',(exitCode,signal)=>{trace.exit={exitCode,signal,elapsedMs:Date.now()-launchedAt};resolve({exitCode,signal});});});
  let buffer='';p.stdout.on('data',chunk=>{buffer+=chunk.toString('utf8');let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const m=JSON.parse(line);trace.messages.push({direction:'received',elapsedMs:Date.now()-start,id:m.id??null,method:m.method??null,errorCode:m.error?.code??null});}catch{}}if(buffer.length>1024*1024)buffer='';});
  p.stderr.on('data',b=>trace.stderrBytes+=b.length);
  const write=p.stdin.write.bind(p.stdin);p.stdin.write=(chunk,...args)=>{let m;try{m=JSON.parse(chunk.toString());}catch{}if(m?.method==='tools/call'){modelToolCalls++;throw Error('live probe forbids task tool calls');}if(m)trace.messages.push({direction:'sent',elapsedMs:Date.now()-start,id:m.id??null,method:m.method??null});return write(chunk,...args);};
  const abort=()=>p.kill();request.signal.addEventListener('abort',abort,{once:true});done.finally(()=>request.signal.removeEventListener('abort',abort)).catch(()=>{});
  return {stdin:p.stdin,stdout:p.stdout,stderr:p.stderr,done,stop:async()=>{if(p.exitCode===null&&p.signalCode===null)p.kill();await done;}};
 };
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(Error('live check hard deadline')),15000);
 try{
  const receipt=await runMcp({launch},{endpoint:{...original,mcp:{...original.mcp,era}},owner:original.owner,cwd,signal:controller.signal,task:{timeoutMs:15000},prompt:'',probeOnly:true});
  results.push({era,ok:true,elapsedMs:Date.now()-start,protocolVersion:receipt.protocolVersion,toolCount:receipt.tools?.length,negotiationAttempts:receipt.negotiationAttempts,diagnostics:receipt.diagnostics,launches});
 }catch(error){results.push({era,ok:false,elapsedMs:Date.now()-start,stage:error.protocolStage,error:String(error.message).slice(0,2000),negotiationAttempts:error.connectionReceipt?.negotiationAttempts,diagnostics:error.connectionReceipt?.diagnostics,launches});}
 finally{clearTimeout(timer);for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill();}
}
const report={endpointId:id,modelToolCalls,productionStateModified:false,results};fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({root,...report},null,2));if(modelToolCalls)throw Error('probe unexpectedly submitted a task');

if(results.some(r=>!r.ok))process.exitCode=1;
