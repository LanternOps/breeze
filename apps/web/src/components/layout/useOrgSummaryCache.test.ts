import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock, claimsRef } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  claimsRef: { current: null as unknown },
}));

vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => claimsRef.current }));
vi.mock('@/components/organizations/record/orgRecordFetch', () => ({
  makeOrgFetch: vi.fn(() => fetchMock),
}));

import { SUMMARY_INTENT_DELAY_MS, useOrgSummaryCache } from './useOrgSummaryCache';

const summaryFor = (orgId: string) => ({ orgId, sites: { count: 1 } });
const okFor = (path: string) => {
  const orgId = path.split('/')[3];
  return Promise.resolve({ ok: true, status: 200, json: async () => summaryFor(orgId) });
};

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset().mockImplementation(okFor);
  claimsRef.current = {
    status: 'resolved',
    claims: { scope: 'partner', orgId: null, partnerId: 'p1' },
  };
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useOrgSummaryCache', () => {
  it('fetches once per org after the intent delay and serves repeats from the cache', async () => {
    const { result, rerender } = renderHook(
      ({ orgId, active }) => useOrgSummaryCache(orgId, active),
      { initialProps: { orgId: 'org-a' as string | null, active: true } },
    );
    await advance(SUMMARY_INTENT_DELAY_MS - 20);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.status).toBe('loading');

    await advance(20);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/orgs/organizations/org-a/summary');
    expect(result.current.status).toBe('ready');
    expect(result.current.summary).toEqual(summaryFor('org-a'));

    rerender({ orgId: 'org-b', active: true });
    await advance(SUMMARY_INTENT_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    rerender({ orgId: 'org-a', active: true });
    expect(result.current.status).toBe('ready');
    await advance(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a pass-through highlight shorter than the delay never fetches', async () => {
    const { rerender } = renderHook(({ orgId }) => useOrgSummaryCache(orgId, true), {
      initialProps: { orgId: 'org-a' },
    });
    await advance(50);
    rerender({ orgId: 'org-b' });
    await advance(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/orgs/organizations/org-b/summary');
  });

  it('a late response for a previous org never surfaces under the current one', async () => {
    let resolveA: (v: unknown) => void = () => {};
    fetchMock.mockImplementation((path: string) =>
      path.includes('org-a')
        ? new Promise((resolve) => {
            resolveA = resolve;
          })
        : okFor(path),
    );
    const { result, rerender } = renderHook(({ orgId }) => useOrgSummaryCache(orgId, true), {
      initialProps: { orgId: 'org-a' },
    });
    await advance(SUMMARY_INTENT_DELAY_MS);
    rerender({ orgId: 'org-b' });
    await advance(SUMMARY_INTENT_DELAY_MS);
    expect(result.current.summary?.orgId).toBe('org-b');

    await act(async () => {
      resolveA({ ok: true, status: 200, json: async () => summaryFor('org-a') });
      await Promise.resolve();
    });
    expect(result.current.summary?.orgId).toBe('org-b');
  });

  it('a 403 marks the session forbidden: no later org fetches, even after close and reopen', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) });
    const { result, rerender } = renderHook(
      ({ orgId, active }) => useOrgSummaryCache(orgId, active),
      { initialProps: { orgId: 'org-a', active: true } },
    );
    await advance(SUMMARY_INTENT_DELAY_MS);
    expect(result.current.status).toBe('error');

    rerender({ orgId: 'org-b', active: true });
    rerender({ orgId: 'org-b', active: false });
    rerender({ orgId: 'org-b', active: true });
    await advance(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('closing the panel clears the cache; reopening refetches', async () => {
    const { result, rerender } = renderHook(
      ({ active }) => useOrgSummaryCache('org-a', active),
      { initialProps: { active: true } },
    );
    await advance(SUMMARY_INTENT_DELAY_MS);
    expect(result.current.status).toBe('ready');

    rerender({ active: false });
    rerender({ active: true });
    await advance(SUMMARY_INTENT_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('an org-scoped session never fetches', async () => {
    claimsRef.current = {
      status: 'resolved',
      claims: { scope: 'organization', orgId: 'org-a', partnerId: null },
    };
    const { result } = renderHook(() => useOrgSummaryCache('org-a', true));
    await advance(500);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('a 200 whose body is not a summary reports error instead of loading forever', async () => {
    for (const body of [null, { success: false }]) {
      fetchMock.mockReset().mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
      const { result, unmount } = renderHook(() => useOrgSummaryCache('org-a', true));
      await advance(SUMMARY_INTENT_DELAY_MS);
      expect(result.current.status).toBe('error');
      unmount();
    }
  });

  it('a response that lands after close and reopen is discarded (epoch guard)', async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    fetchMock.mockReset().mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = resolve; }),
    );
    const { result, rerender } = renderHook(({ active }) => useOrgSummaryCache('org-a', active), {
      initialProps: { active: true },
    });
    await advance(SUMMARY_INTENT_DELAY_MS);
    rerender({ active: false });
    rerender({ active: true });
    await act(async () => {
      resolveFirst({ ok: true, status: 200, json: async () => summaryFor('org-a') });
      await Promise.resolve();
    });
    expect(result.current.status).toBe('loading');
    fetchMock.mockImplementation(okFor);
    await advance(SUMMARY_INTENT_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('ready');
  });

  it('a 500 reports error without throwing', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const { result } = renderHook(() => useOrgSummaryCache('org-a', true));
    await advance(SUMMARY_INTENT_DELAY_MS);
    expect(result.current.status).toBe('error');
    expect(result.current.summary).toBeUndefined();
  });
});
