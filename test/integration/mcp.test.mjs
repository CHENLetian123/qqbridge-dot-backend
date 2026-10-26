import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { QQBridgeClient } from '../../src/qqbridge-client.mjs';
import { GatewayStore } from '../../src/mcp/store.mjs';
import { createMcpServer } from '../../src/mcp/server.mjs';
import { startBridge, eventually, FIXTURE_DOT_TOKEN } from '../fixtures/bridge-harness.mjs';

test(
  'MCP HTTP + signed Events + real bridge: claim/read/send/finish, DSH offline, no real QQ account',
  { timeout: 30000 },
  async (t) => {
    const bridge = await startBridge(t, {
      config: {
        dot: {
          enabled: true,
          conversations: ['group:1001'],
          tokenFile: 'state/dot-api-token',
          leaseMs: 15000,
        },
      },
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-complete-chain-'));
    const store = new GatewayStore(path.join(dir, 'state.sqlite')),
      secret = 'whsec_' + randomBytes(32).toString('base64');
    const token = 'fixture_transport_' + randomBytes(32).toString('hex'),
      deliveries = [];
    const app = createMcpServer({
      store,
      token,
      client: new QQBridgeClient({ baseUrl: bridge.baseUrl, token: FIXTURE_DOT_TOKEN }),
      conversations: ['group:1001'],
      post: async (_url, request) => {
        const payload = new Webhook(secret).verify(request.body, request.headers);
        if (payload.type === 'verification')
          return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
        deliveries.push(payload);
        return { status: 202, body: '{}' };
      },
    });
    const addr = await app.listen(0);
    t.after(async () => {
      await app.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    let id = 0;
    const rpc = async (method, params = {}) => {
      const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.error, undefined, JSON.stringify(body.error));
      return body.result;
    };
    const tool = async (name, args = {}) => {
      const value = await rpc('tools/call', { name, arguments: args });
      assert.notEqual(value.isError, true, JSON.stringify(value));
      return value.structuredContent;
    };
    assert.equal((await tool('qq_get_status')).bridgeReachable, true);
    await rpc('events/subscribe', {
      name: 'qq.wake.available',
      arguments: { conversationKey: 'group:1001' },
      delivery: { mode: 'webhook', url: 'https://fixture-callback.example/events', secret },
      cursor: null,
    });
    await bridge.injectGroup(1001, 'fixture message before claim');
    const event = await eventually(() => deliveries[0]);
    assert.equal(event.data.conversationKey, 'group:1001');
    assert.equal(JSON.stringify(event).includes('fixture message'), false);
    assert.equal(bridge.dshCalls.filter((c) => c.method === 'sessions.prompt').length, 0);
    const claimed = await tool('qq_claim_turn', {
      wakeId: event.data.wakeId,
      claimId: event.eventId,
    });
    assert.equal(claimed.run.runToken, undefined);
    const runId = claimed.run.runId,
      page = await tool('qq_read_messages', { runId, afterSeq: 0, limit: 30 });
    assert.ok(page.messages.some((m) => m.text.includes('fixture message before claim')));
    await bridge.injectGroup(1001, 'fixture message arriving during thought');
    const send = { runId, sendId: event.eventId + ':reply-1', text: 'local simulated Dot reply' };
    assert.equal((await tool('qq_send_message', send)).send.status, 'confirmed');
    await tool('qq_send_message', send);
    assert.equal(bridge.sends.length, 1);
    await tool('qq_finish_turn', { runId, throughSeq: page.readThroughSeq, outcome: 'replied' });
    assert.equal(bridge.sends.length, 1);
    const next = await eventually(async () => {
      const list = await tool('qq_list_wakes');
      return list.wakes.find((w) => w.wakeId !== event.data.wakeId);
    });
    const second = await tool('qq_claim_turn', { wakeId: next.wakeId, claimId: next.wakeId });
    const last = await tool('qq_read_messages', { runId: second.run.runId, afterSeq: 0 });
    assert.ok(last.messages.some((m) => m.text.includes('arriving during thought')));
    await tool('qq_finish_turn', {
      runId: second.run.runId,
      throughSeq: last.readThroughSeq,
      outcome: 'silent',
    });
    assert.equal(bridge.sends.length, 1, 'Silent finish does not emit a message');
  },
);
