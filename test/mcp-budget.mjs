import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {PassThrough,Writable} from 'node:stream';
import {runMcp} from '../lib/mcp.js';
import {probeHarness} from '../lib/runner.js';
import {FakeClock} from './support/fake-clock.mjs';
const root=path.resolve('test-data','mcp-budget-'+Date.now());fs.mkdirSync(root,{recursive:true});
const endpoint={protocol:'mcp',command:process.execPath,args:[],mcp:{transport:'stdio',era:'auto',tool:'messages_send',arguments:{message:'{prompt}'}}};
const tools=[{name:'messages_send',inputSchema:{type:'object',properties:{message:{type:'string'}},required:['message']}}];
const hosts=[],coverage=[];
function host(options={}){
 const clock=new FakeClock(),sleep=ms=>new Promise(resolve=>clock.setTimeout(resolve,ms));
 const launches=[],messages=[];let modelToolCalls=0;
 const launch=async r=>{
  const index=launches.length;launches.push(r);if(options.launchDelay)await sleep(options.launchDelay);
  const stdout=new PassThrough(),stderr=new PassThrough();let resolveDone,stopping;
  const done=new Promise(resolve=>resolveDone=resolve);
  const stop=()=>stopping||(stopping=(async()=>{await sleep(options.cleanupDelay||0);stdout.end();stderr.end();resolveDone({exitCode:0});if(options.cleanupErrorOn===index)throw Error('fixture cleanup failed');})());
  const stdin=new Writable({write(chunk,_encoding,callback){
   const m=JSON.parse(chunk.toString());messages.push({index,method:m.method});callback();
   if(m.method==='tools/call'){modelToolCalls++;return;}
   const reply=value=>queueMicrotask(()=>stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,...value})+'\n'));
   if(m.method==='server/discover'){
    options.onDiscover?.(clock);if(options.discover==='silent')return;
    if(options.discover==='invalid'){queueMicrotask(()=>stdout.write('not json\n'));return;}
    reply({error:{code:-32601,message:'Method not found'}});
   }else if(m.method==='initialize'){
    options.onInitialize?.(clock);if(options.initialize==='silent')return;
    if(options.initialize==='error'){reply({error:{code:-32002,message:'initialize refused'}});return;}
    reply({result:{protocolVersion:'2025-11-25',serverInfo:{name:'budget fixture',version:'1'},capabilities:{tools:{}}}});
   }else if(m.method==='tools/list')reply({result:{tools}});
  }});
  const abort=()=>void stop().catch(()=>{});r.signal.addEventListener('abort',abort,{once:true});done.then(()=>r.signal.removeEventListener('abort',abort));
  stdin.on('finish',()=>{if(!r.argv.includes('--version'))void stop().catch(()=>{});});
  if(r.argv.includes('--version'))clock.setTimeout(()=>{stdout.write('0.2.0\n');void stop().catch(()=>{});},options.versionDelay||0);
  return {stdin,stdout,stderr,done,stop};
 };
 const h={launch,clock,launches,messages,get modelToolCalls(){return modelToolCalls;}};hosts.push(h);return h;
}
const request=(extra={})=>({endpoint:structuredClone(endpoint),cwd:root,owner:'budget-test',signal:new AbortController().signal,task:{timeoutMs:1500},prompt:'',probeOnly:true,...extra});
const failure=async(h,outcome)=>{try{await h.clock.settle(outcome);assert.fail('expected failure');}catch(error){assert(error.connectionReceipt,'missing diagnostic receipt: '+error.message);return error;}};
const probe=(h,extra={})=>h.clock.observe(runMcp(h,request(extra)));

let h=host({discover:'silent'}),r=await h.clock.settle(probe(h));
assert.equal(h.launches.length,2);assert.deepEqual(r.negotiationAttempts.map(a=>a.ok),[false,true]);assert.equal(r.negotiationAttempts[0].kind,'request_timeout');assert.equal(r.diagnostics.fallbackDecision.reason,'discovery_timeout');assert.equal(r.diagnostics.signalAborted,false);
coverage.push('请求超时与总超时分开，尚有预算时成功降级');

