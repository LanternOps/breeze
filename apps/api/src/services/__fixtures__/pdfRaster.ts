// Shared page-1-at-72dpi rasterization helper for the classic-PDF regression
// harness (Task 6). Shells out to poppler's `pdftoppm` — the same tool the
// harness's raster half needs at test time — so
// quotePdf.classicRegression.test.ts (compare) and
// scripts/regen-classic-pdf-baseline.ts (generate) share one implementation
// instead of two copies that could drift.
//
// Output is grayscale PGM (P5): a trivial uncompressed raster format (magic +
// width/height/maxval header, then one byte per pixel) that needs no PNG
// decode dependency — we already gzip the on-disk baseline with node:zlib to
// keep the committed fixture small.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface GrayRaster {
  width: number;
  height: number;
  /** One byte per pixel, row-major, length === width * height. */
  pixels: Buffer;
}

let pdftoppmAvailable: boolean | null = null;

/** Cached `which pdftoppm` check — poppler's presence doesn't change mid-run. */
export function isPdftoppmAvailable(): boolean {
  if (pdftoppmAvailable !== null) return pdftoppmAvailable;
  try {
    execFileSync('which', ['pdftoppm'], { stdio: 'ignore' });
    pdftoppmAvailable = true;
  } catch {
    pdftoppmAvailable = false;
  }
  return pdftoppmAvailable;
}

function parsePgm(buf: Buffer): GrayRaster {
  // Minimal P5 (binary grayscale) parser: magic, then three whitespace/comment
  // -separated tokens (width, height, maxval), then exactly width*height
  // pixel bytes. pdftoppm's own output never emits comments, but tolerate them
  // defensively rather than assuming a fixed byte offset.
  if (buf[0] !== 0x50 || buf[1] !== 0x35) { // "P5"
    throw new Error('parsePgm: not a P5 (binary grayscale) PGM');
  }
  let offset = 2;
  const tokens: number[] = [];
  while (tokens.length < 3) {
    while (offset < buf.length && /\s/.test(String.fromCharCode(buf[offset]!))) offset++;
    if (buf[offset] === 0x23) { // '#' comment — skip to end of line
      while (offset < buf.length && buf[offset] !== 0x0a) offset++;
      continue;
    }
    let start = offset;
    while (offset < buf.length && !/\s/.test(String.fromCharCode(buf[offset]!))) offset++;
    tokens.push(Number(buf.toString('latin1', start, offset)));
  }
  offset += 1; // single whitespace byte separating the header from pixel data
  const [width, height] = tokens;
  const pixels = buf.subarray(offset, offset + width! * height!);
  return { width: width!, height: height!, pixels: Buffer.from(pixels) };
}

/**
 * Rasterizes page 1 of `pdfBytes` at 72dpi grayscale via `pdftoppm`. Returns
 * null if pdftoppm isn't on PATH — callers must skip the raster comparison
 * (with a logged warning) rather than fail, so CI images without poppler
 * still run the operator half of the harness.
 */
export function rasterizePage1Gray(pdfBytes: Buffer): GrayRaster | null {
  if (!isPdftoppmAvailable()) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quotepdf-raster-'));
  try {
    const inputPath = path.join(dir, 'input.pdf');
    const outPrefix = path.join(dir, 'page');
    fs.writeFileSync(inputPath, pdfBytes);
    execFileSync('pdftoppm', ['-gray', '-r', '72', '-f', '1', '-l', '1', inputPath, outPrefix]);
    const outPath = `${outPrefix}-1.pgm`;
    return parsePgm(fs.readFileSync(outPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
