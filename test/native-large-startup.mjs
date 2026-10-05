import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{chromium}=require('playwright'),browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage();
try{
 await page.goto(process.env.COORDINATOR_TEST_URL,{waitUntil:'networkidle'});
 const rpc=async(method,payload)=>page.evaluate(async({method,payload})=>{const r=await fetch('/cross-harness-coordinator/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload})});const v=(await r.json()).result;if(!v.ok)throw Error(JSON.stringify(v));return v.value;},{method,payload});
 const state=JSON.parse(fs.readFileSync(path.join(process.env.COORDINATOR_TEST_HOME,'storages/cross-harness-coordinator/state.json'))),sessionId=Object.keys(state.sessions)[0];assert.ok(sessionId);
 const invitation=await rpc('invite',{sessionId}),privateInvite=JSON.parse(fs.readFileSync(invitation.file)),command=process.env.COORDINATOR_STARTUP_FIXTURE;
 assert.ok(fs.statSync(command).size>256*1024*1024);
 const submitted=await page.evaluate(async({url,token,command})=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-coordinator-invite':token},body:JSON.stringify({label:'大文件隔离回归端',version:'fixture',definition:{command,args:[],protocol:'text'}})});return {status:r.status,body:await r.json()};},{url:privateInvite.url,token:privateInvite.token,command});
 assert.equal(submitted.status,202);assert.equal(submitted.body.connected,true);const after=await rpc('snapshot',{sessionId});assert.equal(after.invitation.state,'connected');assert.equal(after.endpoints.length,1);assert.equal(after.tasks.length,0);
 const result={passed:true,version:after.version,bytes:fs.statSync(command).size,registeredIn:'isolated test profile only',executed:false,coverage:['原生回传HTTP接受超过256MiB启动文件','202登记成功','邀请显示已接入','没有真实Harness或任务执行']};fs.writeFileSync(path.resolve('test-data/native-large-startup-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
