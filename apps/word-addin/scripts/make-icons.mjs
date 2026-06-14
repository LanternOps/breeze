#!/usr/bin/env node
// Generates placeholder ribbon icons into public/assets/ as valid PNGs
// (hand-built chunks: IHDR + zlib IDAT + IEND). Replace with real brand
// icons later by dropping files at the same paths.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'public', 'assets');
mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  // bytes 10-12 (compression/filter/interlace) stay 0
  const row = Buffer.alloc(1 + size * 3); // filter byte 0 + RGB pixels
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Real Breeze mark lives at public/assets/brand.svg (committed). We never
// clobber an existing icon (the committed brand PNGs win); only MISSING icons
// are generated — preferring an rsvg-convert rasterization of brand.svg, and
// falling back to a flat dark badge (not a bright-blue placeholder).
const BRAND_SVG = path.join(outDir, 'brand.svg');
const BREEZE_DARK = [10, 10, 11]; // matches brand.svg badge fill

function rasterizeBrand(size, out) {
  if (!existsSync(BRAND_SVG)) return false;
  try {
    execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), BRAND_SVG, '-o', out], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false; // rsvg-convert not installed — fall back below
  }
}

for (const size of [16, 32, 64, 80]) {
  const out = path.join(outDir, `icon-${size}.png`);
  if (existsSync(out)) continue; // committed brand icon — leave it
  if (rasterizeBrand(size, out)) continue;
  writeFileSync(out, png(size, BREEZE_DARK));
}
console.log(`[make-icons] icons present in ${outDir}`);
