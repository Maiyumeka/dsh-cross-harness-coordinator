import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const count=Number(process.argv[2]||6);
if(!Number.isInteger(count)||count<1||count>20)throw Error('重复次数须为1到20');
const cwd=path.resolve(import.meta.dirname,'..'),root=path.join(cwd,'test-data','repeat-core-'+Date.now());fs.mkdirSync(root,{recursive:true});
const runs=[];
for(let iteration=1;iteration<=count;iteration++){
 const log=path.join(root,iteration+'.log'),fd=fs.openSync(log,'w'),started=Date.now();
 let child;try{child=spawn(process.execPath,['test/run.mjs'],{cwd,env:process.env,windowsHide:true,stdio:['ignore',fd,fd]});}finally{fs.closeSync(fd);}
 const status=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(exitCode,signal)=>resolve({exitCode,signal}));});
 const output=fs.readFileSync(log,'utf8');let summary;
 // Each test prints its own JSON; the runner summary is the last root object.
 const start=[...output.matchAll(/^\{\r?$/gm)].at(-1)?.index;
 try{summary=JSON.parse(output.slice(start));}catch{}
 const result={iteration,...status,passed:status.exitCode===0&&summary?.passed===true&&summary?.core?.length===16,seconds:(Date.now()-started)/1000,summary:summary||null,log};runs.push(result);
 fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({passed:runs.length===count&&runs.every(r=>r.passed),requested:count,completed:runs.length,runs},null,2));
 console.log(JSON.stringify({iteration,passed:result.passed,core:summary?.core?.length,seconds:result.seconds,root}));
 if(!result.passed){process.exitCode=1;break;}
}
