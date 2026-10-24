import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from '@/stores/auth';
import { fetchWispActivity, safeActivityHref } from './wispActivity';

const mockFetch = vi.mocked(fetchWithAuth);
const res = (ok: boolean, body: unknown) =>
  ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response;
const item = (extra: Record<string, unknown> = {}) => ({
  at: '2026-10-24T00:00:00Z', kind: 'concern', orgId: null, title: 'T', detail: null, href: null, costCents: null, ...extra,
});

beforeEach(() => vi.clearAllMocks());

describe('fetchWispActivity', () => {
  it('requests the first page without a cursor', async () => {
    mockFetch.mockResolvedValue(res(true, { data: { items: [item()], nextCursor: 'n1' } }));
    const out = await fetchWispActivity('t/1', null);
    expect(mockFetch).toHaveBeenCalledWith('/wisp/thread/t%2F1/activity?limit=50');
    expect(out.nextCursor).toBe('n1');
    expect(out.items).toHaveLength(1);
  });

  it('appends an encoded cursor', async () => {
    mockFetch.mockResolvedValue(res(true, { data: { items: [], nextCursor: 5 } }));
    const out = await fetchWispActivity('t1', 'a b');
    expect(mockFetch).toHaveBeenCalledWith('/wisp/thread/t1/activity?limit=50&cursor=a%20b');
    expect(out.nextCursor).toBeNull();
  });

  it('throws on a non-ok response', async () => {
    mockFetch.mockResolvedValue(res(false, {}));
    await expect(fetchWispActivity('t1', null)).rejects.toThrow();
  });

  it('throws when items is missing', async () => {
    mockFetch.mockResolvedValue(res(true, { data: {} }));
    await expect(fetchWispActivity('t1', null)).rejects.toThrow();
  });

  it('drops unknown kinds and malformed rows', async () => {
    mockFetch.mockResolvedValue(res(true, {
      data: { items: [item({ kind: 'future' }), item({ title: 3 }), item({ at: null }), item({ kind: 'brief' })], nextCursor: null },
    }));
    const out = await fetchWispActivity('t1', null);
    expect(out.items.map((i) => i.kind)).toEqual(['brief']);
  });
});

describe('safeActivityHref', () => {
  it('allows relative paths', () => {
    expect(safeActivityHref('/tickets/1')).toBe('/tickets/1');
  });
  it.each(['https://x', '//x', '/\\x', 'javascript:alert(1)', '', null])('rejects %s', (v) => {
    expect(safeActivityHref(v as string | null)).toBeNull();
  });
});
