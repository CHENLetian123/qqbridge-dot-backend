import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const FIXTURE_CONSOLE_TOKEN = 'fixture_console_token_for_tests_only';
export const FIXTURE_DOT_TOKEN = 'fixture_dot_backend_token_for_tests_only';
const loader = new URL('./qqbridge-loader.mjs', import.meta.url).href;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function eventually(check, { timeoutMs = 8_000, message = 'Condition was not met.' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; }
    catch (error) { lastError = error; }
    await delay(30);
  }
  throw new Error(message, lastError ? { cause: lastError } : undefined);
}

/**
 * Runs the real patched upstream entrypoint with three explicit external mocks.
 * QQBRIDGE_SOURCE_DIR must already contain the applied patch and overlay.
 */
export async function startBridge(t, { config = {}, seedState = {}, roleCards = {}, dshOnline = false, env = {} } = {}) {
  const sourceSetting = process.env.QQBRIDGE_SOURCE_DIR;
  assert.ok(sourceSetting, 'QQBRIDGE_SOURCE_DIR must point to an already-patched QQBridge checkout.');
  const source = path.resolve(sourceSetting);
  const sourceText = await fs.readFile(path.join(source, 'src/bridge.js'), 'utf8');
  assert.match(sourceText, /dot-backend/, 'Apply the QQBridge adapter patch before running integration tests.');

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qqbridge-dot-component-'));
  const runtime = path.join(temporary, 'qqbridge');
  const stateDirectory = path.join(runtime, 'state');
  const sdkEvents = [];
  const dshCalls = [];
  const onebotRequests = [];
  const sends = [];
  const pendingRpc = new Map();
  let child;
  let output = '';
  let listenerPort;
  let rpcSequence = 0;
  let messageSequence = 100;
  let onebotMessageId = 700_000;
  let disconnectSendResponse = false;
  let onebot;

  t.after(async () => {
    for (const { reject, timer } of pendingRpc.values()) {
      clearTimeout(timer);
      reject(new Error('Fixture is shutting down.'));
    }
    pendingRpc.clear();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      await exited;
      clearTimeout(killTimer);
    }
    if (onebot?.listening) {
      onebot.closeAllConnections();
      await new Promise(resolve => onebot.close(resolve));
    }
    await fs.rm(temporary, { recursive: true, force: true });
  });

  await fs.mkdir(stateDirectory, { recursive: true });
  await fs.cp(path.join(source, 'src'), path.join(runtime, 'src'), { recursive: true });
  await fs.writeFile(path.join(runtime, 'package.json'), JSON.stringify({ type: 'module' }));

  onebot = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const params = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const action = request.url.slice(1);
      onebotRequests.push({ action, params });
      let data;
      if (action === 'get_status') data = { good: true, online: true };
      else if (action === 'get_login_info') data = { user_id: 999_999, nickname: 'FixtureDot' };
      else if (action === 'get_group_member_list') data = [];
      else if (action === 'get_group_member_info') data = { ...params, nickname: `fixture-${params.user_id}` };
      else if (action === 'send_group_msg' || action === 'send_private_msg') {
        data = { message_id: ++onebotMessageId };
        sends.push({ action, params, data });
        if (disconnectSendResponse) {
          request.socket.destroy();
          return;
        }
      } else {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'failed', retcode: 404, wording: `Unexpected fixture action: ${action}` }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'failed', retcode: 500, wording: String(error) }));
    }
  });
  onebot.listen(0, '127.0.0.1');
  await once(onebot, 'listening');
  const onebotUrl = `http://127.0.0.1:${onebot.address().port}`;
  const fixtureConfig = {
    consolePort: 0,
    consoleToken: FIXTURE_CONSOLE_TOKEN,
    ownerQQ: 5005,
    allow: { groups: ['1001', '1002'], private: [] },
    allowAllWhenEmpty: false,
    sendDelayMs: 1,
    dsh: { baseUrl: 'http://127.0.0.1:1', authToken: 'fixture_dsh_token', reasoningEffort: 'max' },
    snowluma: { wsUrl: 'ws://127.0.0.1:1', httpUrl: onebotUrl,
      homeDir: path.join(temporary, 'no-real-qq'), accessToken: 'fixture_snowluma_token',
      followDiscoveredEndpoint: false },
    slang: { enabled: false },
    socialV2: {
      enabled: true,
      autoReplyCheckMs: 3_600_000,
      agentPreset: 'qq-chat-v2',
      wake: { defaultMode: 'active', batchWindowMs: 1_000,
        maxWakePerMinute: 100, maxWakePerHour: 1000, preSleepWaitEnabled: false },
      proactive: { enabled: false },
      sticker: { enabled: false },
      voice: { enabled: false },
      context: { recentLimit: 100, unreadLimit: 100, contextWindow: 20 },
      send: { maxMessageChars: 500, maxSendPerMinute: 50, maxSendPerHour: 100 }
    },
    ...config
  };
  await fs.writeFile(path.join(runtime, 'config.json'), JSON.stringify(fixtureConfig, null, 2));
  await fs.writeFile(path.join(stateDirectory, 'mode.json'), JSON.stringify({ mode: 'reserved2' }));
  if (fixtureConfig.dot?.tokenFile) {
    const tokenPath = path.resolve(runtime, fixtureConfig.dot.tokenFile);
    assert.ok(tokenPath.startsWith(stateDirectory + path.sep), 'Fixture token must be under its temporary state directory.');
    await fs.writeFile(tokenPath, FIXTURE_DOT_TOKEN + '\n');
  }
  for (const [filename, value] of Object.entries(seedState)) {
    assert.equal(path.basename(filename), filename, 'Fixture state must be a direct state filename.');
    await fs.writeFile(path.join(stateDirectory, filename), JSON.stringify(value));
  }
  await fs.mkdir(path.join(runtime, 'roles'), { recursive: true });
  for (const [name, content] of Object.entries(roleCards)) {
    assert.match(name, /^[A-Za-z0-9_-]+$/);
    await fs.writeFile(path.join(runtime, 'roles', name + '.md'), content);
  }

  const childEnvironment = {
    ...process.env,
    QQBRIDGE_COMPONENT_FIXTURE: '1',
    QQBRIDGE_FIXTURE_DSH_ONLINE: dshOnline ? '1' : '0',
    DSH_HOME: path.join(temporary, 'no-real-dsh'),
    QQBRIDGE_DOT_TOKEN: FIXTURE_DOT_TOKEN,
    ...env
  };
  delete childEnvironment.NODE_OPTIONS;
  child = fork(path.join(runtime, 'src/bridge.js'), [], {
    cwd: runtime, execArgv: ['--import', loader], env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  const recordOutput = chunk => { output = (output + chunk.toString()).slice(-30_000); };
  child.stdout.on('data', recordOutput);
  child.stderr.on('data', recordOutput);
  child.on('message', event => {
    if (event.fixtureEvent === 'listening') listenerPort = event.port;
    if (event.fixtureEvent === 'sdk') sdkEvents.push(event);
    if (event.fixtureEvent === 'dsh') dshCalls.push(event);
    if (event.fixtureReply) {
      const waiter = pendingRpc.get(event.fixtureReply);
      if (!waiter) return;
      pendingRpc.delete(event.fixtureReply);
      clearTimeout(waiter.timer);
      event.error ? waiter.reject(new Error(event.error)) : waiter.resolve(event.value);
    }
  });
  child.on('exit', (code, signal) => {
    for (const { reject, timer } of pendingRpc.values()) {
      clearTimeout(timer);
      reject(new Error(`Fixture bridge exited (${code ?? signal}).\n${output}`));
    }
    pendingRpc.clear();
  });
  await eventually(() => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Bridge failed to start.\n${output}`);
    }
    return listenerPort;
  }, { message: `QQBridge HTTP listener did not start; inspect fixture output.`, timeoutMs: 6_000 });

  const rpc = (fixtureOp, fields = {}) => new Promise((resolve, reject) => {
    const requestId = `request-${++rpcSequence}`;
    const timer = setTimeout(() => {
      pendingRpc.delete(requestId);
      reject(new Error(`Fixture RPC timed out: ${fixtureOp}\n${output}`));
    }, 3_000);
    pendingRpc.set(requestId, { resolve, reject, timer });
    child.send({ fixtureOp, requestId, ...fields });
  });
  const baseUrl = `http://127.0.0.1:${listenerPort}`;
  const request = async (pathname, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(baseUrl + pathname, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(4_000)
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    baseUrl, runtime, stateDirectory, dshCalls, sdkEvents, sends, onebotRequests,
    output: () => output,
    request,
    console: (pathname, options = {}) => request(pathname, {
      ...options, headers: { 'x-console-token': FIXTURE_CONSOLE_TOKEN, ...(options.headers ?? {}) }
    }),
    rpc,
    setDshOnline: online => rpc('dsh-online', { online }),
    disconnectSendResponse: enabled => { disconnectSendResponse = enabled; },
    injectGroup: (groupId, message, extra = {}) => rpc('qq-message', { event: {
      post_type: 'message', message_type: 'group', group_id: groupId,
      user_id: 6006, self_id: 999_999, message_id: ++messageSequence,
      time: Math.floor(Date.now() / 1000), sender: { user_id: 6006, nickname: 'FixtureMember' },
      message: [{ type: 'text', data: { text: message } }], ...extra
    } }),
    state: async filename => JSON.parse(await fs.readFile(path.join(stateDirectory, filename), 'utf8'))
  };
}
