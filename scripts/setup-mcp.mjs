import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({
  options: {
    'bridge-config': { type: 'string' },
    conversation: { type: 'string', multiple: true },
    port: { type: 'string', default: '3112' },
  },
});
const state = path.join(root, 'state');
fs.mkdirSync(state, { recursive: true, mode: 0o700 });
const configFile = path.join(state, 'mcp-config.json');
if (fs.existsSync(configFile))
  throw new Error(
    'MCP config already exists; edit it explicitly rather than overwriting credentials.',
  );
const bridgeConfig = path.resolve(
  values['bridge-config'] ?? path.join(root, '../qq-bridge/config.json'),
);
const bridge = JSON.parse(fs.readFileSync(bridgeConfig, 'utf8').replace(/^\uFEFF/, ''));
const conversations =
  values.conversation ??
  bridge.dot?.conversations ??
  (bridge.allow?.groups ?? []).map((id) => 'group:' + id);
if (!conversations.length || conversations.some((k) => !/^(group|private):[1-9]\d*$/.test(k)))
  throw new Error('Provide explicit --conversation keys.');
const port = Number(values.port);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port.');
for (const name of ['mcp-transport-token', 'dot-api-token'])
  fs.writeFileSync(path.join(state, name), randomBytes(32).toString('hex'), {
    flag: 'wx',
    mode: 0o600,
  });
const config = {
  port,
  bridgeBaseUrl: `http://127.0.0.1:${bridge.consolePort || 3100}`,
  bridgeTokenFile: 'dot-api-token',
  transportTokenFile: 'mcp-transport-token',
  database: 'mcp-state.sqlite',
  conversations,
};
fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(
  `Prepared local MCP config for ${conversations.length} conversation(s) on port ${port}. No live bridge settings changed and no ChatGPT account connected.`,
);
console.log(
  'The live bridge does not accept this gateway until its Dot adapter and dedicated token are configured. Keep the existing DSH instance running until account integration is ready.',
);
