import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { useDeviceFilterFields } from './useDeviceFilterFields';
import { FILTER_FIELDS } from './filterFields';
import { useCustomFieldDefinitionsStore, type CustomFieldDefinition } from '../../stores/customFieldDefinitions';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
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

beforeEach(() => {
  vi.clearAllMocks();
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
});
