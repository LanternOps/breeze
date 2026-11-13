import zlib, { crc32 } from 'node:zlib';
import { jsPDF } from 'jspdf';
import { describe, expect, it } from 'vitest';
import {
  MAX_PNG_DECODE_PEAK_BYTES,
  PNG_DECODE_SINGLE_FLIGHT_BYTES,
  checkPngDecodable,
  checkPngImageData,
  withPngDecodeSlot,
} from './pngDecodeLimits';
import { ordinaryPng, pngChunk, pngInflatingTo, pngRows, pngWithImageData, type PngShape } from './__fixtures__/pngImageData';

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A PNG header (RGBA8) with empty image data: enough for the header checks. */
function pngHeader(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const LARGE = pngHeader(4000, 4000); // estimate well over the single-flight threshold
const SMALL = pngHeader(200, 200);

/** Runs `count` decodes of `png` at once; returns the most that ran together. */
async function mostAtOnce(png: Buffer, count: number): Promise<number> {
  let running = 0;
  let most = 0;
  await Promise.all(Array.from({ length: count }, () => withPngDecodeSlot(png, async () => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 10));
    running -= 1;
  })));
  return most;
}

describe('PNG decode peak memory', () => {
  it('estimates the peak from the measured per-pixel cost and admits the largest allowed RGBA image', () => {
    const check = checkPngDecodable(pngHeader(8000, 8000));
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.header.peakBytes).toBe(check.header.decodedBytes + 12 * 8000 * 8000);
    expect(check.header.peakBytes).toBeLessThanOrEqual(MAX_PNG_DECODE_PEAK_BYTES);
  });

  it('refuses an image whose estimated peak is over the budget', () => {
    const check = checkPngDecodable(pngHeader(8000, 8000), { maxPeakBytes: 500_000_000 });
    expect(check).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('runs decodes estimated over the single-flight threshold one at a time', async () => {
    const check = checkPngDecodable(LARGE);
    expect(check.ok && check.header.peakBytes > PNG_DECODE_SINGLE_FLIGHT_BYTES).toBe(true);
    expect(await mostAtOnce(LARGE, 3)).toBe(1);
  });

  it('lets small decodes run together', async () => {
    const check = checkPngDecodable(SMALL);
    expect(check.ok && check.header.peakBytes <= PNG_DECODE_SINGLE_FLIGHT_BYTES).toBe(true);
    expect(await mostAtOnce(SMALL, 3)).toBe(3);
  });

  it('releases the slot when a decode fails', async () => {
    await expect(withPngDecodeSlot(LARGE, async () => { throw new Error('decode failed'); })).rejects.toThrow('decode failed');
    expect(await mostAtOnce(LARGE, 2)).toBe(1);
  });
});

describe('checkPngImageData — how far the image data inflates', () => {
  const TINY: PngShape = { width: 10, height: 10 };
  // Tens of MB behind a 10×10 header: big enough that a decoder holding it is
  // the failure, small enough for the test to build quickly.
  const FAR_PAST = 32 * 1024 * 1024;

  /** The real report-logo decoder (jsPDF → fast-png) accepts the image. */
  function jsPdfDecodes(png: Buffer): boolean {
    try {
      new jsPDF().addImage(new Uint8Array(png), 'PNG', 0, 0, 10, 10);
      return true;
    } catch {
      return false;
    }
  }

  // Each control is a real image: jsPDF (the report-logo decoder) decodes it,
  // except the interlaced 1-bit one, which fast-png 6.4 cannot de-interlace
  // (it is still a valid PNG; other decoders read it).
  it.each<[string, PngShape, boolean]>([
    ['RGBA, not interlaced', { width: 10, height: 10 }, true],
    ['RGBA, Adam7-interlaced', { width: 10, height: 10, interlaced: true }, true],
    ['RGB, Adam7-interlaced, odd size', { width: 37, height: 23, colorType: 2, interlaced: true }, true],
    ['1-bit palette, not interlaced, odd size', { width: 37, height: 23, colorType: 3, bitDepth: 1 }, true],
    ['1-bit palette, Adam7-interlaced, odd size', { width: 37, height: 23, colorType: 3, bitDepth: 1, interlaced: true }, false],
    ['16-bit grey, Adam7-interlaced, smaller than one pass grid', { width: 3, height: 2, colorType: 0, bitDepth: 16, interlaced: true }, true],
  ])('accepts an ordinary %s image', async (_label, shape, jsPdfReads) => {
    const png = ordinaryPng(shape);
    if (jsPdfReads) expect(jsPdfDecodes(png)).toBe(true);
    expect(await checkPngImageData(png)).toMatchObject({ ok: true, header: { width: shape.width, height: shape.height } });
  });

  it('refuses image data that inflates past the size the header declares', async () => {
    const started = Date.now();
    const check = await checkPngImageData(pngInflatingTo(TINY, FAR_PAST));
    expect(check).toMatchObject({ ok: false, reason: 'too_large' });
    // It stops at the declared size instead of inflating all of it.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('refuses image data one byte longer than the header declares', async () => {
    const rows = pngRows(TINY);
    const png = pngWithImageData(TINY, zlib.deflateSync(Buffer.concat([rows, Buffer.alloc(1)])));
    expect(await checkPngImageData(png)).toMatchObject({ ok: false, reason: 'too_large' });
    expect(await checkPngImageData(pngWithImageData(TINY, zlib.deflateSync(rows)))).toMatchObject({ ok: true });
  });

  it('refuses a second compressed stream after the first (a decoder may inflate it too)', async () => {
    const png = pngWithImageData(TINY, Buffer.concat([zlib.deflateSync(pngRows(TINY)), zlib.deflateSync(Buffer.alloc(FAR_PAST))]));
    expect(await checkPngImageData(png)).toMatchObject({ ok: false, reason: 'unreadable' });
  });

  it('counts image data split over several IDAT chunks', async () => {
    const data = zlib.deflateSync(Buffer.alloc(FAR_PAST));
    const half = data.length >> 1;
    const png = pngWithImageData(TINY, data.subarray(0, half), []);
    // Move the second half into its own IDAT, after the first.
    const iend = png.length - 12;
    const split = Buffer.concat([png.subarray(0, iend), pngChunk('IDAT', data.subarray(half)), png.subarray(iend)]);
    expect(await checkPngImageData(split)).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('refuses damaged image data, and a PNG with none', async () => {
    const damaged = Buffer.from(zlib.deflateSync(pngRows(TINY)));
    damaged[damaged.length - 1]! ^= 0xff; // break the checksum
    expect(await checkPngImageData(pngWithImageData(TINY, damaged))).toMatchObject({ ok: false, reason: 'unreadable' });
    const ihdrAndIend = pngWithImageData(TINY, Buffer.alloc(0));
    expect(await checkPngImageData(ihdrAndIend)).toMatchObject({ ok: false, reason: 'unreadable' });
  });

  it('still refuses what the header checks refuse', async () => {
    expect(await checkPngImageData(pngHeader(30_000, 30_000))).toMatchObject({ ok: false, reason: 'too_large' });
    expect(await checkPngImageData(Buffer.from('not a png'))).toMatchObject({ ok: false, reason: 'unreadable' });
  });
});
