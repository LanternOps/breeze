import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from '@/stores/auth';
import { fetchWispActivity, safeActivityHref } from './wispActivity';

const mockFetch = vi.mocked(fetchWithAuth);
const res = (ok: boolean, body: unknown) =>
  ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response;
const item = (extra: Record<string, unknown> = {}) => ({
  id: 'i1', at: '2026-10-24T00:00:00Z', kind: 'concern', orgId: null, title: 'T', detail: null, href: null, costCents: null, ...extra,
});
const CURRENT = { orgId: 'o1', orgName: 'Greenwood', startedAt: '2026-10-24T00:00:00Z' };

beforeEach(() => vi.clearAllMocks());

describe('fetchWispActivity', () => {
  it('requests the first page without a cursor', async () => {
    mockFetch.mockResolvedValue(res(true, { data: { items: [item()], nextCursor: 'n1' } }));
    const out = await fetchWispActivity('t/1', null);
    expect(mockFetch).toHaveBeenCalledWith('/wisp/thread/t%2F1/activity?limit=50', { skipOrgIdInjection: true });
    expect(out.nextCursor).toBe('n1');
    expect(out.items).toHaveLength(1);
  });

  it('appends an encoded cursor', async () => {
    mockFetch.mockResolvedValue(res(true, { data: { items: [], nextCursor: 5 } }));
    const out = await fetchWispActivity('t1', 'a b');
    expect(mockFetch).toHaveBeenCalledWith('/wisp/thread/t1/activity?limit=50&cursor=a%20b', { skipOrgIdInjection: true });
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
      data: { items: [item({ kind: 'future' }), item({ title: 3 }), item({ at: null }), item({ id: 7 }), item({ kind: 'brief' })], nextCursor: null },
    }));
    const out = await fetchWispActivity('t1', null);
    expect(out.items.map((i) => i.kind)).toEqual(['brief']);
    expect(out.items[0]!.id).toBe('i1');
  });

  it('a page where every row is malformed is a contract break, not "no activity"', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockResolvedValue(res(true, { data: { items: [item({ kind: 'renamed' }), item({ id: undefined })], nextCursor: null } }));
    await expect(fetchWispActivity('t1', null)).rejects.toThrow(/malformed/);
    err.mockRestore();
  });

  it('logs dropped rows so a partial contract break is visible', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockResolvedValue(res(true, { data: { items: [item({ kind: 'future' }), item()], nextCursor: null } }));
    await fetchWispActivity('t1', null);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('dropped 1 of 2'), expect.anything());
    err.mockRestore();
  });

  it('W06a shape: reads data.current (the live line) and honours a smaller limit', async () => {
    mockFetch.mockResolvedValue(res(true, { data: { items: [], nextCursor: null, current: CURRENT } }));
    const out = await fetchWispActivity('t1', null, 1);
    expect(mockFetch).toHaveBeenCalledWith('/wisp/thread/t1/activity?limit=1', { skipOrgIdInjection: true });
    expect(out.current).toEqual(CURRENT);
  });

  it.each([undefined, null, { orgId: 'o1' }, { ...CURRENT, startedAt: 5 }])('current is null for %o', async (current) => {
    mockFetch.mockResolvedValue(res(true, { data: { items: [], nextCursor: null, current } }));
    expect((await fetchWispActivity('t1', null)).current).toBeNull();
  });
});

describe('safeActivityHref', () => {
  it('allows relative paths', () => {
    expect(safeActivityHref('/tickets/1')).toBe('/tickets/1');
  });
  it.each(['https://x', '//x', '/\\x', 'javascript:alert(1)', '', null, '/\t/evil.example', '/\n/evil.example', '/\r//evil.example', '/x\\y'])('rejects %j', (v) => {
    expect(safeActivityHref(v as string | null)).toBeNull();
  });
});
