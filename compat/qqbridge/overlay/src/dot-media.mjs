// Bounded raster image transport shared by the gateway and bridge adapter.
import { createHash } from 'node:crypto';

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_BODY = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 16_384;
export const MAX_IMAGE_PIXELS = 20_000_000;

export function imageInfo(buffer) {
  const invalid = () => {
    throw new Error(
      'INVALID_IMAGE: use a PNG, JPEG, GIF or WebP image up to 4 MiB and 20 megapixels.',
    );
  };
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.length > MAX_IMAGE_BYTES) invalid();
  let mimeType, width, height;
  if (
    buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
    buffer.readUInt32BE(8) === 13 &&
    buffer.toString('ascii', 12, 16) === 'IHDR' &&
    buffer.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))
  ) {
    mimeType = 'image/png';
    width = buffer.readUInt32BE(16);
    height = buffer.readUInt32BE(20);
  } else if (
    ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6)) &&
    buffer.at(-1) === 0x3b
  ) {
    mimeType = 'image/gif';
    width = buffer.readUInt16LE(6);
    height = buffer.readUInt16LE(8);
  } else if (
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer.at(-2) === 0xff &&
    buffer.at(-1) === 0xd9
  ) {
    mimeType = 'image/jpeg';
    let offset = 2;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset++] !== 0xff) invalid();
      while (buffer[offset] === 0xff) offset++;
      const marker = buffer[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > buffer.length) invalid();
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) invalid();
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (length < 8) invalid();
        height = buffer.readUInt16BE(offset + 3);
        width = buffer.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP' &&
    buffer.readUInt32LE(4) === buffer.length - 8
  ) {
    mimeType = 'image/webp';
    const type = buffer.toString('ascii', 12, 16);
    if (type === 'VP8X' && buffer.length >= 30) {
      width = 1 + buffer.readUIntLE(24, 3);
      height = 1 + buffer.readUIntLE(27, 3);
    } else if (type === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21);
      width = 1 + (bits & 0x3fff);
      height = 1 + ((bits >>> 14) & 0x3fff);
    } else if (
      type === 'VP8 ' &&
      buffer.length >= 30 &&
      buffer.toString('hex', 23, 26) === '9d012a'
    ) {
      width = buffer.readUInt16LE(26) & 0x3fff;
      height = buffer.readUInt16LE(28) & 0x3fff;
    }
  }
  if (
    !mimeType ||
    !width ||
    !height ||
    width > 8192 ||
    height > 8192 ||
    width * height > MAX_IMAGE_PIXELS
  )
    invalid();
  return {
    mimeType,
    width,
    height,
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

export function decodeImage(image) {
  if (
    !image ||
    typeof image.data !== 'string' ||
    image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    image.data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
  ) {
    throw new Error('INVALID_IMAGE: bounded canonical Base64 is required.');
  }
  const buffer = Buffer.from(image.data, 'base64');
  if (buffer.toString('base64') !== image.data)
    throw new Error('INVALID_IMAGE: noncanonical Base64.');
  const info = imageInfo(buffer);
  if (image.mimeType !== info.mimeType)
    throw new Error('INVALID_IMAGE: MIME type does not match the image bytes.');
  return { buffer, info };
}
