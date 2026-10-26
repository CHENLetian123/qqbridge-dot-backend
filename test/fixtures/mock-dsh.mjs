// Test boundary only. Controlled DSH availability and IPC call receipts.
let online = process.env.QQBRIDGE_FIXTURE_DSH_ONLINE === '1';
let configuredMode = 'reserved2';
let sessionCounter = 0;
const frameQueue = [];
let wakeFrame;
const ok = value => ({ result: { ok: true, value } });
const report = (method, params) => process.send?.({ fixtureEvent: 'dsh', method, params });
const requireOnline = () => { if (!online) throw new Error('Fixture DSH is offline.'); };

process.on('message', message => {
  if (message?.fixtureOp === 'dsh-online') {
    online = message.online === true;
    process.send?.({ fixtureReply: message.requestId, value: { online } });
  } else if (message?.fixtureOp === 'dsh-frame') {
    frameQueue.push({ payload: message.frame });
    wakeFrame?.();
    process.send?.({ fixtureReply: message.requestId, value: { queued: true } });
  }
});

export function unwrap(response, label = 'fixture') {
  if (response?.result?.ok !== true) throw new Error(`${label}: malformed fixture result`);
  return response.result.value;
}
export const discoverDshLaunchToken = () => '';
export function createTurnCollector() {
  let text = '';
  return { push(event) {
    if (event.type === 'assistant/message') text += event.data?.text ?? '';
    return event.type === 'turn/end' ? { text, messages: [] } : null;
  } };
}

export class NodeApiClient {
  constructor() {
    report('client.construct', {});
    this.settings = {
      describe: async () => {
        requireOnline();
        return ok({ namespaces: [
          { ns: 'qq-mode', user: { mode: configuredMode } },
          { ns: 'agent-presets', value: { default: 'qq-chat' } }
        ] });
      },
      update: async params => {
        requireOnline();
        if (params.ns === 'qq-mode' && typeof params.patch?.mode === 'string') {
          configuredMode = params.patch.mode;
        }
        report('settings.update', params);
        return ok({});
      }
    };
    this.agentPresets = { list: async () => { requireOnline(); return ok({ presets: [{ id: 'qq-chat' }, { id: 'qq-chat-v2' }] }); } };
    this.workspace = {
      create: async params => { requireOnline(); report('workspace.create', params); return ok({ created: true, workspace: { workspaceId: 'fixture-workspace' } }); },
      rename: async () => ok({}),
      archiveSession: async params => { report('workspace.archiveSession', params); return ok({}); }
    };
    this.sessions = {
      create: async params => { requireOnline(); const sessionId = `fixture-dsh-${++sessionCounter}`; report('sessions.create', { ...params, sessionId }); return ok({ sessionId }); },
      selectModel: async params => { requireOnline(); report('sessions.selectModel', params); return ok({ selected: params }); },
      prompt: async params => { requireOnline(); report('sessions.prompt', params); return ok({}); },
      list: async () => ok({ items: [] })
    };
    this.events = {
      follow: sessionId => report('events.follow', { sessionId }),
      forget: sessionId => report('events.forget', { sessionId }),
      mux: async function* () {
        report('events.mux', { online });
        requireOnline();
        for (;;) {
          if (!frameQueue.length) await new Promise(resolve => { wakeFrame = resolve; });
          wakeFrame = null;
          while (frameQueue.length) yield frameQueue.shift();
        }
      }
    };
  }
  async callUnary(method, params) { requireOnline(); report(method, params); return ok({ models: [] }); }
  async stopSessionWork(sessionId) { report('stopSessionWork', { sessionId }); return ok({}); }
  async respond(params) { requireOnline(); report('respond', params); return ok({}); }
}
