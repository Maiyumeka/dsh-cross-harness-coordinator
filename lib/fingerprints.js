import fs from 'node:fs';
import {createHash} from 'node:crypto';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sorted=values=>[...values].sort((a,b)=>a.file.localeCompare(b.file));
export function fingerprintReport(endpoint,current){
 const previous=endpoint.fingerprints||[],before=new Map(previous.map(f=>[f.file,f.sha256])),after=new Map(current.map(f=>[f.file,f.sha256]));
 const differences=[...new Set([...before.keys(),...after.keys()])].filter(file=>before.get(file)!==after.get(file)).map(file=>{
  let mtime=null;try{mtime=fs.statSync(file).mtime.toISOString();}catch{}
  return {file,previous:before.get(file)||null,current:after.get(file)||null,mtime,kind:!after.has(file)?'removed':!before.has(file)?'added':'changed'};
 });
 // Bind confirmation to both baselines and the concrete invocation. A stale UI
 // cannot approve a different executable, endpoint, or file replacement.
 const invocation=Object.fromEntries(['command','args','probe_args','launch_env','protocol','mcp','server','sdk','cli'].map(k=>[k,endpoint[k]??null]));
 return {endpointId:endpoint.id,label:endpoint.label,changed:differences.length>0,differences,currentFingerprints:current,confirmationVersion:hash({endpointId:endpoint.id,owner:endpoint.owner,invocation,previous:sorted(previous),current:sorted(current)})};
}
export function fingerprintError(report){return Object.assign(Error('执行端程序或脚本已变化，请先查看差异，再明确重新确认接入'),{protocolStage:'fingerprint',fingerprintReport:report});}
