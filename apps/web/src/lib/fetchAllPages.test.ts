import { describe, expect, it, vi } from 'vitest';
import { fetchAllPages, LIST_MAX_PAGES, LIST_PAGE_SIZE } from './fetchAllPages';

const row = (n: number) => ({ id: `r-${n}` });
const page = (from: number, size: number, total?: number) => ({
  data: Array.from({ length: size }, (_, i) => row(from + i)),
  ...(total === undefined ? {} : { pagination: { total } }),
});

describe('fetchAllPages (#6412)', () => {
  it('asks for the server ceiling and walks every page', async () => {
    const fetchPage = vi.fn(async (p: number) => (p === 1 ? page(1, 100, 150) : page(101, 50, 150)));
    const all = await fetchAllPages(fetchPage);
    expect(all).toHaveLength(150);
    expect(fetchPage).toHaveBeenCalledWith(1, LIST_PAGE_SIZE);
    expect(LIST_PAGE_SIZE).toBe(100);
  });

  it('stops on a short page even with no pagination block (bare array body)', async () => {
    const fetchPage = vi.fn(async () => [row(1), row(2)]);
    expect(await fetchAllPages(fetchPage)).toHaveLength(2);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('honours alias envelope keys', async () => {
    const all = await fetchAllPages(async () => ({ sites: [row(1)] }), { aliasKeys: ['sites'] });
    expect(all).toHaveLength(1);
  });

  it('caps the walk when `total` never arrives', async () => {
    const fetchPage = vi.fn(async (p: number) => page((p - 1) * 100 + 1, 100, 10_000_000));
    const all = await fetchAllPages(fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(LIST_MAX_PAGES);
    expect(all).toHaveLength(LIST_MAX_PAGES * 100);
  });

  it('propagates null so the caller can abort, and never returns a partial walk', async () => {
    expect(await fetchAllPages(async () => null)).toBeNull();
    const midWalkNull = vi.fn(async (p: number) => (p === 1 ? page(1, 100, 300) : null));
    expect(await fetchAllPages(midWalkNull)).toBeNull();
  });

  it('lets a thrown fetch error escape rather than silently truncating', async () => {
    const fetchPage = vi.fn(async (p: number) => {
      if (p === 2) throw new Error('boom');
      return page(1, 100, 250);
    });
    await expect(fetchAllPages(fetchPage)).rejects.toThrow('boom');
  });

  it('respects a custom page size', async () => {
    const fetchPage = vi.fn(async () => page(1, 5, 5));
    await fetchAllPages(fetchPage, { pageSize: 5 });
    expect(fetchPage).toHaveBeenCalledWith(1, 5);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
