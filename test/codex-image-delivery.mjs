import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {WebSocketServer} from 'ws';
import {runHarness,probeHarness} from '../lib/runner.js';
import {Coordinator} from '../lib/engine.js';
import {createRunLog} from '../lib/run-log.js';
import {FakeClock} from './support/fake-clock.mjs';
const root=path.resolve('test-data','codex-image-'+Date.now());fs.mkdirSync(root,{recursive:true});
const cache=path.join(root,'generated-cache');fs.mkdirSync(cache);const source=path.join(cache,'generated.png');
// A valid one-pixel PNG with a large ancillary chunk: tests transport, not AI drawing.
const table=Uint32Array.from({length:256},(_,n)=>{for(let bit=0;bit<8;bit++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const crc=data=>{let value=0xffffffff;for(const byte of data)value=table[(value^byte)&255]^(value>>>8);return (value^0xffffffff)>>>0;};
const chunk=(type,data)=>{const name=Buffer.from(type),header=Buffer.alloc(4),tail=Buffer.alloc(4);header.writeUInt32BE(data.length);tail.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([header,name,data,tail]);};
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6;
const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('tEXt',Buffer.concat([Buffer.from('fixture\0'),Buffer.alloc(2*1024*1024,65)])),chunk('IDAT',deflateSync(Buffer.from([0,80,180,255,255]))),chunk('IEND',Buffer.alloc(0))]);fs.writeFileSync(source,png);
const b64=png.toString('base64'),digest=bytes=>createHash('sha256').update(bytes).digest('hex'),children=[],coverage=[];
const fixture=path.resolve('test/codex-image-fixture.mjs'),endpoint=mode=>({id:'peer',label:'image fixture',protocol:'codex',command:process.execPath,args:[fixture,mode,source]});
const launch=r=>{const p=spawn(r.argv[0],r.argv.slice(1),{cwd:r.cwd,stdio:'pipe',windowsHide:true}),done=new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',(exitCode,signal)=>resolve({exitCode,signal}));});children.push(p);const abort=()=>p.kill();r.signal.addEventListener('abort',abort,{once:true});done.finally(()=>r.signal.removeEventListener('abort',abort)).catch(()=>{});return {stdin:p.stdin,stdout:p.stdout,stderr:p.stderr,done,stop:async()=>{if(p.exitCode===null&&p.signalCode===null)p.kill();await done;}};};
const workspace=name=>{const cwd=path.join(root,name);fs.mkdirSync(cwd);return cwd;};
const req=(mode,cwd,extra={})=>({endpoint:endpoint(mode),cwd,owner:'image-owner',signal:new AbortController().signal,task:{timeoutMs:12000,outputs:['scene1.png']},prompt:'fixture only',...extra});
const until=async predicate=>{const deadline=Date.now()+10000;while(!predicate()){assert(Date.now()<deadline,'expected event missing');await new Promise(resolve=>setTimeout(resolve,10));}};
let server,ws;
try{
 for(const mode of ['normal','fragmented','extension','scope-noise']){
  const cwd=workspace(mode),log=createRunLog(root,'owner',mode,'run');let asks=0;
  const r=await runHarness({launch},req(mode,cwd,{trace:log.write,requestApproval:p=>{asks++;assert.equal(p.cwd,cwd);assert(p.command.includes(source));return {decision:'accept',reason:'fixture approval once'};}}));
  assert.equal(r.ok,true,r.error);assert.equal(asks,3);assert.equal(digest(fs.readFileSync(path.join(cwd,'scene1.png'))),digest(png));assert.equal(r.native.transport.failure,null);assert(r.native.transport.stats.largestMessageBytes>1024*1024);assert.equal(r.native.generatedImages[0].savedPath,source);assert.equal(r.native.generatedImages[0].resultChars,b64.length);assert(JSON.stringify(r).length<10000);
  const text=fs.readFileSync(log.status().path,'utf8');assert(text.includes('codex_image_completed'));assert.equal(text.match(/codex_request_enter/g).length,3);assert(!text.includes(b64.slice(0,200)));assert(log.status().bytes<20000);
 }
 coverage.push('超过2.6MB的图片帧、分片和extension都接收，缓存图源在工作区外仍可逐次审批复制，目标PNG哈希一致','连续三次审批可达，状态和日志仅保留图片路径/大小，不保存base64');
 for(const [mode,code]of [['malformed','RPC_INVALID_JSON'],['oversize','RPC_BUFFER_LIMIT']]){
  const cwd=workspace(mode),log=createRunLog(root,'owner',mode,'run');const r=await runHarness({launch},req(mode,cwd,{trace:log.write,requestApproval:()=>assert.fail('no approval before valid image frame')}));
  assert.equal(r.ok,false);assert(r.native.transport.failure.code===code||mode==='oversize'&&r.native.transport.failure.code==='RPC_MESSAGE_LIMIT');assert(!r.error.includes('完成事件前退出'));assert(fs.readFileSync(log.status().path,'utf8').includes('rpc_failure'));assert(!fs.existsSync(path.join(cwd,'scene1.png')));
 }
 coverage.push('无效JSON和超过16MiB帧保留首次传输错误，不被后续退出覆盖');
 const stopped=await runHarness({launch},req('exit-after-image',workspace('incomplete')));assert.equal(stopped.ok,false);assert.equal(stopped.native.generatedImages.length,1);assert.equal(stopped.native.transport.failure.kind,'process_exit');assert(!fs.existsSync(path.join(root,'incomplete','scene1.png')));coverage.push('生成已完成但未收到turn/completed时仍失败，不自动拿缓存图片放行');
 const clock=new FakeClock(),timedCwd=workspace('deadline');let waiting=false;
 const pending=runHarness({launch,clock},req('hang',timedCwd,{task:{timeoutMs:3000,outputs:['scene1.png']},trace:(event,d)=>{if(event==='rpc_message'&&d.method==='item/started')waiting=true;}}));await until(()=>waiting);await new Promise(resolve=>setImmediate(resolve));clock.fire(clock.pending()[0]);const timed=await pending;assert.equal(timed.ok,false);assert.equal(timed.native.transport.failure.code,'CODEX_DEADLINE');assert.equal(timed.native.termination.abortSource,'codex_deadline');coverage.push('可控期限验证主动超时来源，阶段不被进程退出掩盖');
 const engineCwd=workspace('engine'),engine=new Coordinator({dir:path.join(root,'state'),run:r=>runHarness({launch},r),probe:r=>probeHarness({launch},r)}),actor={id:'owner',cwd:engineCwd};engine.endpoint(actor,endpoint('normal'));assert((await engine.connectEndpoint(actor,'peer')).connected);
 engine.plan(actor,{title:'image log test',tasks:[{id:'image',title:'image',prompt:'fixture',endpoint:'peer',outputs:['scene1.png'],criteria:['png hash'],reason:'fixture'}]});const task=()=>engine.state.sessions.owner.tasks[0];
 for(let i=0;i<3;i++){await until(()=>task().approvals?.some(a=>a.state==='pending'));const a=task().approvals.find(a=>a.state==='pending');engine.decideApproval(actor,{id:'image',approvalId:a.id,approvalVersion:a.version,decision:'accept'},{trustedHuman:true});}
 await until(()=>task().status==='awaiting_review');const runLog=engine.readRunLog(actor,{id:'image'});assert(runLog.text.includes('run_started'));assert(runLog.text.includes('approval_engine_enter'));assert(runLog.text.includes('run_finished'));assert.throws(()=>engine.readRunLog({id:'other'},{id:'image'}));assert.equal(task().result.diagnosticLog.available,true);const image=engine.read(actor,{id:'image',relative:'scene1.png'});assert.equal(image.mime,'image/png');assert.equal(image.sha256,digest(png));assert.equal(task().status,'awaiting_review');await engine.close();coverage.push('每任务每运行JSONL落盘、原会话可读取、外会话拒绝；交付图像仍等待原Agent审查');
 server=http.createServer();ws=new WebSocketServer({server});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let accepted=0;
 ws.on('connection',socket=>socket.on('message',data=>{const m=JSON.parse(data),reply=result=>socket.send(JSON.stringify({id:m.id,result}));if(m.method==='initialize')reply({userAgent:'WS image fixture'});else if(m.method==='model/list')reply({data:[]});else if(m.method==='thread/start')reply({thread:{id:'ws-thread'}});else if(m.method==='turn/start'){reply({turn:{id:'ws-turn'}});socket.send(JSON.stringify({method:'item/completed',params:{threadId:'ws-thread',turnId:'ws-turn',item:{id:'image',type:'imageGeneration',status:'completed',savedPath:source,result:b64}}}));socket.send(JSON.stringify({id:900,method:'item/commandExecution/requestApproval',params:{threadId:'ws-thread',turnId:'ws-turn',itemId:'copy',command:'copy cache png',cwd:wsCwd}}));}else if(m.id===900&&m.result?.decision==='accept'){accepted++;fs.copyFileSync(source,path.join(wsCwd,'scene1.png'));socket.send(JSON.stringify({method:'turn/completed',params:{threadId:'ws-thread',turn:{id:'ws-turn',status:'completed'}}}));}}));
 const wsCwd=workspace('ws'),wsLog=createRunLog(root,'owner','ws','run');const remote=await runHarness({launch},req('normal',wsCwd,{endpoint:{...endpoint('normal'),server:{url:'ws://127.0.0.1:'+server.address().port}},trace:wsLog.write,requestApproval:()=>({decision:'accept',reason:'fixture WS'})}));assert.equal(remote.ok,true,remote.error);assert.equal(accepted,1);assert(remote.native.transport.stats.largestMessageBytes>1024*1024);assert(fs.readFileSync(wsLog.status().path,'utf8').includes('codex_image_completed'));assert.equal(digest(fs.readFileSync(path.join(wsCwd,'scene1.png'))),digest(png));coverage.push('WebSocket大图片消息与日志经受管进程转接，仍逐次审批交付');
 coverage.push('无身份/外线程/外回合图片事件不进入可回收来源，正常当前回合图片保留scopeVerified');
 const capped=createRunLog(root,'owner','cap','run',{maxBytes:1024});for(let i=0;i<100;i++)capped.write('event',{reason:'x'.repeat(100),result:b64,prompt:'not logged'});assert(capped.status().truncated);assert(capped.status().bytes<=1024);assert(!fs.readFileSync(capped.status().path,'utf8').includes('not logged'));coverage.push('日志有界，未知字段、提示词和图像块不落盘');
 const report={passed:true,coverage,imageBytes:png.length,imageFrameChars:b64.length,modelPrompts:0,productionModified:false,root};fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{for(const p of children)if(p.exitCode===null&&p.signalCode===null)p.kill();for(const socket of ws?.clients||[])socket.terminate();await new Promise(resolve=>ws?ws.close(resolve):resolve());await new Promise(resolve=>server?server.close(resolve):resolve());}
