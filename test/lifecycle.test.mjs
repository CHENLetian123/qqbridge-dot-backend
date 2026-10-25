import test from 'node:test';
import assert from 'node:assert/strict';
import { Lifecycle } from '../src/lifecycle.mjs';

function fixture() {
  let now = 1_000;
  const lifecycle = new Lifecycle({ clock: () => now, leaseMs: 100 });
  lifecycle.bind('group:test');
  lifecycle.appendMessage('group:test', '第一条消息');
  return { lifecycle, advance: milliseconds => { now += milliseconds; } };
}

const rejects = (action, code) => assert.throws(action, error => error.code === code);

test('同会话仅一个 active run；事件 2xx 和发送成功都不能代替 finish', () => {
  const { lifecycle } = fixture();
  const run = lifecycle.beginRun('group:test');
  lifecycle.acknowledgeDelivery(run);
  assert.equal(lifecycle.snapshot('group:test').activeRun.deliveryAcknowledged, true);
  rejects(() => lifecycle.beginRun('group:test'), 'RUN_BUSY');
  const { readThroughSeq } = lifecycle.readMessages(run);
  assert.equal(lifecycle.reserveSend(run, { sendId: 'answer:1', text: '已收到' }).shouldDispatch, true);
  lifecycle.recordSendReceipt(run, { sendId: 'answer:1', status: 'confirmed', receiptId: 'offline:1' });
  assert.equal(lifecycle.snapshot('group:test').activeRun.runId, run.runId);
  rejects(() => lifecycle.beginRun('group:test'), 'RUN_BUSY');
  lifecycle.finish(run, { throughSeq: readThroughSeq, outcome: 'replied' });
  assert.equal(lifecycle.snapshot('group:test').activeRun, null);
});

test('重新绑定递增 generation，旧 run 不能改动新 run，未完成消息保留', () => {
  const { lifecycle } = fixture();
  const oldRun = lifecycle.beginRun('group:test');
  lifecycle.readMessages(oldRun);
  lifecycle.reserveSend(oldRun, { sendId: 'old-send', text: '可能已发出' });
  const rebound = lifecycle.bind('group:test');
  assert.equal(rebound.generation, oldRun.generation + 1);
  const newRun = lifecycle.beginRun('group:test');
  rejects(() => lifecycle.finish(oldRun, { throughSeq: 1, outcome: 'silent' }), 'STALE_GENERATION');
  rejects(() => lifecycle.readMessages(oldRun), 'STALE_GENERATION');
  assert.equal(lifecycle.expireLease(oldRun), false);
  const state = lifecycle.snapshot('group:test');
  assert.equal(state.activeRun.runId, newRun.runId);
  assert.equal(state.pendingMessages.length, 1);
  assert.equal(state.sends[0].state, 'unknown');
  assert.equal(lifecycle.reserveSend(newRun, { sendId: 'old-send', text: '可能已发出' }).shouldDispatch, false);
});

test('watchdog 到期后开启新 run，迟到完成和迟到 watchdog 都不误清新 run', () => {
  const { lifecycle, advance } = fixture();
  const oldRun = lifecycle.beginRun('group:test');
  lifecycle.readMessages(oldRun);
  assert.equal(lifecycle.expireLease(oldRun), false);
  advance(100);
  assert.equal(lifecycle.expireLease(oldRun), true);
  const newRun = lifecycle.beginRun('group:test');
  rejects(() => lifecycle.finish(oldRun, { throughSeq: 1, outcome: 'silent' }), 'STALE_RUN');
  assert.equal(lifecycle.expireLease(oldRun), false);
  assert.equal(lifecycle.snapshot('group:test').activeRun.runId, newRun.runId);
  assert.equal(lifecycle.snapshot('group:test').completedThroughSeq, 0);
});

test('没有执行 watchdog 时，租约边界也拒绝完成，并将未确认发送标为 unknown', () => {
  const { lifecycle, advance } = fixture();
  const oldRun = lifecycle.beginRun('group:test');
  lifecycle.readMessages(oldRun);
  lifecycle.reserveSend(oldRun, { sendId: 'timeout:1', text: '外部结果未知' });
  advance(100);
  rejects(() => lifecycle.finish(oldRun, { throughSeq: 1, outcome: 'silent' }), 'LEASE_EXPIRED');
  const state = lifecycle.snapshot('group:test');
  assert.equal(state.completedThroughSeq, 0);
  assert.equal(state.activeRun, null);
  assert.equal(state.sends[0].state, 'unknown');
  const newRun = lifecycle.beginRun('group:test');
  assert.equal(lifecycle.reserveSend(newRun, { sendId: 'timeout:1', text: '外部结果未知' }).shouldDispatch, false);
});

