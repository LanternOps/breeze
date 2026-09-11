import { describe, it, expect, vi, beforeEach } from 'vitest';

// fetchImageFromUrl is the SSRF/size/format guard for the "import image from URL"
// path. The route mocks this whole module, so its real branch logic is only
// exercised here. safeFetch (the SSRF wrapper) and sniffImageMime are mocked;
// db is unused by fetchImageFromUrl but imported by the module, so it's stubbed.
const safeFetch = vi.fn();
vi.mock('./urlSafety', () => ({ safeFetch: (...a: unknown[]) => safeFetch(...a) }));
const sniffImageMime = vi.fn();
vi.mock('./avatarStorage', () => ({ sniffImageMime: (...a: unknown[]) => sniffImageMime(...a) }));
vi.mock('../db', () => ({ db: {} }));

import { fetchImageFromUrl, MAX_CATALOG_IMAGE_SIZE_BYTES, CATALOG_IMAGE_WEBP_REJECTED_MESSAGE } from './catalogImageStorage';

function fakeRes(opts: { ok?: boolean; status?: number; headers?: Record<string, string>; body?: Uint8Array }) {
  const { ok = true, status = 200, headers = {}, body = new Uint8Array([1, 2, 3]) } = opts;
  return {
    ok,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

describe('fetchImageFromUrl', () => {
  beforeEach(() => { safeFetch.mockReset(); sniffImageMime.mockReset(); });

  it('returns the SNIFFED mime + buffer, ignoring the Content-Type header', async () => {
    safeFetch.mockResolvedValue(fakeRes({ headers: { 'content-type': 'text/plain' }, body: new Uint8Array([1, 2, 3, 4]) }));
    sniffImageMime.mockReturnValue('image/png');
    const out = await fetchImageFromUrl('https://example.test/a.png');
    expect(out.mime).toBe('image/png');
    expect(out.buffer.length).toBe(4);
    expect(safeFetch).toHaveBeenCalledWith('https://example.test/a.png', { timeoutMs: 10_000 });
  });

  it('throws on a non-OK response (and never sniffs)', async () => {
    safeFetch.mockResolvedValue(fakeRes({ ok: false, status: 403 }));
    await expect(fetchImageFromUrl('https://x.test')).rejects.toThrow();
    expect(sniffImageMime).not.toHaveBeenCalled();
  });

  it('rejects early when Content-Length exceeds the cap', async () => {
    safeFetch.mockResolvedValue(fakeRes({ headers: { 'content-length': String(MAX_CATALOG_IMAGE_SIZE_BYTES + 1) } }));
    await expect(fetchImageFromUrl('https://x.test')).rejects.toThrow(/too large/i);
  });

  it('rejects when the actual body exceeds the cap despite a missing/lying header', async () => {
    safeFetch.mockResolvedValue(fakeRes({ body: new Uint8Array(MAX_CATALOG_IMAGE_SIZE_BYTES + 1) }));
    await expect(fetchImageFromUrl('https://x.test')).rejects.toThrow(/too large/i);
  });

  it('rejects an empty body', async () => {
    safeFetch.mockResolvedValue(fakeRes({ body: new Uint8Array([]) }));
    await expect(fetchImageFromUrl('https://x.test')).rejects.toThrow(/empty/i);
  });

  it('rejects an unsniffable (non-image) body', async () => {
    safeFetch.mockResolvedValue(fakeRes({ body: new Uint8Array([0, 0, 0]) }));
    sniffImageMime.mockReturnValue(null);
    await expect(fetchImageFromUrl('https://x.test')).rejects.toThrow(/unsupported/i);
  });

  // #4521 — catalog item images reach quotePdf.ts (which uses pdfkit, PNG/JPEG
  // only) via quote line thumbnails, so a WebP sniffed here must be rejected
  // even though it IS a recognized image format — mirrors the quote-image
  // upload fix (#3483, PR #4408).
  it('rejects a sniffed WebP with the clear PDF-specific message, not the generic "unsupported" one', async () => {
    safeFetch.mockResolvedValue(fakeRes({ body: new Uint8Array([1, 2, 3, 4]) }));
    sniffImageMime.mockReturnValue('image/webp');
    await expect(fetchImageFromUrl('https://x.test')).rejects.toThrow(CATALOG_IMAGE_WEBP_REJECTED_MESSAGE);
  });
});
