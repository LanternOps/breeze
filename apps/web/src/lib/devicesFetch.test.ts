import { describe, it, expect, vi } from 'vitest';
import { fetchAllDevices } from './devicesFetch';

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

describe('fetchAllDevices', () => {
  it('legacy single-page API (no nextCursor) — walks one page and returns immediately', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        pagination: { page: 1, limit: 500, total: 3 },
      }),
    );
    const result = await fetchAllDevices({ fetcher });
    expect(result.data).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(result.total).toBe(3);
    expect(result.pagesWalked).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // First call must request includeTotal and not pass a cursor.
    const firstCall = fetcher.mock.calls[0][0] as string;
    expect(firstCall).toContain('includeTotal=true');
    expect(firstCall).not.toContain('cursor=');
  });

  it('new cursor API — walks pages until nextCursor goes null', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: '1' }, { id: '2' }],
          pagination: { nextCursor: 'cur-p2', limit: 2, total: 5 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: '3' }, { id: '4' }],
          pagination: { nextCursor: 'cur-p3', limit: 2 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: '5' }],
          pagination: { nextCursor: null, limit: 2 },
        }),
      );

    const result = await fetchAllDevices({ fetcher, pageLimit: 2 });

    expect(result.data.map((d) => d.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(result.total).toBe(5);
    expect(result.pagesWalked).toBe(3);
    expect(fetcher).toHaveBeenCalledTimes(3);
    // includeTotal only on page 0.
    expect(fetcher.mock.calls[0][0]).toContain('includeTotal=true');
    expect(fetcher.mock.calls[1][0]).not.toContain('includeTotal=true');
    expect(fetcher.mock.calls[2][0]).not.toContain('includeTotal=true');
    // Cursor param threads through after page 0.
    expect(fetcher.mock.calls[0][0]).not.toContain('cursor=');
    expect(fetcher.mock.calls[1][0]).toContain('cursor=cur-p2');
    expect(fetcher.mock.calls[2][0]).toContain('cursor=cur-p3');
  });

  it('treats empty-string nextCursor as terminal (defensive)', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: 'only' }],
        pagination: { nextCursor: '', limit: 200 },
      }),
    );
    const result = await fetchAllDevices({ fetcher });
    expect(result.pagesWalked).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('throws the failed Response on a non-OK page (caller can show error UI)', async () => {
    const failingResponse = jsonResponse({ error: 'nope' }, { ok: false, status: 500 });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: 'p0' }],
          pagination: { nextCursor: 'cur', limit: 1 },
        }),
      )
      .mockResolvedValueOnce(failingResponse);

    await expect(fetchAllDevices({ fetcher, pageLimit: 1 })).rejects.toBe(failingResponse);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('respects includeDecommissioned=false', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ data: [], pagination: { nextCursor: null } }),
      );
    await fetchAllDevices({ fetcher, includeDecommissioned: false });
    expect(fetcher.mock.calls[0][0]).not.toContain('includeDecommissioned');
  });

  describe('MAX_PAGES safety ceiling (#778 review)', () => {
    it('stops walking at MAX_PAGES=200 and returns total=undefined to signal "not the full fleet"', async () => {
      // Server returns nextCursor forever. The walker must stop at the
      // hard ceiling — without it, a stuck server-side cursor would spin
      // the UI thread forever.
      const fetcher = vi.fn().mockImplementation(async () =>
        jsonResponse({
          data: [{ id: 'd' }],
          pagination: { nextCursor: 'never-ending', limit: 1 },
        }),
      );

      const result = await fetchAllDevices({ fetcher, pageLimit: 1 });

      expect(result.pagesWalked).toBe(200);
      expect(result.total).toBeUndefined();
      expect(result.data.length).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(200);
    });

    it('invokes onTruncated with {pagesWalked, pageLimit} when the ceiling is hit', async () => {
      const onTruncated = vi.fn();
      const fetcher = vi.fn().mockImplementation(async () =>
        jsonResponse({
          data: [{ id: 'd' }],
          pagination: { nextCursor: 'never-ending', limit: 1 },
        }),
      );

      await fetchAllDevices({ fetcher, pageLimit: 1, onTruncated });

      expect(onTruncated).toHaveBeenCalledTimes(1);
      expect(onTruncated).toHaveBeenCalledWith({ pagesWalked: 200, pageLimit: 1 });
    });

    it('does NOT invoke onTruncated when the walk terminates naturally', async () => {
      const onTruncated = vi.fn();
      const fetcher = vi.fn().mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: 'a' }],
          pagination: { nextCursor: null, limit: 200, total: 1 },
        }),
      );

      await fetchAllDevices({ fetcher, onTruncated });
      expect(onTruncated).not.toHaveBeenCalled();
    });

    it('a throwing onTruncated does not corrupt the return value', async () => {
      const onTruncated = vi.fn(() => {
        throw new Error('boom');
      });
      const fetcher = vi.fn().mockImplementation(async () =>
        jsonResponse({
          data: [{ id: 'd' }],
          pagination: { nextCursor: 'never-ending', limit: 1 },
        }),
      );

      const result = await fetchAllDevices({ fetcher, pageLimit: 1, onTruncated });
      // Walker still returns the truncated rows even though the callback threw.
      expect(result.pagesWalked).toBe(200);
      expect(result.data.length).toBe(200);
    });
  });

  describe('AbortSignal', () => {
    it('throws AbortError immediately when signal is already aborted before invocation', async () => {
      const fetcher = vi.fn();
      const controller = new AbortController();
      controller.abort();
      await expect(fetchAllDevices({ fetcher, signal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('stops walking when the signal aborts between pages', async () => {
      const controller = new AbortController();
      const fetcher = vi
        .fn()
        .mockImplementationOnce(async () => {
          // Abort during page 0 — the walker should detect it before issuing page 1.
          controller.abort();
          return jsonResponse({
            data: [{ id: '1' }, { id: '2' }],
            pagination: { nextCursor: 'cur-p2', limit: 2, total: 10 },
          });
        })
        .mockResolvedValueOnce(
          jsonResponse({ data: [{ id: '3' }], pagination: { nextCursor: null } }),
        );

      await expect(
        fetchAllDevices({ fetcher, pageLimit: 2, signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      // Page 0 was already in flight when the abort fired, so it completes;
      // page 1 must NOT be issued because the inter-page check trips first.
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('completes normally when signal is provided but never aborts', async () => {
      const controller = new AbortController();
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            data: [{ id: 'a' }, { id: 'b' }],
            pagination: { nextCursor: null, limit: 200, total: 2 },
          }),
        );
      const result = await fetchAllDevices({ fetcher, signal: controller.signal });
      expect(result.data).toEqual([{ id: 'a' }, { id: 'b' }]);
      expect(result.pagesWalked).toBe(1);
    });
  });
});
