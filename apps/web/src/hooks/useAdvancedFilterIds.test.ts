import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FilterConditionGroup } from '@breeze/shared';

import { useAdvancedFilterIds } from './useAdvancedFilterIds';
import { fetchWithAuth } from '../stores/auth';

vi.mock('../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const filter: FilterConditionGroup = {
  operator: 'AND',
  conditions: [{ field: 'status', operator: 'equals', value: 'online' }],
};

function mockPreviewResponse(deviceIds: string[]) {
  vi.mocked(fetchWithAuth).mockResolvedValue({
    ok: true,
    json: async () => ({ data: { totalCount: deviceIds.length, deviceIds, evaluatedAt: new Date().toISOString() } }),
  } as unknown as Response);
}

describe('useAdvancedFilterIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null ids (no filtering) when no filter is active', () => {
    const { result } = renderHook(() => useAdvancedFilterIds(null));

    expect(result.current.ids).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('returns null ids when the filter has no condition with a real value', () => {
    const empty: FilterConditionGroup = {
      operator: 'AND',
      conditions: [{ field: 'hostname', operator: 'contains', value: '' }],
    };
    const { result } = renderHook(() => useAdvancedFilterIds(empty));

    expect(result.current.ids).toBeNull();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('requests idsOnly (no limit cap) and resolves the complete id set', async () => {
    // 250 matches — past the old 100-row preview cap that silently hid devices.
    const manyIds = Array.from({ length: 250 }, (_, i) => `dev-${i}`);
    mockPreviewResponse(manyIds);

    const { result } = renderHook(() => useAdvancedFilterIds(filter));

    await waitFor(() => expect(result.current.ids).not.toBeNull());

    expect(result.current.ids?.size).toBe(250);
    expect(result.current.ids?.has('dev-249')).toBe(true);
    expect(result.current.loading).toBe(false);

    expect(fetchWithAuth).toHaveBeenCalledWith('/filters/preview', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(vi.mocked(fetchWithAuth).mock.calls[0][1]?.body as string);
    expect(body.idsOnly).toBe(true);
    expect(body.conditions).toEqual(filter);
    expect(body.limit).toBeUndefined();
  });

  it('clears the id set when the filter is removed', async () => {
    mockPreviewResponse(['dev-1']);

    const { result, rerender } = renderHook(
      ({ f }: { f: FilterConditionGroup | null }) => useAdvancedFilterIds(f),
      { initialProps: { f: filter as FilterConditionGroup | null } }
    );

    await waitFor(() => expect(result.current.ids?.size).toBe(1));

    rerender({ f: null });

    expect(result.current.ids).toBeNull();
  });

  it('drops the id set (fails open) when the request errors', async () => {
    vi.mocked(fetchWithAuth).mockRejectedValue(new Error('network down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useAdvancedFilterIds(filter));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.ids).toBeNull();
    consoleSpy.mockRestore();
  });
});
