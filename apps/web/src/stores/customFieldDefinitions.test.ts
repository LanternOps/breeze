import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth } from './auth';
import { useCustomFieldDefinitionsStore } from './customFieldDefinitions';

const fetchMock = vi.mocked(fetchWithAuth);

const res = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('customFieldDefinitionsStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCustomFieldDefinitionsStore.setState({ definitions: [], status: 'idle' });
  });

  it('loads definitions from GET /custom-fields', async () => {
    const defs = [
      { id: '1', orgId: null, partnerId: 'p1', name: 'Windows Activation', fieldKey: 'bdr_windows_activation', type: 'text', options: null, required: false, defaultValue: null, deviceTypes: ['windows'] },
    ];
    fetchMock.mockResolvedValueOnce(res({ data: defs, total: 1 }));

    await useCustomFieldDefinitionsStore.getState().fetchCustomFieldDefinitions();

    expect(fetchMock).toHaveBeenCalledWith('/custom-fields');
    expect(useCustomFieldDefinitionsStore.getState().definitions).toEqual(defs);
    expect(useCustomFieldDefinitionsStore.getState().status).toBe('loaded');
  });

  it('is idempotent — a second call while loaded does not refetch', async () => {
    fetchMock.mockResolvedValue(res({ data: [] }));
    await useCustomFieldDefinitionsStore.getState().fetchCustomFieldDefinitions();
    await useCustomFieldDefinitionsStore.getState().fetchCustomFieldDefinitions();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a failed fetch leaves definitions empty and marks status error, not loaded', async () => {
    fetchMock.mockResolvedValueOnce(res({}, false, 403));
    await useCustomFieldDefinitionsStore.getState().fetchCustomFieldDefinitions();
    expect(useCustomFieldDefinitionsStore.getState().definitions).toEqual([]);
    expect(useCustomFieldDefinitionsStore.getState().status).toBe('error');
  });

  it('a malformed body degrades to an empty list rather than throwing', async () => {
    fetchMock.mockResolvedValueOnce(res({ data: 'not-an-array' }));
    await useCustomFieldDefinitionsStore.getState().fetchCustomFieldDefinitions();
    expect(useCustomFieldDefinitionsStore.getState().definitions).toEqual([]);
    expect(useCustomFieldDefinitionsStore.getState().status).toBe('loaded');
  });
});