test('思考期间新消息不被旧已读水位吞掉；finish 必须显式指定 throughSeq', () => {
  const { lifecycle } = fixture();
  const run = lifecycle.beginRun('group:test');
  const read = lifecycle.readMessages(run);
  assert.equal(read.readThroughSeq, 1);
  lifecycle.appendMessage('group:test', '思考期间到达的新消息');
  rejects(() => lifecycle.finish(run, { outcome: 'silent' }), 'INVALID_WATERMARK');
  rejects(() => lifecycle.finish(run, { throughSeq: 2, outcome: 'silent' }), 'INVALID_WATERMARK');
  lifecycle.finish(run, { throughSeq: read.readThroughSeq, outcome: 'silent' });
  const pending = lifecycle.snapshot('group:test').pendingMessages;
  assert.deepEqual(pending.map(message => message.seq), [2]);
  const next = lifecycle.beginRun('group:test');
  assert.deepEqual(lifecycle.readMessages(next).messages, pending);
  rejects(() => lifecycle.finish(next, { throughSeq: 0, outcome: 'silent' }), 'INVALID_WATERMARK');
});

test('分批读取只推进已返回的水位；允许仅确认已读消息的一部分', () => {
  const { lifecycle } = fixture();
  lifecycle.appendMessage('group:test', '第二条');
  lifecycle.appendMessage('group:test', '第三条');
  const run = lifecycle.beginRun('group:test');
  assert.equal(lifecycle.readMessages(run, { limit: 1 }).readThroughSeq, 1);
  rejects(() => lifecycle.finish(run, { throughSeq: 2, outcome: 'silent' }), 'INVALID_WATERMARK');
  assert.equal(lifecycle.readMessages(run, { limit: 1 }).readThroughSeq, 2);
  lifecycle.finish(run, { throughSeq: 1, outcome: 'silent' });
  assert.deepEqual(lifecycle.snapshot('group:test').pendingMessages.map(message => message.seq), [2, 3]);
});

test('sendId 预留幂等、文本冲突拒绝；unknown 不允许自动重试或被覆盖', () => {
  const { lifecycle } = fixture();
  const run = lifecycle.beginRun('group:test');
  const request = { sendId: 'answer:unknown', text: '这条可能送达' };
  assert.equal(lifecycle.reserveSend(run, request).shouldDispatch, true);
  assert.equal(lifecycle.reserveSend(run, request).shouldDispatch, false);
  rejects(() => lifecycle.reserveSend(run, { ...request, text: '不同内容' }), 'SEND_ID_CONFLICT');
  const receipt = { sendId: request.sendId, status: 'unknown', reason: 'connection_lost_after_dispatch' };
  lifecycle.recordSendReceipt(run, receipt);
  assert.equal(lifecycle.recordSendReceipt(run, receipt).state, 'unknown');
  const repeated = lifecycle.reserveSend(run, request);
  assert.equal(repeated.shouldDispatch, false);
  assert.equal(repeated.state, 'unknown');
  rejects(() => lifecycle.recordSendReceipt(run, {
    sendId: request.sendId, status: 'confirmed', receiptId: 'late-guess'
  }), 'RECEIPT_CONFLICT');
  assert.equal(lifecycle.snapshot('group:test').activeRun.runId, run.runId);
});

