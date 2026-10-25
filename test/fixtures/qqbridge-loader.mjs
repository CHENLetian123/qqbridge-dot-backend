// Used only by the child process in the upstream component integration tests.
import { registerHooks } from 'node:module';
import http from 'node:http';

if (process.env.QQBRIDGE_COMPONENT_FIXTURE !== '1' || !process.send) {
  throw new Error('This loader is restricted to the integration-test child process.');
}

const replacements = new Map([
  ['@snowluma/sdk', new URL('./mock-snowluma.mjs', import.meta.url).href],
  ['js-yaml', new URL('./mock-yaml.mjs', import.meta.url).href],
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    let url = replacements.get(specifier);
    if (specifier === './dsh-client.js' && context.parentURL?.endsWith('/src/bridge.js')) {
      url = new URL('./mock-dsh.mjs', import.meta.url).href;
    }
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  }
});

// Observe the real HTTP listener, including the ephemeral port selected by Node.
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  this.once('listening', () => {
    const address = this.address();
    if (address && typeof address === 'object') {
      process.send?.({ fixtureEvent: 'listening', address: address.address, port: address.port });
    }
  });
  return originalListen.apply(this, args);
};

// Prevent a mistaken fixture URL from contacting any real external service.
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw new Error('Integration fixtures permit only HTTP loopback fetches.');
  }
  return originalFetch(input, options);
};
