import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {diagnosticText} from './codex-approval.js';
const segment=value=>createHash('sha256').update(String(value)).digest('hex').slice(0,24);
export const runLogPath=(dir,owner,taskId,runId)=>path.join(dir,'run-logs',segment(owner),segment(taskId),segment(runId)+'.jsonl');
const keys=new Set(['phase','protocol','method','itemId','threadId','turnId','requestId','decision','reason','code','kind','bytes','maxBytes','receivedBytes','largestMessageBytes','bufferBytes','signalAborted','abortSource','exitCode','signal','artifactPath','imageStatus','encodedChars','elapsedMs','remainingMs','stage','runId','revision']);
export function createRunLog(dir,owner,taskId,runId,{maxBytes=1024*1024}={}){
 const file=runLogPath(dir,owner,taskId,runId);let bytes=0,entries=0,truncated=false,error='';
 try{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'',{flag:'wx',mode:0o600});}catch(e){error=diagnosticText(e.message,1000);}
 const write=(event,details={})=>{
  if(error||truncated)return;const data={at:new Date().toISOString(),event:String(event).slice(0,100)};
  for(const [key,value]of Object.entries(details))if(keys.has(key)&&['string','number','boolean'].includes(typeof value))data[key]=typeof value==='string'?diagnosticText(value,key==='reason'?2000:1000):value;
  const line=JSON.stringify(data)+'\n',size=Buffer.byteLength(line);
  try{if(bytes+size+200>maxBytes){const tail=JSON.stringify({at:data.at,event:'log_truncated',maxBytes})+'\n';fs.appendFileSync(file,tail);bytes+=Buffer.byteLength(tail);truncated=true;return;}fs.appendFileSync(file,line);bytes+=size;entries++;}catch(e){error=diagnosticText(e.message,1000);}
 };
 return {write,status:()=>({path:file,bytes,entries,truncated,available:!error,error:error||null})};
}