test('confirmed 回执幂等且不能换成另一回执，沉默也可正常显式收尾', () => {
  const { lifecycle } = fixture();
  const run = lifecycle.beginRun('group:test');
  const read = lifecycle.readMessages(run);
  // No send is needed for a deliberate silent decision.
  const receipt = lifecycle.finish(run, { throughSeq: read.readThroughSeq, outcome: 'silent' });
  const final = lifecycle.snapshot('group:test');
  assert.equal(receipt.outcome, 'silent');
  assert.equal(final.lastRun.outcome, 'silent');
  assert.equal(final.pendingMessages.length, 0);
  assert.equal(final.sends.length, 0);

  lifecycle.appendMessage('group:test', '下一轮');
  const next = lifecycle.beginRun('group:test');
  lifecycle.reserveSend(next, { sendId: 'confirmed:1', text: '确定回复' });
  const sendReceipt = { sendId: 'confirmed:1', status: 'confirmed', receiptId: 'offline:confirmed' };
  assert.deepEqual(lifecycle.recordSendReceipt(next, sendReceipt), lifecycle.recordSendReceipt(next, sendReceipt));
  rejects(() => lifecycle.recordSendReceipt(next, { ...sendReceipt, receiptId: 'different' }), 'RECEIPT_CONFLICT');
  assert.equal(lifecycle.reserveSend(next, { sendId: 'confirmed:1', text: '确定回复' }).shouldDispatch, false);
});

test('完成回执可幂等重放且不清掉新 run；参数冲突和旧 generation 拒绝', () => {
  const { lifecycle } = fixture();
  const first = lifecycle.beginRun('group:test');
  lifecycle.readMessages(first);
  const finish = { throughSeq: 1, outcome: 'silent' };
  const receipt = lifecycle.finish(first, finish);
  assert.deepEqual(lifecycle.finish(first, finish), receipt);
  lifecycle.appendMessage('group:test', '下一轮不能被旧完成请求清掉');
  const next = lifecycle.beginRun('group:test');
  assert.deepEqual(lifecycle.finish(first, finish), receipt);
  rejects(() => lifecycle.finish(first, { throughSeq: 1, outcome: 'replied' }), 'COMPLETION_CONFLICT');
  rejects(() => lifecycle.finish(first, { throughSeq: 0, outcome: 'silent' }), 'COMPLETION_CONFLICT');
  assert.equal(lifecycle.snapshot('group:test').activeRun.runId, next.runId);
  assert.equal(lifecycle.snapshot('group:test').completedThroughSeq, 1);
  lifecycle.bind('group:test');
  rejects(() => lifecycle.finish(first, finish), 'STALE_GENERATION');
});

test('reserved 或 unknown 不能成功收尾，replied 不能虚报确认，水位保持不变', () => {
  const { lifecycle } = fixture();
  const run = lifecycle.beginRun('group:test');
  lifecycle.readMessages(run);
  rejects(() => lifecycle.finish(run, { throughSeq: 1, outcome: 'replied' }), 'REPLY_NOT_CONFIRMED');
  lifecycle.reserveSend(run, { sendId: 'uncertain', text: '结果未确认' });
  for (const outcome of ['silent', 'replied']) {
    rejects(() => lifecycle.finish(run, { throughSeq: 1, outcome }), 'UNRESOLVED_SEND');
  }
  lifecycle.recordSendReceipt(run, { sendId: 'uncertain', status: 'unknown', reason: 'timeout' });
  for (const outcome of ['silent', 'replied']) {
    rejects(() => lifecycle.finish(run, { throughSeq: 1, outcome }), 'UNRESOLVED_SEND');
  }
  const state = lifecycle.snapshot('group:test');
  assert.equal(state.completedThroughSeq, 0);
  assert.equal(state.activeRun.runId, run.runId);
  assert.deepEqual(state.pendingMessages.map(message => message.seq), [1]);
});

test('confirmed 发送不能伪装成 silent；正确 replied 后才推进水位', () => {
  const { lifecycle } = fixture();
  const run = lifecycle.beginRun('group:test');
  lifecycle.readMessages(run);
  lifecycle.reserveSend(run, { sendId: 'confirmed', text: '已确认发送' });
  lifecycle.recordSendReceipt(run, { sendId: 'confirmed', status: 'confirmed', receiptId: 'offline:2' });
  rejects(() => lifecycle.finish(run, { throughSeq: 1, outcome: 'silent' }), 'SILENT_SEND_CONFLICT');
  assert.equal(lifecycle.snapshot('group:test').completedThroughSeq, 0);
  lifecycle.finish(run, { throughSeq: 1, outcome: 'replied' });
  assert.equal(lifecycle.snapshot('group:test').completedThroughSeq, 1);
});
