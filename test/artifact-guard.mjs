// 最小验证：产物"缺失 → 恢复一致"这条不变量，不受其它测试状态干扰
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Coordinator} from '../lib/engine.js';

const root = path.resolve('test-data', 'artifact-guard-' + Date.now());
fs.mkdirSync(root, { recursive: true });
const ws = path.join(root, 'ws');
fs.mkdirSync(ws, { recursive: true });
const fixture = path.resolve('test/fixture.mjs');
const engine = new Coordinator({ dir: path.join(root, 'state'), run: () => { throw Error('本验证不执行真实任务'); } });
const a = { id: 'guard-session', cwd: ws };
const definition = { id: 'g1', label: 'guard端', protocol: 'text', command: process.execPath, args: [fixture, 'text', 'art.txt'], prompt_mode: 'stdin' };

engine.endpoint(a, definition);
engine.plan(a, { title: '产物缺失与恢复', tasks: [{ id: 'job', title: '产出产物', prompt: '写文件', endpoint: 'g1', outputs: ['art.txt'], criteria: ['文件存在'], reason: '验证缺失不锁死' }] });

const job = () => engine.state.sessions[a.id].tasks.find((t) => t.id === 'job');
const file = path.join(ws, 'art.txt');
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

// 直接落一份产物并走一次真实审查，避免依赖外层测试的运行状态。
fs.writeFileSync(file, '第一版内容\n');
const cancelled = engine.state.sessions; // 保留引用，避免未使用告警
assert.ok(cancelled);
await engine.close();

// 用第二个引擎：产物先写好后建任务，派发会直接成功。
const engine2 = new Coordinator({ dir: path.join(root, 'state2'), run: async () => ({ ok: true, exitCode: 0, output: '', stderr: '', artifacts: [] }) });
engine2.endpoint(a, definition);
engine2.plan(a, { title: '产物缺失与恢复', tasks: [{ id: 'job', title: '产出产物', prompt: '写文件', endpoint: 'g1', outputs: ['art.txt'], criteria: ['文件存在'], reason: '验证缺失不锁死' }] });
const job2 = () => engine2.state.sessions[a.id].tasks.find((t) => t.id === 'job');
assert.ok(await until(() => job2().status === 'awaiting_review'), '任务应先进入待审查：' + job2().status);
engine2.read(a, { id: 'job', relative: 'art.txt' });
engine2.review(a, { id: 'job', revision: job2().revision, version: job2().result.version, verdict: 'pass', checks: [{ criterion: '文件存在', status: 'pass', evidence: '读取到真实内容' }], note: '核对通过' });
assert.equal(job2().status, 'passed');

const bytes = fs.readFileSync(file);
const versionAtReview = job2().result.version;
const artifactsAtReview = JSON.stringify(job2().result.artifacts);

// ① 缺失：保留审查记录、不改写已通过版本号
fs.rmSync(file);
await new Promise((r) => setTimeout(r, 200));
const missingState = { status: job2().status, reviews: job2().reviews.length, version: job2().result.version, artifacts: JSON.stringify(job2().result.artifacts) };
assert.equal(missingState.status, 'awaiting_review', '产物缺失应回到待审查而不是永久锁死：' + missingState.status);
assert.equal(missingState.reviews, 1, '缺失不应清空审查记录');
assert.equal(missingState.version, versionAtReview, '缺失不应改写已通过的版本号');
assert.equal(missingState.artifacts, artifactsAtReview, '缺失不应改写产物记录');

// ② 恢复一致：读取动作会先做一轮核对；指纹与已通过版本一致则审查自动恢复生效
fs.writeFileSync(file, bytes);
engine2.read(a, { id: 'job', relative: 'art.txt' });
assert.ok(await until(() => job2().status === 'passed'), '字节恢复一致后应自动恢复通过：' + job2().status);
assert.equal(job2().error, '');
assert.equal(job2().reads['art.txt'], job2().result.artifacts[0].sha256, '恢复后应重新登记读取凭据');

// ③ 内容被真正改写：仍然要作废审查（不能因为这次放宽而漏掉真改写）
fs.writeFileSync(file, '第二版被改写了\n');
engine2.read(a, { id: 'job', relative: 'art.txt' });
assert.ok(await until(() => job2().status !== 'passed'), '内容真改写必须使审查失效：' + job2().status);
assert.equal(job2().reviews.some((r) => r.verdict === 'pass' && r.version === job2().result.version), false, '改写后不应再有针对当前版本的通过审查');

await engine2.close();
console.log(JSON.stringify({ passed: true, coverage: ['产物缺失回到待审查且不清空审查记录', '字节恢复一致自动恢复通过', '内容真改写仍作废审查'], versionAtReview, root }, null, 2));
