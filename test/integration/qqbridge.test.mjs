import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startBridge, eventually, FIXTURE_DOT_TOKEN, FIXTURE_CONSOLE_TOKEN } from '../fixtures/bridge-harness.mjs';

// These component tests run the patched upstream entrypoint. QQ and DSH are
// explicit local fixtures; this suite does not claim real-service compatibility.
const config = (overrides = {}) => ({
  dot: { enabled: true, conversations: ['group:1001'],
    tokenFile: 'state/dot-api-token', leaseMs: 15_000, ...overrides }
});
const dot = (bridge, endpoint, body, headers = {}) => bridge.request('/api/dot/v1' + endpoint, {
  ...(body === undefined ? {} : { method: 'POST', body }),
  headers: { authorization: `Bearer ${FIXTURE_DOT_TOKEN}`, ...headers }
});
const success = response => {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.ok, true, JSON.stringify(response.body));
  return response.body;
};
const refused = response => {
  assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(response));
  assert.equal(response.body.ok, false);
};

async function nextWake(bridge, key = 'group:1001') {
  return eventually(async () => {
    const body = success(await dot(bridge, '/wakes'));
    assert.ok(Array.isArray(body.wakes));
    return body.wakes.find(wake => wake.key === key);
  }, { message: `No pending wake for ${key}.\n${bridge.output()}` });
}
async function claim(bridge, wake, claimId) {
  const result = success(await dot(bridge, '/runs/claim', { wakeId: wake.wakeId, claimId }));
  assert.equal(result.run.key, wake.key);
  assert.ok(result.run.runToken);
  assert.ok(result.run.runId);
  return result;
}
async function read(bridge, run, afterSeq = 0, limit = 30) {
  return success(await dot(bridge, `/runs/${run.runId}/read`, { runToken: run.runToken, afterSeq, limit }));
}
const finish = (bridge, run, throughSeq, outcome) => dot(bridge, `/runs/${run.runId}/finish`, {
  runToken: run.runToken, throughSeq, outcome
});

test('纯 Dot：全部白名单走 Dot，启动和收发不创建或调用 DSH 客户端', {timeout:20000}, async t=>{
  const settings=config();settings.dot.only=true;settings.dot.conversations=['group:1001'];
  const bridge=await startBridge(t,{config:settings,dshOnline:false,seedState:{'mode.json':{mode:'chat'}}});
  const statusResponse=await bridge.console('/api/status');assert.equal(statusResponse.status,200);const status=statusResponse.body;
  assert.equal(status.backend,'dot');assert.equal(status.mode,'reserved2');assert.equal(status.dshReady,false);
  assert.deepEqual(status.dotConversations,['group:1001','group:1002']);
  await bridge.injectGroup(1001,'pure-dot-first');await bridge.injectGroup(1002,'pure-dot-second');
  for(const key of ['group:1001','group:1002']){
    const turn=await claim(bridge,await nextWake(bridge,key),'only-'+key);
    const page=await read(bridge,turn.run);assert.equal(page.messages.length,1);
    const result=success(await dot(bridge,`/runs/${turn.run.runId}/send`,{runToken:turn.run.runToken,sendId:'reply-'+key,text:'Dot-only reply'}));
    assert.equal(result.send.status,'confirmed');success(await finish(bridge,turn.run,page.readThroughSeq,'replied'));
  }
  const invalidMode=await bridge.console('/api/mode',{method:'POST',body:{mode:'chat'}});
  assert.equal(invalidMode.status,409);
  success(await bridge.console('/api/mode',{method:'POST',body:{mode:'reserved2'}}));
  await new Promise(r=>setTimeout(r,5200));
  assert.deepEqual(bridge.dshCalls,[],'Pure Dot must never instantiate, probe or call DSH.');
  assert.equal(bridge.sends.length,2);
});