h=host({launchDelay:350,discover:'silent'});r=await h.clock.settle(probe(h,{task:{timeoutMs:1800}}));
assert.equal(r.diagnostics.launchMs,350);assert.equal(r.diagnostics.discoveryTimeoutMs,483);assert.equal(r.diagnostics.elapsedMs,1183);assert.equal(h.launches.length,2);
coverage.push('宿主启动耗时计入共同预算，重连不重置预算');

for(const source of ['caller','connection_deadline']){
 const controller=new AbortController();h=host({discover:'silent',onDiscover:clock=>clock.setTimeout(()=>controller.abort(Error(source+' cancelled')),30)});
 const error=await failure(h,probe(h,{signal:controller.signal,abortContext:{source}}));
 assert.equal(h.launches.length,1);assert.equal(error.connectionReceipt.negotiationAttempts.length,1);assert.equal(error.connectionReceipt.diagnostics.abortSource,source);assert.equal(error.connectionReceipt.diagnostics.fallbackDecision.reason,'upstream_abort');
}
coverage.push('用户取消与检查期限分别记录，均不再启动新进程');

h=host({cleanupDelay:400});let error=await failure(h,probe(h,{task:{timeoutMs:250}}));
assert.equal(h.launches.length,1);assert.equal(error.protocolStage,'legacy/reconnect');assert.equal(error.connectionReceipt.diagnostics.abortSource,'mcp_deadline');assert.equal(error.connectionReceipt.diagnostics.fallbackDecision.blockedBy,'total_deadline');assert.equal(error.connectionReceipt.diagnostics.reconnectCleanupMs,400);
coverage.push('重连清理耗尽预算时不启动新连接，保留原失败阶段');

h=host({cleanupDelay:400});error=await failure(h,probe(h,{endpoint:{...structuredClone(endpoint),mcp:{...endpoint.mcp,era:'legacy'}},task:{timeoutMs:250}}));
assert.equal(h.launches.length,1);assert.equal(error.protocolStage,'cleanup');assert.equal(error.connectionReceipt.diagnostics.abortSource,'mcp_deadline');assert.equal(error.connectionReceipt.diagnostics.cleanupMs,400);
coverage.push('握手成功后清理超期才归为cleanup，不假报ready');

h=host({discover:'invalid'});error=await failure(h,probe(h));assert.equal(h.launches.length,1);assert.equal(error.connectionReceipt.diagnostics.fallbackDecision.reason,'transport_or_total_failure');
coverage.push('损坏传输不被无条件降级掩盖');

// Hold both callbacks at the same deadline, then explicitly choose their order.
// A stalled event loop is represented by moving time without firing any callback.
const permutations=[];
for(let repeat=0;repeat<25;repeat++)for(const order of ['request-first','deadline-first'])for(const lag of [0,50]){
 h=host({initialize:'silent'});const outcome=probe(h,{task:{timeoutMs:300}});
 await h.clock.until(()=>h.messages.some(m=>m.method==='initialize'));
 const boundary=h.clock.pending().filter(timer=>timer.at===h.clock.now()+300);assert.equal(boundary.length,2);
 h.clock.advanceTo(boundary[0].at+lag);h.clock.fire(order==='request-first'?boundary.at(-1):boundary[0]);error=await failure(h,outcome);
 assert.equal(error.protocolStage,'initialize');assert.equal(error.connectionReceipt.diagnostics.failedPhase,'initialize');assert.equal(h.launches.length,2);assert.equal(error.connectionReceipt.negotiationAttempts.length,2);assert.equal(error.connectionReceipt.diagnostics.abortSource,'mcp_deadline');
 assert.equal(error.code,order==='request-first'?'MCP_REQUEST_TIMEOUT':'MCP_DEADLINE');
 permutations.push({order,lag,stage:error.protocolStage});
}
coverage.push('100次确定性调度：两种超时顺序及事件循环延迟均保留initialize');

