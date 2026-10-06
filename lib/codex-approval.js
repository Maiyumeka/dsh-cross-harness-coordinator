import fs from 'node:fs';
import path from 'node:path';
const check=(ok,message)=>{if(!ok)throw Error(message);};
export const diagnosticText=(value,limit=64000)=>String(value||'').replace(/\bBearer\s+[^\s"']+/gi,'Bearer [已隐藏]').replace(/\b((?:[A-Z0-9_]*API_KEY|access_token|refresh_token|password|secret)\s*[=:]\s*)[^\s,"']+/gi,'$1[已隐藏]').slice(-limit);
function workspacePath(cwd,value){
 check(typeof value==='string'&&value.length>0&&value.length<=1000,'审批缺少有效路径');
 const root=fs.realpathSync(cwd),target=path.resolve(root,value),relative=path.relative(root,target);
 check(!relative.startsWith('..')&&!path.isAbsolute(relative),'审批路径超出任务工作区');
 let parent=target;while(!fs.existsSync(parent)){const next=path.dirname(parent);check(next!==parent,'审批路径无有效上级目录');parent=next;}
 const realRelative=path.relative(root,fs.realpathSync(parent));check(!realRelative.startsWith('..')&&!path.isAbsolute(realRelative),'审批路径链接超出任务工作区');return target;
}
export function codexApproval(method,params,item,cwd){
 check(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(method),'该审批类型尚未接入');
 check(!params.additionalPermissions&&!params.networkApprovalContext&&!params.grantRoot,'请求涉及额外权限或网络/目录授权，不能作为普通任务操作批准');
 check(typeof params.itemId==='string'&&params.itemId.length<=200,'审批缺少itemId');
 const request={method,threadId:params.threadId,turnId:params.turnId,itemId:params.itemId,reason:diagnosticText(params.reason,2000)};
 if(method==='item/commandExecution/requestApproval'){
  check(!params.kind||params.kind==='command','当前只支持命令执行审批');
  const command=params.command??item?.command;check(typeof command==='string'&&command.trim()&&command.length<=16000,'缺少完整命令，不能批准不可见操作');
  check(diagnosticText(command,20000)===command,'命令包含敏感凭据，不能存入审批记录');
  request.command=command;request.cwd=workspacePath(cwd,params.cwd??item?.cwd??cwd);
 }else{
  check(item?.type==='fileChange'&&Array.isArray(item.changes)&&item.changes.length>0&&item.changes.length<=40,'缺少实际文件更改，不能批准不可见补丁');
  request.changes=item.changes.map(change=>{
   check(typeof change.diff==='string','文件更改缺少diff');check(['add','delete','update'].includes(change.kind?.type)&&Object.keys(change.kind).every(k=>k==='type'||k==='move_path'),'文件更改类型无效');
   const kind={type:change.kind.type};if(change.kind.move_path!=null){check(kind.type==='update','只有update允许移动目标');kind.move_path=workspacePath(cwd,change.kind.move_path);}
   return {path:workspacePath(cwd,change.path),kind,diff:change.diff};
  });
  request.cwd=fs.realpathSync(cwd);
 }
 const encoded=JSON.stringify(request);check(encoded.length<=32000,'审批内容超过32KB，请拆分任务后重新审查');check(diagnosticText(encoded,40000)===encoded,'审批内容包含敏感凭据，未保存');return request;
}
export function recheckCodexApproval(request,cwd){
 workspacePath(cwd,request.cwd);for(const change of request.changes||[]){workspacePath(cwd,change.path);if(change.kind.move_path)workspacePath(cwd,change.kind.move_path);}
}
