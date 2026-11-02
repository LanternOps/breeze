import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilterConditionGroup } from '@breeze/shared';

import { useFilterPreview } from './useFilterPreview';
import { fetchWithAuth } from '../stores/auth';

vi.mock('../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const mockFetch = vi.mocked(fetchWithAuth);
const FILTER: FilterConditionGroup = {
  operator: 'AND',
  conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }],
};

const lastBody = () => JSON.parse(String((mockFetch.mock.lastCall?.[1] as RequestInit | undefined)?.body));

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: { totalCount: 0, devices: [], evaluatedAt: '' } }),
  } as unknown as Response);
});

describe('useFilterPreview excludeDecommissioned (#9933)', () => {
  it('sends excludeDecommissioned when the caller asks for it', async () => {
    renderHook(() => useFilterPreview(FILTER, { debounceMs: 0, excludeDecommissioned: true }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(lastBody()).toMatchObject({ conditions: FILTER, excludeDecommissioned: true });
  });

  it('leaves it out by default, so other previews keep removed devices', async () => {
    renderHook(() => useFilterPreview(FILTER, { debounceMs: 0 }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(lastBody().excludeDecommissioned).toBeUndefined();
  });
});
