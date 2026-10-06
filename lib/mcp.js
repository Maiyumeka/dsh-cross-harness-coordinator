import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import Ajv from 'ajv/dist/ajv.js';
import Ajv2020 from 'ajv/dist/2020.js';
import {VERSION} from './version.mjs';
import {workerFile} from './bridges.js';
import {deliver} from './delivery.js';
import {systemClock} from './time.js';

// Bounded RPC over host-managed stdio or a sandboxed network worker.
export const MCP_VERSIONS=['2025-11-25','2025-06-18','2025-03-26','2024-11-05','2026-07-28'];
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const requireValue=(ok,message)=>{if(!ok)throw Error(message);};
const canonical=v=>Array.isArray(v)?v.map(canonical):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const inspect=(v,fn,depth=0)=>{requireValue(depth<=64,'MCP资料嵌套过深');if(typeof v==='string')fn(v);else if(v&&typeof v==='object')Object.values(v).forEach(x=>inspect(x,fn,depth+1));};
export function mcpUses(e,token){let found=false;inspect(e.mcp?.arguments,s=>{if(s.includes('{'+token+'}'))found=true;});return found;}
export function validateMcpDefinition(value={}){
 requireValue(object(value),'MCP调用定义需要对象');
 requireValue(Object.keys(value).every(k=>['transport','tool','arguments','era','deliveryField'].includes(k)),'MCP定义字段无效');
 const transport=value.transport||'stdio';requireValue(['stdio','streamable-http','sse'].includes(transport),'MCP传输无效');
 requireValue(value.era===undefined||['legacy','auto','modern'].includes(value.era),'mcp.era只接受legacy、auto或modern；2025-06-18等日期是协商的protocolVersion，不是era');
 requireValue(!value.deliveryField||/^[a-zA-Z][a-zA-Z0-9_]{0,80}$/.test(value.deliveryField),'MCP文件交付字段无效');
 if(value.tool!==undefined)requireValue(typeof value.tool==='string'&&value.tool.trim()&&value.tool.length<=128,'MCP工具名称无效');
 if(value.arguments!==undefined)requireValue(object(value.arguments),'MCP工具参数模板需要JSON对象');
 requireValue(JSON.stringify(value).length<=16000,'MCP调用定义过大');inspect(value,()=>{});
 return {...value,transport};
}
const argumentsFor=(e,values)=>{
 const replace=v=>typeof v==='string'?v.replace(/\{(prompt|workdir|model|reasoning)\}/g,(_match,key)=>values[key]):Array.isArray(v)?v.map(replace):object(v)?Object.fromEntries(Object.entries(v).filter(([,value])=>!(['{model}','{reasoning}'].includes(value)&&!values[value.slice(1,-1)])).map(([key,value])=>[key,replace(value)])):v;
 return replace(e.mcp.arguments);
};
function validator(schema){
 requireValue(object(schema),'MCP工具必须提供JSON Schema对象');requireValue(JSON.stringify(schema).length<=64000,'MCP工具Schema过大');inspect(schema,()=>{});
 const dialect=schema.$schema;
 requireValue(!dialect||['https://json-schema.org/draft/2020-12/schema','http://json-schema.org/draft-07/schema#','https://json-schema.org/draft-07/schema'].includes(dialect),'不支持的MCP工具JSON Schema版本');
 requireValue(!schema.$async,'不支持异步JSON Schema验证');
 const Class=dialect?.includes('draft-07')?Ajv:Ajv2020;
 const ajv=new Class({strictSchema:true,strictTypes:false,strictRequired:false,strictTuples:false,allowUnionTypes:true,validateFormats:false,ownProperties:true});
 const schemaId=schema.$id||'urn:dsh:mcp-schema:'+digest(schema);
 const validate=ajv.compile({...schema,$id:schemaId});requireValue(!validate.$async,'不支持异步JSON Schema验证');
 validate.atProperty=key=>ajv.getSchema(schemaId+'#/properties/'+encodeURIComponent(key.replaceAll('~','~0').replaceAll('/','~1')));return validate;
}
function binding(e,tools){
 requireValue(e.mcp?.tool&&object(e.mcp.arguments),'MCP已连接，请Agent根据工具列表提供任务工具名称及arguments参数映射');
 requireValue(mcpUses(e,'prompt'),'MCP任务工具参数必须明确映射{prompt}');
 const tool=tools.find(t=>t.name===e.mcp.tool);requireValue(tool,'MCP未提供指定任务工具：'+e.mcp.tool);
 requireValue(tool.inputSchema.type==='object','MCP任务工具inputSchema必须声明object参数');
 requireValue(tool.execution?.taskSupport!=='required','这个MCP工具要求异步task协议，当前桥接只支持直接tools/call返回');
 const validate=validator(tool.inputSchema);
 for(const key of tool.inputSchema.required||[])requireValue(Object.hasOwn(e.mcp.arguments,key),'MCP参数映射缺少必填字段：'+key);
 if(tool.inputSchema.additionalProperties===false)for(const key of Object.keys(e.mcp.arguments))requireValue(Object.hasOwn(tool.inputSchema.properties||{},key),'MCP参数映射包含未声明字段：'+key);
 for(const [key,value]of Object.entries(e.mcp.arguments)){
  let dynamic=false;inspect(value,s=>{if(/\{(?:prompt|workdir|model|reasoning)\}/.test(s))dynamic=true;});
  const check=Object.hasOwn(tool.inputSchema.properties||{},key)?validate.atProperty(key):null;
  if(check&&!dynamic)requireValue(check(value),'MCP固定参数不符合inputSchema：'+key);
  const type=tool.inputSchema.properties?.[key]?.type;
  if(dynamic&&typeof value==='string'&&type)requireValue(type==='string'||(Array.isArray(type)&&type.includes('string')),'MCP字符串模板映射到非字符串参数：'+key);
 }
 if(tool.outputSchema)validator(tool.outputSchema);
 return {tool,validate,fingerprint:digest({tool,mapping:e.mcp})};
}

