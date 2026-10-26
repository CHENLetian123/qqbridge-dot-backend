import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Webhook } from 'standardwebhooks';
import { GatewayStore } from '../src/mcp/store.mjs';
import { DotGateway } from '../src/mcp/gateway.mjs';
import { createMcpServer } from '../src/mcp/server.mjs';
import { PNG, pngImage } from './fixtures/image.mjs';
import {
  publicAddress,
  callbackUrl,
  postWebhook,
  signingKey,
  signedRequest,
  callbackAddresses,
  publicDnsAnswers,
} from '../src/mcp/webhook.mjs';

const transportToken = 'transport_' + randomBytes(32).toString('hex');
const key = 'group:1001',
  other = 'group:1002';
const secret = () => 'whsec_' + randomBytes(32).toString('base64');
const parameters = (signingSecret = secret(), extra = {}) => ({
  name: 'qq.wake.available',
  arguments: { conversationKey: key },
  delivery: { mode: 'webhook', url: 'https://callback.example/mcp-events', secret: signingSecret },
  cursor: null,
  ...extra,
});
function fixture(t, { clock = Date.now, post } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-mcp-test-')),
    filename = path.join(dir, 'state.sqlite');
  let store = new GatewayStore(filename);
  const posts = [],
    calls = [];
  const run = {
    key,
    runId: randomUUID(),
    runToken: 'run_' + randomBytes(32).toString('hex'),
    generation: 1,
    expiresAt: Date.now() + 120000,
  };
  const client = {
    epoch: 'bridge-1',
    pending: [
      { key, wakeId: 'wake-1', reason: 'anyMessage', createdAt: Date.now() },
      { key: other, wakeId: 'other-wake', reason: 'anyMessage', createdAt: Date.now() },
    ],
    async health() {
      return { ok: true, instanceId: this.epoch };
    },
    async listWakes() {
      return { wakes: this.pending };
    },
    async claim(args) {
      calls.push(['claim', args]);
      return {
        ok: true,
        run,
        context: { role: 'friend', token: 'never-expose' },
        readThroughSeq: 0,
      };
    },
    async read() {
      return {
        ok: true,
        messages: [{ seq: 1, text: 'untrusted group text' }],
        readThroughSeq: 1,
        unreadCount: 1,
      };
    },
    async send(_run, args) {
      calls.push(['send', args]);
      return { ok: true, send: { sendId: args.sendId, status: 'confirmed' } };
    },
    async finish(_run, args) {
      calls.push(['finish', args]);
      return { ok: true, completion: args };
    },
  };
  const deliver =
    post ??
    (async (url, request) => {
      posts.push({ url, ...request });
      const payload = JSON.parse(request.body);
      return {
        status: 200,
        body: JSON.stringify(
          payload.type === 'verification' ? { challenge: payload.challenge } : {},
        ),
      };
    });
  const make = () =>
    new DotGateway({
      client,
      store,
      conversations: [key],
      post: deliver,
      clock,
      secrets: [transportToken],
    });
  let gateway = make();
  t.after(async () => {
    await gateway.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    filename,
    client,
    run,
    calls,
    posts,
    get store() {
      return store;
    },
    get gateway() {
      return gateway;
    },
    async restart() {
      await gateway.stop();
      store.close();
      store = new GatewayStore(filename);
      gateway = make();
      return gateway;
    },
  };
}

test('subscription diagnostics distinguish rejected requests and callback failures without secrets', async (t) => {
  const f = fixture(t, {
    post: async () => {
      throw new Error('timeout');
    },
  });
  await assert.rejects(f.gateway.rpc('events/subscribe', parameters()));
  const status = await f.gateway.call('qq_get_status', {});
  assert.equal(status.subscriptions, 0);
  assert.equal(status.lastSubscriptionAttempt.stage, 'failed');
  assert.equal(status.lastSubscriptionAttempt.failedDuring, 'callback_verification');
  assert.equal(status.lastSubscriptionAttempt.reason, 'timeout');
  assert.equal(status.lastSubscriptionAttempt.errorCode, -32015);
  assert.equal(JSON.stringify(status).includes('callback.example'), false);
  await f.restart();
  await assert.rejects(f.gateway.rpc('events/subscribe', { ...parameters(), name: 'invalid' }));
  const diagnostic = (await f.gateway.call('qq_get_status', {})).lastSubscriptionAttempt;
  assert.equal(diagnostic.attempt, 2);
  assert.equal(diagnostic.failedDuring, 'received');
  assert.equal(diagnostic.errorCode, -32602);
});

test('metadata scan diagnostics record actual event schema separately from tools refresh', async (t) => {
  const f = fixture(t);
  f.gateway.allowed.add('private:5005');
  await f.gateway.rpc('tools/list');
  let status = await f.gateway.call('qq_get_status', {});
  assert.equal(status.lastEventDiscovery, null);
  assert.equal(status.lastMetadataScan.count, 1);
  assert.equal(status.lastMetadataScan.toolCount, 9);
  assert.ok(status.lastMetadataScan.toolNames.includes('qq_send_image'));
  assert.deepEqual(status.lastMetadataScan.toolNames, status.toolCatalog.names);
  assert.equal(status.lastMetadataScan.schemaHash, status.toolCatalog.schemaHash);
  const events = await f.gateway.rpc('events/list');
  status = await f.gateway.call('qq_get_status', {});
  assert.deepEqual(
    status.lastEventDiscovery.conversationKeys,
    events.events[0].inputSchema.properties.conversationKey.enum,
  );
  assert.ok(status.lastEventDiscovery.conversationKeys.includes('private:5005'));
  assert.equal(status.lastEventDiscovery.serverVersion, status.serverVersion);
  await f.restart();
  assert.equal(
    (await f.gateway.call('qq_get_status', {})).lastEventDiscovery.schemaHash,
    status.lastEventDiscovery.schemaHash,
  );
});

test('synthetic proxy DNS uses validated public answers without accepting private or mixed addresses', async () => {
  const lookup = async () => [{ address: '198.18.0.5', family: 4 }];
  let queries = 0;
  const resolvePublic = async (host) => {
    assert.equal(host, 'callback.example');
    queries++;
    return [{ address: '8.8.8.8', family: 4 }];
  };
  assert.deepEqual(await callbackAddresses('callback.example', { lookup, resolvePublic }), [
    { address: '8.8.8.8', family: 4 },
  ]);
  assert.equal(queries, 1);
  for (const addresses of [
    [{ address: '127.0.0.1', family: 4 }],
    [
      { address: '8.8.8.8', family: 4 },
      { address: '198.18.0.5', family: 4 },
    ],
  ]) {
    await assert.rejects(
      callbackAddresses('callback.example', { lookup: async () => addresses, resolvePublic }),
      /blocked_address/,
    );
  }
  assert.equal(queries, 1);
  for (const bad of ['198.18.0.1', '10.0.0.1', '::ffff:8.8.8.8', 'not-an-ip'])
    await assert.rejects(
      callbackAddresses('callback.example', {
        lookup,
        resolvePublic: async () => [{ address: bad, family: 4 }],
      }),
      /blocked_address/,
    );
  let request;
  const answers = await publicDnsAnswers('callback.example', {
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options };
      return new Response(
        JSON.stringify({
          Status: 0,
          Answer: [
            { type: 5, data: 'alias.example' },
            { type: 1, data: '8.8.8.8' },
          ],
        }),
      );
    },
  });
  assert.equal(request.url.origin, 'https://cloudflare-dns.com');
  assert.equal(request.url.searchParams.get('name'), 'callback.example');
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(answers, [{ address: '8.8.8.8', family: 4 }]);
});

