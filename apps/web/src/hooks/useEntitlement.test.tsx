import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchWithAuth, useAuthStore } from '../stores/auth';
import { entitlementsCache, resetEntitlementsCache } from '../lib/entitlementsCache';
import { useEntitlement, useEntitlements } from './useEntitlement';

vi.mock('../stores/auth', async () => {
  const { create } = await import('zustand');
  const useAuthStore = create<{ tokens: { accessToken: string } | null }>(() => ({
    tokens: { accessToken: 'header.e30.sig' },
  }));
  return { fetchWithAuth: vi.fn(), useAuthStore };
});

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const row = (overrides: Record<string, unknown>) => ({
  key: 'wisp',
  label: 'Wisp',
  why: 'Wisp triages your fleet continuously.',
  state: 'enabled',
  source: 'plan',
  limits: null,
  expiresAt: null,
  graceUntil: null,
  reason: null,
  ...overrides,
});

const snapshot = (entitlements: unknown[]) => ({ plan: 'pro', entitlements });

describe('useEntitlement', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    resetEntitlementsCache();
    (useAuthStore as unknown as { setState: (s: unknown) => void }).setState({
      tokens: { accessToken: 'header.e30.sig' },
    });
  });

  it('enabled key → state "enabled" with limits/source', async () => {
    const limits = { maxGrants: 25, budgetCentsPerDayCeiling: 1000, minFloorTickMinutes: 15 };
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(snapshot([row({ limits, source: 'billing' })])));

    const { result } = renderHook(() => useEntitlement('wisp'));

    await waitFor(() => expect(result.current.state).toBe('enabled'));
    expect(result.current.limits).toEqual(limits);
    expect(result.current.source).toBe('billing');
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/partner/me/entitlements');
  });

  it('disabled key → state "locked" with why', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse(snapshot([row({ state: 'disabled', source: 'manual', why: 'Upgrade to Pro.' })])),
    );

    const { result } = renderHook(() => useEntitlement('wisp'));

    await waitFor(() => expect(result.current.state).toBe('locked'));
    expect(result.current.why).toBe('Upgrade to Pro.');
    expect(result.current.source).toBe('manual');
  });

  it('fetch failure (500) → state stays "loading", never "enabled" (D10)', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ code: 'entitlement_check_failed' }, false, 503));

    const { result } = renderHook(() => useEntitlement('wisp'));
    const list = renderHook(() => useEntitlements());

    await waitFor(() => expect(list.result.current.failed).toBe(true));
    expect(result.current.state).toBe('loading');
    // Consumers can tell "still loading" from "load failed" and offer a retry.
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(entitlementsCache.value).toBeNull();
  });

  it('fetch rejects → "loading"; reload() refetches', async () => {
    fetchWithAuthMock.mockRejectedValueOnce(new Error('network'));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(snapshot([row({})])));

    const { result } = renderHook(() => useEntitlement('wisp'));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    // Let the rejection settle; state must not flip to enabled.
    await act(async () => { await Promise.resolve(); });
    expect(result.current.state).toBe('loading');

    act(() => result.current.reload());

    await waitFor(() => expect(result.current.state).toBe('enabled'));
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
  });

  it('key missing from the snapshot → "locked"', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(snapshot([row({ key: 'verified_library' })])));

    const { result } = renderHook(() => useEntitlement('wisp'));

    await waitFor(() => expect(result.current.state).toBe('locked'));
    expect(result.current.source).toBeNull();
  });

  it('no access token → no fetch, "loading"', async () => {
    (useAuthStore as unknown as { setState: (s: unknown) => void }).setState({ tokens: null });

    const { result } = renderHook(() => useEntitlement('wisp'));

    await act(async () => { await Promise.resolve(); });
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
    expect(result.current.state).toBe('loading');
  });

  it('two hooks share one in-flight request', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse(snapshot([row({})])));

    const a = renderHook(() => useEntitlement('wisp'));
    const b = renderHook(() => useEntitlement('wisp'));

    await waitFor(() => expect(a.result.current.state).toBe('enabled'));
    await waitFor(() => expect(b.result.current.state).toBe('enabled'));
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });

  it('resetEntitlementsCache() during an in-flight request discards its result (generation)', async () => {
    let resolveFirst!: (r: Response) => void;
    fetchWithAuthMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { resolveFirst = resolve; }),
    );
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse(snapshot([row({ state: 'disabled', why: 'Partner B is on Free.' })])),
    );

    const { result } = renderHook(() => useEntitlement('wisp'));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));

    // Logout (partner A) while A's request is in flight; B's session follows.
    resetEntitlementsCache();
    await act(async () => {
      resolveFirst(makeJsonResponse(snapshot([row({ state: 'enabled' })])));
    });

    await waitFor(() => expect(result.current.state).toBe('locked'));
    expect(result.current.why).toBe('Partner B is on Free.');
    expect(entitlementsCache.value?.entitlements[0]?.state).toBe('disabled');
  });
});
