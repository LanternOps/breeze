import { describe, expect, it } from 'vitest';
import { parseHasAuthenticodeSignature } from './windowsAgentSigning';

/**
 * Builds a minimal synthetic PE header buffer with a well-formed
 * IMAGE_DIRECTORY_ENTRY_SECURITY entry (index 4 of the optional header's data
 * directory table), for either PE32 (magic 0x10b) or PE32+ (magic 0x20b).
 * Nothing beyond the header is present — the real certificate table (if any)
 * is appended after all sections in a real file, but only the directory
 * ENTRY (an RVA/size pair in the header) is needed to decide presence.
 */
function buildPeHeader(magic: 0x10b | 0x20b, securityTableSize: number): Buffer {
  const peOffset = 64;
  const coffOffset = peOffset + 4;
  const optHeaderOffset = coffOffset + 20;
  const dataDirOffset = optHeaderOffset + (magic === 0x10b ? 96 : 112);
  const securityDirOffset = dataDirOffset + 4 * 8;
  const length = securityDirOffset + 8;

  const buf = Buffer.alloc(length);
  buf.writeUInt16LE(0x5a4d, 0); // 'MZ'
  buf.writeUInt32LE(peOffset, 0x3c); // e_lfanew
  buf.writeUInt32LE(0x00004550, peOffset); // 'PE\0\0'
  buf.writeUInt16LE(0x014c, coffOffset); // Machine (irrelevant to the check)
  buf.writeUInt16LE(length - optHeaderOffset, coffOffset + 16); // SizeOfOptionalHeader
  buf.writeUInt16LE(magic, optHeaderOffset);
  buf.writeUInt32LE(0, securityDirOffset); // Security table RVA (unused by the check)
  buf.writeUInt32LE(securityTableSize, securityDirOffset + 4); // Security table size
  return buf;
}

describe('parseHasAuthenticodeSignature', () => {
  it('reports signed for a PE32 header with a non-empty security directory', () => {
    expect(parseHasAuthenticodeSignature(buildPeHeader(0x10b, 4096))).toBe(true);
  });

  it('reports unsigned for a PE32 header with a zero-size security directory', () => {
    expect(parseHasAuthenticodeSignature(buildPeHeader(0x10b, 0))).toBe(false);
  });

  it('reports signed for a PE32+ (64-bit) header with a non-empty security directory', () => {
    expect(parseHasAuthenticodeSignature(buildPeHeader(0x20b, 8192))).toBe(true);
  });

  it('reports unsigned for a PE32+ header with a zero-size security directory', () => {
    expect(parseHasAuthenticodeSignature(buildPeHeader(0x20b, 0))).toBe(false);
  });

  it('returns null for a buffer that is too short to be a PE header', () => {
    expect(parseHasAuthenticodeSignature(Buffer.from([0x4d, 0x5a, 0x90]))).toBeNull();
  });

  it('returns null when the DOS magic is missing', () => {
    const buf = buildPeHeader(0x10b, 4096);
    buf.writeUInt16LE(0x0000, 0);
    expect(parseHasAuthenticodeSignature(buf)).toBeNull();
  });

  it('returns null when the PE signature is missing', () => {
    const buf = buildPeHeader(0x10b, 4096);
    buf.writeUInt32LE(0, 64);
    expect(parseHasAuthenticodeSignature(buf)).toBeNull();
  });

  it('returns null for an unrecognized optional-header magic', () => {
    const buf = buildPeHeader(0x10b, 4096);
    buf.writeUInt16LE(0x0107, 88); // ROM image magic — not PE32/PE32+
    expect(parseHasAuthenticodeSignature(buf)).toBeNull();
  });

  it('returns null when the buffer is truncated before the security directory entry', () => {
    const full = buildPeHeader(0x10b, 4096);
    expect(parseHasAuthenticodeSignature(full.subarray(0, full.length - 4))).toBeNull();
  });
});
