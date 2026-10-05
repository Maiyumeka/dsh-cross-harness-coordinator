import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {check,prepare,verify} from '../scripts/agent-install.mjs';
import {packageFiles} from '../scripts/archive.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright'),browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
const options={home:path.resolve(process.env.COORDINATOR_TEST_HOME),profile:'web',backupRoot:path.resolve('test-data/update-backups')},release=check(options).release,errors=[];
page.on('pageerror',error=>errors.push(error.message));
const rpc=async(channel,method,payload)=>page.evaluate(async({channel,method,payload})=>{const r=await fetch(channel+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload})});const value=await r.json();if(!value.result?.ok)throw Error(JSON.stringify(value));return value.result.value;},{channel,method,payload});
try{
 await page.goto(process.env.COORDINATOR_TEST_URL,{waitUntil:'networkidle'});
 if(await page.getByRole('button',{name:'继续',exact:true}).count())await page.getByRole('button',{name:'继续',exact:true}).click();
 if(await page.getByRole('button',{name:'稍后配置',exact:true}).count())await page.getByRole('button',{name:'稍后配置',exact:true}).click();
 const tool=args=>rpc('/agent-installer-test','execute',args);
 const previousArchive=path.resolve(process.env.COORDINATOR_PREVIOUS_ARCHIVE??'dist/dsh-cross-harness-coordinator-0.1.1.tgz'),previousVersion=packageFiles(previousArchive).manifest.version;
 const initial=await tool({action:'install_bundle',target:previousArchive,enabled:true});assert.equal(initial.application,'applied');
 fs.mkdirSync(path.resolve('test-data/update-workspace'),{recursive:true});
 const workspace=await rpc('/api','workspace/create',{args:{request:{path:path.resolve('test-data/update-workspace')}}});
 const session=await rpc('/api','session/create',{args:{request:{workspaceId:workspace.workspace.workspaceId}}}),sessionId=session.sessionId;
 await page.getByText('update-workspace',{exact:true}).first().click();
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'协调器',exact:true}).click();
 const old=await rpc('/cross-harness-coordinator','settings',{});assert.equal(old.version,previousVersion==='0.1.1'?undefined:previousVersion);
 const stateFile=check(options).stateFile,originalState=fs.existsSync(stateFile)?fs.readFileSync(stateFile):null;
 fs.mkdirSync(path.dirname(stateFile),{recursive:true});fs.writeFileSync(stateFile,JSON.stringify({sessions:{busy:{id:'busy',tasks:[{id:'queued-test',status:'queued'}]}}}));
 assert.throws(()=>prepare(options),/尚未空闲/);if(originalState)fs.writeFileSync(stateFile,originalState);else fs.unlinkSync(stateFile);
 const backup=prepare(options);
 const update=await tool({action:'install_bundle',target:release.archive,enabled:false});assert.equal(update.application,'applied');
 // Keep the old dependency for recovery; disable only its idle bundle.
 for(const name of backup.previousBundles){const disabled=await tool({action:'set_bundle',target:name,enabled:false});assert.equal(disabled.application,'applied');}
 const applied=await tool({action:'set_bundle',target:release.name,enabled:true});assert.equal(applied.application,'applied',JSON.stringify(applied));
 const settings=await rpc('/cross-harness-coordinator','settings',{});assert.equal(settings.version,release.version);assert.equal(settings.activeRuns,0);
 const status=await rpc('/cross-harness-coordinator','snapshot',{sessionId});assert.equal(status.version,release.version);assert.equal(status.endpoints.length,0);
 const probe=await rpc('/agent-installer-test','probe',{sessionId});assert.equal(probe.tools.length,7);assert.ok(probe.plugins.every(p=>p.enabled&&p.fiberPhase==='active'));
 const disk=verify({...options,backup:backup.backup});
 // Reconnect the old 0.1.1 client bindings, without closing the browser or Host.
 await page.reload({waitUntil:'networkidle'});
 if(await page.getByRole('button',{name:'稍后配置',exact:true}).count())await page.getByRole('button',{name:'稍后配置',exact:true}).click();
 if(!await page.getByRole('button',{name:'协调器',exact:true}).count())await page.getByRole('button',{name:'设置',exact:true}).click();
 await page.getByRole('button',{name:'协调器',exact:true}).click();
 await page.getByText('当前运行版本 '+release.version,{exact:true}).waitFor({timeout:10000});
 await page.getByRole('button',{name:'复制接入邀请',exact:true}).first().click();await page.getByRole('button',{name:'取消邀请',exact:true}).waitFor();
 const invite=await rpc('/cross-harness-coordinator','snapshot',{sessionId});assert.equal(invite.invitation.state,'waiting');assert.equal(JSON.parse(fs.readFileSync(invite.invitation.file)).url,new URL(process.env.COORDINATOR_TEST_URL).origin+'/coordinator-invite/submit');
 await rpc('/cross-harness-coordinator','reject',{sessionId});
 assert.deepEqual(errors,[]);await page.screenshot({path:path.resolve('test-data/agent-updated-settings.png')});
 const result={passed:true,from:previousVersion,to:release.version,installed:update.application,activated:applied.application,runtime:settings,disk,probe,coverage:['不退出DSH从'+previousVersion+'更新','新版宿主与客户端实际生效','当前会话保留','七个协调工具可见','复制邀请生成正确地址','安装不接入真实Harness'],errors};
 fs.writeFileSync(path.resolve('test-data/agent-update-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
