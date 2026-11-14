// PNG builders for the image-data size tests (pngDecodeLimits, reportBranding,
// quotePdf, agreementCertificate). Each builds a real PNG: signature, IHDR,
// IDAT and IEND chunks with correct CRCs, so the only thing a test varies is
// what it means to vary.

import zlib from 'node:zlib';

export const PNG_SIGNATURE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

export interface PngShape {
  width: number;
  height: number;
  /** PNG colour type: 0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA. */
  colorType?: number;
  bitDepth?: number;
  interlaced?: boolean;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** The Adam7 passes: x offset, y offset, x step, y step. */
const ADAM7: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];

/**
 * Filtered rows for an image of this shape: every row starts with filter byte
 * 0 (None) and its pixel bytes cycle through `fill`. An interlaced image gets
 * one sub-image per non-empty Adam7 pass, as the PNG specification lays out.
 */
export function pngRows({ width, height, colorType = 6, bitDepth = 8, interlaced = false }: PngShape, fill = 0x5a): Buffer {
  const bitsPerPixel = CHANNELS[colorType]! * bitDepth;
  const passes = interlaced ? ADAM7 : [[0, 0, 1, 1] as const];
  const rows: Buffer[] = [];
  for (const [x0, y0, dx, dy] of passes) {
    const passWidth = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const passHeight = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    if (passWidth === 0 || passHeight === 0) continue;
    const rowBytes = Math.ceil((passWidth * bitsPerPixel) / 8);
    for (let y = 0; y < passHeight; y++) {
      const row = Buffer.alloc(rowBytes + 1);
      for (let i = 1; i <= rowBytes; i++) row[i] = (fill + i + y) & 0xff;
      rows.push(row);
    }
  }
  return Buffer.concat(rows);
}

/** A PNG of this shape whose IDAT holds `imageData` (already compressed). */
export function pngWithImageData(shape: PngShape, imageData: Buffer, extraChunks: Buffer[] = []): Buffer {
  const { width, height, colorType = 6, bitDepth = 8, interlaced = false } = shape;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlaced ? 1 : 0;
  const palette = colorType === 3 ? [pngChunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255]))] : [];
  return Buffer.concat([
    PNG_SIGNATURE_BYTES,
    pngChunk('IHDR', ihdr),
    ...palette,
    ...extraChunks,
    pngChunk('IDAT', imageData),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An ordinary PNG of this shape: its rows, compressed. */
export function ordinaryPng(shape: PngShape): Buffer {
  return pngWithImageData(shape, zlib.deflateSync(pngRows(shape)));
}

/** A PNG declaring `shape` whose image data inflates to `inflatedBytes` zero
 *  bytes, whatever the shape declares. */
export function pngInflatingTo(shape: PngShape, inflatedBytes: number): Buffer {
  return pngWithImageData(shape, zlib.deflateSync(Buffer.alloc(inflatedBytes)));
}

export function asDataUrl(png: Buffer): string {
  return 'data:image/png;base64,' + png.toString('base64');
}
