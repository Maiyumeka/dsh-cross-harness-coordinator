import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {check, prepare, verify} from '../scripts/agent-install.mjs';
const require = createRequire(import.meta.url);
const {chromium} = require('playwright');
const browser = await chromium.launch({channel: 'msedge', headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 1000}}), errors = [];
page.on('pageerror', error => errors.push(error.message));
const home = path.resolve(process.env.COORDINATOR_TEST_HOME ?? 'test-data/agent-install-home');
const options = {home, profile: 'web', backupRoot: path.resolve('test-data/install-backups')};
const release = check(options).release;
const rpc = async (channel, method, payload) => page.evaluate(async ({channel, method, payload}) => {
  const response = await fetch(channel + '/' + method, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({type: 'client-request', rpcId: crypto.randomUUID(), method, payload})});
  const body = await response.json();
  if (!body.result?.ok) throw new Error(JSON.stringify(body));
  return body.result.value;
}, {channel, method, payload});
try {
  await page.goto(process.env.COORDINATOR_TEST_URL, {waitUntil: 'networkidle'});
  if (await page.getByRole('button', {name: '继续', exact: true}).count()) await page.getByRole('button', {name: '继续', exact: true}).click();
  if (await page.getByRole('button', {name: '稍后配置', exact: true}).count()) await page.getByRole('button', {name: '稍后配置', exact: true}).click();
  const list = args => rpc('/agent-installer-test', 'execute', args);
  const before = await list({action: 'list_bundles', limit: 100});
  assert.equal(before.entries.some(e => e.name === release.name), false, 'test requires a clean profile');
  fs.mkdirSync(path.resolve('test-data/install-workspace'), {recursive: true});
  const workspace = await rpc('/api', 'workspace/create', {args: {request: {path: path.resolve('test-data/install-workspace')}}});
  const session = await rpc('/api', 'session/create', {args: {request: {workspaceId: workspace.workspace.workspaceId}}});
  const sessionId = session.sessionId ?? session.session?.sessionId;
  assert.ok(sessionId, JSON.stringify(session));
  const backup = prepare(options);
  const installed = await list({action: 'install_bundle', target: release.archive, enabled: true});
  assert.equal(installed.application, 'applied', JSON.stringify(installed));
  const after = await list({action: 'list_bundles', limit: 100});
  const bundle = after.entries.find(e => e.name === release.name);
  assert.ok(bundle); assert.equal(bundle.version, release.version);
  const disk = verify({...options, backup: backup.backup});
  assert.equal(disk.status, 'installed_runtime_check_required');
  const status = await rpc('/cross-harness-coordinator', 'snapshot', {sessionId});
  assert.equal(status.endpoints.length, 0); // Installation does not silently connect a Harness.
  await page.getByText('install-workspace', {exact: true}).first().click();
  await page.getByRole('button', {name: '设置', exact: true}).click();
  await page.getByRole('button', {name: '协调器', exact: true}).click();
  await page.getByRole('button', {name: '复制接入邀请', exact: true}).first().waitFor();
  const probe = await rpc('/agent-installer-test', 'probe', {sessionId});
  assert.equal(probe.tools.length, 7);
  assert.ok(probe.plugins.some(row => row.enabled && row.fiberPhase === 'active'));
  await page.screenshot({path: path.resolve('test-data/agent-installed-settings.png')});
  assert.deepEqual(errors, []);
  // Reject a tampered release and an installed file that no longer matches.
  const badRelease = path.resolve('test-data/bad-install-release.json');
  fs.writeFileSync(badRelease, JSON.stringify({...release, sha256: '0'.repeat(64)}));
  assert.throws(() => check({...options, release: badRelease}), /checksum mismatch/);
  const installedReadme = path.join(home, 'profiles/web/node_modules', release.name, 'README.md');
  const bytes = fs.readFileSync(installedReadme);
  try {fs.appendFileSync(installedReadme, '\nchanged by verification test\n'); assert.throws(() => verify({...options, backup: backup.backup}), /installed file mismatch/);} finally {fs.writeFileSync(installedReadme, bytes);}
  const result = {passed: true, package: `${release.name}@${release.version}`, sha256: release.sha256, coverage: ['实际 DSH Agent plugin_manager 工具安装并热加载', '原生设置界面和状态 RPC', '七项协调工具注册可用', '安装不登记执行端', '配置备份和包内文件校验', '错误发布哈希拒绝', '已安装内容变化拒绝'], nativeResult: {application: installed.application, enabled: installed.enabled}, bundle, disk, probe, errors};
  fs.writeFileSync(path.resolve('test-data/agent-install-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {await browser.close();}
