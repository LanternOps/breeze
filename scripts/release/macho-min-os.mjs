#!/usr/bin/env node
// Reads the minimum macOS version a thin 64-bit little-endian Mach-O declares.
// CLI: node macho-min-os.mjs <file>...  ->  {"<basename>":"<minos>|null"}
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const MH_MAGIC_64 = 0xfeedfacf;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;
const HEADER_SIZE = 32;

function formatVersion(v) {
  const major = v >>> 16;
  const minor = (v >>> 8) & 0xff;
  const patch = v & 0xff;
  return patch === 0 ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
}

export function readMachOMinOs(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_SIZE) return null;
  if (buf.readUInt32LE(0) !== MH_MAGIC_64) return null;
  const ncmds = buf.readUInt32LE(16);
  let off = HEADER_SIZE;
  let fallback = null;
  for (let i = 0; i < ncmds; i++) {
    if (off + 8 > buf.length) return null;
    const cmd = buf.readUInt32LE(off);
    const cmdsize = buf.readUInt32LE(off + 4);
    if (cmdsize < 8 || off + cmdsize > buf.length) return null;
    if (cmd === LC_BUILD_VERSION) {
      if (cmdsize < 16) return null;
      return formatVersion(buf.readUInt32LE(off + 12));
    }
    if (cmd === LC_VERSION_MIN_MACOSX && fallback === null) {
      if (cmdsize < 12) return null;
      fallback = formatVersion(buf.readUInt32LE(off + 8));
    }
    off += cmdsize;
  }
  return fallback;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = {};
  for (const f of process.argv.slice(2)) {
    out[basename(f)] = readMachOMinOs(readFileSync(f));
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
