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

/**
 * Bytes a decode holds at its peak per pixel, on top of the decoded rows:
 * decoders expand to RGBA, split colour from alpha and keep a compressed copy
 * for the PDF. Measured for an RGBA8 image between 16 and 64 million pixels:
 * pdf-lib about 11, pdfkit and jsPDF about 15 bytes per pixel in total; rows
 * (4 per pixel) plus 12 covers all three.
 */
const PNG_DECODE_PEAK_BYTES_PER_PIXEL = 12;

/** Largest estimated peak a single decode may reach. The largest image the
 *  limits above allow, in 8-bit RGBA, is estimated at about 1.02 GB. */
export const MAX_PNG_DECODE_PEAK_BYTES = 1_200_000_000;

/** Decodes estimated above this run one at a time across the process
 *  (withPngDecodeSlot); smaller ones run concurrently. */
export const PNG_DECODE_SINGLE_FLIGHT_BYTES = 64 * 1024 * 1024;

export interface PngDecodeLimits {
  maxPeakBytes: number;
}

const DEFAULT_LIMITS: PngDecodeLimits = { maxPeakBytes: MAX_PNG_DECODE_PEAK_BYTES };

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
  /** Estimated peak memory of decoding and embedding the image. */
  peakBytes: number;
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
export function checkPngDecodable(data: Buffer, limits: Partial<PngDecodeLimits> = {}): PngDecodeCheck {
  const { maxPeakBytes } = { ...DEFAULT_LIMITS, ...limits };
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
  const peakBytes = decodedBytes + PNG_DECODE_PEAK_BYTES_PER_PIXEL * width * height;
  if (peakBytes > maxPeakBytes) {
    return tooLarge(`an estimated ${peakBytes} bytes to decode, over the ${maxPeakBytes}-byte limit`);
  }

  for (let offset = 8 + 25; offset + 8 <= data.length;) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('latin1', offset + 4, offset + 8);
    if (type === 'IHDR') return unreadable('the image has more than one header');
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') return tooLarge('an animated PNG cannot be embedded');
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  return { ok: true, header: { width, height, bitDepth, colorType, interlaced: interlace === 1, decodedBytes, peakBytes } };
}

/** The bytes of a base64 `data:image/…` URL, or null for anything else. The
 *  label is not trusted: callers pass the bytes on, and the checks here sniff
 *  the PNG signature. */
export function imageBytesFromDataUrl(url: string | null | undefined): Buffer | null {
  const m = url ? /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(url.trim()) : null;
  return m ? Buffer.from(m[1]!, 'base64') : null;
}

/** Whether `data` starts with the PNG signature, whatever it is labelled. */
export function hasPngSignature(data: Buffer): boolean {
  return data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE);
}

// ── single flight for large decodes ─────────────────────────────────────────

let slotHeld = false;
const slotQueue: Array<() => void> = [];

/** Waits for the process-wide large-decode slot (FIFO); resolves to its release. */
function acquireSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = () => {
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        const next = slotQueue.shift();
        if (next) next();
        else slotHeld = false;
      });
    };
    if (slotHeld) {
      slotQueue.push(grant);
    } else {
      slotHeld = true;
      grant();
    }
  });
}

/** Whether decoding `data` is estimated above PNG_DECODE_SINGLE_FLIGHT_BYTES. */
export function isLargePngDecode(data: Buffer | null | undefined): boolean {
  if (!data) return false;
  const check = checkPngDecodable(data);
  return check.ok && check.header.peakBytes > PNG_DECODE_SINGLE_FLIGHT_BYTES;
}

/**
 * Runs `decode` (which decodes `data`, or embeds it in a document that does)
 * holding the process-wide large-decode slot when the image is estimated above
 * PNG_DECODE_SINGLE_FLIGHT_BYTES, so only one such decode is in memory at a
 * time. Anything else (smaller PNGs, JPEGs, no image) runs at once.
 */
export async function withPngDecodeSlot<T>(data: Buffer | null | undefined, decode: () => Promise<T> | T): Promise<T> {
  if (!isLargePngDecode(data)) return decode();
  const release = await acquireSlot();
  try {
    return await decode();
  } finally {
    release();
  }
}

/**
 * The large-decode slot for one document render that meets its images as it
 * goes: `admit` takes the slot (once) when an image is estimated large, and
 * `release` gives it back when the document is finished. A render that never
 * meets a large image never waits.
 */
export function createPngDecodeSlotHolder(): { admit: (data: Buffer | null | undefined) => Promise<void>; release: () => void } {
  let release: (() => void) | null = null;
  let pending: Promise<void> | null = null;
  let closed = false;
  return {
    admit: async (data) => {
      if (closed || release || !isLargePngDecode(data)) return;
      // A slot granted after the render already finished goes straight back.
      pending ??= acquireSlot().then((r) => { if (closed) r(); else release = r; });
      await pending;
    },
    release: () => {
      closed = true;
      const r = release;
      release = null;
      r?.();
    },
  };
}
