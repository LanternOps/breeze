import { crc32 } from 'node:zlib';

/**
 * Size limits for PNGs the API decodes itself or hands to a PDF library that
 * decodes them (pdf-lib's embedPng, pdfkit for a PNG with transparency, jsPDF
 * for report logos). Decoding expands the image to its full pixel rows in
 * memory, so the header is checked first and decoding stays within these
 * limits.
 */

/** Largest image, in pixels: a Letter page scanned at 600 dpi is about 34 million. */
export const MAX_PNG_DECODE_PIXELS = 64_000_000;

/** Longest side, in pixels. */
export const MAX_PNG_DECODE_SIDE = 20_000;

/**
 * Largest buffer of decoded rows, which depends on the bit depth and channels
 * as well as the pixel count: a maximum-size 8-bit RGBA image fits; the same
 * image at 16 bits per channel does not.
 */
export const MAX_PNG_DECODED_BYTES = 256 * 1024 * 1024;

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Channels per pixel by colour type, and the bit depths PNG defines for it. */
const PNG_COLOR_TYPES: ReadonlyMap<number, { channels: number; depths: ReadonlySet<number> }> = new Map([
  [0, { channels: 1, depths: new Set([1, 2, 4, 8, 16]) }], // greyscale
  [2, { channels: 3, depths: new Set([8, 16]) }], // RGB
  [3, { channels: 1, depths: new Set([1, 2, 4, 8]) }], // palette
  [4, { channels: 2, depths: new Set([8, 16]) }], // greyscale + alpha
  [6, { channels: 4, depths: new Set([8, 16]) }], // RGBA
]);

export interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlaced: boolean;
  /** Bytes a decoder allocates for the rows: a filter byte per row (two when
   *  interlaced), plus a second copy of the rows when it de-interlaces. */
  decodedBytes: number;
}

export type PngDecodeCheck =
  | { ok: true; header: PngHeader }
  | { ok: false; reason: 'unreadable' | 'too_large'; detail: string };

/**
 * Whether a PNG may be decoded, from its chunk headers alone. The header must
 * be exactly the one a decoder will use: a PNG signature, then a single IHDR
 * chunk, first, 13 bytes long with a matching CRC, and no other IHDR anywhere
 * (some decoders read every IHDR they meet, in any position, and ignore CRCs).
 * Refused: a colour type / bit depth / compression / filter / interlace value
 * PNG does not define; an empty image; a side over MAX_PNG_DECODE_SIDE; more
 * than MAX_PNG_DECODE_PIXELS; decoded rows over MAX_PNG_DECODED_BYTES; and
 * animation chunks (pdf-lib renders every frame before it rejects an animated
 * PNG). The chunk walk reads only each chunk's length and type, up to IEND.
 */
export function checkPngDecodable(data: Buffer): PngDecodeCheck {
  const unreadable = (detail: string): PngDecodeCheck => ({ ok: false, reason: 'unreadable', detail });
  const tooLarge = (detail: string): PngDecodeCheck => ({ ok: false, reason: 'too_large', detail });

  if (data.length < 8 + 25 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) return unreadable('not a PNG file');
  if (data.readUInt32BE(8) !== 13 || data.toString('latin1', 12, 16) !== 'IHDR') {
    return unreadable('the image header is not the first chunk');
  }
  if (crc32(data.subarray(12, 29)) !== data.readUInt32BE(29)) return unreadable('the image header is damaged');

  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  const bitDepth = data[24]!;
  const colorType = data[25]!;
  const interlace = data[28]!;
  const color = PNG_COLOR_TYPES.get(colorType);
  if (!color || !color.depths.has(bitDepth) || data[26] !== 0 || data[27] !== 0 || (interlace !== 0 && interlace !== 1)) {
    return unreadable(`unsupported image format (colour type ${colorType}, bit depth ${bitDepth})`);
  }
  if (width === 0 || height === 0) return unreadable('the image has no pixels');
  if (width > MAX_PNG_DECODE_SIDE || height > MAX_PNG_DECODE_SIDE) {
    return tooLarge(`${width}×${height} pixels, over the ${MAX_PNG_DECODE_SIDE}-pixel side limit`);
  }
  if (width * height > MAX_PNG_DECODE_PIXELS) {
    return tooLarge(`${width}×${height} pixels, over the ${MAX_PNG_DECODE_PIXELS}-pixel limit`);
  }
  const rowBytes = Math.ceil((width * color.channels * bitDepth) / 8);
  const decodedBytes = (rowBytes + 1 + interlace) * height + (interlace ? rowBytes * height : 0);
  if (decodedBytes > MAX_PNG_DECODED_BYTES) {
    return tooLarge(`${decodedBytes} bytes of image rows, over the ${MAX_PNG_DECODED_BYTES}-byte limit`);
  }

  for (let offset = 8 + 25; offset + 8 <= data.length;) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('latin1', offset + 4, offset + 8);
    if (type === 'IHDR') return unreadable('the image has more than one header');
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') return tooLarge('an animated PNG cannot be embedded');
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  return { ok: true, header: { width, height, bitDepth, colorType, interlaced: interlace === 1, decodedBytes } };
}
