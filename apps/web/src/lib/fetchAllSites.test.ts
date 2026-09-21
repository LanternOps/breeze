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

  it('sorts the concatenated result across pages by display name (G2-2, #6459)', async () => {
    // Page 1 must be a FULL page (100) so the walk continues to page 2;
    // filler entries sort after everything else so the interesting five stay
    // first once sorted.
    const filler = Array.from({ length: 98 }, (_, i) => ({
      id: `filler-${i}`,
      name: `Zz Filler ${String(i).padStart(3, '0')}`,
    }));
    fetchWithAuth
      .mockResolvedValueOnce(
        ok({ data: [{ id: 's1', name: 'Zeta' }, { id: 's2', name: 'alpha' }, ...filler], pagination: { total: 103 } }),
      )
      .mockResolvedValueOnce(
        ok({
          data: [{ id: 's3', name: 'Beta' }, { id: 's4', name: 'Org 10' }, { id: 's5', name: 'Org 2' }],
          pagination: { total: 103 },
        }),
      );

    const sites = await fetchAllSites<{ id: string; name: string }>('/orgs/sites?organizationId=o1');

    expect(sites).toHaveLength(103);
    expect(sites.slice(0, 5).map((s) => s.name)).toEqual(['alpha', 'Beta', 'Org 2', 'Org 10', 'Zeta']);
  });
});
