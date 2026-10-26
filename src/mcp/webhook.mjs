import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Webhook } from 'standardwebhooks';

const blocked = new net.BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
])
  blocked.addSubnet(ip, bits, 'ipv4');
const global6 = new net.BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, bits] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
])
  blocked.addSubnet(ip, bits, 'ipv6');
export const publicAddress = (ip) =>
  net.isIP(ip) === 4
    ? !blocked.check(ip, 'ipv4')
    : net.isIP(ip) === 6 && global6.check(ip, 'ipv6') && !blocked.check(ip, 'ipv6');

export function callbackUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalid_callback_url');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    raw.length > 4096 ||
    (url.port && url.port !== '443')
  )
    throw new Error('invalid_callback_url');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host.endsWith('.local') ||
    host.endsWith('.localhost') ||
    host === 'localhost' ||
    (net.isIP(host) && !publicAddress(host))
  )
    throw new Error('blocked_address');
  return url;
}

// TUN proxies can synthesize 198.18/15 answers. Never connect to those IPs or
// exempt them from SSRF checks: resolve the hostname over authenticated HTTPS,
// validate the real answers, then pin the selected public address as usual.
const synthetic = new net.BlockList();
synthetic.addSubnet('198.18.0.0', 15, 'ipv4');
export async function publicDnsAnswers(
  hostname,
  { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {},
) {
  const url = new URL('https://cloudflare-dns.com/dns-query');
  url.searchParams.set('name', hostname);
  url.searchParams.set('type', 'A');
  const response = await fetchImpl(url, {
    headers: { accept: 'application/dns-json' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error('dns_lookup_failed');
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 16384) throw new Error('dns_lookup_failed');
    chunks.push(Buffer.from(chunk));
  }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (result.Status !== 0 || !Array.isArray(result.Answer)) throw new Error('dns_lookup_failed');
  return result.Answer.filter((row) => row.type === 1).map((row) => ({
    address: row.data,
    family: 4,
  }));
}

export async function callbackAddresses(
  hostname,
  { lookup = dns.lookup, resolvePublic = publicDnsAnswers, timeoutMs = 8000 } = {},
) {
  let dnsTimer;
  const addresses = await Promise.race([
    (async () => {
      let rows = await lookup(hostname, { all: true, verbatim: true, family: 0 });
      if (
        rows.length &&
        rows.every((row) => net.isIP(row.address) === 4 && synthetic.check(row.address, 'ipv4'))
      )
        rows = await resolvePublic(hostname, { timeoutMs });
      if (
        !rows.length ||
        rows.some((row) => !publicAddress(row.address) || net.isIP(row.address) !== row.family)
      )
        throw new Error('blocked_address');
      return rows;
    })(),
    new Promise((_, reject) => {
      dnsTimer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(dnsTimer));
  return addresses;
}

// DNS is checked at every connection. The lookup supplied to https.request
// pins the checked address, preserving the real hostname for Host and TLS/SNI.
export async function postWebhook(
  raw,
  { headers, body },
  { lookup = dns.lookup, timeoutMs = 8000 } = {},
) {
  const url = callbackUrl(raw),
    hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await callbackAddresses(hostname, { lookup, timeoutMs });
  const address = addresses.find((row) => row.family === 4) ?? addresses[0];
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        agent: false,
        headers: { ...headers, 'content-length': Buffer.byteLength(body) },
        lookup: (_host, options, done) =>
          options?.all ? done(null, [address]) : done(null, address.address, address.family),
      },
      (res) => {
        let size = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 128 * 1024) req.destroy(new Error('response_too_large'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(error.message === 'timeout' ? 'timeout' : 'delivery_failed'));
    });
    req.end(body);
  });
}

export function signingKey(secret) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))
    throw new Error('invalid_signing_secret');
  const bytes = Buffer.from(secret.slice(6), 'base64');
  if (
    bytes.length < 24 ||
    bytes.length > 64 ||
    bytes.toString('base64').replace(/=+$/, '') !== secret.slice(6).replace(/=+$/, '')
  )
    throw new Error('invalid_signing_secret');
  return new Webhook(secret);
}

export function signedRequest(subscription, payload, id, now = Date.now()) {
  const body = JSON.stringify(payload),
    date = new Date(now);
  if (Buffer.byteLength(body) > 256 * 1024) throw new Error('event_too_large');
  let signature = signingKey(subscription.secret).sign(id, date, body);
  if (subscription.previousSecret && subscription.previousSecretUntil > now)
    signature += ' ' + signingKey(subscription.previousSecret).sign(id, date, body);
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(Math.floor(now / 1000)),
      'webhook-signature': signature,
      'X-MCP-Subscription-Id': subscription.id,
    },
  };
}

export async function verifyCallback(subscription, post = postWebhook, now = Date.now()) {
  const challenge = randomBytes(32).toString('base64url');
  const response = await post(
    subscription.url,
    signedRequest(
      subscription,
      { type: 'verification', challenge },
      'verification_' + randomBytes(16).toString('hex'),
      now,
    ),
  );
  let actual;
  try {
    actual = JSON.parse(response.body).challenge;
  } catch {}
  if (
    response.status < 200 ||
    response.status >= 300 ||
    typeof actual !== 'string' ||
    Buffer.byteLength(actual) !== Buffer.byteLength(challenge) ||
    !timingSafeEqual(Buffer.from(actual), Buffer.from(challenge))
  )
    throw new Error('challenge_failed');
}