export async function runMcp({launch,clock=systemClock},request){
 const {endpoint:e,cwd,signal,task,prompt,probeOnly=false}=request;
 requireValue(!e.args.some(a=>/\{(?:prompt|model|reasoning)\}/.test(a)),'MCP启动入口不能携带任务参数，请映射到tools/call arguments');
 const network=e.mcp.transport!=='stdio';
 const argv=network?[process.execPath,workerFile('mcp-network.mjs'),JSON.stringify({server:e.server,mcp:e.mcp})]:[e.command,...e.args.map(a=>a.replaceAll('{workdir}',cwd))];
 const started=clock.now(),deadlineAt=Math.min(request.deadlineAt||Infinity,started+task.timeoutMs),remaining=()=>Math.max(0,deadlineAt-clock.now());
 const diagnostics={requestedEra:e.mcp.era||'legacy',startedAt:new Date(started).toISOString(),totalBudgetMs:remaining(),launchMs:0,discoveryTimeoutMs:null,cleanupMs:0,elapsedMs:0,signalAborted:false,abortSource:'none',fallbackDecision:{attempted:false,reason:'not_required'}};
 const timeoutError=(message,code,timeoutMs)=>Object.assign(Error(message),{code,timeoutMs});
 const abortSource=()=>signal.aborted?(request.abortContext?.source==='connection_deadline'?'connection_deadline':'caller'):remaining()===0?'mcp_deadline':'none';
 const updateDiagnostics=()=>{diagnostics.elapsedMs=clock.now()-started;diagnostics.signalAborted=signal.aborted;diagnostics.abortSource=abortSource();};
 let h;try{signal.throwIfAborted();if(!remaining())throw timeoutError('MCP启动前预算已耗尽','MCP_DEADLINE',diagnostics.totalBudgetMs);h=await launch({...request,argv,env:e.launch_env||{}});diagnostics.launchMs=clock.now()-started;}catch(error){diagnostics.launchMs=clock.now()-started;updateDiagnostics();diagnostics.failedPhase='launch';diagnostics.fallbackDecision={attempted:false,reason:'launch_failed'};error.protocolStage='launch';error.connectionReceipt={protocol:'mcp',transport:e.mcp.transport,handshakeVerified:false,negotiationAttempts:[],diagnostics};throw error;}
 let phase='initialize',seq=0,buffer='',stderr='',closed=false,fatal=null,receipt=null,epoch=0,timer,modern=false,generation=0,primaryError=null;
 const negotiationAttempts=[];
 const failureDetails=error=>({error:String(error.message||error).slice(0,2000),kind:signal.aborted?'aborted':error.code==='MCP_REQUEST_TIMEOUT'?'request_timeout':error.code==='MCP_DEADLINE'?'total_deadline':error.rpcError?'rpc_error':'transport_error',...(Number.isFinite(error.timeoutMs)?{timeoutMs:error.timeoutMs}:{}),...(error.rpcError?{rpcError:{code:Number.isInteger(error.rpcError.code)?error.rpcError.code:null,message:String(error.rpcError.message||'').slice(0,1000),...(Array.isArray(error.rpcError.data?.supported)?{supported:error.rpcError.data.supported.filter(v=>typeof v==='string'&&v.length<=64).slice(0,16)}:{})}}:{})});
 const annotate=error=>{updateDiagnostics();error.protocolStage=error.protocolStage||phase;diagnostics.failedPhase=error.protocolStage;diagnostics.failure={stage:error.protocolStage,...failureDetails(error),...(error.protocolStage==='cleanup'&&diagnostics.cleanupFailure?{kind:'cleanup_error'}:{}),...(typeof error.code==='string'?{code:error.code.slice(0,80)}:{})};if(phase==='legacy/reconnect')diagnostics.fallbackDecision.blockedBy=signal.aborted?'upstream_abort':!remaining()?'total_deadline':'reconnect_failed';error.connectionReceipt={...(receipt||{protocol:'mcp',transport:e.mcp.transport,handshakeVerified:false}),negotiationAttempts,diagnostics};return error;};
 const metadata={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'dsh-cross-harness-coordinator',version:VERSION},'io.modelcontextprotocol/clientCapabilities':{}};
 const pending=new Map();
 const send=message=>new Promise((resolve,reject)=>{h.stdin.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n',error=>error?reject(error):resolve());});
 const notify=(method,params)=>send({method,...(params?{params}:{})});
 const rejectAll=error=>{for(const p of pending.values()){clock.clearTimeout(p.timer);p.reject(error);}pending.clear();};
 const cancelAll=reason=>{for(const [id,p]of pending)if(p.method!=='initialize')void notify('notifications/cancelled',{requestId:id,reason}).catch(()=>{});};
 const fail=error=>{fatal=error;rejectAll(error);void h.stop().catch(()=>{});};
 const onAbort=()=>{cancelAll('用户取消或调用超时');rejectAll(signal.reason instanceof Error?signal.reason:Error('MCP调用已取消'));void h.stop().catch(()=>{});};
 const stdinError=error=>rejectAll(error);
 signal.addEventListener('abort',onAbort,{once:true});
 const handle=m=>{
  requireValue(object(m)&&m.jsonrpc==='2.0','MCP输出不是有效JSON-RPC消息');
  if(m.id!==undefined&&!m.method){const p=pending.get(m.id);if(p){clock.clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Object.assign(Error('MCP '+p.method+'：'+JSON.stringify(m.error).slice(0,2000)),{rpcError:m.error})):p.resolve(m.result);}return;}
  if(m.id!==undefined&&m.method){
   requireValue(!modern,'现代MCP不允许服务端反向请求');
   const response=m.method==='ping'?{result:{}}:m.method==='roots/list'?{result:{roots:[{uri:pathToFileURL(cwd).href,name:'当前工作区'}]}}:{error:{code:-32601,message:'此客户端不提供sampling、elicitation或额外权限服务'}};
   void send({id:m.id,...response}).catch(fail);return;
  }
  if(m.method==='notifications/tools/list_changed')epoch++;
 };
 const onData=text=>{
  buffer+=text;
  try{
   let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).replace(/\r$/,'');buffer=buffer.slice(end+1);requireValue(Buffer.byteLength(line)<=1024*1024,'MCP消息超过1MiB');if(line.trim())handle(JSON.parse(line));}
   requireValue(Buffer.byteLength(buffer)<=1024*1024,'MCP消息超过1MiB');
  }catch(error){fail(Error('MCP传输错误：'+error.message));}
 };
 const attach=handle=>{
  const current=++generation;handle.stdin.on('error',stdinError);handle.stdout.setEncoding('utf8');handle.stdout.on('data',onData);
  handle.stderr.on('data',b=>{if(current===generation)stderr=network?'网络桥接产生诊断日志；未保存第三方原文':(stderr+b.toString()).slice(-256000);});
  handle.done.then(()=>{if(current===generation){closed=true;rejectAll(Error('MCP执行端已退出：'+stderr.slice(-1000)));}},error=>{if(current===generation){closed=true;rejectAll(error);}});
 };
 const stopConnection=async()=>{
  const previous=h;generation++;previous.stdout.removeListener('data',onData);previous.stdin.removeListener('error',stdinError);previous.stdin.on('error',()=>{});
  rejectAll(Error('MCP协商通道已关闭'));if(!previous.stdin.destroyed)previous.stdin.end();
  let graceTimer;try{await Promise.race([previous.done.catch(()=>{}),new Promise(resolve=>{graceTimer=clock.setTimeout(resolve,200);graceTimer.unref?.();})]);}finally{clock.clearTimeout(graceTimer);}
  await previous.stop();
 };
 const reconnectLegacy=async()=>{
  const reconnectStarted=clock.now();await stopConnection();diagnostics.reconnectCleanupMs=clock.now()-reconnectStarted;signal.throwIfAborted();if(fatal)throw fatal;if(!remaining())throw timeoutError('MCP总预算已耗尽，未启动降级连接','MCP_DEADLINE',diagnostics.totalBudgetMs);
  buffer='';stderr='';closed=false;epoch=0;modern=false;
  h=await launch({...request,argv,env:e.launch_env||{}});attach(h);diagnostics.reconnectMs=clock.now()-reconnectStarted;
 };
 attach(h);
 const req=(method,params)=>new Promise((resolve,reject)=>{
  if(fatal||closed||signal.aborted){reject(fatal||signal.reason||Error('MCP连接已关闭'));return;}
  const budget=remaining();if(!budget){reject(timeoutError('MCP连接或任务总预算已耗尽','MCP_DEADLINE',diagnostics.totalBudgetMs));return;}
  // Slow servers need time to boot; retain at least two thirds for fresh legacy startup.
  const id=++seq,timeout=method==='server/discover'?Math.max(1,Math.min(4000,Math.floor(budget/3))):method==='tools/call'?budget:Math.min(budget,15000);
  if(method==='server/discover')diagnostics.discoveryTimeoutMs=timeout;
  const requestTimer=clock.setTimeout(()=>{pending.delete(id);if(method!=='initialize')void notify('notifications/cancelled',{requestId:id,reason:'请求超时'}).catch(()=>{});reject(timeoutError('MCP连接或调用超时：'+method,'MCP_REQUEST_TIMEOUT',timeout));},timeout);
  pending.set(id,{resolve,reject,timer:requestTimer,method});void send({id,method,params:modern?{...params,_meta:metadata}:params}).catch(error=>{clock.clearTimeout(requestTimer);pending.delete(id);reject(error);});
 });
 try{
  signal.throwIfAborted();if(!remaining())throw timeoutError('MCP连接或任务总预算已耗尽','MCP_DEADLINE',diagnostics.totalBudgetMs);timer=clock.setTimeout(()=>{const error=timeoutError(probeOnly?'MCP连接检查超时':'MCP任务执行超时','MCP_DEADLINE',diagnostics.totalBudgetMs);cancelAll(error.message);fail(error);},remaining());timer.unref?.();
  let init,methods;
  if(['auto','modern'].includes(e.mcp.era)){
   phase='server/discover';modern=true;let discovered;
   try{discovered=await req('server/discover',{});negotiationAttempts.push({era:'modern',method:'server/discover',ok:true});}catch(error){
    negotiationAttempts.push({era:'modern',method:'server/discover',ok:false,...failureDetails(error)});
    if(error.rpcError?.code===-32022){diagnostics.fallbackDecision={attempted:false,reason:'modern_version_error'};requireValue(error.rpcError.data?.supported?.includes('2026-07-28'),'现代MCP没有共同版本，不能降级initialize');discovered=await req('server/discover',{});}
    else if(e.mcp.era==='modern'||signal.aborted||fatal||!remaining()){diagnostics.fallbackDecision={attempted:false,reason:e.mcp.era==='modern'?'explicit_modern':signal.aborted?'upstream_abort':fatal?'transport_or_total_failure':'total_deadline'};throw error;}
    else{diagnostics.fallbackDecision={attempted:true,reason:error.code==='MCP_REQUEST_TIMEOUT'?'discovery_timeout':'discovery_unavailable'};phase='legacy/reconnect';await reconnectLegacy();}
   }
   if(modern){requireValue(object(discovered)&&discovered.resultType==='complete'&&discovered.supportedVersions?.includes('2026-07-28'),'现代MCP发现结果或版本无效');init={protocolVersion:'2026-07-28',serverInfo:discovered._meta?.['io.modelcontextprotocol/serverInfo']||{name:'未申报',version:'未知'},capabilities:discovered.capabilities};methods=['server/discover','tools/list'];}
  }
  if(!modern){phase='initialize';try{init=await req('initialize',{protocolVersion:MCP_VERSIONS[0],capabilities:{roots:{listChanged:false}},clientInfo:{name:'dsh-cross-harness-coordinator',version:VERSION}});negotiationAttempts.push({era:'legacy',method:'initialize',ok:true});}catch(error){negotiationAttempts.push({era:'legacy',method:'initialize',ok:false,...failureDetails(error)});throw error;}requireValue(init?.protocolVersion!=='2026-07-28','现代MCP不能使用legacy initialize');methods=['initialize','notifications/initialized','tools/list'];}
  requireValue(object(init)&&MCP_VERSIONS.includes(init.protocolVersion),'MCP协议版本不兼容：'+String(init?.protocolVersion));
  requireValue(object(init.serverInfo)&&typeof init.serverInfo.name==='string'&&typeof init.serverInfo.version==='string','MCP未返回有效serverInfo');
  requireValue(object(init.capabilities)&&object(init.capabilities.tools),'MCP执行端没有申报tools能力');
  if(!modern){phase='notifications/initialized';await notify('notifications/initialized');}
  phase='tools/list';const tools=[],cursors=new Set();let cursor,discoveryEpoch=epoch;
  for(let page=0;page<16;page++){
   const result=await req('tools/list',cursor?{cursor}:{});requireValue(object(result)&&Array.isArray(result.tools),'MCP工具列表无效');
   for(const tool of result.tools){requireValue(object(tool)&&typeof tool.name==='string'&&tool.name.length>0&&tool.name.length<=128&&object(tool.inputSchema),'MCP工具定义无效');requireValue(!tools.some(t=>t.name===tool.name),'MCP工具名称重复');tools.push(tool);}
   requireValue(tools.length<=256&&Buffer.byteLength(JSON.stringify(tools))<=256000,'MCP工具列表过大');
   if(result.nextCursor===undefined)break;
   requireValue(typeof result.nextCursor==='string'&&result.nextCursor&&result.nextCursor.length<=2000&&!cursors.has(result.nextCursor)&&page<15,'MCP分页游标无效或超过16页');cursor=result.nextCursor;cursors.add(cursor);
  }
  requireValue(epoch===discoveryEpoch,'MCP工具列表在检查时发生变化，请重新连接');
  receipt={protocol:'mcp',transport:e.mcp.transport,protocolVersion:init.protocolVersion,serverInfo:init.serverInfo,serverCapabilities:init.capabilities,tools,handshakeVerified:true,methods,negotiationAttempts,diagnostics,checkedAt:new Date(clock.now()).toISOString()};
  phase='binding';const currentTool=tools.find(t=>t.name===e.mcp?.tool);
  if(!probeOnly&&currentTool&&e.connection?.binding?.fingerprint!==digest({tool:currentTool,mapping:e.mcp}))throw Object.assign(Error('MCP任务工具或参数映射已变化，请登记会话重新检查连接'),{reconnectRequired:true});
  let bound;try{bound=binding(e,tools);}catch(error){error.reconnectRequired=true;throw error;}receipt.binding={tool:bound.tool.name,fingerprint:bound.fingerprint};
  if(probeOnly)return receipt;
  const args=argumentsFor(e,{prompt,workdir:cwd,model:task.model||'',reasoning:task.reasoning||''});
  requireValue(bound.validate(args),'MCP工具参数不符合inputSchema：'+JSON.stringify(bound.validate.errors).slice(0,2000));
  requireValue(epoch===discoveryEpoch,'MCP工具列表在派发前发生变化，请重新检查连接');
  phase='tools/call';const result=await req('tools/call',{name:bound.tool.name,arguments:args});
  requireValue(!modern||result?.resultType==='complete','MCP要求额外输入或返回非完成结果；不自动批准权限');
  requireValue(object(result)&&Array.isArray(result.content),'MCP工具未返回直接调用结果，当前不支持异步task响应');
  requireValue(result.isError===undefined||typeof result.isError==='boolean','MCP工具isError字段无效');
  requireValue(result.content.every(c=>object(c)&&['text','image','audio','resource','resource_link'].includes(c.type)),'MCP工具返回了无效content类型');
  requireValue(result.structuredContent===undefined||object(result.structuredContent),'MCP structuredContent必须是JSON对象');
  const output=result.content.filter(c=>c?.type==='text'&&typeof c.text==='string').map(c=>c.text).join('\n').slice(-256000);
  if(!result.isError&&bound.tool.outputSchema){const validate=validator(bound.tool.outputSchema);requireValue(object(result.structuredContent)&&validate(result.structuredContent),'MCP structuredContent不符合outputSchema');}
  if(network&&!result.isError){requireValue(e.mcp.deliveryField&&Array.isArray(result.structuredContent?.[e.mcp.deliveryField]),'网络MCP必须通过已映射的structuredContent字段实际交付声明文件');deliver(cwd,task.outputs,result.structuredContent[e.mcp.deliveryField]);}
  return {ok:result.isError!==true,output,stderr,usage:null,mcp:{tool:bound.tool.name,protocolVersion:init.protocolVersion,content:result.content,...(result.structuredContent===undefined?{}:{structuredContent:result.structuredContent})},error:result.isError?'MCP工具执行失败：'+output.slice(-2000):''};
 }catch(error){if(!probeOnly&&['initialize','legacy/reconnect','notifications/initialized','tools/list'].includes(phase))error.reconnectRequired=true;primaryError=annotate(error);throw primaryError;}
 finally{
  clock.clearTimeout(timer);rejectAll(Error('MCP调用结束'));signal.removeEventListener('abort',onAbort);
  let cleanupError;const cleanupStarted=clock.now();
  try{await stopConnection();}catch(error){cleanupError=error;diagnostics.cleanupFailure={error:String(error.message||error).slice(0,2000),kind:'cleanup_error'};}finally{diagnostics.cleanupMs=clock.now()-cleanupStarted;diagnostics.cleanupDeadlineExceeded=!remaining();updateDiagnostics();}
  // Cleanup adds evidence to an existing failure; it must not replace its cause or stage.
  if(!primaryError){
   phase='cleanup';
   if(cleanupError){cleanupError.protocolStage=phase;throw annotate(cleanupError);}
   if(signal.aborted){const error=signal.reason instanceof Error?signal.reason:Error('MCP调用已取消');throw annotate(error);}
   if(fatal)throw annotate(fatal);
   if(!remaining())throw annotate(timeoutError('MCP清理结束时总预算已耗尽','MCP_DEADLINE',diagnostics.totalBudgetMs));
  }
 }
}
