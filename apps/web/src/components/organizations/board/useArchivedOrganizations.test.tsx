import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import type { Organization } from '@/components/settings/organizationTypes';
import { fetchWithAuth } from '@/stores/auth';
import { ARCHIVED_SEARCH_DEBOUNCE_MS, useArchivedOrganizations } from './useArchivedOrganizations';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);

const LIVE: Organization = { id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Alpha Ltd', status: 'active', createdAt: '2026-01-01T00:00:00Z' };
const GAMMA: Organization = { id: 'cccccccc-3333-4333-8333-333333333333', name: 'Gamma LLC', status: 'archived', createdAt: '2026-01-03T00:00:00Z', archived: true, purgeAt: '2026-10-13T00:00:00.000Z' };
const DELTA: Organization = { id: 'dddddddd-4444-4444-8444-444444444444', name: 'Delta Inc', status: 'archived', createdAt: '2026-01-04T00:00:00Z', archived: true, purgeAt: null };

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

/** Mimics the API's server-side `search` over the archived rows (orgs.ts / archivedOrgReads.ts). */
function mockApi(opts: { archived?: Organization[]; truncated?: boolean } = {}) {
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://localhost');
    const search = url.searchParams.get('search')?.toLowerCase();
    const archived = (opts.archived ?? [GAMMA, DELTA]).filter((o) => (search ? o.name.toLowerCase().includes(search) : true));
    return jsonResponse({ data: [LIVE, ...archived], pagination: { page: 1, limit: 100, total: 1 }, archivedTruncated: opts.truncated ?? false });
  });
}
const archivedCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('includeArchived=true'));
const flush = async (ms = ARCHIVED_SEARCH_DEBOUNCE_MS + 50) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => { vi.useFakeTimers(); fetchMock.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('useArchivedOrganizations', () => {
  it('does not fetch while disabled, even if the search changes', async () => {
    mockApi();
    const { rerender } = renderHook(({ enabled, search }) => useArchivedOrganizations({ enabled, search }), { initialProps: { enabled: false, search: '' } });
    rerender({ enabled: false, search: 'gam' });
    await flush();
    expect(archivedCalls()).toHaveLength(0);
  });

  it('fetches with includeArchived=true after the debounce, keeps only archived rows and reports truncation', async () => {
    mockApi({ truncated: true });
    const { result } = renderHook(() => useArchivedOrganizations({ enabled: true, search: '' }));
    await flush(ARCHIVED_SEARCH_DEBOUNCE_MS - 50);
    expect(archivedCalls()).toHaveLength(0);
    await flush(100);
    expect(archivedCalls()).toHaveLength(1);
    expect(String(archivedCalls()[0][0])).toContain('includeArchived=true');
    expect(result.current.archivedOrgs.map((o) => o.id)).toEqual([GAMMA.id, DELTA.id]);
    expect(result.current.truncated).toBe(true);
    expect(result.current.loaded).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it('forwards the search term as the API `search` param and the server narrows the rows', async () => {
    mockApi();
    const { result, rerender } = renderHook(({ search }) => useArchivedOrganizations({ enabled: true, search }), { initialProps: { search: '' } });
    await flush();
    rerender({ search: 'gamma' });
    await flush();
    expect(String(archivedCalls()[1][0])).toContain('search=gamma');
    expect(result.current.archivedOrgs.map((o) => o.id)).toEqual([GAMMA.id]);
  });

  it('drops a stale response that resolves after a newer one, even though it started first', async () => {
    const holds: Array<{ search: string | null; resolve: (r: Response) => void }> = [];
    fetchMock.mockImplementation((input) => new Promise<Response>((resolve) => {
      holds.push({ search: new URL(String(input), 'http://localhost').searchParams.get('search'), resolve });
    }));
    const { result, rerender } = renderHook(({ search }) => useArchivedOrganizations({ enabled: true, search }), { initialProps: { search: '' } });
    await flush();
    rerender({ search: 'delta' });
    await flush();
    expect(holds.map((h) => h.search)).toEqual([null, 'delta']);

    await act(async () => { holds[1].resolve(jsonResponse({ data: [LIVE, DELTA], archivedTruncated: false })); });
    expect(result.current.archivedOrgs.map((o) => o.id)).toEqual([DELTA.id]);
    await act(async () => { holds[0].resolve(jsonResponse({ data: [LIVE, GAMMA, DELTA], archivedTruncated: false })); });
    expect(result.current.archivedOrgs.map((o) => o.id)).toEqual([DELTA.id]);
    expect(result.current.loading).toBe(false);
  });

  it('surfaces a failed fetch as an error message', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'nope' }, false, 500));
    const { result } = renderHook(() => useArchivedOrganizations({ enabled: true, search: '' }));
    await flush();
    expect(result.current.error).toBe('Failed to load archived organizations');
  });

  it('remove() drops a row locally (after a restore)', async () => {
    mockApi();
    const { result } = renderHook(() => useArchivedOrganizations({ enabled: true, search: '' }));
    await flush();
    act(() => result.current.remove(GAMMA.id));
    expect(result.current.archivedOrgs.map((o) => o.id)).toEqual([DELTA.id]);
  });
});
