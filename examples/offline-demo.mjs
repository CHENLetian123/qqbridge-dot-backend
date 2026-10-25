import { Lifecycle } from '../src/lifecycle.mjs';

// Deliberately offline: "receipts" below are local labels, never real QQ results.
let now = 1_000;
const lifecycle = new Lifecycle({ clock: () => now, leaseMs: 100 });
const sessionId = 'offline-group:demo';
const show = label => {
  const state = lifecycle.snapshot(sessionId);
  console.log(JSON.stringify({ 步骤: label, generation: state.generation,
    activeRun: state.activeRun?.runId ?? null, completedThroughSeq: state.completedThroughSeq,
    pendingSeqs: state.pendingMessages.map(message => message.seq),
    sends: state.sends.map(({ sendId, state: receiptState }) => ({ sendId, state: receiptState })) }));
};

lifecycle.bind(sessionId);
lifecycle.appendMessage(sessionId, '你好，当前进度如何？');
const first = lifecycle.beginRun(sessionId);
lifecycle.acknowledgeDelivery(first);
show('事件已收到，run 仍忙碌');
const read = lifecycle.readMessages(first);
lifecycle.appendMessage(sessionId, '补充：也请保留这条新消息');
const reservation = lifecycle.reserveSend(first, { sendId: 'demo-reply:1', text: '正在处理第一条消息。' });
if (reservation.shouldDispatch) {
  lifecycle.recordSendReceipt(first, { sendId: reservation.sendId,
    status: 'confirmed', receiptId: 'offline-simulated-receipt' });
}
show('模拟发送确认，仍需显式 finish');
lifecycle.finish(first, { throughSeq: read.readThroughSeq, outcome: 'replied' });
show('首轮完成，新消息保留');

const second = lifecycle.beginRun(sessionId);
const secondRead = lifecycle.readMessages(second);
lifecycle.finish(second, { throughSeq: secondRead.readThroughSeq, outcome: 'silent' });
show('第二轮选择沉默，正常收尾');

lifecycle.appendMessage(sessionId, '用于演示超时的一条消息');
const expired = lifecycle.beginRun(sessionId);
lifecycle.readMessages(expired);
now += 100;
lifecycle.expireLease(expired);
const replacement = lifecycle.beginRun(sessionId);
try {
  lifecycle.finish(expired, { throughSeq: 3, outcome: 'silent' });
} catch (error) {
  console.log(JSON.stringify({ 步骤: '拒绝迟到完成', code: error.code,
    新run仍有效: lifecycle.snapshot(sessionId).activeRun.runId === replacement.runId }));
}