test('真实桥接：DSH 离线时 Dot 合并唤醒、发送、保留新消息、沉默收尾；另一群仍走 DSH', { timeout: 30_000 }, async t => {
  const bridge = await startBridge(t, { config: config() });
  success(await dot(bridge, '/health'));
  await bridge.injectGroup(1001, 'dot-first-message');
  await bridge.injectGroup(1001, 'dot-second-message');
  await bridge.injectGroup(1002, 'dsh-only-message');
  const wake = await nextWake(bridge);
  const queued = success(await dot(bridge, '/wakes')).wakes;
  assert.deepEqual(queued.map(item => item.key), ['group:1001']);
  const first = await claim(bridge, wake, 'first-claim');
  const retryClaim = await claim(bridge, wake, 'first-claim');
  assert.equal(retryClaim.run.runId, first.run.runId);
  assert.equal(retryClaim.run.runToken, first.run.runToken);
  refused(await dot(bridge, '/runs/claim', { wakeId: wake.wakeId, claimId: 'competing-claim' }));

  const page = await read(bridge, first.run, 0, 1);
  assert.equal(page.messages.length, 1);
  assert.match(page.messages[0].text, /dot-first-message/);
  const rest = await read(bridge, first.run, page.readThroughSeq, 30);
  assert.equal(rest.messages.length, 1);
  assert.match(rest.messages[0].text, /dot-second-message/);
  const processedThrough = rest.readThroughSeq;

  // Let the real DSH reconnect cleanup run while Dot holds a lease.
  await eventually(() => bridge.dshCalls.filter(call => call.method === 'events.mux').length >= 2,
    { message: 'The fixture did not exercise DSH reconnect cleanup.', timeoutMs: 7_000 });
  await read(bridge, first.run, processedThrough);
  assert.equal(bridge.dshCalls.filter(call => call.method === 'sessions.prompt').length, 0);

  const sendRequest = { runToken: first.run.runToken, sendId: 'reply-1', text: '这是模拟 Dot 的一条回复。' };
  const sent = success(await dot(bridge, `/runs/${first.run.runId}/send`, sendRequest));
  assert.equal(sent.send.status, 'confirmed');
  const repeated = success(await dot(bridge, `/runs/${first.run.runId}/send`, sendRequest));
  assert.equal(repeated.deduplicated, true);
  assert.equal(repeated.send.status, 'confirmed');
  refused(await dot(bridge, `/runs/${first.run.runId}/send`, { ...sendRequest, text: '冲突的另一条回复' }));
  assert.equal(bridge.sends.length, 1);
  assert.equal(bridge.sends[0].params.group_id, 1001);
  await bridge.injectGroup(1001, 'dot-new-message-during-run');
  refused(await finish(bridge, first.run, processedThrough + 1, 'replied'));
  const completion = success(await finish(bridge, first.run, processedThrough, 'replied'));
  assert.equal(completion.completion.status, 'finished');
  assert.equal(completion.completion.throughSeq, processedThrough);

  const second = await claim(bridge, await nextWake(bridge), 'second-claim');
  assert.notEqual(second.run.runId, first.run.runId);
  assert.deepEqual(success(await finish(bridge, first.run, processedThrough, 'replied')).completion,
    completion.completion, 'Completion retries must replay a receipt without clearing the next run.');
  const nextMessages = await read(bridge, second.run);
  assert.deepEqual(nextMessages.messages.map(message => message.plain || message.text), ['dot-new-message-during-run']);
  success(await finish(bridge, second.run, nextMessages.readThroughSeq, 'silent'));
  assert.equal(bridge.sends.length, 1, 'A silent completion must not emit a QQ message.');

  await bridge.setDshOnline(true);
  await eventually(() => bridge.dshCalls.find(call => call.method === 'sessions.prompt'),
    { message: 'The non-Dot group did not retain its original DSH path.', timeoutMs: 8_000 });
  const prompts = bridge.dshCalls.filter(call => call.method === 'sessions.prompt').map(call => JSON.stringify(call.params));
  assert.ok(prompts.some(prompt => prompt.includes('dsh-only-message')));
  assert.ok(prompts.every(prompt => !prompt.includes('dot-first-message') && !prompt.includes('dot-new-message-during-run')));
});

