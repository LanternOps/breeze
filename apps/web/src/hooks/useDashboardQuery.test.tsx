import { renderHook, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let currentOrgId: string | null = 'org-a';
const fetchWithAuth = vi.fn();

vi.mock('../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null }) => unknown) => selector({ currentOrgId }),
}));

import { useDashboardQuery } from './useDashboardQuery';

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** A response whose body resolves only when the returned `settle` is called. */
function deferredResponse(body: unknown) {
  let settle!: () => void;
  const gate = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const response = {
    ok: true,
    status: 200,
    json: async () => {
      await gate;
      return body;
    },
  } as unknown as Response;
  return { response, settle };
}

describe('useDashboardQuery staleScope', () => {
  beforeEach(() => {
    currentOrgId = 'org-a';
    fetchWithAuth.mockReset();
  });

  it('is false for a settled load and for a plain refresh-token poll', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse({ total: 5 }));

    const { result, rerender } = renderHook(
      ({ tick }: { tick: number }) => useDashboardQuery<{ total: number }>('/devices/stats', tick, (j: any) => j),
      { initialProps: { tick: 0 } }
    );

    await waitFor(() => expect(result.current.data).toEqual({ total: 5 }));
    expect(result.current.staleScope).toBe(false);

    rerender({ tick: 1 });
    // A same-scope poll keeps the cached value trusted throughout.
    expect(result.current.staleScope).toBe(false);
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.staleScope).toBe(false);
  });

  it('flags the cached value while an org switch is in flight, and clears it on arrival', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonResponse({ total: 42 }));

    const { result, rerender } = renderHook(
      ({ tick }: { tick: number }) => useDashboardQuery<{ total: number }>('/devices/stats', tick, (j: any) => j),
      { initialProps: { tick: 0 } }
    );
    await waitFor(() => expect(result.current.data).toEqual({ total: 42 }));

    // Switch to an org whose response hasn't landed yet. The old count is
    // still in `data` — it must be marked as belonging to the old scope.
    const { response, settle } = deferredResponse({ total: 0 });
    fetchWithAuth.mockResolvedValueOnce(response);
    currentOrgId = 'org-b';
    rerender({ tick: 0 });

    expect(result.current.data).toEqual({ total: 42 });
    expect(result.current.staleScope).toBe(true);

    await act(async () => {
      settle();
    });
    await waitFor(() => expect(result.current.data).toEqual({ total: 0 }));
    expect(result.current.staleScope).toBe(false);
  });

  it('keeps the flag set when the post-switch refetch fails', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonResponse({ total: 42 }));

    const { result, rerender } = renderHook(
      ({ tick }: { tick: number }) => useDashboardQuery<{ total: number }>('/devices/stats', tick, (j: any) => j),
      { initialProps: { tick: 0 } }
    );
    await waitFor(() => expect(result.current.data).toEqual({ total: 42 }));

    fetchWithAuth.mockRejectedValueOnce(new Error('network down'));
    currentOrgId = 'org-b';
    rerender({ tick: 0 });

    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    // Stale data survives the failure (deliberate) but stays untrusted.
    expect(result.current.data).toEqual({ total: 42 });
    expect(result.current.staleScope).toBe(true);
  });

  it('clears the flag when the post-switch request is permission-hidden', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonResponse({ total: 42 }));

    const { result, rerender } = renderHook(
      ({ tick }: { tick: number }) => useDashboardQuery<{ total: number }>('/devices/stats', tick, (j: any) => j),
      { initialProps: { tick: 0 } }
    );
    await waitFor(() => expect(result.current.data).toEqual({ total: 42 }));

    fetchWithAuth.mockResolvedValueOnce({ ok: false, status: 403 } as unknown as Response);
    currentOrgId = 'org-b';
    rerender({ tick: 0 });

    await waitFor(() => expect(result.current.unavailable).toBe(true));
    // A 403 clears `data` outright, so there is no stale value left to flag.
    expect(result.current.data).toBeNull();
    expect(result.current.staleScope).toBe(false);
  });
});
