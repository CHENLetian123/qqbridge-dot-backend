/** Client for the experimental, authenticated QQBridge loopback API.
 * Does not retry writes. Callers must retain claimId/sendId when retrying.
 */
export class QQBridgeClientError extends Error {
  constructor(code, message, status, options) {
    super(message, options);
    this.name = 'QQBridgeClientError';
    this.code = code;
    this.status = status;
  }
}

export class QQBridgeClient {
  #origin;
  #token;
  #timeoutMs;
  #fetch;

  constructor({ baseUrl = 'http://127.0.0.1:3100', token, timeoutMs = 30_000, fetchImpl = globalThis.fetch } = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new QQBridgeClientError('INVALID_BASE_URL', 'Use an HTTP loopback origin without credentials, path, query, or fragment.');
    }
    if (typeof token !== 'string' || token.length < 32 || token.length > 512) {
      throw new QQBridgeClientError('INVALID_TOKEN', 'A Dot token of 32–512 characters is required.');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000 || typeof fetchImpl !== 'function') {
      throw new QQBridgeClientError('INVALID_OPTIONS', 'Invalid timeout or fetch implementation.');
    }
    // Avoid a custom hosts-file entry turning localhost into a token-bearing remote request.
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    this.#origin = url.origin;
    this.#token = token;
    this.#timeoutMs = timeoutMs;
    this.#fetch = fetchImpl;
  }

  async #request(path, body) {
    let response;
    try {
      response = await this.#fetch(`${this.#origin}/api/dot/v1${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${this.#token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#timeoutMs), redirect: 'error'
      });
    } catch {
      throw new QQBridgeClientError('TRANSPORT_UNKNOWN', 'The bridge response was not received; a write may already have happened. Do not invent a new idempotency ID.');
    }
    let result;
    try { result = await response.json(); }
    catch { throw new QQBridgeClientError('INVALID_RESPONSE', 'The bridge did not return JSON; a write outcome may be unknown.', response.status); }
    if (!response.ok || result?.ok !== true) {
      const code = typeof result?.error?.code === 'string' ? result.error.code : 'BRIDGE_REJECTED';
      const message = typeof result?.error?.message === 'string' ? result.error.message : 'The bridge rejected the request.';
      throw new QQBridgeClientError(code, message.replaceAll(this.#token, '[redacted]'), response.status);
    }
    return result;
  }

  #runRequest(operation, run, body) {
    if (!run || typeof run.runId !== 'string' || !/^[a-f0-9-]+$/.test(run.runId) || typeof run.runToken !== 'string') {
      throw new QQBridgeClientError('INVALID_RUN', 'Use the run identity returned by claim().');
    }
    return this.#request(`/runs/${run.runId}/${operation}`, { ...body, runToken: run.runToken });
  }

  health() { return this.#request('/health'); }
  listWakes() { return this.#request('/wakes'); }
  claim({ wakeId, claimId }) { return this.#request('/runs/claim', { wakeId, claimId }); }
  read(run, { afterSeq = 0, limit = 30 } = {}) { return this.#runRequest('read', run, { afterSeq, limit }); }
  send(run, { sendId, text, replyToMessageId } = {}) {
    return this.#runRequest('send', run, { sendId, text, ...(replyToMessageId == null ? {} : { replyToMessageId }) });
  }
  finish(run, { throughSeq, outcome } = {}) { return this.#runRequest('finish', run, { throughSeq, outcome }); }
}