h=host({initialize:'error',cleanupDelay:400});error=await failure(h,probe(h,{task:{timeoutMs:650}}));assert.equal(error.protocolStage,'initialize');assert.equal(error.rpcError.code,-32002);assert.equal(error.connectionReceipt.diagnostics.cleanupMs,400);
coverage.push('已有RPC失败不会被随后的清理超期覆盖');

h=host({initialize:'silent',cleanupErrorOn:1});error=await failure(h,probe(h,{task:{timeoutMs:300}}));assert.equal(error.protocolStage,'initialize');assert.equal(error.connectionReceipt.diagnostics.cleanupFailure.error,'fixture cleanup failed');
coverage.push('清理自身失败作为补充诊断，保留原握手错误');

h=host({cleanupErrorOn:0});error=await failure(h,probe(h,{endpoint:{...structuredClone(endpoint),mcp:{...endpoint.mcp,era:'legacy'}}}));assert.equal(error.protocolStage,'cleanup');assert.equal(error.connectionReceipt.diagnostics.failure.kind,'cleanup_error');
coverage.push('操作成功而清理首次失败时明确归为cleanup');

const controller=new AbortController();h=host({initialize:'error',cleanupDelay:100,onInitialize:clock=>clock.setTimeout(()=>controller.abort(Error('cancel during cleanup')),30)});error=await failure(h,probe(h,{signal:controller.signal}));assert.equal(error.protocolStage,'initialize');assert.equal(error.rpcError.code,-32002);assert.equal(error.connectionReceipt.diagnostics.abortSource,'caller');
coverage.push('错误后的清理期间取消不会覆盖原失败，取消来源仍记录');

const lateCancel=new AbortController();h=host({cleanupDelay:100,onInitialize:clock=>clock.setTimeout(()=>lateCancel.abort(Error('cancel successful handshake cleanup')),30)});error=await failure(h,probe(h,{endpoint:{...structuredClone(endpoint),mcp:{...endpoint.mcp,era:'legacy'}},signal:lateCancel.signal}));assert.equal(error.protocolStage,'cleanup');assert.equal(error.connectionReceipt.diagnostics.abortSource,'caller');
coverage.push('成功握手后的清理期间取消仍拒绝就绪');

h=host({versionDelay:350,initialize:'silent'});const e={...structuredClone(endpoint),probe_args:['--version']};const begin=h.clock.now();error=await failure(h,h.clock.observe(probeHarness(h,{...request({endpoint:e}),deadlineAt:begin+650})));
assert.equal(h.launches.length,3);assert.equal(error.protocolStage,'initialize');assert.equal(error.connectionReceipt.diagnostics.versionProbeMs,350);assert.equal(error.connectionReceipt.diagnostics.totalBudgetMs,300);assert.equal(h.clock.now()-begin,650);
coverage.push('版本预检与握手共享绝对期限，不依赖真实毫秒误差');

h=host({versionDelay:250});error=await failure(h,h.clock.observe(probeHarness(h,{...request({endpoint:e}),deadlineAt:h.clock.now()+150})));assert.equal(h.launches.length,1);assert.equal(error.protocolStage,'connection_budget');assert.equal(error.connectionReceipt.diagnostics.requestedEra,'auto');
coverage.push('预检已耗尽预算时没有MCP启动，仍记录实际模式');

const cancelled=new AbortController();cancelled.abort(Error('already cancelled'));h=host();error=await failure(h,probe(h,{signal:cancelled.signal}));assert.equal(h.launches.length,0);assert.equal(error.connectionReceipt.diagnostics.abortSource,'caller');
coverage.push('已取消的检查不启动进程');
assert(hosts.every(h=>h.modelToolCalls===0));assert(hosts.every(h=>h.clock.pending().length===0),'virtual timers leaked');
const report={passed:true,coverage,permutations:permutations.length,modelToolCalls:0,globalTimersModified:false,root};fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
