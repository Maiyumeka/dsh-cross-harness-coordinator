import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const PROTOCOLS=['text','acp','mcp','a2a','codex','claude-sdk','opencode','cli'];
export const needsConnection=e=>(e?.protocol||'text')!=='text';
const check=(ok,message)=>{if(!ok)throw Error(message);};
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const file=v=>typeof v==='string'&&path.isAbsolute(v)&&fs.existsSync(v)&&fs.statSync(v).isFile();
export const workerFile=name=>fileURLToPath(new URL(name,import.meta.url));
export function validateServer(value,websocket=false){
 check(object(value)&&Object.keys(value).every(k=>['url','interfaceUrl','auth','directory','cardPath','transport','legacyCompat'].includes(k)),'网络入口定义无效');
 const u=new URL(value.url),loopback=['localhost','127.0.0.1','[::1]'].includes(u.hostname);
 check(!u.username&&!u.password&&!u.hash,'入口URL不能包含凭据或片段');
 check(!(u.search&&/token|key|auth|password|secret/i.test(u.search)),'凭据不能放在URL中');
 check(websocket?u.protocol==='wss:'||(u.protocol==='ws:'&&loopback):u.protocol==='https:'||(u.protocol==='http:'&&loopback),'远端入口须使用TLS；明文仅允许本机回环');
 const auth=value.auth||{};check(object(auth)&&Object.keys(auth).every(k=>['bearerEnv','basicEnv','headerEnv'].includes(k)),'认证只接受环境变量名称引用');
 check(Object.keys(auth).length<=1,'只能使用一种认证方式');
 const env=v=>typeof v==='string'&&/^[A-Z][A-Z0-9_]{0,100}$/.test(v);
 if(auth.bearerEnv)check(env(auth.bearerEnv),'认证环境变量名称无效');
 if(auth.basicEnv)check(env(auth.basicEnv),'认证环境变量名称无效');
 if(auth.headerEnv)check(object(auth.headerEnv)&&Object.keys(auth.headerEnv).length<=4&&Object.entries(auth.headerEnv).every(([k,v])=>/^(authorization|x-api-key|api-key)$/i.test(k)&&env(v)),'认证头引用无效');
 check(!websocket||Object.keys(auth).length===0,'Codex WebSocket 当前仅使用服务器现有认证，不支持额外HTTP认证头');
 if(value.directory!==undefined)check(typeof value.directory==='string'&&value.directory.length<1000,'远端工作目录无效');
 if(value.cardPath!==undefined)check(typeof value.cardPath==='string'&&value.cardPath.startsWith('/')&&!value.cardPath.startsWith('//')&&!value.cardPath.includes('://'),'AgentCard路径无效');
 if(value.interfaceUrl!==undefined)validateServer({url:value.interfaceUrl});
 return {...value,url:u.href,auth};
}
export function validateBridge(e){
 check(PROTOCOLS.includes(e.protocol),'不支持的桥接协议');
 if(e.protocol==='a2a'||e.protocol==='opencode'||(e.protocol==='codex'&&e.server)||(e.protocol==='mcp'&&e.mcp?.transport!=='stdio'&&e.mcp?.transport)){
  e.server=validateServer(e.server,e.protocol==='codex');
  if(e.protocol==='a2a')check(!e.server.transport||['JSONRPC','HTTP+JSON','GRPC'].includes(e.server.transport),'A2A传输无效');
  e.command=process.execPath;e.args=[];e.probe_args=[];
 }
 if(e.protocol==='claude-sdk'){
  check(object(e.sdk)&&Object.keys(e.sdk).every(k=>['language','module','cliPath'].includes(k)),'SDK定义无效');
  check(['node','python'].includes(e.sdk.language),'SDK运行时仅支持node或python');
  if(e.sdk.language==='node')check(file(e.sdk.module),'请提供已安装的Claude SDK入口绝对路径');
  else check(!e.sdk.module,'Python SDK使用该解释器已安装的claude_agent_sdk');
  if(e.sdk.cliPath)check(file(e.sdk.cliPath),'Claude CLI路径无效');
 }
 if(e.protocol==='cli'){
  check(Object.keys(e.cli||{}).every(k=>['preset','format','successField','successValue'].includes(k)),'CLI定义字段无效');
  check(object(e.cli)&&['codex','claude','generic'].includes(e.cli.preset),'结构化CLI须指定codex/claude/generic预设');
  check(['json','ndjson'].includes(e.cli.format||'ndjson'),'CLI输出格式无效');
  const startup=Array.isArray(e.args)?e.args:[];
  check(Array.isArray(e.probe_args)&&e.probe_args.length&&e.probe_args.every(a=>typeof a==='string'&&(['--help','--version','-h','-V'].includes(a)||/^[A-Za-z][A-Za-z-]*$/.test(a)||file(a)&&startup.includes(a)||a==='-m'&&startup.includes(a)))&&e.probe_args.some(a=>['--help','--version','-h','-V'].includes(a)),'CLI登记只允许帮助或版本检查');
  if(e.cli.preset==='generic')check(typeof e.cli.successField==='string'&&e.cli.successField.length<100&&['string','boolean','number'].includes(typeof e.cli.successValue),'通用CLI须明确终态成功字段和值');
 }
 return e;
}
export function bridgeFiles(e){
 // Bundle integrity is checked by the installer; endpoint fingerprints cover
 // the external executable/SDK, and survive a change of plugin bundle path.
 return [...(e.sdk?.module?[e.sdk.module]:[]),...(e.sdk?.cliPath?[e.sdk.cliPath]:[])];
}
export function verifiedReceipt(e,r){
 if(e.protocol==='acp')return r?.protocolVersion===1&&r.sessionCreated===true&&r.methods?.includes('initialize')&&r.methods?.includes('session/new');
 const methods={codex:['initialize','initialized','model/list'],'claude-sdk':e.sdk?.language==='python'?['connect','get_server_info']:['initializationResult','supportedModels'],opencode:['global/health','config/providers'],a2a:['agent-card'],cli:['help/version']}[e.protocol];
 return r?.protocol===e.protocol&&r.handshakeVerified===true&&methods?.every(m=>r.methods?.includes(m));
}
export function nativeSelection(e,token){return ['codex','claude-sdk','opencode'].includes(e.protocol)&&e.capabilities?.[token==='model'?'modelSelection':'reasoningSelection']===true&&(token!=='reasoning'||e.protocol==='codex');}
