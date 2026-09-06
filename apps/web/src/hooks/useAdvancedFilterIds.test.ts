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
    expect(result.current.error).toBe(false);
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

  it('issues the preview request for a no-value operator (e.g. the "Untagged" quick filter) despite value being \'\'', async () => {
    // Regression: hasValidConditions used to reject any condition with
    // value === '', which silently dropped no-value operators like isEmpty
    // (Untagged), isNotEmpty, isNull, isNotNull — the hook fell back to "no
    // filter" and the whole fleet came back instead of the filtered set.
    mockPreviewResponse(['dev-1']);
    const untagged: FilterConditionGroup = {
      operator: 'AND',
      conditions: [{ field: 'tags', operator: 'isEmpty', value: '' }],
    };

    const { result } = renderHook(() => useAdvancedFilterIds(untagged));

    await waitFor(() => expect(result.current.ids).not.toBeNull());

    expect(fetchWithAuth).toHaveBeenCalledWith('/filters/preview', expect.objectContaining({ method: 'POST' }));
    expect(result.current.ids?.size).toBe(1);
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

  it('fails CLOSED (empty set + error flag) on a network failure — never an unfiltered list (#4732)', async () => {
    vi.mocked(fetchWithAuth).mockRejectedValue(new Error('network down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useAdvancedFilterIds(filter));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Regression #4732: this used to be `null` ("show everything"), which
    // widened the result on a failed filter instead of narrowing it.
    expect(result.current.ids).not.toBeNull();
    expect(result.current.ids?.size).toBe(0);
    expect(result.current.error).toBe(true);
    consoleSpy.mockRestore();
  });

  it('fails CLOSED (empty set + error flag) on a 403 — a pinned orgId the caller cannot access (#4732)', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'forbidden' }),
    } as unknown as Response);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useAdvancedFilterIds(filter));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.ids).not.toBeNull();
    expect(result.current.ids?.size).toBe(0);
    expect(result.current.error).toBe(true);
    consoleSpy.mockRestore();
  });

  it('fails CLOSED (empty set + error flag) on a 500', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'internal_error' }),
    } as unknown as Response);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useAdvancedFilterIds(filter));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.ids).not.toBeNull();
    expect(result.current.ids?.size).toBe(0);
    expect(result.current.error).toBe(true);
    consoleSpy.mockRestore();
  });

  it('does not set the error flag on a 401, but still fails ids closed — the auth-redirect path owns the failure UX', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'unauthorized' }),
    } as unknown as Response);

    const { result } = renderHook(() => useAdvancedFilterIds(filter));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // fetchWithAuth USUALLY triggers the session-expiry redirect on an
    // unrecoverable 401 (stores/auth.ts handleSessionExpired) before this
    // hook ever sees the response, so `error` (which drives the toast/pill)
    // stays false — piling a second, competing error message on top of a
    // page that's about to navigate away would be confusing.
    expect(result.current.error).toBe(false);
    // But `ids` must still fail CLOSED unconditionally: two of
    // fetchWithAuth's retry-after-refresh branches can return a SURVIVING
    // 401 without ever calling handleSessionExpired (no redirect in
    // flight). If `ids` stayed null in that case, the list would fall back
    // to "no filter active" and render the full unfiltered fleet — exactly
    // the #4732 bug this hook exists to prevent, just gated behind a rarer
    // trigger. So `ids` empties regardless of whether a redirect is (or
    // isn't) actually in flight for this particular 401.
    expect(result.current.ids).not.toBeNull();
    expect(result.current.ids?.size).toBe(0);
  });

  it('clears a prior error once the filter succeeds again', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'internal_error' }),
    } as unknown as Response);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result, rerender } = renderHook(
      ({ f }: { f: FilterConditionGroup }) => useAdvancedFilterIds(f),
      { initialProps: { f: filter } }
    );

    await waitFor(() => expect(result.current.error).toBe(true));

    mockPreviewResponse(['dev-1']);
    const retried: FilterConditionGroup = {
      operator: 'AND',
      conditions: [{ field: 'status', operator: 'equals', value: 'offline' }],
    };
    rerender({ f: retried });

    // Wait on `ids` (the value the success path sets LAST, after `error`),
    // not on `error` — `error` resets to false synchronously at the START of
    // every effect run (including this retry), well before the retried
    // fetch resolves. Waiting on `error` alone is satisfied by that
    // synchronous reset and can read `ids` before the retry's response has
    // landed, flaking the very next assertion (confirmed: failed on direct
    // isolated re-run during PR #4783 review).
    await waitFor(() => expect(result.current.ids?.size).toBe(1));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(false);
    consoleSpy.mockRestore();
  });
});