test('真实路由：认证、跨站、跨会话、DSH 旧工具面与暂停状态均不能越权', { timeout: 15_000 }, async t => {
  const oldDshToken = 'fixture_old_dsh_agent_token_for_tests_only';
  const bridge = await startBridge(t, { config: {
    ...config({ conversations: ['group:1001', 'group:1003'] }),
    allow: { groups: ['1001', '1002', '1003'], private: [] }
  }, seedState: { 'social-v2.json': { paused: false, conversations: {
    'group:1001': { agentToken: oldDshToken, unread: [], recentMessages: [] }
  } } } });
  refused(await bridge.request('/api/dot/v1/health'));
  refused(await dot(bridge, '/health', undefined, { authorization: 'Bearer wrong-token' }));
  refused(await bridge.request('/api/dot/v1/health', { headers: { 'x-console-token': FIXTURE_CONSOLE_TOKEN } }));
  refused(await bridge.request('/api/status', { headers: { 'x-console-token': FIXTURE_DOT_TOKEN } }));
  await bridge.injectGroup(1001, '群一的私有上下文');
  await bridge.injectGroup(1003, '群三的私有上下文');
  const wake1 = await nextWake(bridge);
  const wake3 = await nextWake(bridge, 'group:1003');
  refused(await dot(bridge, '/runs/claim', { wakeId: wake1.wakeId, claimId: 'cross-site' }, { origin: 'https://example.invalid' }));
  const first = await claim(bridge, wake1, 'authorized-1');
  const third = await claim(bridge, wake3, 'authorized-3');
  refused(await dot(bridge, `/runs/${third.run.runId}/read`, { runToken: first.run.runToken, afterSeq: 0, limit: 30 }));
  refused(await dot(bridge, '/runs/claim', { wakeId: 'group:1002', claimId: 'unbound-group' }));

  const legacyToken = await eventually(async () => (await bridge.state('social-v2.json')).conversations?.['group:1001']?.agentToken);
  assert.notEqual(legacyToken, oldDshToken, 'Dot takeover must rotate the former DSH credential.');
  assert.ok(!JSON.stringify(first.context).includes(legacyToken), 'Dot context must not carry the old DSH agent credential.');
  for (const credential of [oldDshToken, legacyToken]) {
    refused(await bridge.console('/api/socialV2/unread?key=group:1001', {
      headers: { 'x-agent-call': '1', 'x-agent-token': credential }
    }));
  }
  for (const [sendId, credential] of [['leak-api-token', FIXTURE_DOT_TOKEN], ['leak-run-token', first.run.runToken]]) {
    const rejected = await dot(bridge, `/runs/${first.run.runId}/send`, {
      runToken: first.run.runToken, sendId, text: credential
    });
    assert.ok(rejected.status === 403 || rejected.body.send?.status === 'rejected', JSON.stringify(rejected));
  }
  assert.equal(bridge.sends.length, 0, 'Known credentials must never reach the OneBot sender.');
  const visible = await read(bridge, first.run);
  success(await bridge.console('/api/socialV2/activity', { method: 'POST', body: { paused: true } }));
  refused(await dot(bridge, `/runs/${first.run.runId}/read`, { runToken: first.run.runToken, afterSeq: 0, limit: 30 }));
  refused(await dot(bridge, `/runs/${first.run.runId}/send`, { runToken: first.run.runToken, sendId: 'paused', text: '不得发送' }));
  refused(await finish(bridge, first.run, visible.readThroughSeq, 'silent'));
  assert.equal(bridge.sends.length, 0);
});

test('真实路由：租约恢复后迟到完成不能清除替代运行', { timeout: 12_000 }, async t => {
  const bridge = await startBridge(t, { config: config({ leaseMs: 1_000 }) });
  await bridge.injectGroup(1001, '租约超时后仍需处理的消息');
  const expired = await claim(bridge, await nextWake(bridge), 'expiring-claim');
  const visible = await read(bridge, expired.run);
  await delay(1_100);
  refused(await finish(bridge, expired.run, visible.readThroughSeq, 'silent'));
  const replacement = await claim(bridge, await nextWake(bridge), 'replacement-claim');
  assert.notEqual(replacement.run.runId, expired.run.runId);
  refused(await finish(bridge, expired.run, visible.readThroughSeq, 'silent'));
  const pending = await read(bridge, replacement.run);
  assert.equal(pending.messages.length, 1);
  assert.match(pending.messages[0].text, /租约超时/);
  success(await finish(bridge, replacement.run, pending.readThroughSeq, 'silent'));
});

test('真实发送边界：OneBot 收到消息后丢失回执，重复调用不会再次发信', { timeout: 12_000 }, async t => {
  const bridge = await startBridge(t, { config: config() });
  await bridge.injectGroup(1001, '验证发送结果不明');
  const active = await claim(bridge, await nextWake(bridge), 'unknown-send-claim');
  const visible = await read(bridge, active.run);
  bridge.disconnectSendResponse(true);
  const payload = { runToken: active.run.runToken, sendId: 'uncertain-1', text: '已交给外部接口但回执丢失' };
  const first = await dot(bridge, `/runs/${active.run.runId}/send`, payload);
  assert.ok([200, 502].includes(first.status), JSON.stringify(first));
  bridge.disconnectSendResponse(false);
  const retry = success(await dot(bridge, `/runs/${active.run.runId}/send`, payload));
  assert.equal(retry.send.status, 'unknown');
  assert.equal(retry.deduplicated, true);
  assert.equal(bridge.sends.length, 1);
  refused(await finish(bridge, active.run, visible.readThroughSeq, 'replied'));
  refused(await finish(bridge, active.run, visible.readThroughSeq, 'silent'));
  const stillUnread = await read(bridge, active.run, 0);
  assert.equal(stillUnread.unreadCount, 1);
});

