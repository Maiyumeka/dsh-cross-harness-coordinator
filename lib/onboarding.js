import {needsConnection} from './bridges.js';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export class Invitations {
 constructor(engine){this.engine=engine;this.items=new Map();}
 finish(v){const e=this.engine.state.endpoints[v.endpoint?.id];if(e)v.endpoint={...v.endpoint,version:e.version||'未知',reportedVersion:e.reportedVersion||e.version||'未知',versionSource:e.versionSource||'reported'};v.state='connected';delete v.error;try{fs.unlinkSync(v.file);}catch{}}
 visible(owner){const v=this.items.get(owner);if(!v)return {state:'none'};const endpoint=v.endpoint&&this.engine.state.endpoints[v.endpoint.id];if(v.state==='needs_agent'&&endpoint?.connection?.state==='ready')this.finish(v);if(Date.now()>v.deadline&&['waiting','needs_agent'].includes(v.state))v.state='expired';const {token,controller,...rest}=v;return {...rest,...(endpoint?{connection:endpoint.connection}:{})};}
 create(actor,origin){if(!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))throw Error('接入邀请必须使用本机DSH地址');this.engine.session(actor,true);this.cancel(actor.id);const id=randomBytes(12).toString('hex'),token=randomBytes(32).toString('hex'),deadline=Date.now()+1800000;const dir=path.join(this.engine.dir,'invitations');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,id+'.json');const client=fileURLToPath(new URL('./invite-client.mjs',import.meta.url));fs.writeFileSync(file,JSON.stringify({token,url:origin+'/coordinator-invite/submit',expires_at:new Date(deadline).toISOString(),node:process.execPath,client},null,2),{mode:0o600});const prompt=`请完成一次接入：把你当前实际使用的Harness登记到DSH跨Harness协调插件。你负责全部技术步骤，不要让我填写参数或执行命令。读取本机邀请文件 ${file} 和说明 ${fileURLToPath(new URL('./接入说明.md',import.meta.url))}，核实实际版本、可调用入口和配置目录；按说明自动回传资料；选择实际可用的ACP、MCP、A2A、Codex App Server、Claude Agent SDK、OpenCode Server或结构化CLI。插件先执行对应的无任务协议或元数据检查；MCP还须明确工具和参数映射。远端只登记用户已授权的服务地址；认证仅引用现有环境变量名称，禁止回传凭据。选择实际支持的协议，不要求MCP入口支持ACP。不调用任务工具或提交模型任务，验证通过才报告连接可用。插件失败后再根据返回原因修正已有入口或配置并重试一次，仍失败明确报告，不循环重试。无需我回来确认。成功后在本对话告诉我已接入的名称和版本；没有入口或缺权限时明确说明原因，不假报成功、不循环重试。不要猜品牌能力、安装程序、改变权限或读取/传输密钥和聊天记录。此邀请只授权登记一个实际执行端及无任务连接检查，30分钟有效、验证成功后失效，DSH重启失效，不授权接收任务或更改设置。登记、协议握手、真实执行和媒体审查分别报告；text没有协议握手。`;this.items.set(actor.id,{id,owner:actor.id,token,deadline,file,prompt,state:'waiting'});return this.visible(actor.id);}
 async submit(token,payload){
  const v=[...this.items.values()].find(v=>{const a=Buffer.from(v.token),b=Buffer.from(String(token));return a.length===b.length&&timingSafeEqual(a,b);});
  if(v?.state==='needs_agent'&&this.engine.state.endpoints[v.endpoint?.id]?.connection?.state==='ready')this.finish(v);
  if(!v||!['waiting','needs_agent'].includes(v.state)||Date.now()>v.deadline)throw Error('邀请已使用、取消、检查中或过期');
  if((v.attempts||0)>=2)throw Error('同一邀请已完成插件检查和一次修正，不能继续重试；请由登记会话使用coordinator_control action=connect修正已有执行端，或生成新邀请');
  if(payload.unsupported_reason){v.state='unsupported';v.error=String(payload.unsupported_reason).slice(0,2000);return {received:true,connected:false,error:v.error};}
  if(!payload.label||!payload.definition)throw Error('缺少名称或调用定义');
  const definition=payload.definition,id='h_'+v.id.slice(0,12);
  if(v.endpoint&&!needsConnection(definition))throw Error('协议连接失败不能改报text来绕过连接验证');
  const endpoint={...definition,id,label:String(payload.label).slice(0,80),version:String(payload.version||'未知').slice(0,100),reported:String(payload.capabilities||'未知').slice(0,2000),capabilities:{...(definition.capabilities||{}),reported:true}};
  if(v.endpoint){
   if(!this.engine.state.endpoints[id])throw Error('已登记执行端被移除，请重新邀请');
   if(Object.values(this.engine.state.sessions).some(s=>s.tasks.some(t=>t.endpoint===id&&!t.closedAt&&!['cancelled','failed','unverified'].includes(t.status))))throw Error('已有任务引用该执行端，不能通过邀请修改调用定义');
  }
  try{this.engine.endpoint({id:v.owner},endpoint);}catch(error){
   if(error.protocolStage!=='fingerprint')throw error;
   v.attempts=(v.attempts||0)+1;v.state='needs_agent';v.error=error.message;
   if(error.fingerprintReport)error.fingerprintReport.proposedDefinition=definition;
   const previous=this.engine.state.endpoints[id],result=this.engine.fingerprintFailure(this.engine.session({id:v.owner}),previous,error);
   return {received:true,...result,error:v.error,fallback:{action:'reconfirm',retryAllowed:false,instruction:'重登记不能覆盖指纹；由登记会话查看差异、核对并明确重新确认。'}};
  }v.attempts=(v.attempts||0)+1;
  v.endpoint={id,label:endpoint.label,version:endpoint.version};v.state='checking';
  let result={registered:true,connected:true,endpointId:id,connection:{state:'not_applicable'}};
  if(needsConnection(endpoint)){
   v.controller=new AbortController();
   try{result=await this.engine.connectEndpoint({id:v.owner},id,{signal:v.controller.signal});}
   catch(error){result={registered:true,connected:false,endpointId:id,error:error.message};}
   delete v.controller;
  }
  if(v.state==='cancelled')return {received:true,registered:true,connected:false,endpointId:id,error:'邀请检查已取消'};
  if(result.connected)this.finish(v);else{v.state='needs_agent';v.error=result.connection?.error||result.error||'协议连接未通过';}
  const saved=this.engine.state.endpoints[id],retryAllowed=v.attempts<2;return {received:true,registered:true,connected:result.connected,endpointId:id,name:endpoint.label,version:saved.version,reportedVersion:saved.reportedVersion,versionSource:saved.versionSource,connection:result.connection||{state:'needs_agent',error:v.error},...(result.connected?{}:{error:v.error,fallback:{action:retryAllowed?'agent_diagnose':'owner_connect_or_new_invite',retryAllowed,instruction:retryAllowed?'插件未完成连接；核对已有入口、配置和宿主限制后，用同一邀请修正重试一次。也可由登记会话使用coordinator_control connect。不能扩大权限或自报验证通过。':'同一邀请的修正次数已用完，不能继续提交；由登记会话使用coordinator_control action=connect修正已有执行端，或生成新邀请。无需重复登记现有端点，不能把失败改报成功。'}})};
 }
 cancel(owner){const v=this.items.get(owner);if(v){v.state='cancelled';v.controller?.abort(Error('用户取消接入检查'));try{fs.unlinkSync(v.file);}catch{}}return this.visible(owner);}
 close(){for(const owner of this.items.keys())this.cancel(owner);this.items.clear();}
}
