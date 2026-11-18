/**
 * Tiny synthetic PNG / JPEG / WebP byte buffers for the prompt-identity logo
 * tests (#10190). Header bytes only: enough for validatePromptLogo's magic and
 * dimension parsing, never a real (or any customer's) logo.
 */
function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function le16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function le24(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
}
function le32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
function ascii(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}

export function png(width: number, height: number, padTo = 0): Uint8Array {
  const bytes = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), ...ascii('IHDR'), ...be32(width), ...be32(height), 8, 6, 0, 0, 0, ...be32(0),
    ...be32(0), ...ascii('IEND'), ...be32(0),
  ];
  while (bytes.length < padTo) bytes.push(0);
  return Uint8Array.from(bytes);
}

export function jpeg(width: number, height: number, sof = 0xc0): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    // APP0 (JFIF), 16 bytes including the length field
    0xff, 0xe0, 0x00, 0x10, ...ascii('JFIF'), 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    // DHT, which is C4 and must NOT be read as a frame header
    0xff, 0xc4, 0x00, 0x03, 0x00,
    // SOFn
    0xff, sof, 0x00, 0x0b, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

function riff(chunk: number[]): Uint8Array {
  return Uint8Array.from([...ascii('RIFF'), ...le32(4 + chunk.length), ...ascii('WEBP'), ...chunk]);
}
export function webpVp8(width: number, height: number): Uint8Array {
  const frame = [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(width & 0x3fff), ...le16(height & 0x3fff), 0, 0];
  return riff([...ascii('VP8 '), ...le32(frame.length), ...frame]);
}
export function webpVp8l(width: number, height: number): Uint8Array {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const data = [0x2f, ...le32(bits >>> 0), 0, 0, 0];
  return riff([...ascii('VP8L'), ...le32(data.length), ...data]);
}
export function webpVp8x(width: number, height: number): Uint8Array {
  const data = [0x10, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)];
  return riff([...ascii('VP8X'), ...le32(data.length), ...data]);
}

export const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');