test('真实控制台恢复：模式切回、暂停恢复及零未读观察均重新唤醒，旧运行保持失效', { timeout: 30_000 }, async t => {
  const bridge = await startBridge(t, { dshOnline: true, config: {
    ...config(),
    socialV2: {
      enabled: true,
      autoReplyCheckMs: 3_600_000,
      agentPreset: 'qq-chat-v2',
      wake: { defaultMode: 'diving', recommendedDefaultInfinite: true,
        batchWindowMs: 1_000, maxWakePerMinute: 100, maxWakePerHour: 1000,
        preSleepWaitEnabled: true, preSleepWaitMs: 60_000 },
      proactive: { enabled: false },
      sticker: { enabled: false },
      voice: { enabled: false },
      context: { recentLimit: 100, unreadLimit: 100, contextWindow: 20 },
      send: { maxMessageChars: 500, maxSendPerMinute: 50, maxSendPerHour: 100 }
    }
  } });
  const setMode = async mode => {
    const changed = success(await bridge.console('/api/mode', { method: 'POST', body: { mode } }));
    assert.equal(changed.mode, mode);
    assert.equal(changed.dshSynced, true, 'Mode changes must use the real console route and DSH settings write-through.');
  };
  const setPaused = async paused => {
    const changed = success(await bridge.console('/api/socialV2/activity', { method: 'POST', body: { paused } }));
    assert.equal(changed.paused, paused);
  };
  const rejectsOldRun = async (run, throughSeq) => {
    refused(await dot(bridge, `/runs/${run.runId}/read`, { runToken: run.runToken, afterSeq: 0, limit: 30 }));
    refused(await finish(bridge, run, throughSeq, 'silent'));
  };

  // Only one inbound message is injected in this scenario. Every later wake
  // must arise from restoring an interrupted run/observation, without QQ input.
  await bridge.injectGroup(1001, '模式与暂停恢复期间不能丢失的消息');
  const original = await claim(bridge, await nextWake(bridge), 'before-mode-change');
  const originalPage = await read(bridge, original.run);
  assert.equal(originalPage.messages.length, 1);
  assert.equal(original.context.wakeConfig.infinite, true);
  assert.equal(original.context.wakeConfig.sleepUntil, null);

  await setMode('chat');
  await setMode('reserved2');
  const afterMode = await claim(bridge, await nextWake(bridge), 'after-mode-change');
  assert.notEqual(afterMode.run.runId, original.run.runId);
  await rejectsOldRun(original.run, originalPage.readThroughSeq);
  const afterModePage = await read(bridge, afterMode.run);
  assert.equal(afterModePage.messages.length, 1);

  await setPaused(true);
  await setPaused(false);
  const afterPause = await claim(bridge, await nextWake(bridge), 'after-pause');
  assert.notEqual(afterPause.run.runId, afterMode.run.runId);
  await rejectsOldRun(afterMode.run, afterModePage.readThroughSeq);
  const afterPausePage = await read(bridge, afterPause.run);
  assert.equal(afterPausePage.messages.length, 1);
  const observed = success(await finish(bridge, afterPause.run, afterPausePage.readThroughSeq, 'silent'));
  assert.equal(observed.observation.state, 'observing');
  const persisted = (await bridge.state('social-v2.json')).conversations['group:1001'];
  assert.equal(persisted.unread.length, 0);
  assert.equal(persisted.wakeConfig.infinite, true);
  assert.equal(persisted.wakeConfig.sleepUntil, null);

  // There is now no unread fallback, finite sleep timer or proactive wake.
  // An interrupted observation still needs to resume when reserved2 returns.
  await setMode('chat');
  await setMode('reserved2');
  const afterObservation = await claim(bridge, await nextWake(bridge), 'after-observation-mode-change');
  const empty = await read(bridge, afterObservation.run);
  assert.equal(empty.messages.length, 0);
  assert.equal(empty.unreadCount, 0);
  assert.equal(empty.readThroughSeq, afterPausePage.readThroughSeq);
  assert.equal(success(await finish(bridge, afterObservation.run, empty.readThroughSeq, 'silent')).observation.state, 'observing');

  // Exercise the same zero-unread observation restoration through pause.
  await setPaused(true);
  await setPaused(false);
  const afterObservedPause = await claim(bridge, await nextWake(bridge), 'after-observation-pause');
  const stillEmpty = await read(bridge, afterObservedPause.run);
  assert.equal(stillEmpty.messages.length, 0);
  assert.equal(stillEmpty.unreadCount, 0);
  success(await finish(bridge, afterObservedPause.run, stillEmpty.readThroughSeq, 'silent'));
  assert.equal(bridge.sends.length, 0);
  assert.equal(bridge.dshCalls.filter(call => call.method === 'sessions.prompt').length, 0);
});

