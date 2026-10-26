import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { DotGateway, RpcError } from './gateway.mjs';

const same = (a, b) =>
  typeof a === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function createMcpServer({ token, ...options }) {
  if (typeof token !== 'string' || token.length < 32)
    throw new Error('A dedicated transport token is required.');
  const gateway = options.gateway ?? new DotGateway(options);
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(JSON.stringify(body));
    };
    let id = null;
    try {
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      if (
        !local ||
        !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(req.headers.host ?? '') ||
        req.headers.origin ||
        req.headers['sec-fetch-site'] === 'cross-site'
      ) {
        json(403, { error: 'Local transport only.' });
        return;
      }
      if (!same(req.headers.authorization, 'Bearer ' + token)) {
        res.setHeader('www-authenticate', 'Bearer');
        json(401, { error: 'Authentication required.' });
        return;
      }
      if (req.url === '/healthz' && req.method === 'GET') {
        const status = await gateway.call('qq_get_status', {});
        json(200, status);
        return;
      }
      if (req.url !== '/mcp') {
        json(404, { error: 'Not found.' });
        return;
      }
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        json(405, { error: 'Use JSON-RPC POST.' });
        return;
      }
      const version = req.headers['mcp-protocol-version'];
      if (version && !['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'].includes(version)) {
        json(400, { error: 'Unsupported MCP protocol version.' });
        return;
      }
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
        json(415, { error: 'JSON required.' });
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024) {
          json(413, { error: 'Request too large.' });
          return;
        }
        chunks.push(chunk);
      }
      let request;
      try {
        request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new RpcError(-32700, 'Parse error.');
      }
      if (
        !request ||
        Array.isArray(request) ||
        request.jsonrpc !== '2.0' ||
        typeof request.method !== 'string' ||
        (Object.hasOwn(request, 'id') &&
          typeof request.id !== 'string' &&
          typeof request.id !== 'number' &&
          request.id !== null)
      )
        throw new RpcError(-32600, 'Invalid request.');
      id = request.id ?? null;
      if (!Object.hasOwn(request, 'id')) {
        if (!request.method.startsWith('notifications/'))
          throw new RpcError(-32600, 'Only notifications may omit id.');
        res.writeHead(202);
        res.end();
        return;
      }
      const result = await gateway.rpc(request.method, request.params ?? {});
      json(200, { jsonrpc: '2.0', id, result });
    } catch (error) {
      json(200, {
        jsonrpc: '2.0',
        id,
        error: {
          code: error instanceof RpcError ? error.code : -32603,
          message: error instanceof RpcError ? error.message : 'Internal operation failed.',
          ...(error instanceof RpcError && error.data ? { data: error.data } : {}),
        },
      });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;
  return {
    server,
    gateway,
    async listen(port = 3112) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      gateway.start();
      return server.address();
    },
    async close() {
      await gateway.stop();
      server.closeIdleConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