test('encrypted SQLite records survive restart without plaintext credentials', async (t) => {
  const f = fixture(t);
  f.store.put('private', 'x', { secret: 'private-signing-key', value: 17 });
  await f.restart();
  assert.deepEqual(f.store.get('private', 'x'), { secret: 'private-signing-key', value: 17 });
  for (const name of fs.readdirSync(f.dir).filter((n) => !n.endsWith('.key')))
    assert.equal(
      fs.readFileSync(path.join(f.dir, name)).includes(Buffer.from('private-signing-key')),
      false,
    );
});

test('MCP discovery, tool annotations, invalid schemas and authorization stay scoped', async (t) => {
  const f = fixture(t),
    g = f.gateway;
  assert.deepEqual((await g.rpc('server/discover')).supportedVersions, ['2026-07-28']);
  assert.ok((await g.rpc('server/discover')).capabilities.events);
  const tools = (await g.rpc('tools/list')).tools;
  assert.equal(tools.find((t) => t.name === 'qq_send_message').annotations.readOnlyHint, false);
  assert.equal(tools.find((t) => t.name === 'qq_read_messages').annotations.readOnlyHint, false);
  assert.deepEqual(
    (await g.call('qq_list_wakes', {})).wakes.map((w) => w.key),
    [key],
  );
  await assert.rejects(g.call('qq_claim_turn', { wakeId: 'other-wake', claimId: 'x' }));
  await assert.rejects(g.call('qq_read_messages', { runId: 'not-owned' }));
  await assert.rejects(
    g.call('qq_claim_turn', { wakeId: 'wake-1', claimId: 'x', conversationKey: other }),
  );
  assert.equal(f.calls.length, 0);
});

