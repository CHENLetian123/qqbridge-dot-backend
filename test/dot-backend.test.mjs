import test from 'node:test';
import assert from 'node:assert/strict';
import { createDotBackend, DotError } from '../compat/qqbridge/overlay/src/dot-backend.mjs';

const key = 'group:10001';
const token = 'test-only-token-with-at-least-32-characters';
const throws = (fn, code) => assert.throws(fn, error => error.code === code);

function fixture({ sendText, leaseMs = 1000 } = {}) {
  let now = 1000;
  let paused = false;
  let observationBlocked = true;
  let lastSeq = 0;
  let ack = 0;
  let messages = [];
  const requests = [];
  let sent = 0;
  let restored = 0;
  const state = () => ({ lastReadThroughSeq: ack, lastUnreadSeq: lastSeq, unreadSeqs: messages.map(m => m.seq) });
  const hooks = {
    assertConversationAllowed: () => { if (paused) throw new DotError('PAUSED', 'Paused.', 403); },
    buildContext: () => ({ role: 'Test role', instructions: 'Read before finishing.' }),
    getReadState: state,
    readUnread: (_, after, limit) => ({ ...state(), messages: messages.filter(m => m.seq > after).slice(0, limit) }),
    acknowledgeThrough: (_, through) => { ack = Math.max(ack, through); messages = messages.filter(m => m.seq > through); },
    sendText: sendText ?? (async () => { sent += 1; return { sent: 1 }; }),
    inspectObservation: () => ({ blocked: observationBlocked, remainingMs: 100 }),
    restoreWakeTimers: () => { restored += 1; },
    replayPendingWakes: (k, reason) => requests.push(['replay', k, reason]),
    requestWake: (k, reason) => requests.push(['wake', k, reason]),
    log: () => {}
  };
  const backend = createDotBackend({ config: { enabled: true, conversations: [key], leaseMs }, token, hooks, clock: () => now });
  const append = value => { const m = { seq: ++lastSeq, text: value }; messages.push(m); backend.onIncoming(key); return m; };
  const claim = (claimId = `claim-${now}-${lastSeq}`) => {
    const wake = backend.enqueueWake(key, 'test');
    return backend.claim({ wakeId: wake.wakeId, claimId });
  };
  return { backend, append, claim, state, requests, advance: ms => { now += ms; },
    pause: value => { paused = value; }, observed: () => { observationBlocked = false; },
    sent: () => sent, restored: () => restored };
}

test('queued delivery does not consume a run lease; claim retries do not create a second run', () => {
  const f = fixture();
  f.append('message');
  const wake = f.backend.enqueueWake(key, 'atMention');
  assert.equal(f.backend.enqueueWake(key, 'question').wakeId, wake.wakeId);
  f.advance(100_000);
  assert.equal(f.backend.listWakes().wakes[0].wakeId, wake.wakeId);
  const first = f.backend.claim({ wakeId: wake.wakeId, claimId: 'claim-1' });
  const retry = f.backend.claim({ wakeId: wake.wakeId, claimId: 'claim-1' });
  assert.equal(retry.run.runId, first.run.runId);
  assert.equal(retry.deduplicated, true);
  assert.equal(f.backend.listWakes().wakes.length, 0);
  assert.equal(f.backend.busyReason(key), 'dotRun');
  throws(() => f.backend.claim({ wakeId: 'different', claimId: 'claim-1' }), 'CLAIM_CONFLICT');
});

test('read pagination cannot jump unseen messages; later arrivals survive finish', () => {
  const f = fixture();
  f.append('one'); f.append('two');
  const { run } = f.claim();
  throws(() => f.backend.read(run.runId, { runToken: run.runToken, afterSeq: 1 }), 'INVALID_CURSOR');
  const first = f.backend.read(run.runId, { runToken: run.runToken, limit: 1 });
  assert.equal(first.readThroughSeq, 1);
  throws(() => f.backend.finish(run.runId, { runToken: run.runToken, throughSeq: 2, outcome: 'silent' }), 'INVALID_WATERMARK');
  const second = f.backend.read(run.runId, { runToken: run.runToken, afterSeq: 1 });
  assert.equal(second.readThroughSeq, 2);
  f.append('three during thinking');
  f.backend.finish(run.runId, { runToken: run.runToken, throughSeq: 2, outcome: 'silent' });
  assert.deepEqual(f.state().unreadSeqs, [3]);
  assert.ok(f.requests.some(item => item[2] === 'dotPending'));
});

