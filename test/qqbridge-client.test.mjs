import test from 'node:test';
import assert from 'node:assert/strict';
import { QQBridgeClient } from '../src/qqbridge-client.mjs';

const token = 'test-only-dot-bearer-token-not-a-real-credential';

test('client confines credentials to loopback and refuses redirects', async () => {
  for (const baseUrl of ['https://example.com', 'http://example.com', 'http://127.0.0.1/?token=x',
    'http://user:pass@127.0.0.1/', 'http://127.0.0.1/api/status']) {
    assert.throws(() => new QQBridgeClient({ baseUrl, token }), error => error.code === 'INVALID_BASE_URL');
  }
  let seen;
  const client = new QQBridgeClient({ baseUrl: 'http://localhost:3100', token,
    fetchImpl: async (url, init) => { seen = { url, init }; return Response.json({ ok: true, wakes: [] }); } });
  await client.listWakes();
  assert.equal(seen.url, 'http://127.0.0.1:3100/api/dot/v1/wakes');
  assert.equal(seen.init.headers.authorization, `Bearer ${token}`);
  assert.equal(seen.init.headers['x-console-token'], undefined);
  assert.equal(seen.init.redirect, 'error');
});

test('client does not silently retry an uncertain send or replace caller idempotency keys', async () => {
  let calls = 0;
  let request;
  const client = new QQBridgeClient({ token, fetchImpl: async (_, init) => {
    calls += 1;
    request = JSON.parse(init.body);
    throw new Error('connection closed');
  } });
  await assert.rejects(() => client.send({ runId: 'abc-123', runToken: 'run-secret' }, { sendId: 'stable-id', text: 'hello' }),
    error => error.code === 'TRANSPORT_UNKNOWN');
  assert.equal(calls, 1);
  assert.equal(request.sendId, 'stable-id');
  assert.equal(request.runToken, 'run-secret');
});
