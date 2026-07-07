import { describe, it, expect, vi, beforeEach } from 'vitest';

// The module imports `db` (pool) and `safeFetch`. Mock `../db` so importing the
// storage module never opens a real pool, and make runOutsideDbContext a
// pass-through. Keep the real SsrfBlockedError from urlSafety but stub safeFetch.
vi.mock('../db', () => ({
  runOutsideDbContext: <T,>(fn: () => T) => fn(),
  db: {},
}));
vi.mock('./urlSafety', async (importActual) => {
  const actual = await importActual<typeof import('./urlSafety')>();
  return { ...actual, safeFetch: vi.fn() };
});

import { fetchRemoteImage, RemoteImageError, MAX_QUOTE_IMAGE_SIZE_BYTES } from './quoteImageStorage';
import { safeFetch, SsrfBlockedError } from './urlSafety';

const safeFetchMock = vi.mocked(safeFetch);

// A minimal but valid PNG magic-byte header (>= 12 bytes) so the real
// sniffImageMime recognizes it.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

// Minimal stub of just the Response surface fetchRemoteImage uses (`ok`,
// `headers.get`, `arrayBuffer`). Avoids undici recomputing a real Response's
// content-length from the body, which would defeat the fast-reject test.
function res(body: Buffer, init?: { status?: number; contentLength?: number }): Response {
  const status = init?.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-length' && init?.contentLength != null ? String(init.contentLength) : null) },
    arrayBuffer: async () => body,
  } as unknown as Response;
}

describe('fetchRemoteImage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the sniffed mime + bytes for a real PNG', async () => {
    safeFetchMock.mockResolvedValue(res(PNG));
    const out = await fetchRemoteImage('https://cdn.example.com/logo.png');
    expect(out.mime).toBe('image/png');
    expect(out.buffer.equals(PNG)).toBe(true);
    expect(safeFetchMock).toHaveBeenCalledWith('https://cdn.example.com/logo.png', { timeoutMs: 8000 });
  });

  it('maps an SSRF block to reason "unreachable"', async () => {
    safeFetchMock.mockRejectedValue(new SsrfBlockedError('blocked'));
    await expect(fetchRemoteImage('https://internal/x.png')).rejects.toBeInstanceOf(RemoteImageError);
    await expect(fetchRemoteImage('https://internal/x.png')).rejects.toMatchObject({ reason: 'unreachable' });
  });

  it('maps a timeout error to reason "timeout"', async () => {
    safeFetchMock.mockRejectedValue(new Error('request timed out after 8000ms'));
    await expect(fetchRemoteImage('https://slow/x.png')).rejects.toMatchObject({ reason: 'timeout' });
  });

  it('rejects a non-2xx response as "unreachable"', async () => {
    safeFetchMock.mockResolvedValue(res(PNG, { status: 404 }));
    await expect(fetchRemoteImage('https://cdn/x.png')).rejects.toMatchObject({ reason: 'unreachable' });
  });

  it('rejects bytes that are not a supported image even if the URL claims one', async () => {
    safeFetchMock.mockResolvedValue(res(Buffer.from('<!doctype html><html></html>')));
    await expect(fetchRemoteImage('https://cdn/looks-like.png')).rejects.toMatchObject({ reason: 'not_image' });
  });

  it('rejects a buffer over the 5 MB cap', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]);
    safeFetchMock.mockResolvedValue(res(big));
    await expect(fetchRemoteImage('https://cdn/big.png')).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('fast-rejects on an oversized Content-Length header', async () => {
    safeFetchMock.mockResolvedValue(res(PNG, { contentLength: 6 * 1024 * 1024 }));
    await expect(fetchRemoteImage('https://cdn/liar.png')).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('maps a generic transport error to "unreachable" and keeps the original error as cause', async () => {
    const original = new Error('ECONNRESET');
    safeFetchMock.mockRejectedValue(original);
    await expect(fetchRemoteImage('https://cdn/x.png')).rejects.toMatchObject({ reason: 'unreachable' });
    let caught: unknown;
    try {
      await fetchRemoteImage('https://cdn/x.png');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RemoteImageError);
    expect((caught as RemoteImageError).cause).toBeInstanceOf(Error);
    expect(((caught as RemoteImageError).cause as Error).message).toBe('ECONNRESET');
  });

  it('allows a buffer exactly at the 5 MB cap', async () => {
    const exact = Buffer.concat([PNG, Buffer.alloc(MAX_QUOTE_IMAGE_SIZE_BYTES - PNG.length)]);
    expect(exact.length).toBe(MAX_QUOTE_IMAGE_SIZE_BYTES);
    safeFetchMock.mockResolvedValue(res(exact));
    const out = await fetchRemoteImage('https://cdn/exact-cap.png');
    expect(out.mime).toBe('image/png');
  });
});
