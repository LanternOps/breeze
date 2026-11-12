import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  MAX_PNG_DECODE_PEAK_BYTES,
  PNG_DECODE_SINGLE_FLIGHT_BYTES,
  checkPngDecodable,
  withPngDecodeSlot,
} from './pngDecodeLimits';

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