test('claim retries reuse identity, never return run tokens, and send deduplication persists', async (t) => {
  const f = fixture(t);
  const args = { wakeId: 'wake-1', claimId: 'stable' };
  const claim = await f.gateway.call('qq_claim_turn', args);
  assert.equal(claim.run.runId, f.run.runId);
  assert.equal(claim.run.runToken, undefined);
  assert.equal(claim.context.token, undefined);
  await f.restart();
  const again = await f.gateway.call('qq_claim_turn', args);
  assert.equal(again.run.runId, claim.run.runId);
  const send = { runId: claim.run.runId, sendId: 'stable-send', text: 'local fixture only' };
  await f.gateway.call('qq_send_message', send);
  await f.restart();
  await f.gateway.call('qq_send_message', send);
  assert.equal(f.calls.filter((c) => c[0] === 'send').length, 1);
  await assert.rejects(f.gateway.call('qq_send_message', { ...send, text: 'changed text' }));
});

test('a lost send response fences new IDs and message acknowledgement across restart', async (t) => {
  const f = fixture(t);
  await f.gateway.call('qq_claim_turn', { wakeId: 'wake-1', claimId: 'stable' });
  f.client.send = async () => {
    f.calls.push(['send']);
    throw Object.assign(new Error('transport'), { code: 'TRANSPORT_UNKNOWN' });
  };
  const send = { runId: f.run.runId, sendId: 'first', text: 'fixture' };
  await assert.rejects(f.gateway.call('qq_send_message', send));
  await f.restart();
  await assert.rejects(f.gateway.call('qq_send_message', send));
  await assert.rejects(f.gateway.call('qq_send_message', { ...send, sendId: 'different' }));
  await assert.rejects(
    f.gateway.call('qq_finish_turn', { runId: f.run.runId, throughSeq: 1, outcome: 'silent' }),
  );
  assert.equal(f.calls.filter((c) => c[0] === 'send').length, 1);
});

test('bridge restart after a confirmed unfinished send requires local reconciliation', async (t) => {
  const f = fixture(t);
  await f.gateway.call('qq_claim_turn', { wakeId: 'wake-1', claimId: 'stable' });
  await f.gateway.call('qq_send_message', { runId: f.run.runId, sendId: 'first', text: 'fixture' });
  f.client.epoch = 'bridge-2';
  f.client.pending[0].wakeId = 'wake-2';
  await assert.rejects(f.gateway.call('qq_claim_turn', { wakeId: 'wake-2', claimId: 'new' }));
  assert.deepEqual((await f.gateway.call('qq_get_status', {})).reconciliationRequired, [key]);
});

test('a persistence failure after sending leaves the durable reservation uncertain', async (t) => {
  const f = fixture(t);
  await f.gateway.call('qq_claim_turn', { wakeId: 'wake-1', claimId: 'stable' });
  const put = f.store.put.bind(f.store);
  let failed = false;
  f.store.put = (kind, id, value) => {
    if (kind === 'send' && value.result && !failed) {
      failed = true;
      throw new Error('simulated disk failure');
    }
    return put(kind, id, value);
  };
  const send = { runId: f.run.runId, sendId: 'persist-failure', text: 'fixture' };
  await assert.rejects(f.gateway.call('qq_send_message', send));
  assert.equal(f.store.list('send')[0].state, 'reserved');
  await f.restart();
  await assert.rejects(f.gateway.call('qq_send_message', send));
  assert.equal(f.calls.filter((c) => c[0] === 'send').length, 1);
});

test('a successfully finished turn does not create a false restart send fence', async (t) => {
  const f = fixture(t);
  await f.gateway.call('qq_claim_turn', { wakeId: 'wake-1', claimId: 'stable' });
  await f.gateway.call('qq_send_message', { runId: f.run.runId, sendId: 'first', text: 'fixture' });
  await f.gateway.call('qq_finish_turn', { runId: f.run.runId, throughSeq: 1, outcome: 'replied' });
  f.client.epoch = 'bridge-2';
  assert.deepEqual((await f.gateway.call('qq_get_status', {})).reconciliationRequired, []);
});

