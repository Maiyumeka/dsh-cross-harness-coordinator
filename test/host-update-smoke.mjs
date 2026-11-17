import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {evaluatePluginCompatibility, loadProfileDirectory, composeEntries} from '@deepseek-ai/dsh-app-boot';
import {apply} from '../lib/index.js';
import {packageFiles} from '../scripts/archive.mjs';

const runtime = path.resolve(process.env.COORDINATOR_HOST_RUNTIME);
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const root = fs.mkdtempSync(path.resolve('test-data/host-update-smoke-'));
const coverage = [];
const hostVersion = JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'))).version;
assert.equal(hostVersion, pkg.dshCoordinator.runtimeVersion);
assert.equal(evaluatePluginCompatibility(pkg, {}, hostVersion), undefined);
assert.equal(evaluatePluginCompatibility(pkg, {}, '0.2.2-rc.4'), undefined);
assert.equal(evaluatePluginCompatibility(pkg, {}, '0.2.2'), undefined);
assert.ok(evaluatePluginCompatibility(pkg, {}, '0.2.3-rc.1'));
assert.ok(evaluatePluginCompatibility(pkg, {}, '0.3.0'));
coverage.push('真实宿主兼容检查接受 rc.3、rc.4 和 0.2.2，隔离下一个系列');

const profile = path.join(root, 'profile');
const write = (relative, value) => {
  const target = path.join(profile, relative);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
};
const release = JSON.parse(fs.readFileSync('dist/agent-install.json'));
const packed = packageFiles(release.archive);
assert.equal(packed.manifest.engines.dsh, pkg.engines.dsh);
for(const hook of ['preinstall','install','postinstall','preuninstall','uninstall','postuninstall','prepare']){
  assert.equal(packed.manifest.scripts?.[hook],undefined,'candidate must not run host lifecycle hooks');
}
for (const [name, data] of packed.files) write(path.join('node_modules', pkg.name, name), data.toString());
const healthy = 'coordinator-smoke-healthy';
const obsolete = 'coordinator-smoke-obsolete';
const missing = 'coordinator-smoke-missing';
write('package.json', {name:'coordinator-smoke-profile', dsh:{profile:{bundles:[pkg.name, obsolete, missing, healthy]}}});
write('node_modules/' + obsolete + '/package.json', {
  ...pkg, name:obsolete, engines:{...pkg.engines,dsh:'0.2.2-rc.1'}
});
write('node_modules/' + healthy + '/package.json', {
  name:healthy,version:'1.0.0',dsh:{bundle:{patch:'./cordis.patch.yml'}}
});
write('node_modules/' + healthy + '/cordis.patch.yml', '- insert:\n    - id: healthy-sentinel\n      name: healthy-sentinel\n');
const before = fs.readFileSync(path.join(profile, 'package.json'));
const loaded = loadProfileDirectory('coordinator-smoke', profile, path.join(runtime, 'package.json'));
assert.equal(loaded.layers.length, 2);
assert.deepEqual(loaded.skippedBundles.map(item => item.packageName), [obsolete, missing]);
assert.match(loaded.skippedBundles[0].reason, /incompatible/);
const entries = composeEntries(loaded.layers.map(layer => layer.patches));
assert.ok(JSON.stringify(entries).includes('healthy-sentinel'));
assert.ok(JSON.stringify(entries).includes(pkg.name));
assert.deepEqual(fs.readFileSync(path.join(profile, 'package.json')), before);
coverage.push('真实加载器跳过旧候选包和缺失包，正常插件继续组装，配置字节保持一致');

const tools = new Map(), effects = [];
let rpc, observed = 0, disposed = 0, route;
const signal = new AbortController().signal;
const cwd = path.join(root, 'workspace');
fs.mkdirSync(cwd);
const ctx = {
  agents:{get:()=>undefined}, sessions:{get:()=>undefined},
  sessionController:{prompt:async()=>{throw Error('probe cannot submit prompts');}},
  sessionQuery:{observeSession:async(id,options)=>{
    assert.equal(options.signal, signal);
    assert.equal(options.projectionMode,'none');
    if(id==='missing')throw Error('session not found');
    observed++;
    return {header:{cwd},[Symbol.dispose]:()=>{disposed++;}};
  }},
  tools:{register:tool=>{tools.set(tool.name,tool);return()=>tools.delete(tool.name);}},
  systemPrompt:{section:()=>()=>{}},
  connection:{register:(_ctx,_channel,handler)=>{rpc=handler;}},
  webServer:{port:32180,register:value=>{route=value;return()=>{};}},
  on:()=>()=>{},effect:factory=>effects.push(factory()),
};
const engine = apply(ctx,{dataDir:path.join(root,'state')});
try {
  assert.equal(tools.size,7);
  assert.equal(route.path,'/coordinator-invite');
  assert.equal((await rpc('settings',{},signal)).value.version,pkg.version);
  assert.equal((await rpc('snapshot',{sessionId:'cold'},signal)).ok,true);
  assert.equal(observed,disposed);
  assert.equal((await rpc('snapshot',{sessionId:'missing'},signal)).ok,false);
  assert.equal((await rpc('settings-save',{concurrency:0},signal)).ok,false);
  coverage.push('真实 defineTool 注册七项工具，设置 RPC、冷会话读取、释放和错误返回通过');
} finally {
  for(const cleanup of effects)await cleanup();
}
assert.equal(tools.size,0);
coverage.push('插件卸载释放工具和引擎资源');

const require = createRequire(import.meta.url);
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
let client;
vm.runInNewContext(fs.readFileSync('lib/client.js','utf8'), {
  window:{__ModuleLoader__:{load:definition=>{client=definition.factory(require);}}}
});
let settings;
const styles=[];
const document={createElement:()=>({remove(){styles.pop();}}),head:{appendChild:style=>styles.push(style)}};
vm.runInNewContext(fs.readFileSync('lib/client.js','utf8'), {
  document,window:{__ModuleLoader__:{load:definition=>{client=definition.factory(require);}}}
});
const cleanups=[];
client.apply({
  effect:factory=>cleanups.push(factory()),
  connection:{rpc:{call:async()=>({ok:true,value:{}})}},
  sessions:{},
  slots:{inject:(_name,register)=>register(),register:(_options,component)=>{settings=component;}}
});
const html=renderToStaticMarkup(React.createElement(settings,{rpc:async()=>({})}));
assert.match(html,/协调器/);
for(const cleanup of cleanups)cleanup();
assert.equal(styles.length,0);
coverage.push('设置页客户端注册、服务端渲染和样式清理通过');
const report={passed:true,hostVersion,pluginVersion:pkg.version,coverage,root,scope:'isolated copied runtime; no production profile changes'};
fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
