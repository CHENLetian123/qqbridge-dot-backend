import { parseArgs } from 'node:util';
import { loadConfig } from '../src/mcp/config.mjs';
const { values } = parseArgs({ options: { config: { type: 'string' } } });
try {
  const cfg = loadConfig(values.config),
    base = `http://127.0.0.1:${cfg.port}`;
  const headers = { authorization: 'Bearer ' + cfg.token, 'content-type': 'application/json' };
  const rpc = async (method) => {
    const res = await fetch(base + '/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    const body = await res.json();
    if (!res.ok || body.error) throw new Error('Protocol check failed');
    return body.result;
  };
  const discovery = await rpc('server/discover'),
    tools = await rpc('tools/list'),
    events = await rpc('events/list');
  const status = await (
    await fetch(base + '/healthz', {
      headers,
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    })
  ).json();
  console.log(
    JSON.stringify(
      {
        localMcpReady: true,
        protocol: discovery.supportedVersions,
        tools: tools.tools.map((t) => t.name),
        events: events.events.map((e) => e.name),
        bridgeReady: status.bridgeReachable,
        conversationCount: status.conversations?.length,
        subscriptionCount: status.subscriptions,
        reconciliationRequired: status.reconciliationRequired?.length,
      },
      null,
      2,
    ),
  );
} catch {
  console.error('Local MCP check failed. Start the service first and verify its local config.');
  process.exitCode = 1;
}
