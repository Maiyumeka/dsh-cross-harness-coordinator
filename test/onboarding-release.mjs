import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {check,prepare} from '../scripts/agent-install.mjs';
import {sha256} from '../scripts/archive.mjs';
const release=JSON.parse(fs.readFileSync(path.resolve('dist/agent-install.json'),'utf8'));
const root=path.resolve('test-data','onboarding-release-'+Date.now()),home=path.join(root,'home'),profile=path.join(home,'profiles','desktop');fs.mkdirSync(profile,{recursive:true});
const oldName='dsh-cross-harness-coordinator-v0-1-10',oldPackage=path.join(profile,'node_modules',oldName);fs.mkdirSync(oldPackage,{recursive:true});
fs.writeFileSync(path.join(oldPackage,'package.json'),JSON.stringify({name:oldName,version:'0.1.10',dshCoordinator:{canonicalName:'dsh-cross-harness-coordinator'}}));
fs.writeFileSync(path.join(profile,'package.json'),JSON.stringify({dependencies:{[oldName]:'fixture'},dsh:{profile:{bundles:[oldName]}}}));
const state=path.join(home,'storages','cross-harness-coordinator');fs.mkdirSync(state,{recursive:true});fs.writeFileSync(path.join(state,'state.json'),JSON.stringify({schema:1,sessions:{},endpoints:{probe:{id:'probe',owner:'owner',connection:{state:'checking'}}},events:[]}));
// A real desktop app.asar carries the CLI inside it: dsh/node_modules/@deepseek-ai/dsh/package.json.
// The cli path recorded in the release manifest is only a launcher, so the check has to anchor on
// what the asar actually ships. These fixtures reproduce both layouts.
const cliRoot=path.join(root,'fixture-cli');fs.mkdirSync(path.join(cliRoot,'lib'),{recursive:true});
const writeCliVersion=value=>fs.writeFileSync(path.join(cliRoot,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version:value}));
writeCliVersion(release.runtimeVersion);
function writeAsar(file,entries){
  const texts=entries.map(([,text])=>text),payloads=texts.map(text=>Buffer.from(text));
  const manifest={files:{}};let cursor=0;
  entries.forEach(([name],index)=>{manifest.files[name]={size:payloads[index].length,offset:String(cursor)};cursor+=payloads[index].length;});
  const header=Buffer.from(JSON.stringify(manifest)),headerSize=header.length+8,total=payloads.reduce((sum,buffer)=>sum+buffer.length,0);
  const asar=Buffer.alloc(8+headerSize+total);
  asar.writeUInt32LE(headerSize,4);asar.writeUInt32LE(header.length,12);header.copy(asar,16);
  let at=8+headerSize;for(const payload of payloads){payload.copy(asar,at);at+=payload.length;}
  fs.writeFileSync(file,asar);
}
const desktop=JSON.stringify({version:release.runtimeVersion});
const embedded=JSON.stringify({name:'@deepseek-ai/dsh',version:release.runtimeVersion});
const asarWithCli=path.join(root,'fixture-app.asar');
writeAsar(asarWithCli,[['package.json',desktop],['dsh/node_modules/@deepseek-ai/dsh/package.json',embedded]]);
const asarWithoutCli=path.join(root,'fixture-flat.asar');
writeAsar(asarWithoutCli,[['package.json',desktop]]);
const releaseFile=path.join(root,'fixture-release.json');
const releaseFor=(overrides={})=>({...release,defaults:{...release.defaults,home,cli:path.join(cliRoot,'lib','bin.js'),asar:asarWithCli},...overrides});
const writeRelease=overrides=>{fs.writeFileSync(releaseFile,JSON.stringify(releaseFor(overrides)));return releaseFile;};
const coverage=[];
writeRelease();
const checked=check({home,profile:'desktop',release:releaseFile});
assert.equal(checked.runtimeVersion,release.runtimeVersion);
coverage.push('桌面 asar 布局（CLI 在 asar 内、磁盘无独立 CLI 包）通过检查');
coverage.push('asar 内嵌 CLI 版本作为运行时证据');
writeRelease({defaults:{...releaseFor().defaults,cli:path.join(root,'not-a-cli','bin.js')}});
assert.equal(check({home,profile:'desktop',release:releaseFile}).runtimeVersion,release.runtimeVersion);
coverage.push('非 CLI 包的启动器路径不被当作运行时证据');
writeCliVersion('0.0.0-stale');writeRelease();
assert.throws(()=>check({home,profile:'desktop',release:releaseFile}),/runtime mismatch: desktop [^,]+, CLI 0\.0\.0-stale/);
coverage.push('磁盘上真正不一致的 CLI 仍被拒绝');
writeCliVersion(release.runtimeVersion);
writeRelease({defaults:{...releaseFor().defaults,asar:asarWithoutCli}});
assert.equal(check({home,profile:'desktop',release:releaseFile}).runtimeVersion,release.runtimeVersion);
coverage.push('asar 无内嵌条目时回退到磁盘 CLI 版本');
writeCliVersion('0.0.0-stale');
assert.throws(()=>check({home,profile:'desktop',release:releaseFile}),/runtime mismatch/);
coverage.push('回退路径同样拒绝不一致');
writeCliVersion(release.runtimeVersion);writeRelease({runtimeVersion:'0.0.0-wrong'});
assert.throws(()=>check({home,profile:'desktop',release:releaseFile}),/runtime mismatch: desktop [^,]+, expected 0\.0\.0-wrong/);
coverage.push('桌面版本与发布声明不一致时拒绝');
writeRelease();
assert.equal(checked.pendingConnections.length,1);const backupRoot=path.join(root,'backups');assert.throws(()=>prepare({home,profile:'desktop',backupRoot,release:releaseFile}),/协议连接检查尚未空闲/);assert.equal(fs.existsSync(backupRoot),false);
coverage.push('ACP检查进行中禁止升级准备');
for(const [file,digest]of Object.entries(checked.hashes))assert.equal(sha256(fs.readFileSync(path.resolve(file))),digest,'发布源码不一致：'+file);
coverage.push('发布包及文件清单完整性','包内源码文件对应发布哈希');
const result={passed:true,version:checked.release.version,archive:checked.release.archive,sha256:checked.release.sha256,sourceFilesVerified:Object.keys(checked.hashes).length,fixtureInstalledVersion:checked.installedVersion,productionModified:false,coverage,root};fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