test('subscriptions verify callbacks, refresh idempotently, rotate keys and persist', async (t) => {
  let now = Date.now();
  const f = fixture(t, { clock: () => now }),
    p = parameters();
  const first = await f.gateway.rpc('events/subscribe', p);
  assert.equal(f.posts.length, 1);
  const retry = await f.gateway.rpc('events/subscribe', p);
  assert.equal(first.id, retry.id);
  assert.equal(f.posts.length, 1);
  await f.restart();
  assert.equal(f.gateway.activeSubscriptions().length, 1);
  const rotated = parameters(secret());
  await f.gateway.subscribe(rotated);
  assert.equal(f.posts.length, 2);
  const saved = f.store.get('subscription', first.id);
  assert.equal(saved.previousSecret, p.delivery.secret);
  const req = signedRequest(saved, { data: 'fixture' }, 'rotation-test', now);
  assert.equal(req.headers['webhook-signature'].split(' ').length, 2);
  assert.deepEqual(new Webhook(p.delivery.secret).verify(req.body, req.headers), {
    data: 'fixture',
  });
  assert.deepEqual(new Webhook(rotated.delivery.secret).verify(req.body, req.headers), {
    data: 'fixture',
  });
  now += 25 * 3600000;
  assert.equal(f.gateway.activeSubscriptions().length, 0);
});

test('subscription failure and wrong filters never activate delivery', async (t) => {
  const f = fixture(t, { post: async () => ({ status: 200, body: '{"challenge":"wrong"}' }) });
  await assert.rejects(
    f.gateway.subscribe(parameters()),
    (e) => e.code === -32015 && e.data.reason === 'challenge_failed',
  );
  await assert.rejects(
    f.gateway.subscribe(parameters(secret(), { arguments: { conversationKey: other } })),
  );
  await assert.rejects(f.gateway.subscribe(parameters('whsec_invalid')));
  assert.equal(f.store.list('subscription').length, 0);
});

test('subscription refresh does not extend callback verification cache indefinitely', async (t) => {
  let now = Date.now();
  const f = fixture(t, { clock: () => now }),
    p = parameters();
  await f.gateway.subscribe(p);
  now += 4 * 60_000;
  await f.gateway.subscribe(p);
  assert.equal(f.posts.length, 1);
  now += 2 * 60_000;
  await f.gateway.subscribe(p);
  assert.equal(f.posts.length, 2);
});

test('signed event delivery contains no chat content and 2xx does not claim or finish work', async (t) => {
  const f = fixture(t),
    p = parameters();
  await f.gateway.subscribe(p);
  await f.gateway.poll();
  const events = f.posts.filter((r) => !JSON.parse(r.body).type);
  assert.equal(events.length, 1);
  const event = new Webhook(p.delivery.secret).verify(events[0].body, events[0].headers);
  assert.equal(event.name, 'qq.wake.available');
  assert.equal(event.data.wakeId, 'wake-1');
  assert.equal(event.data.conversationKey, key);
  assert.equal(JSON.stringify(event).includes('untrusted group text'), false);
  assert.equal(f.calls.length, 0);
  await f.restart();
  await f.gateway.poll();
  assert.equal(f.posts.filter((r) => !JSON.parse(r.body).type).length, 1);
});

test('retry preserves event ID, re-signs exact body and unsubscribe stops further delivery', async (t) => {
  let now = Date.now(),
    delivered = [];
  const f = fixture(t, {
    clock: () => now,
    post: async (_url, req) => {
      const body = JSON.parse(req.body);
      if (body.type === 'verification')
        return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
      delivered.push(req);
      return { status: 503, body: '' };
    },
  });
  const p = parameters();
  await f.gateway.subscribe(p);
  await f.gateway.poll();
  await f.restart();
  now += 3000;
  await f.gateway.poll();
  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].headers['webhook-id'], delivered[1].headers['webhook-id']);
  assert.equal(delivered[0].body, delivered[1].body);
  assert.notEqual(
    delivered[0].headers['webhook-signature'],
    delivered[1].headers['webhook-signature'],
  );
  const cancel = { ...p, delivery: { mode: 'webhook', url: p.delivery.url } };
  await f.gateway.rpc('events/unsubscribe', cancel);
  await f.gateway.rpc('events/unsubscribe', cancel);
  now += 10000;
  await f.gateway.poll();
  assert.equal(delivered.length, 2);
});

