import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));

const { fetchAllSites, ListFetchError } = await import('./fetchAllSites');

function site(n: number) {
  return { id: `site-${n}`, name: `Site ${n}` };
}
function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => fetchWithAuth.mockReset());

describe('fetchAllSites (#6412)', () => {
  it('walks past the route page limit so a site beyond it is still selectable', async () => {
    // 260 sites => 100 + 100 + 60. Before this helper the picker saw 50.
    fetchWithAuth
      .mockResolvedValueOnce(ok({ data: Array.from({ length: 100 }, (_, i) => site(i + 1)), pagination: { total: 260 } }))
      .mockResolvedValueOnce(ok({ data: Array.from({ length: 100 }, (_, i) => site(i + 101)), pagination: { total: 260 } }))
      .mockResolvedValueOnce(ok({ data: Array.from({ length: 60 }, (_, i) => site(i + 201)), pagination: { total: 260 } }));

    const sites = await fetchAllSites('/orgs/sites?organizationId=o1');

    expect(sites).toHaveLength(260);
    expect(sites.some((s: { id: string }) => s.id === 'site-51')).toBe(true);
    expect(sites.at(-1)).toEqual(site(260));
    expect(fetchWithAuth).toHaveBeenNthCalledWith(1, '/orgs/sites?organizationId=o1&page=1&limit=100', undefined);
  });

  it('uses `?` when the path carries no query of its own', async () => {
    fetchWithAuth.mockResolvedValue(ok({ data: [site(1)] }));
    await fetchAllSites('/orgs/sites');
    expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/sites?page=1&limit=100', undefined);
  });

  it('forwards fetchWithAuth options (orgIdOverride pinning)', async () => {
    fetchWithAuth.mockResolvedValue(ok({ data: [] }));
    await fetchAllSites('/orgs/sites?organizationId=o9', { orgIdOverride: 'o9' });
    expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/sites?organizationId=o9&page=1&limit=100', { orgIdOverride: 'o9' });
  });

  it('accepts the legacy {sites:[...]} envelope', async () => {
    fetchWithAuth.mockResolvedValue(ok({ sites: [site(1), site(2)] }));
    expect(await fetchAllSites('/orgs/sites')).toHaveLength(2);
  });

  it('throws on a non-OK response rather than returning an empty list', async () => {
    fetchWithAuth.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await expect(fetchAllSites('/orgs/sites')).rejects.toThrow('status 500');
  });

  it('throws a ListFetchError carrying the status so callers keep a 401 bail', async () => {
    fetchWithAuth.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    await expect(fetchAllSites('/orgs/sites')).rejects.toBeInstanceOf(ListFetchError);
    await expect(fetchAllSites('/orgs/sites')).rejects.toMatchObject({ status: 401 });
  });

  it('fails closed to [] on an unrecognized 200 body, or throws under strictShape', async () => {
    fetchWithAuth.mockResolvedValue(ok({ error: 'nope' }));
    expect(await fetchAllSites('/orgs/sites')).toEqual([]);
    await expect(fetchAllSites('/orgs/sites', undefined, { strictShape: true })).rejects.toThrow(
      /not a parseable list/,
    );
  });

  it('does not fire a second request when the first page is short', async () => {
    fetchWithAuth.mockResolvedValue(ok({ data: [site(1)], pagination: { total: 1 } }));
    await fetchAllSites('/orgs/sites');
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });
});
