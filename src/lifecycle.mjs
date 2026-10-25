/**
 * Offline lifecycle experiment: no network, QQ SDK, MCP server, or persistence.
 * An in-memory reservation cannot guarantee exactly-once external delivery.
 */
export class LifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LifecycleError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new LifecycleError(code, message); };
const copy = value => structuredClone(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export class Lifecycle {
  #sessions = new Map();
  #clock;
  #leaseMs;
  #nextRun = 0;

  constructor({ clock = Date.now, leaseMs = 60_000 } = {}) {
    if (typeof clock !== 'function' || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
      fail('INVALID_CONFIG', 'clock must be a function and leaseMs a positive integer.');
    }
    this.#clock = clock;
    this.#leaseMs = leaseMs;
  }

  #session(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (!session) fail('NOT_BOUND', 'Bind this session before using it.');
    return session;
  }

  #now() {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0) fail('INVALID_CLOCK', 'clock must return nonnegative integer milliseconds.');
    return now;
  }

  #matches(session, token) {
    return Boolean(session.activeRun && session.generation === token?.generation &&
      session.activeRun.runId === token?.runId);
  }

  #close(session, status) {
    const run = session.activeRun;
    for (const send of session.sends.values()) {
      if (send.runId === run.runId && send.state === 'reserved') {
        send.state = 'unknown';
        send.receipt = { status: 'unknown', reason: status };
      }
    }
    session.lastRun = { ...run, status };
    session.activeRun = null;
  }

  #live(token) {
    const session = this.#session(token?.sessionId);
    if (session.generation !== token.generation) fail('STALE_GENERATION', 'The session has been rebound.');
    if (!this.#matches(session, token)) fail('STALE_RUN', 'This run is no longer active.');
    // Compare the run fence before touching state: a late old run cannot expire a new run.
    if (this.#now() >= session.activeRun.expiresAt) {
      this.#close(session, 'lease_expired');
      fail('LEASE_EXPIRED', 'This run lease has expired.');
    }
    return session;
  }

  /** Rebinding preserves the queue and send records, but invalidates the old run. */
  bind(sessionId) {
    if (!nonempty(sessionId)) fail('INVALID_SESSION', 'sessionId must be a nonempty string.');
    let session = this.#sessions.get(sessionId);
    if (!session) {
      session = { sessionId, generation: 0, latestSeq: 0, completedThroughSeq: 0,
        messages: [], sends: new Map(), completions: new Map(), activeRun: null, lastRun: null };
      this.#sessions.set(sessionId, session);
    }
    if (session.activeRun) this.#close(session, 'binding_changed');
    session.generation += 1;
    session.completions.clear();
    return { sessionId, generation: session.generation };
  }

  appendMessage(sessionId, text) {
    const session = this.#session(sessionId);
    if (!nonempty(text)) fail('INVALID_MESSAGE', 'text must be a nonempty string.');
    const message = { seq: ++session.latestSeq, text };
    session.messages.push(message);
    return copy(message);
  }

  beginRun(sessionId) {
    const session = this.#session(sessionId);
    const now = this.#now();
    if (session.activeRun && now >= session.activeRun.expiresAt) this.#close(session, 'lease_expired');
    if (session.activeRun) fail('RUN_BUSY', 'Only one run may be active per session.');
    if (session.completedThroughSeq === session.latestSeq) fail('NO_PENDING_MESSAGES', 'No pending messages.');
    const token = { sessionId, generation: session.generation, runId: `run-${++this.#nextRun}` };
    session.activeRun = { ...token, expiresAt: now + this.#leaseMs,
      readThroughSeq: session.completedThroughSeq, deliveryAcknowledged: false };
    return copy(token);
  }

  /** Models webhook HTTP 2xx receipt only; it does not finish a run. */
  acknowledgeDelivery(token) {
    const session = this.#live(token);
    session.activeRun.deliveryAcknowledged = true;
    return copy(session.activeRun);
  }

  readMessages(token, { limit = 100 } = {}) {
    const session = this.#live(token);
    if (!Number.isSafeInteger(limit) || limit <= 0) fail('INVALID_LIMIT', 'limit must be a positive integer.');
    const run = session.activeRun;
    const messages = session.messages.filter(message => message.seq > run.readThroughSeq).slice(0, limit);
    if (messages.length) run.readThroughSeq = messages.at(-1).seq;
    return { messages: copy(messages), readThroughSeq: run.readThroughSeq };
  }

  /** The caller may dispatch only when this newly created reservation says so. */
  reserveSend(token, { sendId, text } = {}) {
    const session = this.#live(token);
    if (!nonempty(sendId) || !nonempty(text)) fail('INVALID_SEND', 'sendId and text must be nonempty strings.');
    const existing = session.sends.get(sendId);
    if (existing) {
      if (existing.text !== text) fail('SEND_ID_CONFLICT', 'sendId is already associated with different text.');
      return { ...copy(existing), shouldDispatch: false };
    }
    const send = { sendId, text, generation: token.generation, runId: token.runId,
      state: 'reserved', receipt: null };
    session.sends.set(sendId, send);
    return { ...copy(send), shouldDispatch: true };
  }

  /** Unknown is terminal here: operator reconciliation is outside this experiment. */
  recordSendReceipt(token, { sendId, status, receiptId, reason } = {}) {
    const session = this.#live(token);
    const send = session.sends.get(sendId);
    if (!send) fail('SEND_NOT_RESERVED', 'Reserve a send before recording its receipt.');
    if (send.generation !== token.generation || send.runId !== token.runId) {
      fail('SEND_OWNER_MISMATCH', 'Only the reserving run may record this receipt.');
    }
    let receipt;
    if (status === 'confirmed' && nonempty(receiptId)) receipt = { status, receiptId };
    else if (status === 'unknown' && nonempty(reason)) receipt = { status, reason };
    else fail('INVALID_RECEIPT', 'Use confirmed with receiptId, or unknown with reason.');
    if (send.state !== 'reserved') {
      if (JSON.stringify(send.receipt) !== JSON.stringify(receipt)) {
        fail('RECEIPT_CONFLICT', 'A terminal receipt cannot be overwritten or retried automatically.');
      }
      return copy(send);
    }
    send.state = status;
    send.receipt = receipt;
    return copy(send);
  }

  /** Explicit completion, independent of delivery ACKs and individual send receipts. */
  finish(token, { throughSeq, outcome } = {}) {
    const session = this.#session(token?.sessionId);
    if (session.generation !== token.generation) fail('STALE_GENERATION', 'The session has been rebound.');
    const completed = session.completions.get(token.runId);
    if (completed) {
      if (completed.throughSeq !== throughSeq || completed.outcome !== outcome) {
        fail('COMPLETION_CONFLICT', 'A completed run cannot be finished with different parameters.');
      }
      // Replay the small immutable receipt, without inspecting or changing a newer active run.
      return copy(completed);
    }
    this.#live(token);
    const run = session.activeRun;
    if (!Number.isSafeInteger(throughSeq) || throughSeq < session.completedThroughSeq ||
        throughSeq > run.readThroughSeq) {
      fail('INVALID_WATERMARK', 'throughSeq must be explicit, monotonic, and no greater than readThroughSeq.');
    }
    if (outcome !== 'replied' && outcome !== 'silent') fail('INVALID_OUTCOME', 'outcome must be replied or silent.');
    const sends = [...session.sends.values()].filter(send => send.runId === token.runId);
    if (sends.some(send => send.state !== 'confirmed')) {
      fail('UNRESOLVED_SEND', 'Reserved or unknown sends require expiry or reconciliation, not successful completion.');
    }
    if (outcome === 'replied' && sends.length === 0) {
      fail('REPLY_NOT_CONFIRMED', 'replied requires a confirmed send from this run.');
    }
    if (outcome === 'silent' && sends.length !== 0) {
      fail('SILENT_SEND_CONFLICT', 'silent cannot conceal a send from this run.');
    }
    const receipt = { sessionId: token.sessionId, generation: token.generation,
      runId: token.runId, throughSeq, outcome, status: 'finished' };
    run.outcome = outcome;
    run.throughSeq = throughSeq;
    session.completedThroughSeq = throughSeq;
    this.#close(session, 'finished');
    session.completions.set(token.runId, receipt);
    return copy(receipt);
  }

  /** Safe for delayed watchdog callbacks: an old token never clears a replacement run. */
  expireLease(token) {
    const session = this.#session(token?.sessionId);
    if (!this.#matches(session, token) || this.#now() < session.activeRun.expiresAt) return false;
    this.#close(session, 'lease_expired');
    return true;
  }

  snapshot(sessionId) {
    const session = this.#session(sessionId);
    return copy({ sessionId, generation: session.generation, latestSeq: session.latestSeq,
      completedThroughSeq: session.completedThroughSeq,
      pendingMessages: session.messages.filter(message => message.seq > session.completedThroughSeq),
      activeRun: session.activeRun, lastRun: session.lastRun, sends: [...session.sends.values()] });
  }
}