test('410 terminates a subscription and 413 does not retry oversized delivery', async (t) => {
  for (const status of [410, 413]) {
    let count = 0;
    const f = fixture(t, {
      post: async (_u, r) => {
        const b = JSON.parse(r.body);
        if (b.type) return { status: 200, body: JSON.stringify({ challenge: b.challenge }) };
        count++;
        return { status, body: '' };
      },
    });
    await f.gateway.subscribe(parameters());
    await f.gateway.poll();
    await f.gateway.poll();
    assert.equal(count, 1);
    if (status === 410) assert.equal(f.gateway.activeSubscriptions().length, 0);
  }
});

test('callback networking blocks private, mixed DNS, mapped IPv6, redirects and invalid secrets', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    '::ffff:8.8.8.8',
    '2001:db8::1',
    '192.0.2.1',
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
  for (const url of [
    'http://example.com/',
    'https://127.0.0.1/',
    'https://localhost/',
    'https://x.local/',
    'https://user:pass@example.com/',
    'https://example.com:444/',
  ])
    assert.throws(() => callbackUrl(url));
  await assert.rejects(
    postWebhook(
      'https://example.com/',
      { headers: {}, body: '{}' },
      {
        lookup: async () => [
          { address: '8.8.8.8', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
      },
    ),
  );
  await assert.rejects(
    postWebhook(
      'https://example.com/',
      { headers: {}, body: '{}' },
      { lookup: () => new Promise(() => {}), timeoutMs: 5 },
    ),
    /timeout/,
  );
  assert.throws(() => signingKey('whsec_aaaa'));
});

test('stateless HTTP MCP transport authenticates discovery and rejects browser requests', async (t) => {
  const f = fixture(t),
    app = createMcpServer({ gateway: f.gateway, token: transportToken });
  const address = await app.listen(0);
  t.after(async () => {
    await app.close();
  });
  const base = `http://127.0.0.1:${address.port}`;
  const rpc = async (body, extra = {}) =>
    fetch(base + '/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + transportToken,
        'content-type': 'application/json',
        ...extra,
      },
      body: JSON.stringify(body),
    });
  assert.equal((await fetch(base + '/mcp')).status, 401);
  assert.equal((await rpc({}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await rpc({}, { 'mcp-protocol-version': 'bad' })).status, 400);
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const discovered = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'server/discover' })).json();
  assert.ok(discovered.result.capabilities.events);
  const unknown = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'not/a/method' })).json();
  assert.equal(unknown.error.code, -32601);
  const rejected = await (
    await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'qq_read_messages', arguments: { runId: 'foreign' } },
    })
  ).json();
  assert.equal(rejected.result.isError, true);
  assert.equal(JSON.stringify(rejected).includes(f.run.runToken), false);
});

test('official MCP SDK client can initialize, discover and call tools on the HTTP endpoint', async (t) => {
  const f = fixture(t),
    app = createMcpServer({ gateway: f.gateway, token: transportToken });
  const address = await app.listen(0);
  const client = new Client({ name: 'qqbridge-local-sdk-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await app.close();
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer ' + transportToken } },
    }),
  );
  const discovered = (await client.listTools()).tools;
  assert.equal(discovered.length, 9);
  const imageTool = discovered.find((tool) => tool.name === 'qq_send_image');
  assert.deepEqual(imageTool._meta['openai/fileParams'], ['file']);
  assert.deepEqual(imageTool.inputSchema.properties.file.required, ['download_url', 'file_id']);
  const response = await client.callTool({ name: 'qq_get_status', arguments: {} });
  assert.equal(response.structuredContent.bridgeReachable, true);
  await client.callTool({
    name: 'qq_claim_turn',
    arguments: { wakeId: 'wake-1', claimId: 'image-sdk' },
  });
  f.client.image = async () => ({ ok: true, messageSeq: 1, image: pngImage() });
  const picture = await client.callTool({
    name: 'qq_read_image',
    arguments: { runId: f.run.runId, messageSeq: 1 },
  });
  assert.equal(picture.content[1].type, 'image');
  assert.equal(picture.content[1].data, PNG);
  assert.equal(picture.structuredContent.image.data, undefined);
  assert.equal(picture.content[0].text.includes(PNG), false);
});

