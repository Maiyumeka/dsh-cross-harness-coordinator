import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {VERSION} from './version.mjs';
import {validateMcpDefinition,mcpUses,MCP_VERSIONS} from './mcp.js';

const hash=b=>createHash('sha256').update(b).digest('hex');
const clone=x=>JSON.parse(JSON.stringify(x));
const requireValue=(condition,message)=>{if(!condition)throw Error(message);};
// Hash executable bytes with bounded memory; large native Harness binaries are valid.
function startupHash(file){
 const fd=fs.openSync(file,'r');
 try{
  const before=fs.fstatSync(fd,{bigint:true});requireValue(before.isFile(),'启动路径必须是文件');
  const digest=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let count;
  while((count=fs.readSync(fd,buffer,0,buffer.length,null))>0)digest.update(buffer.subarray(0,count));
  const after=fs.fstatSync(fd,{bigint:true}),current=fs.statSync(file,{bigint:true});
  const same=stat=>['dev','ino','size','mtimeNs','ctimeNs'].every(key=>stat[key]===before[key]);
  requireValue(same(after)&&same(current),'启动文件在校验时发生变化，请等待更新完成后重新接入');
  return digest.digest('hex');
 }finally{fs.closeSync(fd);}
}
const text=(v,max=16000)=>{requireValue(typeof v==='string'&&v.trim()&&v.length<=max,'字段需要有效文字');return v.trim();};
const key=v=>{requireValue(typeof v==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(v),'任务或执行端编号无效');return v;};
const strings=(v,max=40)=>{requireValue(Array.isArray(v)&&v.length<=max&&v.every(x=>typeof x==='string'&&x.length<=16000),'数组字段无效');return v;};
// 查询结果必须能无损往返 JSON：宿主会拒绝含 undefined 的返回值
// （JSON.stringify 会静默丢弃它，而工具边界不允许静默丢数据）。
// 净化对象与数组内部的 undefined、函数与 symbol；Date 规范化成 ISO 字符串。
const stripUndefined=v=>{
 if(Array.isArray(v))return v.map(stripUndefined).filter(x=>x!==undefined);
 if(v instanceof Date)return v.toISOString();
 if(v&&typeof v==='object'){const out={};for(const [k,x] of Object.entries(v)){const clean=stripUndefined(x);if(clean!==undefined)out[k]=clean;}return out;}
 return (typeof v==='function'||typeof v==='symbol')?undefined:v;
};
const unfinished=new Set(['running','stopping','awaiting_review','queued','blocked']);
// 执行端可见性：默认对本机所有会话共享（用户宣言），由【登记它的会话】决定是否共享。
// 共享不是"忽略登记"——执行端仍须由用户邀请接入且 confirmed，程序文件指纹仍逐次核对。
const SHARE_KEY='sharePolicy',DECL_KEY='declaration',SHARED='all',PRIVATE='session';
const sharePolicy=s=>s?.[SHARE_KEY]===PRIVATE?PRIVATE:SHARED;
// 失败原因的已知修复建议。只给"该改哪个字段/该填哪个变量"，不代替用户做选择、不绕过宿主限制。
const remedy=text=>{
 const t=String(text||''),out=[];
 if(/run as node|ELECTRON_RUN_AS_NODE/i.test(t))out.push('检测到 ELECTRON_RUN_AS_NODE：在登记该执行端时通过 launch_env 传 ELECTRON_RUN_AS_NODE=0，或让宿主以 Electron 模式启动。');
 if(/trusted directory|skip-git-repo-check/i.test(t))out.push('执行端要求受信任目录：把工作区初始化为 git 仓库，或在调用定义 args 里补 --skip-git-repo-check。');
 if(/read-only sandbox|writing is blocked/i.test(t))out.push('执行端默认只读沙箱：按该 CLI 的参数补写权限（如 Codex 的 -s workspace-write）。');
 if(/provider|api[_ -]?key|no_provider/i.test(t))out.push('执行端没有可用模型 provider：由用户先配置其凭据（注意不要用 text 桥接冒充）。');
 if(/sandbox\.backend_unavailable|not ready/i.test(t))out.push('执行端沙箱后端未就绪：保持未验证并报告环境限制。');
 if(/timeout|超时/i.test(t))out.push('确认工作区磁盘状态与已有日志后再重派。');
 out.push('若该端持续不可用，用 coordinator_control action=rework 携带 endpoint 把此任务改派到另一个可用执行端。');
 return out;
};
// 宣言由系统按策略自动生成（Agent 判定并书写），带生成时间；不向会话发唤醒通知，只入历史。
const makeDeclaration=(policy,at)=>({text:policy===SHARED?'本机已接入的执行端对本机所有会话开放：任一会话均可派发任务给它们，无需重复接入。执行端仍须由用户亲自邀请登记，程序文件指纹逐次核对；如不再需要跨会话使用，切回"仅本会话"即可。':'本机执行端仅限登记它的会话使用：其他会话看不到、也无法派发任务给它。',at,source:'system'});
export class Coordinator {
 constructor({dir,run,probe,notify=async()=>false,concurrency=2}){
  this.dir=path.resolve(dir);this.run=run;this.probe=probe;this.notify=notify;this.concurrency=concurrency;this.live=new Map();this.connecting=new Map();this.scheduled=false;this.closed=false;this.notifying=new Set();
  fs.mkdirSync(this.dir,{recursive:true});this.file=path.join(this.dir,'state.json');
  this.state=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{schema:1,sessions:{},endpoints:{},events:[]};
  requireValue(this.state.schema===1,'不支持的数据版本');
  for(const e of Object.values(this.state.endpoints))if(['acp','mcp'].includes(e.protocol)&&(!e.connection||e.connection.state==='checking'))e.connection={state:'unverified',error:'尚未完成登记时'+e.protocol.toUpperCase()+'连接验证，请由登记会话检查连接'};
  this.concurrency=this.state.preferences?.concurrency||concurrency;
  for(const s of Object.values(this.state.sessions)){
   s.paused=true;for(const t of s.tasks)if(unfinished.has(t.status)){t.recovery_from=t.status;t.status='paused';t.error='插件重启，须核对真实进度后恢复';}
  }this.save();
 }
 save(){const tmp=this.file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.state,null,2));fs.renameSync(tmp,this.file);}
 event(s,kind,message){const event={id:randomUUID(),at:new Date().toISOString(),session:s.id,kind,message};this.state.events.push(event);this.state.events=this.state.events.slice(-2000);s.pendingEvents.push(event.id);this.save();this.kickNotify(s.id);}
 session(actor,create=false){requireValue(actor?.id,'只能由绑定会话操作');let s=this.state.sessions[actor.id];if(!s&&create){requireValue(path.isAbsolute(actor.cwd)&&fs.existsSync(actor.cwd),'当前会话需要已有工作目录');s=this.state.sessions[actor.id]={id:actor.id,cwd:fs.realpathSync(actor.cwd),title:'当前会话',paused:false,tasks:[],pendingEvents:[]};this.save();}requireValue(s,'此会话尚未创建协调任务');if(actor.cwd)requireValue(fs.realpathSync(actor.cwd)===s.cwd,'工作目录发生变化，请使用原会话目录核对');return s;}
 filePath(s,relative){requireValue(typeof relative==='string'&&relative.length&&relative.length<1000&&!path.isAbsolute(relative),'产物必须是工作目录内相对路径');const target=path.resolve(s.cwd,relative),rel=path.relative(s.cwd,target);requireValue(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel),'产物路径越界');let p=target;while(!fs.existsSync(p)){const parent=path.dirname(p);requireValue(parent!==p,'路径不存在');p=parent;}const real=fs.realpathSync(p),r=path.relative(s.cwd,real);requireValue(!r.startsWith('..')&&!path.isAbsolute(r),'产物链接指向工作区外');return target;}
 snapshot(s,t){return t.outputs.map(relative=>{const file=this.filePath(s,relative);if(!fs.existsSync(file))return {path:relative,missing:true};const stat=fs.statSync(file);requireValue(stat.isFile(),'声明产物不是文件');requireValue(stat.size<=64*1024*1024,'产物超过64MB，首版无法完成内容哈希核对');return {path:relative,size:stat.size,sha256:hash(fs.readFileSync(file))};});}
 resultVersion(artifacts){return hash(JSON.stringify(artifacts));}
 public(actor){const s=this.state.sessions[actor.id];if(!s)return {version:VERSION,session:actor.id,title:'当前会话',paused:false,tasks:[],endpoints:[],events:[]};return stripUndefined({...clone(s),version:VERSION,endpoints:Object.values(this.state.endpoints).filter(e=>this.vis(s,e)).map(({fingerprints,...rest})=>({...rest,ownerHere:rest.owner===s.id})),events:this.state.events.filter(e=>e.session===s.id).slice(-40)});}
 // 可见性：本会话自己登记的执行端始终可见；他人登记的、且其登记会话未取消共享时才可见。
 vis(s,e){return !!e&&!!s&&(e.owner===s.id||sharePolicy(this.state.sessions[e.owner])===SHARED);}
 prefs(actor,change){
  const s=this.session(actor,true),count=()=>Object.values(this.state.endpoints).filter(e=>e.confirmed&&e.owner!==s.id).length;
  if(change===undefined)return {sharePolicy:sharePolicy(s),declaration:s[DECL_KEY]||makeDeclaration(sharePolicy(s),null),crossSessionEndpoints:count()};
  requireValue([SHARED,PRIVATE].includes(change.sharePolicy),'共享策略无效');s[SHARE_KEY]=change.sharePolicy;s[DECL_KEY]=makeDeclaration(change.sharePolicy,new Date().toISOString());
  this.save();return {sharePolicy:change.sharePolicy,declaration:s[DECL_KEY],crossSessionEndpoints:count()};
 }
 endpoint(actor,input){
  const s=this.session(actor,true);const e=clone(input);e.id=key(e.id);requireValue(!this.connecting.has(e.id),'连接正在检查，请等待结果');requireValue(!this.state.endpoints[e.id]||this.live.size===0,'有执行中的任务，不能修改已有执行端');e.label=text(e.label,80);e.protocol=e.protocol||'text';requireValue(['text','acp','mcp'].includes(e.protocol),'只支持text、ACP或MCP本机入口');requireValue(path.isAbsolute(e.command)&&fs.existsSync(e.command)&&fs.statSync(e.command).isFile(),'启动程序须为已有绝对路径');requireValue(!/\.(cmd|bat|ps1)$/i.test(e.command),'请提供底层可执行程序和参数');e.args=strings(e.args||[],80);e.probe_args=strings(e.probe_args||[],80);e.prompt_mode=e.prompt_mode||'stdin';requireValue(['stdin','arg'].includes(e.prompt_mode),'提示词方式无效');e.owner=s.id;e.confirmed=true;e.capabilities=e.capabilities||{};
  if(e.protocol==='mcp'){e.mcp=validateMcpDefinition(e.mcp);requireValue(!e.args.some(a=>/\{(?:prompt|model|reasoning)\}/.test(a)),'MCP启动参数不能携带任务，请在mcp.arguments中映射');}
  // A callback cannot supply its own successful connection receipt.
  e.connection={state:['acp','mcp'].includes(e.protocol)?'unverified':'not_applicable'};
  e.launch_env=e.launch_env||{};requireValue(Object.keys(e.launch_env).length<=8,'配置目录过多');for(const [name,value]of Object.entries(e.launch_env))requireValue(/^[A-Z][A-Z0-9_]*(?:_HOME|_DIR)$/.test(name)&&typeof value==='string'&&path.isAbsolute(value)&&fs.existsSync(value)&&fs.statSync(value).isDirectory(),'仅接受已有配置目录变量，不接受密钥');
  requireValue(!this.state.endpoints[e.id]||this.state.endpoints[e.id].owner===s.id,'执行端属于其他会话');e.fingerprints=this.fingerprints(e);this.state.endpoints[e.id]=e;this.event(s,'endpoint','用户接入邀请登记 '+e.label);return this.public(actor);
 }
 fingerprints(e){return [...new Set([e.command,...[...e.args,...e.probe_args].filter(p=>path.isAbsolute(p)&&fs.existsSync(p)&&fs.statSync(p).isFile())])].map(file=>({file,sha256:startupHash(file)}));}
 checkEndpoint(e){requireValue(JSON.stringify(this.fingerprints(e))===JSON.stringify(e.fingerprints),'执行端程序或脚本已变化，请重新确认接入');}
 async connectEndpoint(actor,id,{signal,definition}={}){
  const s=this.session(actor),original=this.state.endpoints[key(id)];
  requireValue(!this.closed,'插件正在关闭');requireValue(original&&original.owner===s.id,'只能检查或修正本会话登记的执行端');
  requireValue(['acp','mcp'].includes(original.protocol),'这个执行端使用text协议，没有协议连接检查');requireValue(!this.connecting.has(id),'连接正在检查，请等待结果');
  requireValue(![...this.live.values()].some(l=>l.t.endpoint===id||l.cwd===s.cwd),'执行端或当前工作区仍有任务运行，请等待空闲');
  if(definition){
   requireValue(typeof definition==='object'&&!Array.isArray(definition),'调用定义需要JSON对象');
   const target=definition.protocol||original.protocol;requireValue(['acp','mcp'].includes(target),'协议连接失败不能改报text绕过检查');
   requireValue(Object.keys(definition).every(k=>['command','args','probe_args','launch_env','capabilities','prompt_mode','protocol',...(target==='mcp'?['mcp']:[])].includes(k)),'仅可修正已有协议执行端的调用定义');
   requireValue(!Object.values(this.state.sessions).some(x=>x.tasks.some(t=>t.endpoint===id&&!['cancelled','failed','unverified'].includes(t.status))),'仍有任务引用该执行端，不能更改调用定义');
   this.endpoint(actor,{...original,...definition});
  }
  const e=this.state.endpoints[id],protocol=e.protocol.toUpperCase(),controller=new AbortController();
  const abort=()=>controller.abort(signal.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const record={controller,cwd:s.cwd,promise:null};this.connecting.set(id,record);
  e.connection={state:'checking',startedAt:new Date().toISOString()};this.save();
  const timer=setTimeout(()=>controller.abort(Error(protocol+'连接检查超时（15秒）')),15000);timer.unref?.();
  record.promise=(async()=>{
   try{
    controller.signal.throwIfAborted();this.checkEndpoint(e);requireValue(typeof this.probe==='function','宿主未提供'+protocol+'连接检查入口');
    const receipt=await this.probe({owner:s.id,cwd:s.cwd,endpoint:clone(e),signal:controller.signal});
    controller.signal.throwIfAborted();
    if(e.protocol==='mcp'){
     requireValue(receipt?.protocol==='mcp'&&MCP_VERSIONS.includes(receipt.protocolVersion)&&receipt.handshakeVerified===true&&receipt.binding?.tool===e.mcp.tool&&receipt.binding?.fingerprint&&receipt.methods?.includes('notifications/initialized')&&receipt.methods?.includes('tools/list'),'MCP检查未返回握手、工具发现和任务映射证据');
     e.connection={...stripUndefined(receipt),state:'ready',workspace:s.cwd,capabilitiesAreReported:true};
    }else{
     requireValue(receipt?.protocolVersion===1&&receipt.sessionCreated===true&&receipt.methods?.includes('initialize')&&receipt.methods?.includes('session/new'),'ACP检查未返回完整握手和会话证据');
     e.connection={state:'ready',...stripUndefined({protocolVersion:receipt.protocolVersion,agentInfo:receipt.agentInfo||{},agentCapabilities:receipt.agentCapabilities||{},methods:receipt.methods,checkedAt:receipt.checkedAt}),workspace:s.cwd,sessionCreated:true,capabilitiesAreReported:true};
    }
    this.checkEndpoint(e);this.save();
   }catch(error){
    e.connection={...stripUndefined(error.connectionReceipt||{}),state:'needs_agent',stage:error.protocolStage||error.acpStage||'launch',error:String(error.message||error).slice(0,2000),checkedAt:new Date().toISOString()};
    if(!this.closed)this.event(s,'connection',e.label+'（'+e.id+'）'+protocol+'连接验证失败：'+e.connection.error+'。请当前Agent核对实际入口、配置、MCP工具映射或宿主限制；可用coordinator_control connect检查已有执行端，必要时提供definition修正后重试一次。不发模型任务、不放宽权限、不把自报结果标记为通过。');else this.save();
   }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.connecting.delete(id);this.schedule();}
   return stripUndefined({endpointId:id,label:e.label,registered:true,connected:e.connection.state==='ready',connection:clone(e.connection)});
  })();return record.promise;
 }
 readyEndpoint(e){requireValue(e?.confirmed,'执行端未登记');requireValue(!['acp','mcp'].includes(e.protocol)||e.connection?.state==='ready',e.protocol.toUpperCase()+'连接尚未验证通过，请登记会话先检查连接');}
 // 移除执行端：只允许登记它的会话移除；仍有未终结任务引用时拒绝（已取消/失败/无法验证的不再锁住执行端）。
 removeEndpoint(actor,id){
  const s=this.session(actor,true),e=this.state.endpoints[key(id)];
  requireValue(e,'执行端不存在');
  requireValue(e.owner===s.id,'只能移除本会话登记的执行端');
  requireValue(!this.connecting.has(id),'连接正在检查，请等待结果');
  requireValue(this.live.size===0,'有执行中的任务，请先暂停再移除');
  const blockingTerminal=new Set(['cancelled','failed','unverified']);
  const used=[...new Set(Object.values(this.state.sessions).flatMap(x=>(x.tasks||[]).filter(t=>t.endpoint===e.id&&!blockingTerminal.has(t.status)).map(t=>t.id+'('+t.status+')')))];
  requireValue(used.length===0,'仍有未终结任务引用该执行端（'+used.join('、')+'），请先取消这些任务');
  delete this.state.endpoints[e.id];
  // 清掉该执行端的接入资料残留（只删确实含此 id 的文件，避免误删别人的回传）。
  try{const dir=path.join(this.dir,'invitations');for(const f of fs.readdirSync(dir)){if(!/^response.*\.json$/i.test(f))continue;const p=path.join(dir,f);if(fs.readFileSync(p,'utf8').includes(e.id))fs.unlinkSync(p);}}catch{}
  this.save();return {removed:e.id,label:e.label,remaining:Object.keys(this.state.endpoints).length};
 }
 plan(actor,{title,tasks}){
  const s=this.session(actor,true);requireValue(!s.tasks.some(t=>this.live.has(t.runId)),'请先暂停执行，再修改计划');requireValue(Array.isArray(tasks)&&tasks.length>0&&tasks.length<=30,'首版计划需1至30项任务');const seen=new Set();
  const normalized=tasks.map(raw=>{const t=clone(raw);t.id=key(t.id);requireValue(!seen.has(t.id),'任务编号重复');seen.add(t.id);t.title=text(t.title,200);t.prompt=text(t.prompt);t.endpoint=key(t.endpoint);const e=this.state.endpoints[t.endpoint];requireValue(e?.confirmed&&this.vis(s,e),'执行端尚未由用户接入，或未对当前会话共享');t.dependencies=strings(t.dependencies||[]);t.outputs=strings(t.outputs,20);requireValue(t.outputs.length>0,'任务需要声明产物');t.outputs.forEach(p=>this.filePath(s,p));t.criteria=strings(t.criteria,20);requireValue(t.criteria.length>0&&t.criteria.every(x=>x.trim()),'每项任务须明确验收条件');t.reason=text(t.reason,2000);t.model=String(t.model||'');t.reasoning=String(t.reasoning||'');
   this.readyEndpoint(e);requireValue(!t.model||(e.protocol==='mcp'?e.capabilities.modelSelection===true&&mcpUses(e,'model'):e.args.some(a=>a.includes('{model}'))||(e.protocol==='acp'&&e.capabilities.modelSelection===true)),'这个执行端没有经过确认的模型选择方式');requireValue(!t.reasoning||(e.capabilities.reasoningSelection===true&&(e.protocol==='mcp'?mcpUses(e,'reasoning'):e.args.some(a=>a.includes('{reasoning}')))),'这个执行端没有经过确认的思考强度参数');
   return {...t,revision:1,status:'queued',history:[],reviews:[],autoReworks:0,timeoutMs:Math.min(1800000,Math.max(1000,Number(t.timeoutMs)||300000))};});
  const visit=(id,stack=new Set(),done=new Set())=>{requireValue(!stack.has(id),'存在循环依赖：'+id);if(done.has(id))return;const t=normalized.find(t=>t.id===id);requireValue(t,'缺少前置任务：'+id);stack.add(id);for(const dep of t.dependencies)visit(dep,stack,done);stack.delete(id);done.add(id);};normalized.forEach(t=>visit(t.id));
  const outputOwners=new Set();for(const t of normalized)for(const p of t.outputs){const normalizedPath=this.filePath(s,p).toLowerCase();requireValue(!outputOwners.has(normalizedPath),'多个任务声明同一产物，请分开产物路径');outputOwners.add(normalizedPath);}
  if(s.tasks.length){requireValue(s.tasks.every(t=>!unfinished.has(t.status)&&t.status!=='paused'),'已有未完成计划，请修改任务而非覆盖计划');s.previousPlans=s.previousPlans||[];s.previousPlans.push(clone(s.tasks));}
  s.tasks=normalized;s.title=text(title,200);this.event(s,'plan','当前Agent创建计划：'+s.title);this.schedule();return this.public(actor);
 }
 getTask(s,id){const t=s.tasks.find(t=>t.id===id);requireValue(t,'任务不存在');return t;}
 ready(s,t){return t.dependencies.every(id=>{const d=this.getTask(s,id);return d.status==='passed'&&d.result&&this.resultVersion(this.snapshot(s,d))===d.result.version;});}
 schedule(){if(this.scheduled||this.closed)return;this.scheduled=true;queueMicrotask(()=>{this.scheduled=false;this.pump();});}
 // 产物核对：比较"当前指纹"与"上次通过审查时的指纹"。事件驱动，可由 pump() 或 read() 触发。
 // 不变量只有三条，关键是"缺失时绝不去跟缺文件的版本号比"（那必然不等，会把任务误判为被改写）：
 //  · 产物缺失 → 交付物不完整，回到待审查等待（保留审查记录）；blocked 是终态，不在这里用；
 //  · 产物在且指纹 == 上次通过审查时的指纹 → 同一份字节，原审查自动生效，不必重新审查；
 //  · 产物在且指纹不同 → 真的被改写，作废审查并作废下游。
 guard(s){
  if(!s||s.paused)return;
  for(const t of s.tasks.filter(t=>t.status==='passed'||(t.status==='awaiting_review'&&t.result&&(t.reviews||[]).some(r=>r.verdict==='pass')))){
   let snap,why='';
   try{snap=this.snapshot(s,t);}catch(e){snap=null;why='声明产物无法核对（'+(e.message||'未知原因')+'）；请核对后重新读取审查。';}
   const missing=!snap||snap.some(a=>a.missing);
   const reviewed=t.result&&(t.reviews||[]).some(r=>r.verdict==='pass')?t.result.version:null;
   if(missing){
    if(t.status==='passed'){
     t.status='awaiting_review';
     t.error=snap?'声明产物暂时缺失，等待内容恢复；字节与原审查一致即自动生效，否则需重新读取并核对。':why;
     this.event(s,'artifact',t.title+'：'+t.error);
    }
   }else{
    const version=this.resultVersion(snap);
    if(reviewed&&version===reviewed){
     // 同一份字节：原审查继续有效。缺失期间被降级为待审查的，在这里恢复为通过。
     if(t.status!=='passed'){
      t.status='passed';t.error='';t.reads=Object.fromEntries(snap.map(a=>[a.path,a.sha256]));
      this.event(s,'review',t.title+'：产物内容与已通过审查的版本一致，原审查自动生效');
     }
    }else if(version!==t.result.version){
     // 字节确实变了才作废。这一条与上面互斥；若写成"仅当没有通过审查时"才作废，就会放过真改写。
     this.invalidate(s,t,'产物内容变化，原审查失效',false);
    }
   }
  }
 }
 pump(){
  if(this.closed)return;for(const s of Object.values(this.state.sessions)){
   if(s.paused)continue;
   this.guard(s);
   if(this.live.size>=this.concurrency)return;
   // A single writer per workspace; dependencies alone cannot prevent overlapping shell edits.
   if([...this.live.values(),...this.connecting.values()].some(l=>l.cwd===s.cwd))continue;
   for(const t of s.tasks.filter(t=>t.status==='queued')){try{if(this.ready(s,t)){this.start(s,t);break;}}catch(e){this.block(s,t,e.message);}}
  }
 }
 start(s,t){
  const endpoint=this.state.endpoints[t.endpoint];try{this.readyEndpoint(endpoint);this.checkEndpoint(endpoint);}catch(e){this.block(s,t,e.message);return;}
  t.runId=randomUUID();const runId=t.runId,revision=t.revision,controller=new AbortController();t.status='running';t.error='';t.inputVersions=Object.fromEntries(t.dependencies.map(id=>[id,this.getTask(s,id).result.version]));
  const record={s,t,cwd:s.cwd,controller,promise:null};this.live.set(runId,record);this.event(s,'started',t.title+' → '+endpoint.label);
  record.promise=(async()=>{
   try{
    const prompt=[t.prompt,'验收条件：'+t.criteria.join('；'),'工作目录：'+s.cwd,'仅写入本任务范围，交付相对路径：'+t.outputs.join('、'),t.reworkFeedback?'返工要求：'+t.reworkFeedback:'',t.recovery_from?'恢复任务：先检查已有文件及日志，报告已完成/需修复/未开始，不盲目重复操作。':''].filter(Boolean).join('\n');
    const result=await this.run({owner:s.id,cwd:s.cwd,endpoint:clone(endpoint),task:clone(t),prompt,signal:controller.signal});
    if(t.runId!==runId||t.revision!==revision||t.invalidated){t.history.push({runId,revision,superseded:true,result});return;}
    if(controller.signal.aborted){t.status=t.cancelRequested?'cancelled':'paused';t.error='执行已停止，恢复时需核对进度';return;}
    const artifacts=this.snapshot(s,t);t.result={...result,artifacts,version:this.resultVersion(artifacts),revision,inputVersions:t.inputVersions};
    if(result.ok===false){t.status='failed';t.error=result.error||'执行失败';t.remedy=remedy(t.error+'\n'+String(result.stderr||''));}else{t.status='awaiting_review';t.error=artifacts.some(a=>a.missing)?'有声明产物缺失，待当前Agent检查':'等待当前对话Agent检查真实产物';delete t.remedy;}delete t.recovery_from;this.event(s,'result',t.title+'：'+t.error);
   }catch(e){if(!t.invalidated){t.status=controller.signal.aborted?(t.cancelRequested?'cancelled':'paused'):'failed';t.error=String(e.message);if(endpoint.protocol==='mcp'&&e.reconnectRequired&&!controller.signal.aborted){endpoint.connection={...stripUndefined(e.connectionReceipt||{}),state:'needs_agent',stage:e.protocolStage||'binding',error:t.error,checkedAt:new Date().toISOString()};const owner=this.state.sessions[endpoint.owner];if(owner)this.event(owner,'connection',endpoint.label+' MCP工具连接需要重新核对：'+t.error);}this.event(s,'error',t.title+'：'+t.error);}}
   finally{this.live.delete(runId);if(t.invalidated){delete t.invalidated;t.status=s.paused?'paused':'queued';}this.save();this.schedule();}
  })();
 }
 read(actor,{id,relative},agentRead=true){const s=this.session(actor),t=this.getTask(s,id);this.guard(s);requireValue(t.outputs.includes(relative),'只能读取声明产物');const file=this.filePath(s,relative);requireValue(fs.existsSync(file),'产物不存在');const size=fs.statSync(file).size;requireValue(size<=10*1024*1024,'预览文件超过10MB，请用宿主文件工具读取');const buffer=fs.readFileSync(file),ext=path.extname(file).toLowerCase();const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.wav':'audio/wav','.mp3':'audio/mpeg','.ogg':'audio/ogg'}[ext];const value={path:file,relative,sha256:hash(buffer),size,...(mime?{mime,base64:buffer.toString('base64')}:{text:buffer.toString('utf8').slice(0,256000)})};if(agentRead){t.reads=t.reads||{};t.reads[relative]=value.sha256;this.save();}return value;}
 review(actor,{id,revision,version,verdict,checks,note}){
  const current=this.session(actor),target=this.getTask(current,id);for(const id of target.dependencies){const parent=this.getTask(current,id);requireValue(parent.status==='passed'&&parent.result?.version===target.result?.inputVersions?.[id]&&this.resultVersion(this.snapshot(current,parent))===parent.result.version,'前置内容或版本已变更，旧结果不可放行');}
  const s=this.session(actor),t=this.getTask(s,id);requireValue(!s.paused&&t.status==='awaiting_review','任务当前不能审查放行');requireValue(t.revision===revision&&t.result?.version===version,'审查针对旧版本，请重新读取当前产物');const actual=this.snapshot(s,t);requireValue(this.resultVersion(actual)===version,'产物已变化，请重新执行或核对');requireValue(['pass','rework','unverified'].includes(verdict),'审查结论无效');requireValue(Array.isArray(checks)&&checks.length===t.criteria.length,'须逐项检查全部验收条件');checks.forEach((c,i)=>requireValue(c.criterion===t.criteria[i]&&['pass','fail','unverified'].includes(c.status)&&typeof c.evidence==='string'&&c.evidence.trim(),'检查项、结论与证据不完整'));
  if(verdict==='pass'){requireValue(checks.every(c=>c.status==='pass')&&!actual.some(a=>a.missing),'存在失败/未验证/缺失产物，不可通过');requireValue(t.outputs.every(p=>t.reads?.[p]===actual.find(a=>a.path===p).sha256),'当前Agent需读取每项当前产物，不能只接受执行端自报');}
  const decision={at:new Date().toISOString(),reviewer:s.id,revision,version,verdict,checks:clone(checks),note:text(note,8000)};t.reviews.push(decision);
  if(verdict==='pass'){t.status='passed';t.error='';this.event(s,'review',t.title+'：当前Agent审查通过');this.schedule();}
  else if(verdict==='unverified'){t.status='unverified';t.error=decision.note;this.event(s,'review',t.title+'：无法验证，'+decision.note);}
  else{t.autoReworks++;if(t.autoReworks>2)this.block(s,t,'本轮自动返工已达上限：'+decision.note);else this.invalidate(s,t,decision.note,true);}
  this.save();return this.public(actor);
 }
 archive(s,t){if(!t.result)return;const dir=path.join(this.dir,'history',hash(s.id).slice(0,12),t.id,String(t.revision));fs.mkdirSync(dir,{recursive:true});const saved=[];for(const a of t.result.artifacts||[]){try{const file=this.filePath(s,a.path);if(fs.existsSync(file)&&fs.statSync(file).size<=64*1024*1024){const dest=path.join(dir,hash(a.path).slice(0,12)+path.extname(a.path));fs.copyFileSync(file,dest);saved.push({path:a.path,archive:dest});}}catch(e){saved.push({path:a.path,error:e.message});}}t.history.push({revision:t.revision,result:t.result,reviews:clone(t.reviews),archived:saved});}
 invalidate(s,root,reason,rerun=true){const affected=new Set([root.id]);let changed=true;while(changed){changed=false;for(const t of s.tasks)if(!affected.has(t.id)&&t.dependencies.some(id=>affected.has(id))){affected.add(t.id);changed=true;}}
  for(const t of s.tasks.filter(t=>affected.has(t.id))){this.archive(s,t);t.revision++;t.reworkFeedback=t===root?reason:'前置变更：'+root.title;t.result=null;t.reads={};t.reviews=[];t.error=t.reworkFeedback;const running=this.live.get(t.runId);if(running){t.invalidated=true;t.status='stopping';running.controller.abort();}else if(t.status!=='cancelled'){t.status=s.paused?'paused':t===root&&!rerun?'blocked':'queued';}}
  this.event(s,'invalidated',root.title+'：'+reason+'；受影响 '+[...affected].join('、'));this.schedule();return [...affected];
 }
 // 进入 blocked 的唯一入口：记住是从哪个状态卡住的，recover() 才能原路退回。
 // blocked 曾是"只进不出"的终态，产物被误判为改写就会把整条链路永久锁死。
 block(s,t,reason){if(t.status==='blocked')return;t.blockedFrom=t.status||'queued';t.status='blocked';t.error=reason;this.event(s,'blocked',t.title+'：'+reason);}
 // 恢复 blocked：默认退回卡住前的状态；rerun 则作废该任务及其下游并重新排队。
 // 端点与依赖会由 scheduler 重新校验，不跳过任何检查；cancelled 不参与恢复。
 recover(actor,{id,rerun=false,note}){
  const s=this.session(actor),t=this.getTask(s,id);
  requireValue(t.status==='blocked','只有被阻塞的任务需要恢复');
  // 先把"为什么会卡"的条件当场验一遍：条件没修好就拒绝恢复，别让用户以为恢复了、结果派发不出去。
  const endpoint=this.state.endpoints[t.endpoint];
  requireValue(endpoint&&endpoint.confirmed&&this.vis(s,endpoint),'目标执行端仍未接入或未对当前会话共享，请先修好再恢复');
  for(const dep of t.dependencies){const parent=this.getTask(s,dep);requireValue(parent.status==='passed'||parent.status==='cancelled','前置任务尚未通过，请先处理前置再恢复');}
  if(!rerun){const back=t.blockedFrom||'queued';requireValue(back!=='queued'||this.ready(s,t),'前置或端点条件未满足，暂不能恢复；可用 rerun 作废后重新执行');}
  s.paused=false;
  const reason=text(note||('人工恢复：'+String(t.error||'阻塞')),8000);
  t.autoReworks=0;t.error='';
  if(rerun){this.invalidate(s,t,reason,true);}
  else{
   const back=t.blockedFrom||'queued';
   delete t.blockedFrom;
   t.reworkFeedback=reason;
   t.status=back==='running'||back==='stopping'?'queued':back;
   this.event(s,'recovered',t.title+'：'+reason+'（退回 '+t.status+'）');
  }
  this.save();this.schedule();return this.public(actor);
 }
 // 返工：可同时改要求(prompt)与执行端(endpoint)。换端点须是已登记、已确认、且对当前会话可见的端；
 // 换端后旧结果一并作废并重新排队，避免"端点坏了只能取消整条计划"。
 rework(actor,{id,note,prompt,endpoint}){
  const s=this.session(actor),t=this.getTask(s,id);
  if(prompt)t.prompt=text(prompt);
  if(endpoint!==undefined){
   const target=key(endpoint),e=this.state.endpoints[target];
   if(!e||!e.confirmed)throw Error('目标执行端尚未由用户接入');
   if(!this.vis(s,e))throw Error('目标执行端未对当前会话共享');
   t.endpoint=target;
  }
  t.autoReworks=0;this.invalidate(s,t,text(note,8000),true);return this.public(actor);
 }
 async control(actor,action){const s=this.session(actor);requireValue(['pause','resume','cancel'].includes(action),'操作无效');if(action==='resume'){requireValue(![...this.live.values()].some(l=>l.s===s),'仍有进程停止中');s.paused=false;for(const t of s.tasks.filter(t=>t.status==='paused')){if(t.recovery_from==='awaiting_review'&&t.result){t.status='awaiting_review';}else{t.status='queued';t.recovery_from=t.recovery_from||'interrupted';}}this.event(s,'resume','当前Agent恢复工作，先核对落盘进度');this.schedule();}
  else{s.paused=true;for(const t of s.tasks){if(!unfinished.has(t.status)&&t.status!=='paused')continue;if(action==='cancel')t.cancelRequested=true;t.recovery_from=t.status;const live=this.live.get(t.runId);if(live){t.status='stopping';live.controller.abort();}else t.status=action==='cancel'?'cancelled':'paused';}this.event(s,action,action==='pause'?'暂停派发，正在停止受管工作':'取消本会话工作');const settling=[...this.live.values()].filter(l=>l.s===s).map(l=>l.promise);await Promise.race([Promise.allSettled(settling),new Promise(r=>{const timer=setTimeout(r,8000);timer.unref?.();})]);}
  this.save();return this.public(actor);
 }
 async kickNotify(id){const s=this.state.sessions[id];if(!s||s.paused||this.notifying.has(id)||!s.pendingEvents.length||this.closed)return;this.notifying.add(id);try{const ids=[...s.pendingEvents],events=this.state.events.filter(e=>ids.includes(e.id));const accepted=await this.notify(id,events);if(accepted){s.pendingEvents=s.pendingEvents.filter(x=>!ids.includes(x));this.save();}}catch(e){s.notificationError=String(e.message);this.save();}finally{this.notifying.delete(id);}}
 async close(){this.closed=true;const checks=[...this.connecting.values()];for(const c of checks)c.controller.abort(Error('插件关闭，协议连接检查已取消'));await Promise.allSettled(checks.map(c=>c.promise));for(const s of Object.values(this.state.sessions))await this.control({id:s.id},'pause');this.save();}
}
