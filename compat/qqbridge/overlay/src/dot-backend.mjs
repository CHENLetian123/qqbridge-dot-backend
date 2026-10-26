// QQBridge Dot adapter, original code: Copyright (c) 2026 Slava Chan, MIT.
// Experimental, process-local state. This is a loopback bridge API, not an MCP server.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { decodeImage, MAX_IMAGE_BODY } from './dot-media.mjs';

export class DotError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = 'DotError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (code, message, status = 409) => { throw new DotError(code, message, status); };
const clone = value => structuredClone(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const MAX_RUNS = 2048;
const MAX_SENDS = 8192;

export function createDotBackend(options) { return new DotBackend(options); }

export class DotBackend {
  #enabled;
  #keys;
  #token;
  #hooks;
  #clock;
  #leaseMs;
  #epoch = randomUUID();
  #sessions = new Map();
  #runs = new Map();
  #claims = new Map();
  #sendCount = 0;
  #timer = null;

  constructor({ config = {}, token = '', hooks = {}, clock = Date.now } = {}) {
    this.#enabled = config.enabled === true;
    const keys = config.conversations ?? [];
    if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string' || !/^(group|private):[1-9]\d*$/.test(key))) {
      fail('INVALID_CONFIG', 'dot.conversations must contain canonical QQ conversation keys.', 400);
    }
    if (this.#enabled && (typeof token !== 'string' || token.length < 32 || token.length > 512)) {
      fail('INVALID_TOKEN', 'An independent Dot token of 32–512 characters is required.', 400);
    }
    this.#leaseMs = config.leaseMs ?? 120_000;
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs < 100 || this.#leaseMs > 900_000) {
      fail('INVALID_CONFIG', 'dot.leaseMs must be an integer from 100 to 900000.', 400);
    }
    if (typeof clock !== 'function') fail('INVALID_CONFIG', 'clock must be a function.', 400);
    this.#keys = new Set(this.#enabled ? keys : []);
    this.#token = token;
    this.#hooks = hooks;
    this.#clock = clock;
    for (const key of this.#keys) this.#sessions.set(key, {
      revision: 1, queued: null, active: null, observation: null, sends: new Map(), leaseFailures: 0, interrupted: false
    });
  }

  owns(key) { return this.#keys.has(key); }

  #session(key) {
    if (!this.owns(key)) fail('NOT_OWNED', 'This conversation is not assigned to Dot.', 403);
    return this.#sessions.get(key);
  }

  #allowed(key, action) {
    this.#session(key);
    this.#hooks.assertConversationAllowed(key, action);
  }

  #safeHook(name, ...args) {
    try { this.#hooks[name]?.(...args); }
    catch (error) { this.#hooks.log?.(`[dot] ${name} failed: ${this.#redact(error.message)}`); }
  }

  #redact(message) {
    let result = String(message || 'Dot adapter request failed.');
    if (this.#token) result = result.replaceAll(this.#token, '[redacted]');
    for (const run of this.#runs.values()) result = result.replaceAll(run.runToken, '[redacted]');
    return result.slice(0, 1000);
  }

  #publicRun(run) {
    return { key: run.key, runId: run.runId, runToken: run.runToken,
      generation: run.generation, expiresAt: run.expiresAt };
  }

  #publicSend(send) {
    return { sendId: send.sendId, status: send.status, text: send.text,
      ...(send.imageInfo ? { image: clone(send.imageInfo) } : {}),
      ...(send.replyToMessageId ? { replyToMessageId: send.replyToMessageId } : {}),
      ...(send.receipt ? { receipt: clone(send.receipt) } : {}),
      ...(send.error ? { error: clone(send.error) } : {}) };
  }

  #recoveryReceipts(run) {
    const sends = [...this.#session(run.key).sends.values()];
    return {
      uncertainSends: sends.filter(send => send.status === 'unknown').map(send => this.#publicSend(send)),
      previousSends: sends.filter(send => send.runId !== run.runId &&
        this.#runs.get(send.runId)?.status !== 'finished').map(send => this.#publicSend(send))
    };
  }

  #readState(key) {
    const state = this.#hooks.getReadState(key);
    if (!state || !integer(state.lastReadThroughSeq) || !integer(state.lastUnreadSeq) ||
        !Array.isArray(state.unreadSeqs) || state.unreadSeqs.some(seq => !integer(seq) || seq === 0)) {
      fail('INVALID_HOST_STATE', 'The bridge returned an invalid read state.', 500);
    }
    return state;
  }

  #visibleThrough(run) {
    const state = this.#readState(run.key);
    let through = run.baseThroughSeq;
    const seqs = [...new Set(state.unreadSeqs)].filter(seq => seq > through).sort((a, b) => a - b);
    for (const seq of seqs) {
      if (!run.seen.has(seq)) return through;
      through = seq;
    }
    // Old acknowledged/evicted messages are no longer pending, but never acknowledge
    // beyond something this run actually saw (or the initial acknowledged prefix).
    return Math.min(state.lastUnreadSeq, Math.max(through, run.maxSeen));
  }

  enqueueWake(key, reason) {
    this.#allowed(key, 'wake');
    const session = this.#session(key);
    if (!text(reason)) fail('INVALID_WAKE', 'A wake reason is required.', 400);
    if (!session.queued) session.queued = {
      wakeId: randomUUID(), key, reason: reason.slice(0, 250), createdAt: this.#clock()
    };
    session.observation = null;
    session.interrupted = false;
    return clone(session.queued);
  }

  #closeRun(run, status) {
    const session = this.#session(run.key);
    if (session.active?.runId !== run.runId) return;
    run.status = status;
    for (const send of session.sends.values()) {
      if (send.runId === run.runId && send.status === 'pending') {
        send.status = 'unknown';
        send.error = { code: 'RUN_ENDED_DURING_SEND', message: 'Delivery may have happened; do not retry automatically.' };
      }
    }
    session.active = null;
  }

  #expire(key) {
    const session = this.#session(key);
    const run = session.active;
    if (!run || this.#clock() < run.expiresAt) return false;
    this.#closeRun(run, 'expired');
    session.leaseFailures += 1;
    // Bounded recovery; subsequent real messages/admin wakes can still wake the session.
    if (session.leaseFailures <= 3) {
      try { this.enqueueWake(key, `leaseRetry:${run.reason}`); } catch { /* paused/revoked */ }
    }
    this.#safeHook('replayPendingWakes', key, 'expired');
    return true;
  }

  isBusy(key) {
    if (!this.owns(key)) return false;
    this.#expire(key);
    const session = this.#session(key);
    return Boolean(session.active || session.queued);
  }

  busyReason(key) {
    if (!this.owns(key)) return 'not-dot';
    this.#expire(key);
    const session = this.#session(key);
    return session.active ? 'dotRun' : session.queued ? 'dotQueued' : 'dotIdle';
  }

  listWakes() {
    const wakes = [];
    for (const key of this.#keys) {
      this.#expire(key);
      try { this.#allowed(key, 'wake'); } catch { continue; }
      const session = this.#session(key);
      if (session.queued && !session.active) wakes.push(clone(session.queued));
    }
    return { ok: true, wakes };
  }

  claim({ wakeId, claimId } = {}) {
    if (!text(wakeId) || !text(claimId) || claimId.length > 128) fail('INVALID_CLAIM', 'wakeId and claimId are required.', 400);
    const previous = this.#claims.get(claimId);
    if (previous) {
      if (previous.wakeId !== wakeId) fail('CLAIM_CONFLICT', 'claimId belongs to another wake.');
      const run = this.#getRun(previous.runId, previous.runToken);
      this.assertRun(run.key, run.runId, run.runToken);
      return { ok: true, run: this.#publicRun(run), context: clone(run.context),
        readThroughSeq: this.#visibleThrough(run), ...this.#recoveryReceipts(run), deduplicated: true };
    }
    const entry = [...this.#sessions.entries()].find(([, session]) => session.queued?.wakeId === wakeId);
    if (!entry) fail('WAKE_NOT_FOUND', 'This wake no longer exists.', 404);
    const [key, session] = entry;
    this.#allowed(key, 'context');
    this.#expire(key);
    if (session.active) fail('RUN_BUSY', 'This conversation already has an active run.');
    if (session.queued?.wakeId !== wakeId) fail('WAKE_NOT_FOUND', 'This wake was replaced.', 404);
    if (this.#runs.size >= MAX_RUNS) fail('CAPACITY_REACHED', 'The experimental in-memory run ledger is full.', 503);
    const state = this.#readState(key);
    const context = this.#hooks.buildContext(key, session.queued.reason);
    const run = { key, runId: randomUUID(), runToken: randomBytes(24).toString('hex'),
      generation: `${this.#epoch}:${session.revision}`, revision: session.revision,
      expiresAt: this.#clock() + this.#leaseMs, status: 'active', reason: session.queued.reason,
      baseThroughSeq: state.lastReadThroughSeq, maxSeen: state.lastReadThroughSeq, seen: new Set(), context,
      completion: null };
    session.active = run;
    session.queued = null;
    session.observation = null;
    this.#runs.set(run.runId, run);
    this.#claims.set(claimId, { wakeId, runId: run.runId, runToken: run.runToken });
    return { ok: true, run: this.#publicRun(run), context: clone(context), readThroughSeq: state.lastReadThroughSeq,
      ...this.#recoveryReceipts(run) };
  }

  #getRun(runId, runToken) {
    const run = this.#runs.get(runId);
    if (!run || !equal(run.runToken, runToken)) fail('INVALID_RUN_TOKEN', 'Unknown run or invalid run token.', 403);
    if (this.#session(run.key).revision !== run.revision) fail('STALE_GENERATION', 'This conversation was reset.', 410);
    return run;
  }

  assertRun(key, runId, runToken) {
    const run = this.#getRun(runId, runToken);
    if (run.key !== key) fail('RUN_SCOPE_MISMATCH', 'The run belongs to another conversation.', 403);
    this.#allowed(key, 'wake');
    this.#expire(key);
    if (run.status !== 'active' || this.#session(key).active?.runId !== runId) {
      fail('STALE_RUN', 'This run has ended or expired.', 410);
    }
    return this.#publicRun(run);
  }

  captureSendGuard(key, runId, runToken) {
    const current = this.#session(key).active;
    const id = runId ?? current?.runId;
    const token = runToken ?? current?.runToken;
    this.assertRun(key, id, token);
    return () => {
      this.assertRun(key, id, token);
      this.#allowed(key, 'send');
    };
  }

  read(runId, { runToken, afterSeq = 0, limit = 30 } = {}) {
    const run = this.#getRun(runId, runToken);
    this.assertRun(run.key, runId, runToken);
    this.#allowed(run.key, 'read');
    if (!integer(afterSeq) || afterSeq > this.#visibleThrough(run)) fail('INVALID_CURSOR', 'Do not skip unread messages.', 400);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_LIMIT', 'limit must be from 1 to 100.', 400);
    const result = this.#hooks.readUnread(run.key, afterSeq, limit);
    if (!Array.isArray(result?.messages)) fail('INVALID_HOST_STATE', 'The bridge returned an invalid message page.', 500);
    for (const message of result.messages) if (integer(message.seq) && message.seq > 0) {
      run.seen.add(message.seq);
      run.maxSeen = Math.max(run.maxSeen, message.seq);
    }
    const state = this.#readState(run.key);
    return { ok: true, messages: clone(result.messages), readThroughSeq: this.#visibleThrough(run), unreadCount: state.unreadSeqs.length };
  }

  async image(runId, { runToken, messageSeq, imageIndex = 0 } = {}) {
    const run = this.#getRun(runId, runToken);
    this.assertRun(run.key, runId, runToken);
    this.#allowed(run.key, 'image');
    if (!integer(messageSeq) || !run.seen.has(messageSeq)) fail('IMAGE_NOT_READ', 'Read the message in this run before accessing its image.', 403);
    if (!integer(imageIndex) || imageIndex > 31) fail('INVALID_IMAGE_INDEX', 'Use an imageIndex from 0 to 31.', 400);
    const image = await this.#hooks.readImage(run.key, { messageSeq, imageIndex });
    this.assertRun(run.key, runId, runToken);
    this.#allowed(run.key, 'image');
    let decoded;
    try { decoded = decodeImage(image); }
    catch { fail('INVALID_IMAGE', 'The message image is unavailable or exceeds supported raster limits.', 422); }
    return { ok: true, messageSeq, imageIndex, image: { ...decoded.info, data: decoded.buffer.toString('base64') } };
  }

  async send(runId, { runToken, sendId, text: rawText, image, replyToMessageId } = {}) {
    const run = this.#getRun(runId, runToken);
    const session = this.#session(run.key);
    if (!text(sendId) || sendId.length > 128 || (image ? rawText != null : !text(rawText) || rawText.length > 4096)) {
      fail('INVALID_SEND', 'sendId and a bounded nonempty text are required.', 400);
    }
    if (!image && (rawText.includes(this.#token) || [...this.#runs.values()].some(item => rawText.includes(item.runToken)))) {
      fail('CREDENTIAL_IN_MESSAGE', 'The message contains a bridge credential.', 403);
    }
    if (replyToMessageId != null && (typeof replyToMessageId !== 'string' || !/^-?[1-9]\d*$/.test(replyToMessageId))) {
      fail('INVALID_REPLY_ID', 'replyToMessageId must be a nonzero integer string.', 400);
    }
    let imageData, imageMetadata;
    if (image) {
      try { const decoded = decodeImage(image); imageData = { mimeType: decoded.info.mimeType, data: decoded.buffer.toString('base64') }; imageMetadata = decoded.info; }
      catch { fail('INVALID_IMAGE', 'Only bounded PNG, JPEG, GIF and WebP image bytes are accepted.', 422); }
    }
    const body = { text: image ? '' : rawText.trim(), ...(imageMetadata ? { imageInfo: imageMetadata } : {}), replyToMessageId: replyToMessageId ?? null };
    const fingerprint = JSON.stringify(body);
    const existing = session.sends.get(sendId);
    if (existing) {
      this.#allowed(run.key, 'send');
      if (existing.fingerprint !== fingerprint) fail('SEND_ID_CONFLICT', 'sendId was already used for a different message.');
      if (existing.promise) await existing.promise;
      return { ok: true, send: this.#publicSend(existing), deduplicated: true };
    }
    this.assertRun(run.key, runId, runToken);
    this.#allowed(run.key, 'send');
    if ([...session.sends.values()].some(item => item.status === 'unknown')) {
      fail('SEND_RECONCILIATION_REQUIRED', 'An earlier send has an unknown outcome; a new send must wait for reconciliation.');
    }
    if (this.#sendCount >= MAX_SENDS) fail('CAPACITY_REACHED', 'The experimental in-memory send ledger is full.', 503);
    const send = { sendId, runId, fingerprint, ...body, status: 'pending', receipt: null, error: null, promise: null };
    session.sends.set(sendId, send);
    this.#sendCount += 1;
    send.promise = Promise.resolve().then(async () => {
      try {
        const receipt = await this.#hooks.sendText(run.key, { ...body, ...(imageData ? { image: imageData } : {}), runId, runToken, sendId });
        if (receipt?.sent !== 1) throw new DotError('UNCONFIRMED_SEND', 'The bridge did not confirm one complete send.', 502);
        // A late network receipt is useful evidence, but it must not mutate a replacement run.
        send.status = 'confirmed';
        send.receipt = clone(receipt);
        send.error = null;
      } catch (error) {
        const definitelyRejected = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500;
        send.status = definitelyRejected ? 'rejected' : 'unknown';
        send.error = { code: error.code || (definitelyRejected ? 'SEND_REJECTED' : 'SEND_UNKNOWN'), message: this.#redact(error.message) };
      }
    }).finally(() => { send.promise = null; });
    await send.promise;
    return { ok: true, send: this.#publicSend(send), deduplicated: false };
  }

  finish(runId, { runToken, throughSeq, outcome } = {}) {
    const run = this.#getRun(runId, runToken);
    this.#allowed(run.key, 'finish');
    if (run.completion) {
      if (run.completion.throughSeq !== throughSeq || run.completion.outcome !== outcome) {
        fail('COMPLETION_CONFLICT', 'This run was already finished with different parameters.');
      }
      return { ok: true, completion: clone(run.completion), observation: clone(run.observationAtFinish), deduplicated: true };
    }
    this.assertRun(run.key, runId, runToken);
    if (!integer(throughSeq) || throughSeq < run.baseThroughSeq || throughSeq > this.#visibleThrough(run)) {
      fail('INVALID_WATERMARK', 'throughSeq must be explicit and no greater than this run has read.', 400);
    }
    if (!['silent', 'replied'].includes(outcome)) fail('INVALID_OUTCOME', 'outcome must be silent or replied.', 400);
    const session = this.#session(run.key);
    const sends = [...session.sends.values()].filter(send => send.runId === runId);
    if ([...session.sends.values()].some(send => send.runId !== runId && send.status === 'unknown')) {
      fail('SEND_RECONCILIATION_REQUIRED', 'An earlier unknown send must be reconciled before acknowledging more messages.');
    }
    if (sends.some(send => send.promise || ['pending', 'unknown'].includes(send.status))) {
      fail('UNRESOLVED_SEND', 'An in-flight or uncertain send cannot be completed as success.');
    }
    const confirmed = sends.filter(send => send.status === 'confirmed').length;
    if (outcome === 'replied' && confirmed === 0) fail('REPLY_NOT_CONFIRMED', 'No confirmed reply exists in this run.');
    if (outcome === 'silent' && confirmed !== 0) fail('SILENT_SEND_CONFLICT', 'A confirmed reply cannot be declared silent.');
    this.#hooks.acknowledgeThrough(run.key, throughSeq);
    run.completion = { runId, key: run.key, generation: run.generation, throughSeq, outcome, status: 'finished' };
    this.#closeRun(run, 'finished');
    session.leaseFailures = 0;
    session.observation = { state: 'observing', startedAt: this.#clock() };
    this.#checkObservation(run.key);
    run.observationAtFinish = clone(session.observation);
    this.#safeHook('replayPendingWakes', run.key, 'finished');
    if (this.#readState(run.key).unreadSeqs.some(seq => seq > throughSeq)) {
      this.#safeHook('requestWake', run.key, 'dotPending');
    }
    return { ok: true, completion: clone(run.completion), observation: clone(run.observationAtFinish) };
  }

  #checkObservation(key) {
    const session = this.#session(key);
    if (session.observation?.state !== 'observing' || session.active || session.queued) return;
    try {
      this.#allowed(key, 'observe');
      const observation = this.#hooks.inspectObservation(key);
      if (observation.blocked) {
        session.observation.remainingMs = Math.max(0, Number(observation.remainingMs) || 0);
        return;
      }
      this.#hooks.restoreWakeTimers(key);
      session.observation = { state: 'settled', completedAt: this.#clock() };
    } catch { /* Pause/revocation does not grant sleep or erase the observation requirement. */ }
  }

  onIncoming(key) {
    if (!this.owns(key)) return;
    const session = this.#session(key);
    if (session.observation?.state === 'observing') {
      // The bridge's normal batching/allowlist/rate checks still decide when to enqueue.
      this.#safeHook('requestWake', key, 'dotObservation');
    }
  }

  invalidate(key, reason = 'reset') {
    if (!this.owns(key)) return;
    const session = this.#session(key);
    session.interrupted ||= Boolean(session.active || session.queued || session.observation?.state === 'observing');
    if (session.active) this.#closeRun(session.active, 'invalidated');
    session.revision += 1;
    session.queued = null;
    session.observation = null;
    this.#hooks.log?.(`[dot] invalidated ${key}: ${this.#redact(reason)}`);
  }

  resume(key) {
    if (!this.owns(key)) return false;
    try {
      this.#allowed(key, 'wake');
      if (this.isBusy(key)) return false;
      const session = this.#session(key);
      if (!session.interrupted && this.#readState(key).unreadSeqs.length === 0) return false;
      // Keep the interrupted marker until the normal batching/rate gate really enqueues.
      this.#hooks.requestWake(key, 'bootstrap');
      return true;
    } catch { return false; }
  }

  tick() {
    for (const key of this.#keys) {
      this.#expire(key);
      this.#checkObservation(key);
    }
  }

  start() {
    if (!this.#enabled || this.#timer) return;
    this.#timer = setInterval(() => this.tick(), Math.max(25, Math.min(1000, Math.floor(this.#leaseMs / 4))));
    this.#timer.unref?.();
  }

  close() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const key of this.#keys) this.invalidate(key, 'shutdown');
  }

  async handleHttp({ req, res, url, readBody, sendJson, boundPort }) {
    try {
      if (!this.#enabled) fail('DOT_DISABLED', 'Dot integration is disabled.', 404);
      const remote = req.socket?.remoteAddress;
      if (remote && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
        fail('LOOPBACK_ONLY', 'This API accepts loopback clients only.', 403);
      }
      if (!equal(req.headers.authorization, `Bearer ${this.#token}`)) fail('UNAUTHORIZED', 'A valid Dot Bearer token is required.', 401);
      if (req.headers.origin) {
        const origins = [`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`, `http://[::1]:${boundPort}`];
        if (!origins.includes(req.headers.origin)) fail('ORIGIN_DENIED', 'Cross-origin requests are not allowed.', 403);
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') fail('ORIGIN_DENIED', 'Cross-site requests are not allowed.', 403);
      const prefix = '/api/dot/v1';
      if (req.method === 'GET' && url.pathname === `${prefix}/health`) {
        sendJson({ ok: true, protocolVersion: 1, storage: 'memory', conversations: this.#keys.size, instanceId: this.#epoch });
        return;
      }
      if (req.method === 'GET' && url.pathname === `${prefix}/wakes`) { sendJson(this.listWakes()); return; }
      if (req.method !== 'POST') fail('NOT_FOUND', 'Unknown Dot route.', 404);
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
        fail('JSON_REQUIRED', 'Use Content-Type: application/json.', 415);
      }
      const maxBody = /\/runs\/[a-f0-9-]+\/send$/.test(url.pathname) ? MAX_IMAGE_BODY : 65_536;
      if (Number(req.headers['content-length']) > maxBody) fail('BODY_TOO_LARGE', 'Request body exceeds the operation limit.', 413);
      const body = await readBody(maxBody);
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INVALID_BODY', 'A JSON object is required.', 400);
      if (Buffer.byteLength(JSON.stringify(body)) > maxBody) fail('BODY_TOO_LARGE', 'Request body exceeds 64 KiB.', 413);
      if (url.pathname === `${prefix}/runs/claim`) { sendJson(this.claim(body)); return; }
      const match = /^\/api\/dot\/v1\/runs\/([a-f0-9-]+)\/(read|image|send|finish)$/.exec(url.pathname);
      if (!match) fail('NOT_FOUND', 'Unknown Dot route.', 404);
      const [, runId, operation] = match;
      sendJson(await this[operation](runId, body));
    } catch (error) {
      if (res.writableEnded) return;
      sendJson({ ok: false, error: { code: error.code || 'BRIDGE_REJECTED', message: this.#redact(error.message) } }, error.statusCode || 500);
    }
  }
}