test('stdio tunnel adapter forwards JSON-RPC without exposing transport credentials', async (t) => {
  const f = fixture(t),
    app = createMcpServer({ gateway: f.gateway, token: transportToken });
  const address = await app.listen(0);
  fs.writeFileSync(path.join(f.dir, 'transport-token'), transportToken);
  fs.writeFileSync(path.join(f.dir, 'bridge-token'), 'bridge_' + randomBytes(32).toString('hex'));
  const config = path.join(f.dir, 'mcp-config.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      port: address.port,
      transportTokenFile: 'transport-token',
      bridgeTokenFile: 'bridge-token',
      database: 'unused.sqlite',
      conversations: [key],
    }),
  );
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../scripts/mcp-stdio.mjs', import.meta.url)), '--config', config],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  t.after(async () => {
    if (child.exitCode === null) {
      const exit = once(child, 'exit');
      child.kill();
      await exit;
    }
    await app.close();
  });
  const response = new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Stdio response timed out')), 5000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('\n')) {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(output.split('\n')[0]));
        } catch (e) {
          reject(e);
        }
      }
    });
    child.once('error', reject);
  });
  child.stdin.write(
    JSON.stringify({ jsonrpc: '2.0', id: 17, method: 'server/discover', params: {} }) + '\n',
  );
  const result = await response;
  assert.equal(result.id, 17);
  assert.ok(result.result.capabilities.events);
  assert.equal(JSON.stringify(result).includes(transportToken), false);
});

test('native image file parameters download once, deduplicate by file ID and never persist signed URLs or bytes', async (t) => {
  const f = fixture(t);
  let downloads = 0;
  f.gateway.imageDownload = async () => {
    downloads++;
    return pngImage();
  };
  await f.gateway.call('qq_claim_turn', { wakeId: 'wake-1', claimId: 'image-file' });
  const args = {
    runId: f.run.runId,
    sendId: 'native-file',
    file: {
      file_id: 'file-fixture',
      download_url: 'https://files.example/image?signature=private-test-marker',
      mime_type: 'image/png',
      file_name: 'output.png',
    },
  };
  assert.equal((await f.gateway.call('qq_send_image', args)).send.status, 'confirmed');
  assert.equal(
    (
      await f.gateway.call('qq_send_image', {
        ...args,
        file: { ...args.file, download_url: 'https://files.example/fresh-url' },
      })
    ).send.status,
    'confirmed',
  );
  assert.equal(downloads, 1);
  assert.equal(f.calls.filter((call) => call[0] === 'send').length, 1);
  const records = JSON.stringify(f.gateway.store.list('send'));
  assert.equal(records.includes('private-test-marker'), false);
  assert.equal(records.includes(PNG), false);
  await assert.rejects(
    f.gateway.call('qq_send_message', {
      runId: f.run.runId,
      sendId: args.sendId,
      text: 'conflict',
    }),
    /conflict/,
  );
  await assert.rejects(
    f.gateway.call('qq_send_image', {
      ...args,
      sendId: 'invalid',
      file: { file_id: 'file', download_url: 42 },
    }),
    (error) => error.code === -32602,
  );
});

test('image preparation failure is a definite rejection with no QQ dispatch or uncertain-send fence', async (t) => {
  const f = fixture(t);
  f.gateway.imageDownload = async () => {
    throw new Error('private URL must never escape');
  };
  await f.gateway.call('qq_claim_turn', { wakeId: 'wake-1', claimId: 'image-reject' });
  const response = await f.gateway.rpc('tools/call', {
    name: 'qq_send_image',
    arguments: {
      runId: f.run.runId,
      sendId: 'bad-image',
      file: { file_id: 'bad-file', download_url: 'https://127.0.0.1/private' },
    },
  });
  assert.equal(response.structuredContent.send.status, 'rejected');
  assert.equal(
    f.calls.some((call) => call[0] === 'send'),
    false,
  );
  assert.equal(JSON.stringify(response).includes('private URL'), false);
  await f.gateway.call('qq_finish_turn', { runId: f.run.runId, throughSeq: 0, outcome: 'silent' });
});

test('forwarding a received image uses the same durable ledger as native generated files', async (t) => {
  const f = fixture(t);
  let reads = 0;
  f.client.image = async (_run, args) => {
    reads++;
    assert.equal(args.messageSeq, 1);
    return { image: pngImage() };
  };
  await f.gateway.call('qq_claim_turn', { wakeId: 'wake-1', claimId: 'image-forward' });
  const args = { runId: f.run.runId, sendId: 'forward-one', messageSeq: 1 };
  await f.gateway.call('qq_forward_image', args);
  await f.gateway.call('qq_forward_image', args);
  assert.equal(reads, 1);
  assert.equal(f.calls.find((call) => call[0] === 'send')[1].image.data, PNG);
  await assert.rejects(f.gateway.call('qq_forward_image', { ...args, messageSeq: 2 }), /conflict/);
});
