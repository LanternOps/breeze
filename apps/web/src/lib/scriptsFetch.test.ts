import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchAllScripts } from './scriptsFetch';

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

/** N placeholder script rows, ids unique across the whole walk. */
function rows(count: number, offset = 0): { id: string }[] {
  return Array.from({ length: count }, (_, i) => ({ id: `s${offset + i}` }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchAllScripts', () => {
  it('single short page — one request, returns every row', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      jsonResponse({ data: rows(3), pagination: { page: 1, limit: 100, total: 3 } }),
    );

    const result = await fetchAllScripts({ fetcher });

    expect(result.data.map((s) => s.id)).toEqual(['s0', 's1', 's2']);
    expect(result.total).toBe(3);
    expect(result.pagesWalked).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('this is the #3301 regression — a library past one page is returned in full, not truncated', async () => {
    // The bug: one unpaginated request returned 50 rows and every caller
    // rendered them as if that were the whole library.
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ data: rows(100, 0), pagination: { page: 1, limit: 100, total: 250 } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: rows(100, 100), pagination: { page: 2, limit: 100, total: 250 } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: rows(50, 200), pagination: { page: 3, limit: 100, total: 250 } }),
      );

    const result = await fetchAllScripts({ fetcher });

    expect(result.data).toHaveLength(250);
    expect(result.data[0].id).toBe('s0');
    expect(result.data[249].id).toBe('s249');
    expect(result.pagesWalked).toBe(3);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('requests limit=100 and increments page, and omits includeSystem by default', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: rows(2, 0) }))
      .mockResolvedValueOnce(jsonResponse({ data: rows(1, 2) }));

    await fetchAllScripts({ fetcher, pageLimit: 2 });

    const urls = fetcher.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toBe('/scripts?limit=2&page=1');
    expect(urls[1]).toBe('/scripts?limit=2&page=2');
    expect(urls[0]).not.toContain('includeSystem');
  });

  it('passes includeSystem=true through on every page when asked', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: rows(2, 0) }))
      .mockResolvedValueOnce(jsonResponse({ data: rows(1, 2) }));

    await fetchAllScripts({ fetcher, pageLimit: 2, includeSystem: true });

    for (const call of fetcher.mock.calls) {
      expect(call[0] as string).toContain('includeSystem=true');
    }
  });

  it('an exactly-full final page is followed by one more request that comes back empty', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: rows(2, 0) }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    const result = await fetchAllScripts({ fetcher, pageLimit: 2 });

    expect(result.data).toHaveLength(2);
    expect(result.pagesWalked).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('accepts the legacy `scripts` envelope key', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ scripts: rows(2), pagination: { total: 2 } }));

    const result = await fetchAllScripts({ fetcher });

    expect(result.data.map((s) => s.id)).toEqual(['s0', 's1']);
  });

  it('a malformed body yields an empty list rather than an envelope object in state', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse({ unexpected: 'shape' }));

    const result = await fetchAllScripts({ fetcher });

    expect(result.data).toEqual([]);
    expect(result.pagesWalked).toBe(1);
  });

  it('throws the failed Response so callers can branch on status (401 → login)', async () => {
    const failed = jsonResponse({}, { ok: false, status: 401 });
    const fetcher = vi.fn().mockResolvedValueOnce(failed);

    await expect(fetchAllScripts({ fetcher })).rejects.toBe(failed);
  });

  it('fails the whole walk when a later page errors — never returns a silent partial', async () => {
    const failed = jsonResponse({}, { ok: false, status: 500 });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: rows(2, 0) }))
      .mockResolvedValueOnce(failed);

    await expect(fetchAllScripts({ fetcher, pageLimit: 2 })).rejects.toBe(failed);
  });

  it('an already-aborted signal throws before any request is issued', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();

    await expect(fetchAllScripts({ fetcher, signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('aborting mid-walk stops before the next request', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockImplementation(async () => {
      controller.abort();
      return jsonResponse({ data: rows(2) });
    });

    await expect(
      fetchAllScripts({ fetcher, pageLimit: 2, signal: controller.signal }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('hitting the MAX_PAGES ceiling reports truncation and drops total', async () => {
    // Server that never returns a short page: the walk must stop at the
    // safety ceiling AND say so, because a silent stop here is the same class
    // of bug this module exists to remove.
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse({
      data: rows(2),
      pagination: { total: 9999 },
    }));
    const onTruncated = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await fetchAllScripts({ fetcher, pageLimit: 2, onTruncated });

    expect(fetcher).toHaveBeenCalledTimes(50);
    expect(result.pagesWalked).toBe(50);
    expect(result.total).toBeUndefined();
    expect(onTruncated).toHaveBeenCalledWith({
      pagesWalked: 50,
      pageLimit: 2,
      actualCount: 100,
    });
  });

  it('an onTruncated callback that throws does not corrupt the return', async () => {
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse({ data: rows(2) }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await fetchAllScripts({
      fetcher,
      pageLimit: 2,
      onTruncated: () => {
        throw new Error('caller bug');
      },
    });

    expect(result.data).toHaveLength(100);
    expect(result.pagesWalked).toBe(50);
  });
});
