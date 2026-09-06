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

    expect(fetchMock).toHaveBeenCalledWith(
      `/orgs/sites?organizationId=${ORG_ID}`,
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
      '/orgs/sites?organizationId=brand-new-org',
      expect.objectContaining({ orgIdOverride: 'brand-new-org' }),
    );
  });

  it('refresh() fails closed (null) on a malformed 200 body, without touching sites state destructively', async () => {
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

  it('refresh() with no org (null, no override) resolves null without a request', async () => {
    const { result } = renderHook(() => useSiteCrud(null, { onUnauthorized, t }));
    let value: unknown;
    await act(async () => {
      value = await result.current.refresh();
    });
    expect(value).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
