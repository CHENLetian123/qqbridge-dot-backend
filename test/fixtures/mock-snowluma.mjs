// Test boundary only. No QQ client or SnowLuma installation is accessed.
import { EventEmitter } from 'node:events';
import { PNG } from './image.mjs';

const report = value => process.send?.({ fixtureEvent: 'sdk', ...value });
let client;
let nextMessageId = 900_000;

process.on('message', async message => {
  if (message?.fixtureOp !== 'qq-message') return;
  try {
    if (!client) throw new Error('Mock SnowLuma client is not initialized.');
    const event = message.event;
    await client.eventHandler?.(event);
    const handler = event.message_type === 'private' ? client.privateHandler : client.groupHandler;
    if (!handler) throw new Error('QQ message handler is not registered.');
    await handler(event);
    process.send?.({ fixtureReply: message.requestId, value: { accepted: true } });
  } catch (error) {
    process.send?.({ fixtureReply: message.requestId, error: String(error?.stack ?? error) });
  }
});

export const text = value => [{ type: 'text', data: { text: String(value) } }];

export class SnowLumaWebSocketClient extends EventEmitter {
  constructor(options) {
    super();
    this.url = options.url;
    this.accessToken = options.accessToken;
    client = this;
  }
  onPrivateMessage(handler) { this.privateHandler = handler; }
  onGroupMessage(handler) { this.groupHandler = handler; }
  onEvent(handler) { this.eventHandler = handler; }
  onNotice() {}
  onBotStatus() {}
  async connect() { queueMicrotask(() => this.emit('open')); }
  close() {}
  async getLoginInfo() { return { user_id: 999_999, nickname: 'FixtureDot' }; }
  async getGroupMemberInfo(groupId, userId) { return { group_id: groupId, user_id: userId, nickname: `fixture-${userId}` }; }
  async getGroupMemberList() { return []; }
  async getImage({ file }) {
    report({ action: 'get_image', params: { file } });
    if (file !== 'fixture-image.png') throw new Error('Image not found in fixture cache.');
    return { base64: PNG };
  }
  async sendGroupMessage(groupId, message) {
    const result = { message_id: ++nextMessageId };
    report({ action: 'send_group_msg', params: { group_id: groupId, message }, result });
    return result;
  }
  async sendPrivateMessage(userId, message) {
    const result = { message_id: ++nextMessageId };
    report({ action: 'send_private_msg', params: { user_id: userId, message }, result });
    return result;
  }
  async request(action) { throw new Error(`Unexpected mocked SDK request: ${action}`); }
  async raw(action) { throw new Error(`Unexpected mocked SDK raw request: ${action}`); }
}
