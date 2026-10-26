// A public, synthetic one-pixel PNG. No user images are stored in the repository.
export const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFz8AAAAASUVORK5CYII=';
export const pngImage = () => ({ mimeType: 'image/png', data: PNG });

export function largePngImage(size = 1_100_000) {
  const original = Buffer.from(PNG, 'base64');
  const chunk = Buffer.alloc(size + 12, 65);
  chunk.writeUInt32BE(size, 0);
  chunk.write('tEXt', 4, 'ascii');
  chunk.write('fixture\0', 8, 'ascii');
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return {
    mimeType: 'image/png',
    data: Buffer.concat([original.subarray(0, -12), chunk, original.subarray(-12)]).toString(
      'base64',
    ),
  };
}