test('real bridge image bytes use the existing QQ send guard, quota, deduplication and finish path', { timeout: 20000 }, async t => {
  const { pngImage, largePngImage, PNG } = await import('../fixtures/image.mjs');
  const bridge = await startBridge(t, { config: config() });
  await bridge.injectGroup(1001, '', { message: [{ type: 'image', data: { file: 'fixture-image.png', url: 'https://example.invalid/private-signature-never-expose' } }] });
  const { run } = await claim(bridge, await nextWake(bridge), 'media-roundtrip');
  const imagePath = `/runs/${run.runId}/image`;
  const imageArgs = { runToken: run.runToken, messageSeq: 1, imageIndex: 0 };
  assert.equal((await dot(bridge, imagePath, imageArgs)).status, 403, 'Unseen messages are inaccessible');
  const page = await read(bridge, run);
  assert.deepEqual(page.messages[0].images, [{ index: 0 }]);
  assert.equal(JSON.stringify(page).includes('private-signature'), false);
  const picture = success(await dot(bridge, imagePath, imageArgs));
  assert.equal(picture.image.data, PNG);
  assert.equal(picture.image.width, 1);
  assert.equal((await dot(bridge, imagePath, { ...imageArgs, imageIndex: 1 })).status, 404);
  const sendPath = `/runs/${run.runId}/send`;
  const args = { runToken: run.runToken, sendId: 'large-file', image: largePngImage() };
  const sent = success(await dot(bridge, sendPath, args));
  assert.equal(sent.send.status, 'confirmed');
  assert.ok(sent.send.image.bytes > 1000000);
  assert.equal(JSON.stringify(sent).includes(args.image.data), false);
  assert.equal(success(await dot(bridge, sendPath, args)).deduplicated, true);
  assert.equal(bridge.sends.length, 1);
  assert.equal(bridge.sends[0].params.message[0].type, 'image');
  assert.equal(bridge.sends[0].params.message[0].data.file, 'base64://' + args.image.data);
  refused(await dot(bridge, sendPath, { ...args, image: pngImage() }));
  refused(await finish(bridge, run, page.readThroughSeq, 'silent'));
  success(await finish(bridge, run, page.readThroughSeq, 'replied'));
  assert.equal((await dot(bridge, imagePath, imageArgs)).status, 410);
});

test('configured persona reaches Dot claim context and health diagnoses missing cards without exposing the prompt', { timeout: 15000 }, async t => {
  const bridge = await startBridge(t, { config: config(), seedState: { 'current-role.json': { role: 'FixturePersona', mode: 'active' } }, roleCards: { FixturePersona: '# Fixture character\n## Identity\nYou speak as the fixture character with a dry sense of humor.\n## Old transport [v1]\nlegacy-only-marker\n## Current style [v2]\ncurrent-style-marker' } });
  const health = success(await dot(bridge, '/health'));
  assert.equal(health.persona.name, 'FixturePersona');
  assert.equal(health.persona.available, true);
  assert.equal(JSON.stringify(health).includes('dry sense'), false);
  await bridge.injectGroup(1001, 'role test');
  const turn = await claim(bridge, await nextWake(bridge), 'persona-context');
  assert.equal(turn.context.role.name, 'FixturePersona');
  assert.match(turn.context.role.prompt, /current-style-marker/);
  assert.doesNotMatch(turn.context.role.prompt, /legacy-only-marker/);
  assert.match(turn.context.instructions, /Apply context.role.prompt/);
  assert.equal(health.persona.promptChars, turn.context.role.prompt.length);
  const page = await read(bridge, turn.run);
  success(await finish(bridge, turn.run, page.readThroughSeq, 'silent'));
  const fs = await import('node:fs/promises');
  await fs.writeFile(bridge.stateDirectory + '/current-role.json', JSON.stringify({ role: 'MissingFixtureCard', mode: 'active' }));
  const missing = success(await dot(bridge, '/health')).persona;
  assert.equal(missing.configured, true); assert.equal(missing.available, false); assert.equal(missing.promptChars, 0);
});
