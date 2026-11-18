import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSiteCrud } from './useSiteCrud';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('@/lib/runAction', async () => {
  const actual = await vi.importActual<typeof import('@/lib/runAction')>('@/lib/runAction');
  return actual;
});

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);
const t = ((key: string) => key) as unknown as import('i18next').TFunction;

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const ORG_ID = 'org-1';
const SITE = { id: 'site-1', name: 'Main Office', timezone: 'America/New_York', deviceCount: 2 };

describe('useSiteCrud', () => {
  const onUnauthorized = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    onUnauthorized.mockReset();
    showToastMock.mockReset();
  });

  it('refresh() GETs sites for the bound org with orgIdOverride, even while ambient scope points elsewhere', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [SITE] }));
    const { result } = renderHook(() => useSiteCrud(ORG_ID, { onUnauthorized, t }));

    await act(async () => {
      await result.current.refresh();
    });

    // `fetchAllSites` (#6412) pages to exhaustion, so the request now also
    // carries explicit `page`/`limit` params instead of relying on the
    // server's default page size.
    expect(fetchMock).toHaveBeenCalledWith(
      `/orgs/sites?organizationId=${ORG_ID}&page=1&limit=100`,
      expect.objectContaining({ orgIdOverride: ORG_ID }),
    );
    expect(result.current.sites).toEqual([SITE]);
  });

  it('refresh(overrideOrgId) fetches a DIFFERENT org than the one the hook is bound to', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const { result } = renderHook(() => useSiteCrud(null, { onUnauthorized, t }));

    await act(async () => {
      await result.current.refresh('brand-new-org');
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/orgs/sites?organizationId=brand-new-org&page=1&limit=100',
      expect.objectContaining({ orgIdOverride: 'brand-new-org' }),
    );
  });

  it('refresh() fails closed (null) on a malformed 200 body, without touching sites state destructively', async () => {
    // `fetchAllSites(..., { strictShape: true })` (#6412) keeps this branch: a
    // 200 body that isn't a parseable list throws rather than being unwrapped
    // to `[]`, so a first-site caller still sees "unknown", not "confirmed zero".
    fetchMock.mockResolvedValue(jsonResponse({ data: null }));
    const { result } = renderHook(() => useSiteCrud(ORG_ID, { onUnauthorized, t }));

    let value: unknown;
    await act(async () => {
      value = await result.current.refresh();
    });

    expect(value).toBeNull();
    expect(result.current.sites).toEqual([]);
    // `sitesFailed` is what actually distinguishes this from a genuinely
    // empty org — `sites` alone reads identically in both cases.
    expect(result.current.sitesFailed).toBe(true);
  });

  it('sitesFailed flags a request-level failure too, and clears on the next successful refresh', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, false, 500));
    const { result } = renderHook(() => useSiteCrud(ORG_ID, { onUnauthorized, t }));

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.sitesFailed).toBe(true);

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [SITE] }));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.sitesFailed).toBe(false);
    expect(result.current.sites).toEqual([SITE]);
  });

  it('clear() also resets sitesFailed', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, false, 500));
    const { result } = renderHook(() => useSiteCrud(ORG_ID, { onUnauthorized, t }));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.sitesFailed).toBe(true);

    act(() => result.current.clear());
    expect(result.current.sitesFailed).toBe(false);
  });

  it('clear() empties the list without a network request', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [SITE] }));
    const { result } = renderHook(() => useSiteCrud(ORG_ID, { onUnauthorized, t }));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.sites).toEqual([SITE]);

    fetchMock.mockClear();
    act(() => {
      result.current.clear();
    });

    expect(result.current.sites).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('openAdd/openEdit/openDelete/close drive siteModalMode and selectedSite', () => {
    const { result } = renderHook(() => useSiteCrud(ORG_ID, { onUnauthorized, t }));

    act(() => result.current.openAdd());
    expect(result.current.siteModalMode).toBe('add');
    expect(result.current.selectedSite).toBeNull();

    act(() => result.current.openEdit(SITE));
    expect(result.current.siteModalMode).toBe('edit');
    expect(result.current.selectedSite).toEqual(SITE);

    act(() => result.current.openDelete(SITE));
    expect(result.current.siteModalMode).toBe('delete');

    act(() => result.current.close());
    expect(result.current.siteModalMode).toBe('closed');
    expect(result.current.selectedSite).toBeNull();
    expect(result.current.guidingFirstSite).toBe(false);
  });

  it('openAdd guides the first site only once the bound org is confirmed to have none (#9868)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const { result } = renderHook(() => useSiteCrud(ORG_ID, { onUnauthorized, t }));

    // Before any listing has loaded, an empty list is not evidence of zero sites.
    act(() => result.current.openAdd());
    expect(result.current.guidingFirstSite).toBe(false);
    act(() => result.current.close());

    await act(async () => {
      await result.current.refresh();
    });
    act(() => result.current.openAdd());
    expect(result.current.guidingFirstSite).toBe(true);

    act(() => result.current.close());
    expect(result.current.guidingFirstSite).toBe(false);
  });

  it('openAdd does not guide when the org already has sites, the listing failed, or in fleet mode', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [SITE] }));
    const withSites = renderHook(() => useSiteCrud(ORG_ID, { onUnauthorized, t }));
    await act(async () => {
      await withSites.result.current.refresh();
    });
    act(() => withSites.result.current.openAdd());
    expect(withSites.result.current.guidingFirstSite).toBe(false);

    fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, false));
    const failed = renderHook(() => useSiteCrud(ORG_ID, { onUnauthorized, t }));
    await act(async () => {
      await failed.result.current.refresh();
    });
    expect(failed.result.current.sitesFailed).toBe(true);
    act(() => failed.result.current.openAdd());
    expect(failed.result.current.guidingFirstSite).toBe(false);

    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const fleet = renderHook(() => useSiteCrud(ORG_ID, { onUnauthorized, t, fleet: true }));
    await act(async () => {
      await fleet.result.current.refresh();
    });
    act(() => fleet.result.current.openAdd());
    expect(fleet.result.current.guidingFirstSite).toBe(false);
  });

  it('submit() in add mode POSTs /orgs/sites with orgId in the body, then refreshes and closes', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url) === '/orgs/sites' && init?.method === 'POST') return jsonResponse({ id: 'new-site' });
      return jsonResponse({ data: [SITE] });
    });
    const { result } = renderHook(() => useSiteCrud(ORG_ID, { onUnauthorized, t }));

    act(() => result.current.openAdd());
    await act(async () => {
      await result.current.submit({ name: 'New Site', timezone: 'UTC' });
    });

    const postCall = fetchMock.mock.calls.find(([url, init]) => url === '/orgs/sites' && (init as RequestInit)?.method === 'POST');
    expect(postCall).toBeTruthy();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body.orgId).toBe(ORG_ID);
    // The POST itself also carries orgIdOverride — the site-mutation routes
    // don't consult it server-side today, but the hook's guarantee should not
    // depend on that staying true.
    expect((postCall![1] as { orgIdOverride?: string }).orgIdOverride).toBe(ORG_ID);
    expect(result.current.siteModalMode).toBe('closed');
    // #10084: a successful create confirms itself instead of just closing.
    expect(showToastMock).toHaveBeenCalledWith({ type: 'success', message: 'settings:sites.toasts.created' });
  });

  it('submit() in edit mode PATCHes /orgs/sites/:id', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url) === `/orgs/sites/${SITE.id}` && init?.method === 'PATCH') return jsonResponse({});
      return jsonResponse({ data: [SITE] });
    });
    const { result } = renderHook(() => useSiteCrud(ORG_ID, { onUnauthorized, t }));

    act(() => result.current.openEdit(SITE));
    await act(async () => {
      await result.current.submit({ name: 'Renamed' });
    });

    const patchCall = fetchMock.mock.calls.find(
      ([url, init]) => url === `/orgs/sites/${SITE.id}` && (init as RequestInit)?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    expect((patchCall![1] as { orgIdOverride?: string }).orgIdOverride).toBe(ORG_ID);
    expect(showToastMock).toHaveBeenCalledWith({ type: 'success', message: 'settings:sites.toasts.saved' });
  });

  it('confirmDelete() DELETEs the selected site, then refreshes and closes', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url) === `/orgs/sites/${SITE.id}` && init?.method === 'DELETE') return jsonResponse({});
      return jsonResponse({ data: [] });
    });
    const { result } = renderHook(() => useSiteCrud(ORG_ID, { onUnauthorized, t }));

    act(() => result.current.openDelete(SITE));
    await act(async () => {
      await result.current.confirmDelete();
    });

    const deleteCall = fetchMock.mock.calls.find(
      ([url, init]) => url === `/orgs/sites/${SITE.id}` && (init as RequestInit)?.method === 'DELETE',
    );
    expect(deleteCall).toBeTruthy();
    expect((deleteCall![1] as { orgIdOverride?: string }).orgIdOverride).toBe(ORG_ID);
    expect(result.current.siteModalMode).toBe('closed');
    expect(showToastMock).toHaveBeenCalledWith({ type: 'success', message: 'settings:sites.toasts.deleted' });
  });

  it('a non-401 submit failure leaves the modal open and surfaces a toast (via runAction, not a thrown rejection)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, false, 500));
    const { result } = renderHook(() => useSiteCrud(ORG_ID, { onUnauthorized, t }));

    act(() => result.current.openAdd());
    await act(async () => {
      await result.current.submit({ name: 'X' });
    });

    expect(result.current.siteModalMode).toBe('add');
    // runAction itself calls showToast for a non-2xx body before throwing
    // ActionError — this is the "surfaced via toast" half of the contract,
    // not just "the modal happened to stay open".
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('a non-401 confirmDelete failure leaves the modal open and surfaces a toast', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, false, 500));
    const { result } = renderHook(() => useSiteCrud(ORG_ID, { onUnauthorized, t }));

    act(() => result.current.openDelete(SITE));
    await act(async () => {
      await result.current.confirmDelete();
    });

    expect(result.current.siteModalMode).toBe('delete');
    expect(result.current.selectedSite).toEqual(SITE);
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('getSiteFormDefaults maps address/contact sub-objects to the flat form shape', () => {
    const { result } = renderHook(() => useSiteCrud(ORG_ID, { onUnauthorized, t }));
    const defaults = result.current.getSiteFormDefaults({
      ...SITE,
      address: { line1: '1 Main St', city: 'Springfield' },
      contact: { name: 'Jo', email: 'jo@example.com' },
    });
    expect(defaults).toMatchObject({
      name: SITE.name,
      timezone: SITE.timezone,
      addressLine1: '1 Main St',
      city: 'Springfield',
      contactName: 'Jo',
      contactEmail: 'jo@example.com',
      contactPhone: '',
    });
  });

  it('getSiteFormDefaults keeps numeric jsonb values and blanks other non-strings', () => {
    const { result } = renderHook(() => useSiteCrud(ORG_ID, { onUnauthorized, t }));
    const defaults = result.current.getSiteFormDefaults({
      ...SITE,
      address: { postalCode: 62701, line1: { nested: true } },
      contact: { phone: 5551234 },
    });
    expect(defaults).toMatchObject({ postalCode: '62701', addressLine1: '', contactPhone: '5551234' });
  });

  it('refresh() with no org (null, no override) resolves null without a request', async () => {
    const { result } = renderHook(() => useSiteCrud(null, { onUnauthorized, t }));
    let value: unknown;
    await act(async () => {
      value = await result.current.refresh();
    });
    expect(value).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('fleet mode (#9794)', () => {
    const ORG_A = 'org-a';
    const ORG_B = 'org-b';
    const SITE_A = { ...SITE, id: 'site-a', orgId: ORG_A, orgName: 'Alpha' };
    const SITE_B = { ...SITE, id: 'site-b', orgId: ORG_B, orgName: 'Bravo' };
    const findWrite = (method: string) =>
      fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === method);

    it('refresh() with no org lists every accessible site with NO organizationId and no org pin', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: [SITE_A, SITE_B] }));
      const { result } = renderHook(() => useSiteCrud(null, { onUnauthorized, t, fleet: true }));

      let value: unknown;
      await act(async () => {
        value = await result.current.refresh();
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('/orgs/sites?page=1&limit=100');
      // null = inject nothing, so a stale ambient org can never narrow the fleet list.
      expect((init as { orgIdOverride?: string | null }).orgIdOverride).toBeNull();
      expect(value).toEqual([SITE_A, SITE_B]);
      expect(result.current.sites.map((s) => s.orgId)).toEqual([ORG_A, ORG_B]);
    });

    it('refresh() with an org selected still lists that org only', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: [SITE_A] }));
      const { result } = renderHook(() => useSiteCrud(ORG_A, { onUnauthorized, t, fleet: true }));
      await act(async () => {
        await result.current.refresh();
      });
      expect(fetchMock).toHaveBeenCalledWith(
        `/orgs/sites?organizationId=${ORG_A}&page=1&limit=100`,
        expect.objectContaining({ orgIdOverride: ORG_A }),
      );
    });

    it('add in fleet view without an org pick issues no write', async () => {
      const { result } = renderHook(() => useSiteCrud(null, { onUnauthorized, t, fleet: true }));
      act(() => result.current.openAdd());
      expect(result.current.writeOrgId).toBeNull();
      await act(async () => {
        await result.current.submit({ name: 'New Site' });
      });
      expect(findWrite('POST')).toBeUndefined();
      expect(result.current.siteModalMode).toBe('add');
    });

    it('add in fleet view writes to the picked org', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
      const { result } = renderHook(() => useSiteCrud(null, { onUnauthorized, t, fleet: true }));
      act(() => result.current.openAdd());
      act(() => result.current.setWriteOrgId(ORG_B));
      await act(async () => {
        await result.current.submit({ name: 'New Site' });
      });
      const post = findWrite('POST')!;
      expect(JSON.parse((post[1] as RequestInit).body as string).orgId).toBe(ORG_B);
      expect((post[1] as { orgIdOverride?: string }).orgIdOverride).toBe(ORG_B);
    });

    it('an org switch mid-add does not retarget the write (org captured at openAdd)', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
      const { result, rerender } = renderHook(
        ({ orgId }: { orgId: string | null }) => useSiteCrud(orgId, { onUnauthorized, t, fleet: true }),
        { initialProps: { orgId: ORG_A as string | null } },
      );
      act(() => result.current.openAdd(ORG_A));
      rerender({ orgId: ORG_B });
      await act(async () => {
        await result.current.submit({ name: 'New Site' });
      });
      const post = findWrite('POST')!;
      expect(JSON.parse((post[1] as RequestInit).body as string).orgId).toBe(ORG_A);
      expect((post[1] as { orgIdOverride?: string }).orgIdOverride).toBe(ORG_A);
    });

    it('openAdd() ignores a non-string argument (an onClick MouseEvent) and falls back to the bound org', () => {
      const { result } = renderHook(() => useSiteCrud(ORG_A, { onUnauthorized, t }));
      act(() => (result.current.openAdd as (arg?: unknown) => void)({ type: 'click' }));
      expect(result.current.writeOrgId).toBe(ORG_A);
    });

    it("edit and delete in fleet view target the row's own org", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
      const { result } = renderHook(() => useSiteCrud(null, { onUnauthorized, t, fleet: true }));

      act(() => result.current.openEdit(SITE_B));
      await act(async () => {
        await result.current.submit({ name: 'Renamed' });
      });
      const patch = findWrite('PATCH')!;
      expect(patch[0]).toBe(`/orgs/sites/${SITE_B.id}`);
      expect(JSON.parse((patch[1] as RequestInit).body as string).orgId).toBe(ORG_B);
      expect((patch[1] as { orgIdOverride?: string }).orgIdOverride).toBe(ORG_B);

      act(() => result.current.openDelete(SITE_A));
      await act(async () => {
        await result.current.confirmDelete();
      });
      const del = findWrite('DELETE')!;
      expect(del[0]).toBe(`/orgs/sites/${SITE_A.id}`);
      expect((del[1] as { orgIdOverride?: string }).orgIdOverride).toBe(ORG_A);
    });

    it('a slower, superseded refresh never overwrites the newer org\'s list', async () => {
      let resolveSlow!: (r: Response) => void;
      fetchMock.mockImplementation((url: string) =>
        String(url).includes(`organizationId=${ORG_A}`)
          ? new Promise<Response>((resolve) => { resolveSlow = resolve; })
          : Promise.resolve(jsonResponse({ data: [SITE_B] })),
      );
      const { result, rerender } = renderHook(
        ({ orgId }: { orgId: string | null }) => useSiteCrud(orgId, { onUnauthorized, t, fleet: true }),
        { initialProps: { orgId: ORG_A as string | null } },
      );

      let slow!: Promise<unknown>;
      act(() => { slow = result.current.refresh(); });
      rerender({ orgId: ORG_B });
      await act(async () => {
        await result.current.refresh();
      });
      expect(result.current.sites).toEqual([SITE_B]);

      await act(async () => {
        resolveSlow(jsonResponse({ data: [SITE_A] }));
        await slow;
      });
      expect(result.current.sites).toEqual([SITE_B]);
      expect(result.current.sitesLoading).toBe(false);
    });

    it('a write with no resolvable org is refused loudly, not silently', async () => {
      const { result } = renderHook(() => useSiteCrud(null, { onUnauthorized, t, fleet: true }));
      const orphan = { ...SITE, id: 'site-x' }; // a row without orgId
      act(() => result.current.openEdit(orphan));
      await act(async () => {
        await result.current.submit({ name: 'Renamed' });
      });
      act(() => result.current.openDelete(orphan));
      await act(async () => {
        await result.current.confirmDelete();
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(showToastMock).toHaveBeenCalledTimes(2);
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });

    it('an MFA-required 403 on the write keeps the modal open and surfaces it (same path as OrgSitesTab)', async () => {
      fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? jsonResponse({ error: 'MFA required', code: 'MFA_REQUIRED' }, false, 403)
          : jsonResponse({ data: [] }),
      );
      const { result } = renderHook(() => useSiteCrud(null, { onUnauthorized, t, fleet: true }));
      act(() => result.current.openAdd(ORG_A));
      await act(async () => {
        await result.current.submit({ name: 'New Site' });
      });
      expect(findWrite('POST')).toBeDefined();
      expect(result.current.siteModalMode).toBe('add');
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
      expect(onUnauthorized).not.toHaveBeenCalled();
    });
  });
});
