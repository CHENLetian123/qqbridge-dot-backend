// Secure MCP Tunnel can launch this adapter using --mcp-command. It forwards
// only JSON-RPC to the authenticated loopback gateway; credentials stay local.
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/mcp/config.mjs';
const { values } = parseArgs({ options: { config: { type: 'string' } } });
const cfg = loadConfig(values.config);
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let active = 0;
input.on('line', async (line) => {
  let request,
    id = null;
  try {
    if (Buffer.byteLength(line) > 64 * 1024 || active >= 16) throw new Error('Limit');
    request = JSON.parse(line);
    id = request?.id ?? null;
    active++;
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.port}/mcp`, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + cfg.token, 'content-type': 'application/json' },
        body: line,
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 202) return;
      if (!res.ok) throw new Error('Transport');
      const response = await res.json();
      process.stdout.write(JSON.stringify(response) + '\n');
    } finally {
      active--;
    }
  } catch {
    if (!request || Object.hasOwn(request, 'id'))
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: 'Local gateway unavailable or request rejected.' },
        }) + '\n',
      );
  }
});
