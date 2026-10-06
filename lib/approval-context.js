// Read the public policy seam; never inspect chat text or issue a probe approval.
export function approvalContext(approval,session){
 const checkedAt=new Date().toISOString();
 const result=(state,policy,canRequest,reason,code)=>({state,policy,canRequest,reason,code,checkedAt});
 if(!session||typeof approval?.request!=='function')return result('unavailable',null,false,'本会话无法提供操作批准：原会话或DSH审批服务不可用','COORDINATOR_APPROVAL_UNAVAILABLE');
 if(typeof approval.overrideOf!=='function'||!approval.config)return result('unknown',null,false,'无法核实本会话审批策略，Codex任务已在派发前阻塞；不会用试运行探测审批','COORDINATOR_APPROVAL_UNKNOWN');
 let policy;try{policy=approval.overrideOf(session)??approval.config.policy??'ask';}catch{return result('unknown',null,false,'无法读取本会话审批策略，Codex任务已在派发前阻塞','COORDINATOR_APPROVAL_UNKNOWN');}
 if(policy==='never')return result('disabled','never',false,'本会话无法提供操作批准：会话禁用审批提示（never），Codex需要批准的命令/文件操作不可用','COORDINATOR_APPROVAL_DISABLED');
 if(policy==='ask')return result('ask','ask',true,'会话允许请求操作批准；实际答复通道仍可能不可用，批准不保证获得',null);
 return result('unknown',null,false,'审批服务返回未知策略，Codex任务已在派发前阻塞','COORDINATOR_APPROVAL_UNKNOWN');
}
