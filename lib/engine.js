import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {VERSION} from './version.mjs';
import {validateMcpDefinition,mcpUses,MCP_VERSIONS} from './mcp.js';
import {needsConnection,validateBridge,bridgeFiles,verifiedReceipt,nativeSelection} from './bridges.js';
import {fingerprintReport,fingerprintError} from './fingerprints.js';
import {createRunLog,runLogPath} from './run-log.js';
import {validText as text,validKey as key,validStrings as strings,validArray,validObject,fieldError} from './validation.js';
import {collectImage} from './collect-image.js';

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
 constructor({dir,run,probe,notify=async()=>false,concurrency=2,approvalContext=null,collectionAccess=null}){
  this.dir=path.resolve(dir);this.run=run;this.probe=probe;this.notify=notify;this.concurrency=concurrency;this.approvalContext=approvalContext;this.collectionAccess=collectionAccess;this.live=new Map();this.connecting=new Map();this.pendingApprovals=new Map();this.scheduled=false;this.closed=false;this.notifying=new Set();
  fs.mkdirSync(this.dir,{recursive:true});this.file=path.join(this.dir,'state.json');
  this.state=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{schema:1,sessions:{},endpoints:{},events:[]};
  requireValue(this.state.schema===1,'不支持的数据版本');
  for(const e of Object.values(this.state.endpoints)){
   if(needsConnection(e)&&(!e.connection||e.connection.state==='checking'))e.connection={state:'unverified',error:'尚未完成登记时'+e.protocol.toUpperCase()+'连接验证，请由登记会话检查连接'};
   if(e.connection?.stage==='launch'&&/执行端程序或脚本已变化/.test(e.connection.error||''))e.connection.stage='fingerprint';
  }
  this.concurrency=this.state.preferences?.concurrency||concurrency;
  for(const s of Object.values(this.state.sessions)){
   for(const t of s.tasks)for(const a of t.approvals||[])if(['pending','reviewing'].includes(a.state)){a.state='withdrawn';a.reason='插件重启，审批失效';}
   s.paused=true;for(const t of s.tasks)if(unfinished.has(t.status)){t.recovery_from=t.status;t.status='paused';t.error='插件重启，须核对真实进度后恢复';}
  }this.save();
 }
 save(){const tmp=this.file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.state,null,2));fs.renameSync(tmp,this.file);}
 event(s,kind,message){const event={id:randomUUID(),at:new Date().toISOString(),session:s.id,kind,message};this.state.events.push(event);this.state.events=this.state.events.slice(-2000);s.pendingEvents.push(event.id);this.save();this.kickNotify(s.id);}
 session(actor,create=false){requireValue(actor?.id,'只能由绑定会话操作');let s=this.state.sessions[actor.id];if(!s&&create){requireValue(path.isAbsolute(actor.cwd)&&fs.existsSync(actor.cwd),'当前会话需要已有工作目录');s=this.state.sessions[actor.id]={id:actor.id,cwd:fs.realpathSync(actor.cwd),title:'当前会话',paused:false,tasks:[],pendingEvents:[]};this.save();}requireValue(s,'此会话尚未创建协调任务');if(actor.cwd)requireValue(fs.realpathSync(actor.cwd)===s.cwd,'工作目录发生变化，请使用原会话目录核对');return s;}
 filePath(s,relative){requireValue(typeof relative==='string'&&relative.length&&relative.length<1000&&!path.isAbsolute(relative),'产物必须是工作目录内相对路径');const target=path.resolve(s.cwd,relative),rel=path.relative(s.cwd,target);requireValue(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel),'产物路径越界');let p=target;while(!fs.existsSync(p)){const parent=path.dirname(p);requireValue(parent!==p,'路径不存在');p=parent;}const real=fs.realpathSync(p),r=path.relative(s.cwd,real);requireValue(!r.startsWith('..')&&!path.isAbsolute(r),'产物链接指向工作区外');return target;}
 snapshot(s,t){return t.outputs.map(relative=>{const file=this.filePath(s,relative);if(!fs.existsSync(file))return {path:relative,missing:true};const stat=fs.statSync(file);requireValue(stat.isFile(),'声明产物不是文件');requireValue(stat.size<=64*1024*1024,'产物超过64MB，首版无法完成内容哈希核对');return {path:relative,size:stat.size,sha256:hash(fs.readFileSync(file))};});}
 resultVersion(artifacts){return hash(JSON.stringify(artifacts));}
 public(actor){const context=this.approvalContext?.(actor.id);const s=this.state.sessions[actor.id];if(!s)return stripUndefined({approvalContext:context,version:VERSION,session:actor.id,title:'当前会话',paused:false,tasks:[],closedTasks:[],endpoints:Object.values(this.state.endpoints).filter(e=>this.vis({id:actor.id},e)).map(({fingerprints,...rest})=>({...rest,ownerHere:rest.owner===actor.id})),events:[]});const view=clone(s);return stripUndefined({...view,approvalContext:context,tasks:view.tasks.filter(t=>!t.closedAt),closedTasks:view.tasks.filter(t=>t.closedAt),version:VERSION,endpoints:Object.values(this.state.endpoints).filter(e=>this.vis(s,e)).map(({fingerprints,...rest})=>({...rest,ownerHere:rest.owner===s.id})),events:this.state.events.filter(e=>e.session===s.id).slice(-40)});}
 // 可见性：本会话自己登记的执行端始终可见；他人登记的、且其登记会话未取消共享时才可见。
 vis(s,e){return !!e&&!!s&&(e.owner===s.id||sharePolicy(this.state.sessions[e.owner])===SHARED);}
 prefs(actor,change){
  const s=this.session(actor,true),count=()=>Object.values(this.state.endpoints).filter(e=>e.confirmed&&e.owner!==s.id).length;
  if(change===undefined)return {sharePolicy:sharePolicy(s),declaration:s[DECL_KEY]||makeDeclaration(sharePolicy(s),null),crossSessionEndpoints:count()};
  requireValue([SHARED,PRIVATE].includes(change.sharePolicy),'共享策略无效');s[SHARE_KEY]=change.sharePolicy;s[DECL_KEY]=makeDeclaration(change.sharePolicy,new Date().toISOString());
  this.save();return {sharePolicy:change.sharePolicy,declaration:s[DECL_KEY],crossSessionEndpoints:count()};
 }
 endpoint(actor,input,{preview=false}={}){
  const s=this.session(actor,true);validObject(input,'endpoint');const e=clone(input);e.id=key(e.id,'endpoint.id');requireValue(!this.connecting.has(e.id),'连接正在检查，请等待结果');requireValue(!this.state.endpoints[e.id]||this.live.size===0,'有执行中的任务，不能修改已有执行端');e.label=text(e.label,80,'endpoint.label');e.protocol=e.protocol||'text';validateBridge(e);requireValue(path.isAbsolute(e.command)&&fs.existsSync(e.command)&&fs.statSync(e.command).isFile(),'启动程序须为已有绝对路径');requireValue(!/\.(cmd|bat|ps1)$/i.test(e.command),'请提供底层可执行程序和参数');e.args=strings(e.args||[],80,'endpoint.args');e.probe_args=strings(e.probe_args||[],80,'endpoint.probe_args');e.prompt_mode=e.prompt_mode||'stdin';requireValue(['stdin','arg'].includes(e.prompt_mode),'提示词方式无效');e.owner=s.id;e.confirmed=true;e.capabilities=e.capabilities||{};
  if(e.protocol==='mcp'){e.mcp=validateMcpDefinition(e.mcp);requireValue(!e.args.some(a=>/\{(?:prompt|model|reasoning)\}/.test(a)),'MCP启动参数不能携带任务，请在mcp.arguments中映射');}
  // A callback cannot supply its own successful connection receipt.
  e.connection={state:needsConnection(e)?'unverified':'not_applicable'};
  e.launch_env=e.launch_env||{};requireValue(Object.keys(e.launch_env).length<=8,'配置目录过多');for(const [name,value]of Object.entries(e.launch_env))requireValue(/^[A-Z][A-Z0-9_]*(?:_HOME|_DIR)$/.test(name)&&typeof value==='string'&&path.isAbsolute(value)&&fs.existsSync(value)&&fs.statSync(value).isDirectory(),'仅接受已有配置目录变量，不接受密钥');
  const existing=this.state.endpoints[e.id];requireValue(!existing||existing.owner===s.id,'执行端属于其他会话');
  const current=this.fingerprints(e);if(existing&&!preview){const report=fingerprintReport({...e,fingerprints:existing.fingerprints},current);if(report.changed)throw fingerprintError(report);}
  e.fingerprints=current;e.reportedVersion=existing?.reportedVersion||e.reportedVersion||e.version||'未知';e.version=e.reportedVersion;e.versionSource='reported';
  e.fingerprintHistory=existing?.fingerprintHistory||[];if(preview)return e;this.state.endpoints[e.id]=e;this.event(s,'endpoint','用户接入邀请登记 '+e.label);return this.public(actor);
 }
 fingerprints(e){return [...new Set([e.command,...(e.protocol==='text'?[]:bridgeFiles(e)),...[...e.args,...e.probe_args].filter(p=>path.isAbsolute(p)&&fs.existsSync(p)&&fs.statSync(p).isFile())])].map(file=>({file,sha256:startupHash(file)}));}
 checkEndpoint(e){try{const report=fingerprintReport(e,this.fingerprints(e));if(report.changed)throw fingerprintError(report);}catch(error){error.protocolStage='fingerprint';throw error;}}
 fingerprintFailure(s,e,error){e.connection={state:'needs_agent',stage:'fingerprint',error:error.message,...(error.fingerprintReport?{fingerprintReport:stripUndefined(error.fingerprintReport)}:{}),checkedAt:new Date().toISOString()};this.event(s,'connection',e.label+'：指纹校验失败。请用coordinator_control action=reconfirm查看差异，明确核对后携带confirmation_version与note确认；基线未更新。');return stripUndefined({endpointId:e.id,label:e.label,registered:true,connected:false,connection:clone(e.connection)});}
 async reconfirmEndpoint(actor,id,{confirmationVersion,note,signal,definition}={}){
  const s=this.session(actor),e=this.state.endpoints[key(id)];requireValue(!this.closed,'插件正在关闭');requireValue(e&&e.owner===s.id,'只能重新确认本会话登记的执行端');
  requireValue(!this.connecting.has(id),'连接正在检查，请等待结果');
  requireValue(![...this.live.values()].some(l=>l.t.endpoint===id||l.cwd===s.cwd),'执行端或当前工作区仍有任务运行，请等待空闲');
  signal?.throwIfAborted();let candidate=e;
  if(definition){requireValue(Object.keys(definition).every(k=>['command','args','probe_args','launch_env','capabilities','prompt_mode','protocol','mcp','server','sdk','cli'].includes(k)),'仅可修正已有协议执行端的调用定义');requireValue(needsConnection({protocol:definition.protocol||e.protocol}),'协议连接失败不能改报text绕过检查');requireValue(!Object.values(this.state.sessions).some(x=>x.tasks.some(t=>t.endpoint===id&&!t.closedAt&&!['cancelled','failed','unverified'].includes(t.status))),'仍有任务引用该执行端，不能更改调用定义');candidate=this.endpoint(actor,{...e,...definition},{preview:true});}
  const report=fingerprintReport({...candidate,fingerprints:e.fingerprints},this.fingerprints(candidate));if(definition)report.proposedDefinition=clone(definition);
  if(!confirmationVersion)return stripUndefined({...report,confirmed:false,requiresConfirmation:report.changed,instruction:'查看每项差异并核对实际入口后，携带confirmation_version和确认依据执行reconfirm；不会自动更新基线或启动任务。'});
  requireValue(typeof confirmationVersion==='string'&&confirmationVersion===report.confirmationVersion,'文件或调用定义在查看差异后又发生变化，请重新查看并确认');
  const reason=text(note,8000,'note');requireValue(report.changed,'指纹没有变化，无需重新建立基线');
  const history=[...(e.fingerprintHistory||[]),{at:new Date().toISOString(),actor:s.id,note:reason,previous:clone(e.fingerprints||[]),current:clone(report.currentFingerprints),confirmationVersion,...(definition?{definition:clone(definition)}:{})}].slice(-20);if(definition)Object.assign(e,candidate);e.fingerprintHistory=history;
  e.fingerprints=clone(report.currentFingerprints);e.reportedVersion=e.reportedVersion||e.version||'未知';e.version=e.reportedVersion;e.versionSource='reported';e.connection={state:needsConnection(e)?'unverified':'not_applicable',stage:'reconfirm',checkedAt:new Date().toISOString()};this.event(s,'reconfirm',e.label+'：明确确认启动文件差异；'+reason+'。既有任务记录保留，协议连接须重新验证。');
  if(!needsConnection(e))return {endpointId:id,confirmed:true,connected:false,connection:clone(e.connection)};
  const result=await this.connectEndpoint(actor,id,{signal});return {...result,confirmed:true};
 }
 async connectEndpoint(actor,id,{signal,definition}={}){
  const s=this.session(actor),original=this.state.endpoints[key(id)];
  requireValue(!this.closed,'插件正在关闭');requireValue(original&&original.owner===s.id,'只能检查或修正本会话登记的执行端');
  requireValue(needsConnection(original),'这个执行端使用text协议，没有协议连接检查');requireValue(!this.connecting.has(id),'连接正在检查，请等待结果');
  requireValue(![...this.live.values()].some(l=>l.t.endpoint===id||l.cwd===s.cwd),'执行端或当前工作区仍有任务运行，请等待空闲');
  if(definition){
   requireValue(typeof definition==='object'&&!Array.isArray(definition),'调用定义需要JSON对象');
   const target=definition.protocol||original.protocol;requireValue(needsConnection({protocol:target}),'协议连接失败不能改报text绕过检查');
   requireValue(Object.keys(definition).every(k=>['command','args','probe_args','launch_env','capabilities','prompt_mode','protocol','mcp','server','sdk','cli'].includes(k)),'仅可修正已有协议执行端的调用定义');
   requireValue(!Object.values(this.state.sessions).some(x=>x.tasks.some(t=>t.endpoint===id&&!t.closedAt&&!['cancelled','failed','unverified'].includes(t.status))),'仍有任务引用该执行端，不能更改调用定义');
   const candidate=this.endpoint(actor,{...original,...definition},{preview:true}),report=fingerprintReport({...candidate,fingerprints:original.fingerprints},candidate.fingerprints);
   if(report.changed){report.proposedDefinition=clone(definition);return this.fingerprintFailure(s,original,fingerprintError(report));}
   this.endpoint(actor,{...original,...definition});
  }
  const e=this.state.endpoints[id],protocol=e.protocol.toUpperCase(),controller=new AbortController(),started=Date.now(),deadlineAt=started+15000,abortContext={source:'none'};
  const abort=()=>{if(!controller.signal.aborted){abortContext.source='caller';controller.abort(signal.reason);}};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const record={controller,cwd:s.cwd,promise:null};this.connecting.set(id,record);
  e.connection={state:'checking',startedAt:new Date().toISOString()};this.save();
  const timer=setTimeout(()=>{if(!controller.signal.aborted){abortContext.source='connection_deadline';controller.abort(Object.assign(Error(protocol+'连接检查超时（15秒）'),{code:'COORDINATOR_CONNECTION_DEADLINE'}));}},15000);timer.unref?.();
  record.promise=(async()=>{
   try{
    controller.signal.throwIfAborted();this.checkEndpoint(e);requireValue(typeof this.probe==='function','宿主未提供'+protocol+'连接检查入口');
    const receipt=await this.probe({owner:s.id,cwd:s.cwd,endpoint:clone(e),signal:controller.signal,deadlineAt,abortContext});
    controller.signal.throwIfAborted();
    if(e.protocol==='mcp'){
     requireValue(receipt?.protocol==='mcp'&&MCP_VERSIONS.includes(receipt.protocolVersion)&&receipt.handshakeVerified===true&&receipt.binding?.tool===e.mcp.tool&&receipt.binding?.fingerprint&&(receipt.methods?.includes('notifications/initialized')||receipt.protocolVersion==='2026-07-28'&&receipt.methods?.includes('server/discover'))&&receipt.methods?.includes('tools/list'),'MCP检查未返回握手、工具发现和任务映射证据');
     e.connection={...stripUndefined(receipt),state:'ready',workspace:s.cwd,capabilitiesAreReported:true};
    }else{
     requireValue(verifiedReceipt(e,receipt),protocol+'检查未返回完整连接证据');
     e.connection={...stripUndefined(receipt),state:'ready',workspace:s.cwd,capabilitiesAreReported:true};
    }
    this.checkEndpoint(e);
    e.reportedVersion=e.reportedVersion||e.version||'未知';
    if(receipt.entryVersion?.state==='verified'){e.version=receipt.entryVersion.version;e.versionSource='entry_probe';e.versionMismatch=e.reportedVersion!==e.version&&e.reportedVersion!=='未知'?{reported:e.reportedVersion,observed:e.version}:null;}else e.versionSource=e.versionSource||'reported';
    this.save();
   }catch(error){
    e.connection={...stripUndefined(error.connectionReceipt||{}),state:'needs_agent',stage:error.protocolStage||error.acpStage||'launch',error:String(error.message||error).slice(0,2000),...(error.fingerprintReport?{fingerprintReport:stripUndefined(error.fingerprintReport)}:{}),checkedAt:new Date().toISOString()};
    const next=e.connection.stage==='fingerprint'?'请用coordinator_control action=reconfirm查看差异；明确核对并携带confirmation_version与note后才重建基线，再由插件重新验证连接。':'请当前Agent核对实际入口、配置、MCP工具映射或宿主限制；可用coordinator_control connect检查已有执行端，必要时提供definition修正后重试一次。';
    if(!this.closed)this.event(s,'connection',e.label+'（'+e.id+'）'+protocol+'连接验证失败：'+e.connection.error+'。'+next+'不发模型任务、不放宽权限、不把自报结果标记为通过。');else this.save();
   }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.connecting.delete(id);this.schedule();}
   return stripUndefined({endpointId:id,label:e.label,registered:true,connected:e.connection.state==='ready',connection:clone(e.connection)});
  })();return record.promise;
 }
 readyEndpoint(e){requireValue(e?.confirmed,'执行端未登记');requireValue(!needsConnection(e)||e.connection?.state==='ready',e.protocol.toUpperCase()+'连接尚未验证通过，请登记会话先检查连接');}
 // 移除执行端：只允许登记它的会话移除；仍有未终结任务引用时拒绝（已取消/失败/无法验证的不再锁住执行端）。
 removeEndpoint(actor,id){
  const s=this.session(actor,true),e=this.state.endpoints[key(id)];
  requireValue(e,'执行端不存在');
  requireValue(e.owner===s.id,'只能移除本会话登记的执行端');
  requireValue(!this.connecting.has(id),'连接正在检查，请等待结果');
  requireValue(this.live.size===0,'有执行中的任务，请先暂停再移除');
  const blockingTerminal=new Set(['cancelled','failed','unverified']);
  const used=[...new Set(Object.values(this.state.sessions).flatMap(x=>(x.tasks||[]).filter(t=>t.endpoint===e.id&&!t.closedAt&&!blockingTerminal.has(t.status)).map(t=>t.id+'('+t.status+')')))];
  requireValue(used.length===0,'仍有未终结任务引用该执行端（'+used.join('、')+'），请先取消这些任务');
  delete this.state.endpoints[e.id];
  // 清掉该执行端的接入资料残留（只删确实含此 id 的文件，避免误删别人的回传）。
  try{const dir=path.join(this.dir,'invitations');for(const f of fs.readdirSync(dir)){if(!/^response.*\.json$/i.test(f))continue;const p=path.join(dir,f);if(fs.readFileSync(p,'utf8').includes(e.id))fs.unlinkSync(p);}}catch{}
  this.event(s,'endpoint_removed','用户移除执行端 '+e.label+'（'+e.id+'）');return {removed:e.id,label:e.label,remaining:Object.keys(this.state.endpoints).length};
 }
 plan(actor,{title,tasks}){
  const planTitle=text(title,200,'title');validArray(tasks,30,'tasks',{min:1});
  const s=this.session(actor,true);requireValue(!s.tasks.some(t=>this.live.has(t.runId)),'请先暂停执行，再修改计划');const seen=new Set();
  const normalized=tasks.map((raw,index)=>{
   const field='tasks['+index+']';validObject(raw,field);const t=clone(raw);
   for(const name of ['result','runId','diagnosticLog','approvalPreflight','approvals','reads','inputVersions','invalidated','cancelRequested','recovery_from','blockedFrom','closedAt','closedEndpointLabel','reworkFeedback'])delete t[name];
   t.id=key(t.id,field+'.id');requireValue(!seen.has(t.id),'任务编号重复：字段='+field+'.id');seen.add(t.id);
   t.title=text(t.title,200,field+'.title');t.prompt=text(t.prompt,16000,field+'.prompt');t.reason=text(t.reason,2000,field+'.reason');t.endpoint=key(t.endpoint,field+'.endpoint');
   t.dependencies=strings(t.dependencies===undefined?[]:t.dependencies,40,field+'.dependencies');t.dependencies.forEach((dep,i)=>key(dep,field+'.dependencies['+i+']'));
   t.outputs=strings(t.outputs,20,field+'.outputs',{min:1});t.criteria=strings(t.criteria,20,field+'.criteria',{min:1});t.criteria.forEach((criterion,i)=>text(criterion,16000,field+'.criteria['+i+']'));
   const e=this.state.endpoints[t.endpoint];requireValue(e?.confirmed&&this.vis(s,e),'执行端尚未由用户接入，或未对当前会话共享');
   t.outputs.forEach((p,i)=>{try{this.filePath(s,p);}catch(error){throw fieldError(field+'.outputs['+i+']',p,error.message);}});t.model=String(t.model||'');t.reasoning=String(t.reasoning||'');
   this.readyEndpoint(e);requireValue(!t.model||(e.protocol==='mcp'?e.capabilities.modelSelection===true&&mcpUses(e,'model'):e.args.some(a=>a.includes('{model}'))||(e.protocol==='acp'&&e.capabilities.modelSelection===true)||nativeSelection(e,'model')),'这个执行端没有经过确认的模型选择方式');requireValue(!t.reasoning||(e.capabilities.reasoningSelection===true&&(e.protocol==='mcp'?mcpUses(e,'reasoning'):(e.args.some(a=>a.includes('{reasoning}'))||nativeSelection(e,'reasoning')))),'这个执行端没有经过确认的思考强度参数');
   delete t.closedAt;delete t.closedEndpointLabel;const gate=this.executionGate(s,e);
   return {...t,revision:1,status:gate?.blocked?'blocked':'queued',...(gate?{approvalPreflight:gate}:{}),...(gate?.blocked?{blockedFrom:'queued',error:gate.reason}:{}),history:[],reviews:[],autoReworks:0,timeoutMs:Math.min(1800000,Math.max(1000,Number(t.timeoutMs)||300000))};});
  const visit=(id,stack=new Set(),done=new Set())=>{requireValue(!stack.has(id),'存在循环依赖：'+id);if(done.has(id))return;const t=normalized.find(t=>t.id===id);requireValue(t,'缺少前置任务：'+id);stack.add(id);for(const dep of t.dependencies)visit(dep,stack,done);stack.delete(id);done.add(id);};normalized.forEach(t=>visit(t.id));
  const outputOwners=new Set();for(const t of normalized)for(const p of t.outputs){const normalizedPath=this.filePath(s,p).toLowerCase();requireValue(!outputOwners.has(normalizedPath),'多个任务声明同一产物，请分开产物路径');outputOwners.add(normalizedPath);}
  if(s.tasks.length){requireValue(s.tasks.every(t=>!unfinished.has(t.status)&&t.status!=='paused'),'已有未完成计划，请修改任务而非覆盖计划');s.previousPlans=s.previousPlans||[];s.previousPlans.push(clone(s.tasks));}
  s.tasks=normalized;s.title=planTitle;this.event(s,'plan','当前Agent创建计划：'+s.title);this.schedule();return this.public(actor);
 }
 executionGate(s,endpoint){if(endpoint?.protocol!=='codex'||!this.approvalContext)return null;const context=this.approvalContext(s.id);return {...context,required:'possible',blocked:context.canRequest!==true};}
 assertApprovalChannel(record){const gate=this.executionGate(record.s,this.state.endpoints[record.t.endpoint]);if(gate)record.t.approvalPreflight=gate;if(gate?.blocked)throw Object.assign(Error(gate.reason),{code:gate.code});return gate;}
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
  // Closed history stays at rest; ancestors of a current task remain subject to
  // artifact validation so hiding a passed row cannot bypass its dependencies.
  const tracked=new Set(s.tasks.filter(t=>!t.closedAt).map(t=>t.id));let expanded=true;
  while(expanded){expanded=false;for(const t of s.tasks)if(tracked.has(t.id))for(const id of t.dependencies||[])if(!tracked.has(id)){tracked.add(id);expanded=true;}}
  for(const t of s.tasks.filter(t=>tracked.has(t.id)&&(t.status==='passed'||(t.status==='awaiting_review'&&t.result&&(t.reviews||[]).some(r=>r.verdict==='pass'))))){
   let snap,why='';
   try{snap=this.snapshot(s,t);}catch(e){snap=null;why='声明产物无法核对（'+(e.message||'未知原因')+'）；请核对后重新读取审查。';}
   const missing=!snap||snap.some(a=>a.missing);
   const reviewed=t.result&&(t.reviews||[]).some(r=>r.verdict==='pass')?t.result.version:null;
   if(missing){
    if(t.status==='passed'){
     t.status='awaiting_review';
     delete t.closedAt;
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
  const endpoint=this.state.endpoints[t.endpoint];try{requireValue(this.vis(s,endpoint),'执行端已取消对当前会话共享');this.readyEndpoint(endpoint);this.checkEndpoint(endpoint);}catch(e){this.block(s,t,e.message);return;}
  const gate=this.executionGate(s,endpoint);if(gate)t.approvalPreflight=gate;if(gate?.blocked){this.block(s,t,gate.reason);return;}
  t.runId=randomUUID();const runId=t.runId,revision=t.revision,controller=new AbortController();t.status='running';t.error='';t.inputVersions=Object.fromEntries(t.dependencies.map(id=>[id,this.getTask(s,id).result.version]));
  const logger=createRunLog(this.dir,s.id,t.id,runId),record={s,t,cwd:s.cwd,controller,promise:null,runId,revision,deadlineAt:Date.now()+t.timeoutMs,logger};t.diagnosticLog=logger.status();logger.write('run_started',{runId,revision,protocol:endpoint.protocol});this.live.set(runId,record);this.event(s,'started',t.title+' → '+endpoint.label);
  record.promise=(async()=>{
   try{
    const prompt=[t.prompt,'验收条件：'+t.criteria.join('；'),'工作目录：'+s.cwd,'仅写入本任务范围，交付相对路径：'+t.outputs.join('、'),t.reworkFeedback?'返工要求：'+t.reworkFeedback:'',t.recovery_from?'恢复任务：先检查已有文件及日志，报告已完成/需修复/未开始，不盲目重复操作。':''].filter(Boolean).join('\n');
    const result=await this.run({owner:s.id,cwd:s.cwd,endpoint:clone(endpoint),task:clone(t),prompt,signal:controller.signal,deadlineAt:record.deadlineAt,requestApproval:proposal=>this.requestApproval(record,proposal),trace:logger.write});
    record.result=result;result.diagnosticLog=logger.status();
    if(t.runId!==runId||t.revision!==revision||t.invalidated){t.history.push({runId,revision,superseded:true,result});return;}
    const artifacts=this.snapshot(s,t);t.result={...result,artifacts,version:this.resultVersion(artifacts),revision,inputVersions:t.inputVersions};
    if(controller.signal.aborted){t.status=t.cancelRequested?'cancelled':'paused';t.error='执行已停止，恢复时需核对进度';return;}
    if(result.ok===false){t.status='failed';t.error=result.error||'执行失败';t.remedy=remedy(t.error+'\n'+String(result.stderr||''));}else{t.status='awaiting_review';t.error=artifacts.some(a=>a.missing)?'有声明产物缺失，待当前Agent检查':'等待当前对话Agent检查真实产物';delete t.remedy;}delete t.recovery_from;this.event(s,'result',t.title+'：'+t.error);
   }catch(e){logger.write('run_exception',{reason:e.message,code:e.code||'',signalAborted:controller.signal.aborted});if(!t.invalidated){t.status=controller.signal.aborted?(t.cancelRequested?'cancelled':'paused'):'failed';t.error=String(e.message);if(needsConnection(endpoint)&&e.reconnectRequired&&!controller.signal.aborted){endpoint.connection={...stripUndefined(e.connectionReceipt||{}),state:'needs_agent',stage:e.protocolStage||'binding',error:t.error,checkedAt:new Date().toISOString()};const owner=this.state.sessions[endpoint.owner];if(owner)this.event(owner,'connection',endpoint.label+' MCP工具连接需要重新核对：'+t.error);}this.event(s,'error',t.title+'：'+t.error);}}
   finally{for(const [id,p]of this.pendingApprovals)if(p.record===record)this.finishApproval(id,'cancel','任务结束，审批已撤回');this.live.delete(runId);if(t.cancelRequested){delete t.invalidated;t.status='cancelled';t.cancelledAt=new Date().toISOString();}else if(t.invalidated){delete t.invalidated;t.status=s.paused?'paused':'queued';}logger.write('run_finished',{decision:t.status,signalAborted:controller.signal.aborted});t.diagnosticLog=logger.status();if(record.result)record.result.diagnosticLog=t.diagnosticLog;if(t.result)t.result.diagnosticLog=t.diagnosticLog;this.save();this.schedule();}
  })();
 }
 requestApproval(record,proposal){
  const {s,t,controller,runId,revision}=record;let stage='signal';record.logger?.write('approval_engine_enter',{method:proposal.method,itemId:proposal.itemId,threadId:proposal.threadId,turnId:proposal.turnId,requestId:proposal.requestId});try{controller.signal.throwIfAborted();proposal.signal?.throwIfAborted();
  stage='task_scope';requireValue(this.live.get(runId)===record&&t.runId===runId&&t.revision===revision&&!t.invalidated&&!this.closed,'原任务已经结束，不能申请操作批准');
  stage='channel';this.assertApprovalChannel(record);
  stage='deadline';requireValue(Date.now()<record.deadlineAt,'任务期限已到，不能申请批准');
  stage='method';requireValue(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(proposal.method),'不支持的审批类型');
  stage='limits';const {signal,...request}=proposal;t.approvals=t.approvals||[];requireValue(t.approvals.filter(a=>a.runId===runId).length<64,'本轮审批超过64次，请核对任务');requireValue([...this.pendingApprovals.values()].filter(p=>p.record===record).length<8,'待处理审批超过8项');
  const a={id:randomUUID(),runId,revision,request:clone(request),state:'pending',createdAt:new Date().toISOString(),expiresAt:new Date(record.deadlineAt).toISOString()};a.version=hash(JSON.stringify({runId,revision,request:a.request}));t.approvals.push(a);t.approvals=t.approvals.slice(-128);
  stage='enqueue';return new Promise(resolve=>{
   const abort=()=>this.finishApproval(a.id,'cancel','任务取消、回合结束或审批已撤回'),combined=AbortSignal.any([controller.signal,...(signal?[signal]:[])]);
   this.pendingApprovals.set(a.id,{record,a,resolve,signal:combined,abort});combined.addEventListener('abort',abort,{once:true});
   this.event(s,'approval',t.title+'等待批准一次操作，请查看coordinator_status中的approvals；由原会话审批后继续同一任务。');if(combined.aborted)abort();
  });}catch(error){record.logger?.write('approval_engine_rejected',{stage,method:proposal.method,itemId:proposal.itemId,reason:error.message,code:error.code||''});throw error;}
 }
 approval(actor,{id,approvalId,approvalVersion}){
  const s=this.session(actor),t=this.getTask(s,key(id)),p=this.pendingApprovals.get(approvalId);
  requireValue(p&&p.record.s===s&&p.record.t===t,'审批不存在、已失效或不属于本会话任务');
  requireValue(p.a.version===approvalVersion,'审批版本不一致，请重新查看具体操作');
  requireValue(this.live.get(p.record.runId)===p.record&&t.runId===p.record.runId&&t.revision===p.record.revision&&!t.invalidated&&!p.signal.aborted&&Date.now()<p.record.deadlineAt,'任务已经变化、取消或超期，不能批准');return p;
 }
 beginApproval(actor,args){const p=this.approval(actor,args);requireValue(p.a.state==='pending','该审批正在处理，请等待');p.a.state='reviewing';this.save();return {request:clone(p.a.request),signal:p.signal};}
 finishApproval(approvalId,decision,reason,state='withdrawn',meta={}){
  const p=this.pendingApprovals.get(approvalId);if(!p)return false;
  const valid=decision==='accept'&&!p.signal.aborted&&this.live.get(p.record.runId)===p.record&&p.record.t.runId===p.record.runId&&p.record.t.revision===p.record.revision&&!p.record.t.invalidated&&Date.now()<p.record.deadlineAt;
  this.pendingApprovals.delete(approvalId);p.signal.removeEventListener('abort',p.abort);p.a.state=valid?'accepted':state;p.a.reason=reason;p.a.decidedAt=new Date().toISOString();if(meta.code)p.a.failureCode=meta.code;p.record.logger?.write('approval_engine_decided',{decision:valid?'accept':'cancel',reason,code:meta.code||'',requestId:p.a.request.requestId,itemId:p.a.request.itemId});this.event(p.record.s,'approval_decided',p.record.t.title+'：'+(valid?'批准一次操作':'未批准操作')+'，'+reason);p.resolve({decision:valid?'accept':'cancel',reason,...(meta.code?{code:meta.code}:{})});return true;
 }
 decideApproval(actor,args,{trustedHuman=false,outcome}={}){
  const p=this.approval(actor,args);requireValue(['accept','cancel'].includes(args.decision),'只允许批准一次或拒绝');
  const gate=this.executionGate(p.record.s,this.state.endpoints[p.record.t.endpoint]);if(gate)p.record.t.approvalPreflight=gate;
  if(args.decision==='accept'&&gate?.blocked){this.finishApproval(p.a.id,'cancel',gate.reason,'unavailable',{code:gate.code});return this.public(actor);}
  requireValue(args.decision==='cancel'||trustedHuman||outcome==='allowed-once','Agent不能自行批准；须由DSH原生审批返回allowed-once');
  this.finishApproval(p.a.id,args.decision,args.decision==='accept'?'原任务会话批准本次操作':'用户拒绝本次操作','rejected');return this.public(actor);
 }
 readRunLog(actor,{id}){const session=this.session(actor),task=this.getTask(session,key(id));requireValue(task.runId&&task.diagnosticLog?.available,'本次任务尚无可用运行日志');const file=runLogPath(this.dir,session.id,task.id,task.runId);requireValue(fs.existsSync(file)&&fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink(),'运行日志不可用');const root=fs.realpathSync(path.join(this.dir,'run-logs')),relative=path.relative(root,fs.realpathSync(file));requireValue(!relative.startsWith('..')&&!path.isAbsolute(relative),'日志链接越界');requireValue(fs.statSync(file).size<=1024*1024,'运行日志超过限制');return {path:file,text:fs.readFileSync(file,'utf8'),truncated:task.diagnosticLog.truncated};}
 collectArtifact(actor,{id,itemId,relative,note}){
  const s=this.session(actor),t=this.getTask(s,key(id));requireValue(!this.closed&&!t.closedAt&&!this.live.has(t.runId)&&!t.invalidated&&['failed','awaiting_review'].includes(t.status),'仅可回收本会话已停止且未关闭的失败/待审查任务产物');
  requireValue(t.result&&t.result.revision===t.revision&&t.runId,'当前任务没有同版本执行记录');requireValue(t.outputs.includes(relative),'只能回收到本任务声明的产物路径');
  const e=this.state.endpoints[t.endpoint];requireValue(e?.protocol==='codex'&&!e.server,'只支持本机Codex stdio的已记录图片，远端路径不可当本机路径');
  requireValue(![...this.live.values(),...this.connecting.values()].some(r=>r.cwd===s.cwd),'工作区仍有受管进程，请等待空闲');
  const image=t.result.native?.generatedImages?.find(i=>i.itemId===itemId);requireValue(image&&image.status==='completed'&&!image.failure&&image.savedPath,'没有可回收的本轮完成图片路径；不会扫描默认缓存目录');
  requireValue(image.scopeVerified!==false,'图片事件未绑定当前线程和回合，不能回收');
  const reason=text(note,8000,'note');requireValue(typeof this.collectionAccess==='function','宿主未提供产物回收权限检查');const access=this.collectionAccess(actor,e);
  requireValue(access?.mode==='danger-full-access'&&typeof access.cacheHome==='string','图片回收需要原会话已有完全文件权限；插件不会扩大权限。其它模式请使用宿主文件工具按现有权限处理');
  this.filePath(s,relative);this.snapshot(s,t);const receipt=collectImage({cwd:s.cwd,cacheHome:access.cacheHome,source:image.savedPath,relative,expectedSha256:image.sha256});
  const previous=t.result,originalArtifacts=previous.artifacts||[],recoveries=(previous.recoveries||[]).filter(r=>r.path!==relative),entry={...receipt,itemId,scopeVerification:image.scopeVerified===true?'verified':'legacy-record',runId:t.runId,revision:t.revision,at:new Date().toISOString(),actor:s.id,note:reason};recoveries.push(entry);
  const artifacts=this.snapshot(s,t),complete=artifacts.every(a=>!a.missing&&(recoveries.some(r=>r.path===a.path&&r.sha256===a.sha256)||previous.ok===true&&originalArtifacts.some(p=>p.path===a.path&&p.sha256===a.sha256)));
  t.result={...previous,recoveries,artifacts,version:this.resultVersion(artifacts),artifactRecovery:{executionOk:previous.ok===true,executionStatus:previous.ok===true?'completed':'failed',executionError:previous.error||'',complete,mediaInspectionRequired:true,reviewStatus:'pending'}};t.reads={};t.reviews=[];
  t.status=complete?'awaiting_review':previous.ok?'awaiting_review':'failed';t.error=complete?'图片已回收，等待原Agent检查真实产物；原执行结果保留':'已回收部分图片，其余声明产物仍未交付；原执行失败记录保留';
  this.event(s,'artifact_collected',t.title+'：回收 '+relative+'，SHA-256已核对；生成、执行和媒体审查仍分别记录');return this.public(actor);
 }
 read(actor,{id,relative},agentRead=true){const s=this.session(actor),t=this.getTask(s,id);this.guard(s);requireValue(t.outputs.includes(relative),'只能读取声明产物');const file=this.filePath(s,relative);requireValue(fs.existsSync(file),'产物不存在');const size=fs.statSync(file).size;requireValue(size<=10*1024*1024,'预览文件超过10MB，请用宿主文件工具读取');const buffer=fs.readFileSync(file),ext=path.extname(file).toLowerCase();const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.wav':'audio/wav','.mp3':'audio/mpeg','.ogg':'audio/ogg'}[ext];const value={path:file,relative,sha256:hash(buffer),size,...(mime?{mime,base64:buffer.toString('base64')}:{text:buffer.toString('utf8').slice(0,256000)})};if(agentRead){t.reads=t.reads||{};t.reads[relative]=value.sha256;this.save();}return value;}
 review(actor,{id,revision,version,verdict,checks,note}){
  const current=this.session(actor),target=this.getTask(current,id);for(const id of target.dependencies){const parent=this.getTask(current,id);requireValue(parent.status==='passed'&&parent.result?.version===target.result?.inputVersions?.[id]&&this.resultVersion(this.snapshot(current,parent))===parent.result.version,'前置内容或版本已变更，旧结果不可放行');}
  const s=this.session(actor),t=this.getTask(s,id);requireValue(!s.paused&&t.status==='awaiting_review','任务当前不能审查放行');requireValue(t.revision===revision&&t.result?.version===version,'审查针对旧版本，请重新读取当前产物');const actual=this.snapshot(s,t);requireValue(this.resultVersion(actual)===version,'产物已变化，请重新执行或核对');requireValue(['pass','rework','unverified'].includes(verdict),'审查结论无效');requireValue(Array.isArray(checks)&&checks.length===t.criteria.length,'须逐项检查全部验收条件');checks.forEach((c,i)=>requireValue(c.criterion===t.criteria[i]&&['pass','fail','unverified'].includes(c.status)&&typeof c.evidence==='string'&&c.evidence.trim(),'检查项、结论与证据不完整'));
  if(verdict==='pass'){requireValue(checks.every(c=>c.status==='pass')&&!actual.some(a=>a.missing),'存在失败/未验证/缺失产物，不可通过');requireValue(t.outputs.every(p=>t.reads?.[p]===actual.find(a=>a.path===p).sha256),'当前Agent需读取每项当前产物，不能只接受执行端自报');}
  const decision={at:new Date().toISOString(),reviewer:s.id,revision,version,verdict,checks:clone(checks),note:text(note,8000,'note')};t.reviews.push(decision);
  if(t.result.artifactRecovery)t.result.artifactRecovery.reviewStatus=verdict==='pass'?'passed':verdict;
  if(verdict==='pass'){t.status='passed';t.error='';this.event(s,'review',t.title+'：当前Agent审查通过');this.schedule();}
  else if(verdict==='unverified'){t.status='unverified';t.error=decision.note;this.event(s,'review',t.title+'：无法验证，'+decision.note);}
  else{t.autoReworks++;if(t.autoReworks>2)this.block(s,t,'本轮自动返工已达上限：'+decision.note);else this.invalidate(s,t,decision.note,true);}
  this.save();return this.public(actor);
 }
 archive(s,t){if(!t.result)return;const dir=path.join(this.dir,'history',hash(s.id).slice(0,12),t.id,String(t.revision));fs.mkdirSync(dir,{recursive:true});const saved=[];for(const a of t.result.artifacts||[]){try{const file=this.filePath(s,a.path);if(fs.existsSync(file)&&fs.statSync(file).size<=64*1024*1024){const dest=path.join(dir,hash(a.path).slice(0,12)+path.extname(a.path));fs.copyFileSync(file,dest);saved.push({path:a.path,archive:dest});}}catch(e){saved.push({path:a.path,error:e.message});}}t.history.push({revision:t.revision,result:t.result,reviews:clone(t.reviews),archived:saved});}
 invalidate(s,root,reason,rerun=true){const affected=new Set([root.id]);let changed=true;while(changed){changed=false;for(const t of s.tasks)if(!affected.has(t.id)&&t.dependencies.some(id=>affected.has(id))){affected.add(t.id);changed=true;}}
  for(const t of s.tasks.filter(t=>affected.has(t.id))){this.archive(s,t);delete t.closedAt;t.revision++;t.reworkFeedback=t===root?reason:'前置变更：'+root.title;t.result=null;t.reads={};t.reviews=[];t.error=t.reworkFeedback;const running=this.live.get(t.runId);if(running){t.invalidated=true;t.status='stopping';running.controller.abort();}else if(t.status!=='cancelled'){t.status=s.paused?'paused':t===root&&!rerun?'blocked':'queued';}}
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
  const gate=this.executionGate(s,endpoint);if(gate)t.approvalPreflight=gate;
  if(rerun||['queued','running','stopping'].includes(t.blockedFrom||'queued'))requireValue(!gate?.blocked,gate?.reason||'审批通道不可用');
  for(const dep of t.dependencies){const parent=this.getTask(s,dep);requireValue(parent.status==='passed'||parent.status==='cancelled','前置任务尚未通过，请先处理前置再恢复');}
  if(!rerun){const back=t.blockedFrom||'queued';requireValue(back!=='queued'||this.ready(s,t),'前置或端点条件未满足，暂不能恢复；可用 rerun 作废后重新执行');}
  s.paused=false;
  const reason=text(note||('人工恢复：'+String(t.error||'阻塞')),8000,'note');
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
  if(prompt)t.prompt=text(prompt,16000,'prompt');
  if(endpoint!==undefined){
   const target=key(endpoint),e=this.state.endpoints[target];
   if(!e||!e.confirmed)throw Error('目标执行端尚未由用户接入');
   if(!this.vis(s,e))throw Error('目标执行端未对当前会话共享');
   t.endpoint=target;
  }
  t.autoReworks=0;this.invalidate(s,t,text(note,8000,'note'),true);return this.public(actor);
 }
 closeTask(actor,id){const s=this.session(actor),t=this.getTask(s,key(id));requireValue(['passed','failed','unverified','cancelled'].includes(t.status),'未完成任务请先用单任务cancel结束执行');requireValue(!this.live.has(t.runId),'任务进程仍在停止中，请稍候');if(!t.closedAt){t.closedAt=new Date().toISOString();t.closedEndpointLabel=this.state.endpoints[t.endpoint]?.label||t.endpoint||'未知执行端';this.event(s,'task_closed',t.title+'：移出当前任务列表，保留产物、任务状态和历史审查记录');}return this.public(actor);}
 async control(actor,action,id){if(action==='close')return this.closeTask(actor,id);const s=this.session(actor);requireValue(['pause','resume','cancel'].includes(action),'操作无效');requireValue(id===undefined||action==='cancel','任务编号只适用于单任务cancel');if(action==='resume'){requireValue(![...this.live.values()].some(l=>l.s===s),'仍有进程停止中');s.paused=false;for(const t of s.tasks.filter(t=>t.status==='paused')){if(t.recovery_from==='awaiting_review'&&t.result){t.status='awaiting_review';}else{t.status='queued';t.recovery_from=t.recovery_from||'interrupted';}}this.event(s,'resume','当前Agent恢复工作，先核对落盘进度');this.schedule();}
  else{
   const one=id!==undefined,targets=one?[this.getTask(s,key(id))]:s.tasks.filter(t=>unfinished.has(t.status)||t.status==='paused');
   if(one)requireValue(unfinished.has(targets[0].status)||targets[0].status==='paused','任务已经结束，不能再次取消');else s.paused=true;
   const settling=[];for(const t of targets){if(action==='cancel'){t.cancelRequested=true;delete t.invalidated;}t.recovery_from=t.status;const live=this.live.get(t.runId);if(live){t.status='stopping';live.controller.abort();settling.push(live.promise);}else{t.status=action==='cancel'?'cancelled':'paused';if(action==='cancel')t.cancelledAt=new Date().toISOString();}}
   this.event(s,action,one?targets[0].title+'：请求结束此任务；其他任务保持各自状态':action==='pause'?'暂停派发，正在停止受管工作':'取消本会话工作');
   let timer;try{await Promise.race([Promise.allSettled(settling),new Promise(r=>{timer=setTimeout(r,8000);timer.unref?.();})]);}finally{clearTimeout(timer);}if(one)this.schedule();
  }
  this.save();return this.public(actor);
 }
 async kickNotify(id){const s=this.state.sessions[id];if(!s||s.paused||this.notifying.has(id)||!s.pendingEvents.length||this.closed)return;this.notifying.add(id);try{const ids=[...s.pendingEvents],events=this.state.events.filter(e=>ids.includes(e.id));const accepted=await this.notify(id,events);if(accepted){s.pendingEvents=s.pendingEvents.filter(x=>!ids.includes(x));this.save();}}catch(e){s.notificationError=String(e.message);this.save();}finally{this.notifying.delete(id);}}
 async close(){this.closed=true;const checks=[...this.connecting.values()];for(const c of checks)c.controller.abort(Error('插件关闭，协议连接检查已取消'));await Promise.allSettled(checks.map(c=>c.promise));for(const s of Object.values(this.state.sessions))await this.control({id:s.id},'pause');this.save();}
}
