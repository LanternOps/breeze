import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getBinarySource, getGithubAgentUrl } = vi.hoisted(() => ({
  getBinarySource: vi.fn((): 'github' | 'local' => 'github'),
  getGithubAgentUrl: vi.fn((os: string, arch: string) => `https://gh.test/breeze-agent-${os}-${arch}.exe`),
}));
vi.mock('./binarySource', () => ({ getBinarySource, getGithubAgentUrl }));

const { isS3Configured, getPresignedUrl, isS3NotFound } = vi.hoisted(() => ({
  isS3Configured: vi.fn(() => false),
  getPresignedUrl: vi.fn(() => Promise.resolve('https://s3.test/breeze-agent-windows-amd64.exe')),
  isS3NotFound: vi.fn(() => false),
}));
vi.mock('./s3Storage', () => ({ isS3Configured, getPresignedUrl, isS3NotFound }));

const {
  openSync,
  closeSync,
  readSync,
  statSync,
} = vi.hoisted(() => ({
  openSync: vi.fn(() => 1),
  closeSync: vi.fn(),
  readSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 0 }) as unknown as ReturnType<typeof import('node:fs').statSync>),
}));
vi.mock('node:fs', () => ({ openSync, closeSync, readSync, statSync }));

import {
  parseHasAuthenticodeSignature,
  isWindowsAgentSigned,
  _resetWindowsAgentSigningCacheForTests,
} from './windowsAgentSigning';

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

function partialResponse(body: Buffer): Response {
  return new Response(new Uint8Array(body), { status: 206 });
}

describe('isWindowsAgentSigned', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    _resetWindowsAgentSigningCacheForTests();
    getBinarySource.mockReturnValue('github');
    getGithubAgentUrl.mockImplementation((os: string, arch: string) => `https://gh.test/breeze-agent-${os}-${arch}.exe`);
    isS3Configured.mockReturnValue(false);
    isS3NotFound.mockReturnValue(false);
    getPresignedUrl.mockResolvedValue('https://s3.test/breeze-agent-windows-amd64.exe');
    openSync.mockReturnValue(1);
    closeSync.mockReturnValue(undefined);
    statSync.mockReturnValue({ size: 0 } as unknown as ReturnType<typeof import('node:fs').statSync>);
    readSync.mockReturnValue(0);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves true when the GitHub source serves a partial, signed PE header', async () => {
    fetchMock.mockResolvedValue(partialResponse(buildPeHeader(0x10b, 4096)));
    await expect(isWindowsAgentSigned()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gh.test/breeze-agent-windows-amd64.exe',
      expect.objectContaining({ headers: expect.objectContaining({ Range: expect.stringMatching(/^bytes=0-/) }) }),
    );
  });

  it('resolves false when the GitHub fetch rejects (network failure) — fails closed, never throws', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    await expect(isWindowsAgentSigned()).resolves.toBe(false);
  });

  it('resolves false, not true, when getGithubAgentUrl itself throws synchronously (#7185 regression)', async () => {
    // A malformed BINARY_VERSION makes the URL builder throw before any fetch
    // happens (see binarySource.ts's release-tag guard). That must still
    // fail closed rather than escaping as an unhandled rejection out of
    // /support/check/:code.
    getGithubAgentUrl.mockImplementation(() => {
      throw new Error('Refusing to build a download URL for malformed release tag');
    });
    await expect(isWindowsAgentSigned()).resolves.toBe(false);
  });

  it('resolves false when the origin ignores the Range header and answers 200 with a full body', async () => {
    // Only 206 Partial Content is trusted — a plain 200 would mean buffering
    // the whole ~60 MB binary on every cache miss instead of just the header.
    fetchMock.mockResolvedValue(new Response(new Uint8Array(buildPeHeader(0x10b, 4096)), { status: 200 }));
    await expect(isWindowsAgentSigned()).resolves.toBe(false);
  });

  it('caches the result across calls within the TTL — only one fetch for two calls', async () => {
    fetchMock.mockResolvedValue(partialResponse(buildPeHeader(0x10b, 4096)));
    await isWindowsAgentSigned();
    await isWindowsAgentSigned();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the local binary when S3 is configured but returns not-found', async () => {
    getBinarySource.mockReturnValue('local');
    isS3Configured.mockReturnValue(true);
    isS3NotFound.mockReturnValue(true);
    getPresignedUrl.mockRejectedValue(new Error('NoSuchKey'));
    const localHeader = buildPeHeader(0x10b, 4096);
    statSync.mockReturnValue({ size: localHeader.length } as unknown as ReturnType<typeof import('node:fs').statSync>);
    readSync.mockImplementation((_fd: number, buffer: Buffer) => {
      localHeader.copy(buffer);
      return localHeader.length;
    });

    await expect(isWindowsAgentSigned()).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves false without throwing when local mode has no binary on disk (ENOENT)', async () => {
    getBinarySource.mockReturnValue('local');
    isS3Configured.mockReturnValue(false);
    openSync.mockImplementation(() => {
      const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    await expect(isWindowsAgentSigned()).resolves.toBe(false);
  });
});
