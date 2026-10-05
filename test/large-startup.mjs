import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Coordinator} from '../lib/engine.js';
import {Invitations} from '../lib/onboarding.js';
const root=path.resolve('test-data','large-startup-'+Date.now());fs.mkdirSync(root,{recursive:true});
const file=path.join(root,'large-executable.bin'),size=257*1024*1024+17,fd=fs.openSync(file,'w');
fs.ftruncateSync(fd,size);fs.writeSync(fd,Buffer.from('begin'),0,5,0);fs.writeSync(fd,Buffer.from('tail'),0,4,size-4);fs.closeSync(fd);
const digest=createHash('sha256');for await(const chunk of fs.createReadStream(file))digest.update(chunk);const expected=digest.digest('hex');
const engine=new Coordinator({dir:path.join(root,'state'),run:()=>{throw Error('不得启动真实任务');}}),actor={id:'large-file-test',cwd:root},definition={command:file,args:[],probe_args:[],protocol:'text'};
const invitation=new Invitations(engine),shown=invitation.create(actor,'http://127.0.0.1:32180'),token=JSON.parse(fs.readFileSync(shown.file)).token;
const original=fs.readSync;let largestBuffer=0;
fs.readSync=function(fd,buffer,...args){largestBuffer=Math.max(largestBuffer,buffer.byteLength);return original.call(fs,fd,buffer,...args);};
try{assert.equal((await invitation.submit(token,{label:'大启动文件回归',definition})).connected,true);}finally{fs.readSync=original;}
const endpoint=Object.values(engine.state.endpoints)[0];assert.equal(endpoint.fingerprints[0].sha256,expected);assert.ok(largestBuffer<=1024*1024);engine.checkEndpoint(endpoint);
const changed=fs.openSync(file,'r+');fs.writeSync(changed,Buffer.from('EDIT'),0,4,size-4);fs.closeSync(changed);assert.throws(()=>engine.checkEndpoint(endpoint),/已变化/);
// A mutation during hashing must never be accepted as a stable identity.
let mutated=false;fs.readSync=function(handle,buffer,...args){const n=original.call(fs,handle,buffer,...args);if(!mutated&&n){mutated=true;const f=fs.openSync(file,'r+');fs.writeSync(f,Buffer.from('RACE'),0,4,size-4);fs.closeSync(f);}return n;};
try{assert.throws(()=>engine.fingerprints(definition),/校验时发生变化/);}finally{fs.readSync=original;}
let actual;
if(process.env.COORDINATOR_STARTUP_FILE){const command=process.env.COORDINATOR_STARTUP_FILE;const fingerprints=engine.fingerprints({command,args:[],probe_args:[]});actual={bytes:fs.statSync(command).size,hashed:true,sha256:fingerprints[0].sha256};}
invitation.close();await engine.close();
const result={passed:true,size,largestBuffer,actual,coverage:['超过256MiB的邀请登记','完整文件SHA256一致','分块内存上限1MiB','相同体积尾部修改被拒绝','校验过程中修改被拒绝','没有启动模型或真实任务']};
fs.writeFileSync(path.resolve('test-data/large-startup-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
