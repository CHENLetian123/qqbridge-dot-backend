import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import {
  MAX_IMAGE_BYTES,
  imageInfo,
  decodeImage,
} from '../compat/qqbridge/overlay/src/dot-media.mjs';
import { downloadImage } from '../src/mcp/media.mjs';
import { PNG, pngImage } from './fixtures/image.mjs';

const bytes = Buffer.from(PNG, 'base64');
test('image transport validates signatures, dimensions, MIME and canonical Base64 without accepting paths or SVG', () => {
  assert.deepEqual([imageInfo(bytes).width, imageInfo(bytes).height], [1, 1]);
  assert.equal(decodeImage(pngImage()).buffer.equals(bytes), true);
  for (const buffer of [
    Buffer.from('<svg></svg>'.repeat(8)),
    bytes.subarray(0, 24),
    Buffer.alloc(MAX_IMAGE_BYTES + 1),
  ])
    assert.throws(() => imageInfo(buffer));
  const huge = Buffer.from(bytes);
  huge.writeUInt32BE(100000, 16);
  assert.throws(() => imageInfo(huge));
  assert.throws(() => decodeImage({ ...pngImage(), mimeType: 'image/jpeg' }));
  assert.throws(() => decodeImage({ ...pngImage(), data: 'file:///private/image.png' }));
  assert.throws(() =>
    decodeImage({ ...pngImage(), data: 'a'.repeat(((MAX_IMAGE_BYTES * 4) / 3) | 0) }),
  );
});

function network(replies, calls) {
  return (url, options, callback) => {
    const req = new EventEmitter();
    req.destroy = (error) => {
      if (error) queueMicrotask(() => req.emit('error', error));
    };
    req.end = () =>
      queueMicrotask(() => {
        calls.push({ url: url.href, options });
        const reply = replies.shift();
        const res = Readable.from(reply.chunks ?? [bytes]);
        res.statusCode = reply.status ?? 200;
        res.headers = reply.headers ?? {};
        callback(res);
      });
    return req;
  };
}
const publicResolve = async () => [{ address: '8.8.8.8', family: 4 }];
test('image downloads pin DNS, bound streaming bytes, verify bytes and validate every redirect', async () => {
  const calls = [];
  const image = await downloadImage('https://files.example/one?signature=private', {
    resolve: publicResolve,
    request: network(
      [{ status: 302, headers: { location: 'https://cdn.example/two' } }, {}],
      calls,
    ),
  });
  assert.equal(image.data, PNG);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.authorization, undefined);
  calls[0].options.lookup('files.example', {}, (err, address) => {
    assert.equal(err, null);
    assert.equal(address, '8.8.8.8');
  });
  for (const target of [
    'http://example.com/i',
    'file:///tmp/i.png',
    'https://127.0.0.1/i',
    'https://[::ffff:127.0.0.1]/i',
  ])
    await assert.rejects(downloadImage(target));
  await assert.rejects(
    downloadImage('https://files.example/i?secret=hidden', {
      resolve: publicResolve,
      request: network([{ status: 302, headers: { location: 'https://127.0.0.1/i' } }], []),
    }),
    (error) => !error.message.includes('hidden'),
  );
  await assert.rejects(
    downloadImage('https://files.example/i', {
      resolve: publicResolve,
      request: network([{ chunks: [Buffer.alloc(MAX_IMAGE_BYTES), Buffer.from('x')] }], []),
    }),
  );
  await assert.rejects(
    downloadImage('https://files.example/i', {
      resolve: publicResolve,
      request: network([{ chunks: [Buffer.from('<html>not an image</html>')] }], []),
    }),
  );
  await assert.rejects(
    downloadImage('https://files.example/i', {
      resolve: async () => {
        throw new Error('blocked_address');
      },
      request: () => assert.fail('Must not connect after rejected DNS'),
    }),
  );
});