test('completed receipt replay cannot clear a new active run; resets fence old receipts', () => {
  const f = fixture();
  f.append('one');
  const first = f.claim('one').run;
  f.backend.read(first.runId, { runToken: first.runToken });
  const request = { runToken: first.runToken, throughSeq: 1, outcome: 'silent' };
  const result = f.backend.finish(first.runId, request);
  f.append('two');
  const second = f.claim('two').run;
  assert.deepEqual(f.backend.finish(first.runId, request).completion, result.completion);
  assert.equal(f.backend.assertRun(key, second.runId, second.runToken).runId, second.runId);
  throws(() => f.backend.finish(first.runId, { ...request, outcome: 'replied' }), 'COMPLETION_CONFLICT');
  f.backend.invalidate(key, 'manual reset');
  throws(() => f.backend.finish(first.runId, request), 'STALE_GENERATION');
  throws(() => f.backend.read(second.runId, { runToken: second.runToken }), 'STALE_GENERATION');
});

test('lease expiry keeps unread data and rejects old finish/queued-send guards', () => {
  const f = fixture();
  f.append('one');
  const first = f.claim('one').run;
  f.backend.read(first.runId, { runToken: first.runToken });
  const guard = f.backend.captureSendGuard(key, first.runId, first.runToken);
  f.advance(1000);
  const wake = f.backend.listWakes().wakes[0];
  const second = f.backend.claim({ wakeId: wake.wakeId, claimId: 'two' }).run;
  throws(guard, 'STALE_RUN');
  throws(() => f.backend.finish(first.runId, { runToken: first.runToken, throughSeq: 1, outcome: 'silent' }), 'STALE_RUN');
  assert.equal(f.backend.assertRun(key, second.runId, second.runToken).runId, second.runId);
  assert.deepEqual(f.state().unreadSeqs, [1]);
});

test('concurrent retries dispatch once; an in-flight send prevents successful finish', async () => {
  let release;
  let dispatches = 0;
  const barrier = new Promise(resolve => { release = resolve; });
  const f = fixture({ sendText: async () => { dispatches += 1; await barrier; return { sent: 1 }; } });
  f.append('one');
  const { run } = f.claim();
  f.backend.read(run.runId, { runToken: run.runToken });
  const request = { runToken: run.runToken, sendId: 'reply-1', text: 'hello' };
  const first = f.backend.send(run.runId, request);
  const retry = f.backend.send(run.runId, request);
  await Promise.resolve();
  assert.equal(dispatches, 1);
  throws(() => f.backend.finish(run.runId, { runToken: run.runToken, throughSeq: 1, outcome: 'replied' }), 'UNRESOLVED_SEND');
  release();
  const [a, b] = await Promise.all([first, retry]);
  assert.equal(a.send.status, 'confirmed');
  assert.equal(b.deduplicated, true);
  await assert.rejects(() => f.backend.send(run.runId, { ...request, text: 'changed' }), error => error.code === 'SEND_ID_CONFLICT');
  throws(() => f.backend.finish(run.runId, { runToken: run.runToken, throughSeq: 1, outcome: 'silent' }), 'SILENT_SEND_CONFLICT');
  f.backend.finish(run.runId, { runToken: run.runToken, throughSeq: 1, outcome: 'replied' });
  assert.equal(f.state().lastReadThroughSeq, 1);
});

test('a lost send response remains uncertain, cannot be retried or hidden in finish', async () => {
  let dispatches = 0;
  const f = fixture({ sendText: async () => { dispatches += 1; throw new Error('connection lost after delivery'); } });
  f.append('one');
  const { run } = f.claim();
  f.backend.read(run.runId, { runToken: run.runToken });
  const request = { runToken: run.runToken, sendId: 'maybe-sent', text: 'hello' };
  assert.equal((await f.backend.send(run.runId, request)).send.status, 'unknown');
  assert.equal((await f.backend.send(run.runId, request)).deduplicated, true);
  assert.equal(dispatches, 1);
  for (const outcome of ['silent', 'replied']) {
    throws(() => f.backend.finish(run.runId, { runToken: run.runToken, throughSeq: 1, outcome }), 'UNRESOLVED_SEND');
  }
  assert.equal(f.state().lastReadThroughSeq, 0);
});

