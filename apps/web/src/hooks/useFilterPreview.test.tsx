import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFilterPreview } from './useFilterPreview';
import { fetchWithAuth } from '../stores/auth';
import type { FilterConditionGroup } from '@breeze/shared';
vi.mock('../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const mockFetch = vi.mocked(fetchWithAuth);
const filter: FilterConditionGroup = { operator: 'AND', conditions: [{ field: 'hostname', operator: 'contains', value: 'web' }] };
beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { count: 1, devices: [] } }) } as Response);
});
describe('useFilterPreview owner scope', () => {
  it('previews all organizations without ambient or explicit org injection', async () => {
    renderHook(() => useFilterPreview(filter, { allOrgs: true, orgId: 'org-1', debounceMs: 0 }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/filters/preview', expect.objectContaining({ method: 'POST', skipOrgIdInjection: true })));
  });
  it('refetches when allOrgs changes and restores the explicit org scope', async () => {
    const { rerender } = renderHook(({ allOrgs }) => useFilterPreview(filter, { allOrgs, orgId: 'org-1', debounceMs: 0 }), { initialProps: { allOrgs: false } });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/filters/preview?orgId=org-1', expect.not.objectContaining({ skipOrgIdInjection: true })));
    rerender({ allOrgs: true });
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith('/filters/preview', expect.objectContaining({ skipOrgIdInjection: true })));
    rerender({ allOrgs: false });
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith('/filters/preview?orgId=org-1', expect.not.objectContaining({ skipOrgIdInjection: true })));
  });
});
