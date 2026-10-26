import https from 'node:https';
import { callbackUrl, callbackAddresses } from './webhook.mjs';
import { MAX_IMAGE_BYTES, imageInfo } from '../../compat/qqbridge/overlay/src/dot-media.mjs';

// No cookies, bearer tokens or incoming headers accompany the signed file URL.
// Validate and pin public DNS on every redirect; never delegate fetching to QQ.
export async function downloadImage(
  raw,
  { resolve = callbackAddresses, request = https.request, timeoutMs = 12_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let current = raw;
  try {
    for (let hop = 0; hop <= 3; hop++) {
      const url = callbackUrl(current);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('timeout');
      const addresses = await resolve(url.hostname.replace(/^\[|\]$/g, ''), {
        timeoutMs: remaining,
      });
      const address = addresses.find((row) => row.family === 4) ?? addresses[0];
      const response = await new Promise((resolveResponse, reject) => {
        const req = request(
          url,
          {
            method: 'GET',
            agent: false,
            headers: { accept: 'image/*', 'accept-encoding': 'identity' },
            lookup: (_host, options, done) =>
              options?.all ? done(null, [address]) : done(null, address.address, address.family),
          },
          (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
              res.destroy();
              clearTimeout(timer);
              resolveResponse({ location: res.headers.location });
              return;
            }
            if (
              res.statusCode !== 200 ||
              (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') ||
              Number(res.headers['content-length']) > MAX_IMAGE_BYTES
            ) {
              res.resume();
              req.destroy(new Error('file_unavailable'));
              return;
            }
            let size = 0;
            const chunks = [];
            res.on('data', (chunk) => {
              size += chunk.length;
              if (size > MAX_IMAGE_BYTES) req.destroy(new Error('image_too_large'));
              else chunks.push(chunk);
            });
            res.on('error', () => req.destroy(new Error('download_failed')));
            res.on('end', () => {
              clearTimeout(timer);
              resolveResponse({ buffer: Buffer.concat(chunks) });
            });
          },
        );
        const timer = setTimeout(
          () => req.destroy(new Error('timeout')),
          Math.max(1, deadline - Date.now()),
        );
        req.on('error', () => {
          clearTimeout(timer);
          reject(new Error('download_failed'));
        });
        req.end();
      });
      if (response.buffer)
        return { data: response.buffer.toString('base64'), ...imageInfo(response.buffer) };
      if (!response.location) throw new Error('file_unavailable');
      current = new URL(response.location, url).href;
    }
  } catch {
    // Signed URL query strings and TLS/network errors must not reach logs or model context.
    throw new Error(
      'IMAGE_DOWNLOAD_FAILED: image unavailable, unsafe, expired, oversized or unsupported. No QQ send was attempted.',
    );
  }
  throw new Error('IMAGE_DOWNLOAD_FAILED: too many redirects. No QQ send was attempted.');
}
