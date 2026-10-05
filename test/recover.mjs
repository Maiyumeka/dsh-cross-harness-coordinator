// blocked 的恢复通道：blocked 曾是"只进不出"的终态 —— 端点被移除、产物被误判为改写，
// 都可能把任务永久锁死，连"把条件恢复回去"都救不回来。这里验证恢复通道真的能退出来。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Coordinator} from '../lib/engine.js';

const root = path.resolve('test-data', 'recover-' + Date.now());
fs.mkdirSync(root, { recursive: true });
const ws = path.join(root, 'ws');
fs.mkdirSync(ws, { recursive: true });
const fixture = path.resolve('test/fixture.mjs');

const engine = new Coordinator({ dir: path.join(root, 'state'), run: () => { throw Error('本验证不执行真实任务'); } });
const a = { id: 'recover-session', cwd: ws };
const definition = (id) => ({ id, label: id + '端', protocol: 'text', command: process.execPath, args: [fixture, 'text', 'out.txt'], prompt_mode: 'stdin' });

engine.endpoint(a, definition('ep1'));
engine.plan(a, { title: '阻塞与恢复', tasks: [{ id: 'job', title: '会被阻塞的任务', prompt: '写文件', endpoint: 'ep1', outputs: ['out.txt'], criteria: ['文件存在'], reason: '验证恢复通道' }] });
const job = () => engine.state.sessions[a.id].tasks.find((t) => t.id === 'job');
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

// ① 端点被移除 → 派发时阻塞，并记住卡住前的状态
engine.control(a, 'pause');
delete engine.state.endpoints.ep1;
engine.control(a, 'resume');
assert.ok(await until(() => job().status === 'blocked'), '端点不可用应使任务阻塞，实际：' + job().status);
assert.match(job().error, /执行端/);
assert.equal(job().blockedFrom, 'queued', '应记住卡住前的状态');

// ② 条件未修复时不允许恢复（不绕过端点校验）
assert.throws(() => engine.recover(a, { id: 'job' }), /执行端|接入/, '端点仍不可用时应拒绝恢复');

// ③ 非阻塞任务不接受恢复动作（顺序放在恢复之前，避免状态歧义）
assert.throws(() => engine.recover(a, { id: 'nope' }), /任务不存在/);

// ④ 端点修好后恢复 → 退回排队，而不是停在终态
engine.endpoint(a, definition('ep1'));
engine.recover(a, { id: 'job' });
assert.equal(job().status, 'queued', '恢复后应退回排队');
assert.equal(job().blockedFrom, undefined, '恢复后不应再带阻塞来源');
assert.equal(job().error, '');
assert.throws(() => engine.recover(a, { id: 'job' }), /只有被阻塞/, '已恢复的任务不再接受恢复');

// ⑤ rerun 语义：作废本任务及其下游，重新排队
engine.control(a, 'pause');
job().status = 'blocked';
job().error = '人工制造的阻塞，用于验证 rerun';
engine.recover(a, { id: 'job', rerun: true, note: '恢复时选择重新执行' });
assert.equal(job().status, 'queued');
assert.equal(job().reworkFeedback, '恢复时选择重新执行');
assert.equal(job().result, null, 'rerun 应作废旧结果');

await engine.close();
console.log(JSON.stringify({
  passed: true,
  coverage: ['端点不可用阻塞并记住来源状态', '条件未修复时拒绝恢复', '恢复后退回排队而非终态', '非阻塞任务不受恢复影响', 'rerun 作废并重新排队'],
  root,
}, null, 2));