test('a synchronously rejected send settles its reservation and can finish silently', async () => {
  const f = fixture({ sendText: () => { throw new DotError('RATE_LIMITED', 'No dispatch occurred.', 429); } });
  f.append('one');
  const { run } = f.claim();
  f.backend.read(run.runId, { runToken: run.runToken });
  const result = await f.backend.send(run.runId, { runToken: run.runToken, sendId: 'rejected', text: 'hello' });
  assert.equal(result.send.status, 'rejected');
  assert.equal(f.backend.finish(run.runId, { runToken: run.runToken, throughSeq: 1, outcome: 'silent' }).completion.status, 'finished');
});

test('silence releases the run but local observation continues until the real host gate passes', () => {
  const f = fixture();
  f.append('one');
  const { run } = f.claim();
  f.backend.read(run.runId, { runToken: run.runToken });
  assert.equal(f.backend.finish(run.runId, { runToken: run.runToken, throughSeq: 1, outcome: 'silent' }).observation.state, 'observing');
  assert.equal(f.backend.isBusy(key), false);
  f.backend.tick();
  assert.equal(f.restored(), 0);
  f.append('new observation message');
  assert.ok(f.requests.some(item => item[2] === 'dotObservation'));
  f.observed();
  f.backend.tick();
  assert.equal(f.restored(), 1);
  f.backend.tick();
  assert.equal(f.restored(), 1);
});

test('current authorization and conversation scope are checked again at actual send time', () => {
  const f = fixture();
  f.append('one');
  const { run } = f.claim();
  const guard = f.backend.captureSendGuard(key, run.runId, run.runToken);
  throws(() => f.backend.assertRun('group:20002', run.runId, run.runToken), 'RUN_SCOPE_MISMATCH');
  throws(() => f.backend.read(run.runId, { runToken: 'wrong' }), 'INVALID_RUN_TOKEN');
  f.pause(true);
  throws(guard, 'PAUSED');
  assert.deepEqual(f.backend.listWakes().wakes, []);
});

test('transport and run credentials cannot be sent as QQ text', async () => {
  const f = fixture();
  f.append('one');
  const { run } = f.claim();
  for (const secret of [token, run.runToken]) {
    await assert.rejects(() => f.backend.send(run.runId, {
      runToken: run.runToken, sendId: 'blocked-secret', text: `quoted ${secret}`
    }), error => error.code === 'CREDENTIAL_IN_MESSAGE');
  }
  assert.equal(f.sent(), 0);
});

test('replacement claim retries preserve recovery receipts and cannot bypass an uncertain send with a new ID', async () => {
  const f = fixture({ sendText: async () => { throw new Error('no response'); } });
  f.append('one');
  const original = f.claim('old').run;
  await f.backend.send(original.runId, { runToken: original.runToken, sendId: 'uncertain', text: 'hello' });
  f.advance(1000);
  const wake = f.backend.listWakes().wakes[0];
  const request = { wakeId: wake.wakeId, claimId: 'replacement' };
  const first = f.backend.claim(request);
  const retried = f.backend.claim(request);
  assert.equal(first.uncertainSends.length, 1);
  assert.deepEqual(retried.uncertainSends, first.uncertainSends);
  assert.deepEqual(retried.previousSends, first.previousSends);
  const run = first.run;
  await assert.rejects(() => f.backend.send(run.runId, { runToken: run.runToken, sendId: 'new-id', text: 'hello' }),
    error => error.code === 'SEND_RECONCILIATION_REQUIRED');
  f.backend.read(run.runId, { runToken: run.runToken });
  throws(() => f.backend.finish(run.runId, { runToken: run.runToken, throughSeq: 1, outcome: 'silent' }), 'SEND_RECONCILIATION_REQUIRED');
  assert.equal(f.state().lastReadThroughSeq, 0);
});

test('resuming a mode/pause interruption restores observation even after all unread messages were acknowledged', () => {
  const f = fixture();
  f.append('one');
  const { run } = f.claim();
  f.backend.read(run.runId, { runToken: run.runToken });
  f.backend.finish(run.runId, { runToken: run.runToken, throughSeq: 1, outcome: 'silent' });
  assert.deepEqual(f.state().unreadSeqs, []);
  f.pause(true);
  f.backend.invalidate(key, 'mode-change');
  assert.equal(f.backend.resume(key), false);
  f.pause(false);
  assert.equal(f.backend.resume(key), true);
  assert.ok(f.requests.some(item => item[0] === 'wake' && item[2] === 'bootstrap'));
  f.backend.enqueueWake(key, 'bootstrap');
  assert.equal(f.backend.resume(key), false);
});
