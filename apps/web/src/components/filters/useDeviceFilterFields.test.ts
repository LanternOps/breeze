import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { useDeviceFilterFields } from './useDeviceFilterFields';
import { FILTER_FIELDS } from './filterFields';
import { useCustomFieldDefinitionsStore, type CustomFieldDefinition } from '../../stores/customFieldDefinitions';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
const mockFetch = vi.mocked(fetchWithAuth);

const DEF: CustomFieldDefinition = {
  id: 'cf-1',
  orgId: null,
  partnerId: 'p-1',
  name: 'Asset disposition',
  fieldKey: 'asset_disposition',
  type: 'dropdown',
  options: null,
  required: false,
  defaultValue: null,
  deviceTypes: null,
};

beforeEach(async () => {
  vi.clearAllMocks();
  await import('../../stores/orgStore'); // let the store's lazy org-scope subscription attach
  await new Promise((r) => setTimeout(r, 0));
  useCustomFieldDefinitionsStore.setState({ definitions: [], status: 'idle' });
});

describe('useDeviceFilterFields (#8843)', () => {
  it('returns the static catalog itself while no definitions are loaded (fetch failed)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    const { result } = renderHook(() => useDeviceFilterFields());

    await waitFor(() => expect(useCustomFieldDefinitionsStore.getState().status).toBe('error'));
    expect(result.current).toBe(FILTER_FIELDS);
  });

  it('appends custom.<key> fields and keeps a stable reference across re-renders', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [DEF] }) } as unknown as Response);
    const { result, rerender } = renderHook(() => useDeviceFilterFields());

    await waitFor(() => expect(result.current).toHaveLength(FILTER_FIELDS.length + 1));
    expect(result.current.at(-1)).toMatchObject({ key: 'custom.asset_disposition', label: 'Asset disposition', category: 'custom' });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // FilterBuilder children memo on this array — a fresh array per render
    // would re-derive every ConditionRow on each parent render.
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);

    // A new definitions list (e.g. after a refetch) yields a new catalog.
    act(() => useCustomFieldDefinitionsStore.setState({ definitions: [DEF, { ...DEF, id: 'cf-2', fieldKey: 'k2', name: 'K2' }] }));
    expect(result.current).not.toBe(first);
    expect(result.current).toHaveLength(FILTER_FIELDS.length + 2);
  });

  it('drops the previous org\'s definitions and refetches when the header org changes (#8946)', async () => {
    useOrgStore.setState({ currentOrgId: 'org-a', currentPartnerId: 'p-1', allOrgs: false });
    const DEF_B = { ...DEF, id: 'cf-b', fieldKey: 'org_b_only', name: 'Org B only' };
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [DEF] }) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [DEF_B] }) } as unknown as Response);
    const { result } = renderHook(() => useDeviceFilterFields());
    await waitFor(() => expect(result.current.at(-1)).toMatchObject({ key: 'custom.asset_disposition' }));

    act(() => useOrgStore.setState({ currentOrgId: 'org-b' }));

    await waitFor(() => expect(result.current.at(-1)).toMatchObject({ key: 'custom.org_b_only' }));
    expect(result.current.some((f) => f.key === 'custom.asset_disposition')).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('discards a response that was in flight for the previous org (#8946)', async () => {
    useOrgStore.setState({ currentOrgId: 'org-a', currentPartnerId: 'p-1', allOrgs: false });
    let resolveA!: (r: Response) => void;
    mockFetch
      .mockReturnValueOnce(new Promise<Response>((r) => { resolveA = r; }))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) } as unknown as Response);
    const { result } = renderHook(() => useDeviceFilterFields());
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    act(() => useOrgStore.setState({ currentOrgId: 'org-b' }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveA({ ok: true, status: 200, json: async () => ({ data: [DEF] }) } as unknown as Response);
    });
    expect(result.current).toBe(FILTER_FIELDS);
  });
});
