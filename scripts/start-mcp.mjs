import { parseArgs } from 'node:util';
import { QQBridgeClient } from '../src/qqbridge-client.mjs';
import { GatewayStore } from '../src/mcp/store.mjs';
import { loadConfig } from '../src/mcp/config.mjs';
import { createMcpServer } from '../src/mcp/server.mjs';
const { values } = parseArgs({ options: { config: { type: 'string' } } });
try {
  const cfg = loadConfig(values.config),
    store = new GatewayStore(cfg.database);
  const client = new QQBridgeClient({
    baseUrl: cfg.bridgeBaseUrl,
    token: cfg.bridgeToken,
    timeoutMs: 5000,
  });
  const app = createMcpServer({
    client,
    store,
    conversations: cfg.conversations,
    token: cfg.token,
    secrets: [cfg.token, cfg.bridgeToken],
  });
  await app.listen(cfg.port);
  console.log(
    `Dot MCP ready on 127.0.0.1:${cfg.port}; account connection is not configured by starting this service.`,
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
} catch {
  console.error('Dot MCP startup failed. Check config file, token files and port availability.');
  process.exitCode = 1;
}
