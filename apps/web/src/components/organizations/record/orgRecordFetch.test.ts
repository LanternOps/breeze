import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { makeOrgFetch, useLatest } from './orgRecordFetch';
import { registerOrgIdProvider, useAuthStore } from '@/stores/auth';

describe('makeOrgFetch', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The ambient provider stands in for an OrgSwitcher parked on ANOTHER org —
    // the exact condition the record page has to survive.
    registerOrgIdProvider(() => 'switcher-org');
    useAuthStore.setState({
      tokens: { accessToken: 'token', expiresAt: Date.now() + 60_000 } as never,
      user: { id: 'u1', email: 'u@example.com' } as never,
      isAuthenticated: true,
    });
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    registerOrgIdProvider(() => null);
  });

  it('pins every request to the record org, not the switcher org', async () => {
    const orgFetch = makeOrgFetch('record-org');
    await orgFetch('/devices?limit=10');
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain('orgId=record-org');
    expect(url).not.toContain('switcher-org');
  });

  it('keeps caller-supplied init (method, body, headers) intact', async () => {
    const orgFetch = makeOrgFetch('record-org');
    await orgFetch('/x', { method: 'POST', body: '{"a":1}' });
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
  });

  it('refuses a caller that pins a conflicting org in the path itself', async () => {
    const orgFetch = makeOrgFetch('record-org');
    await expect(orgFetch('/devices?orgId=some-other-org')).rejects.toThrow(/some-other-org/);
  });
});

describe('useLatest', () => {
  it('returns a referentially STABLE object across renders', () => {
    // Callers list this in useCallback/useEffect dependency arrays. A fresh
    // object per render re-fires the loader on every state update it causes —
    // an infinite render loop, which surfaces as a hung worker rather than a
    // failed assertion, so it has to be pinned here.
    const { result, rerender } = renderHook(() => useLatest<string>());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(result.current.run).toBe(first.run);
  });

  it('resolves the newest call and drops a superseded one', async () => {
    const { result } = renderHook(() => useLatest<string>());

    let resolveSlow!: (v: string) => void;
    const slow = new Promise<string>((r) => {
      resolveSlow = r;
    });
    const fast = Promise.resolve('second');

    let slowOutcome: string | undefined = 'unset';
    let fastOutcome: string | undefined = 'unset';

    await act(async () => {
      const slowRun = result.current.run(slow).then((v) => {
        slowOutcome = v;
      });
      const fastRun = result.current.run(fast).then((v) => {
        fastOutcome = v;
      });
      resolveSlow('first');
      await Promise.all([slowRun, fastRun]);
    });

    // The in-flight first call resolved LAST but must not win: an org switch or
    // a tab change mid-flight would otherwise paint the previous org's rows.
    expect(fastOutcome).toBe('second');
    expect(slowOutcome).toBeUndefined();
  });

  it('drops a response that arrives after unmount', async () => {
    const { result, unmount } = renderHook(() => useLatest<string>());
    const pending = result.current.run(Promise.resolve('late'));
    unmount();
    await expect(pending).resolves.toBeUndefined();
  });

  it('propagates rejections from the newest call so callers can show an error', async () => {
    const { result } = renderHook(() => useLatest<string>());
    await expect(result.current.run(Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });
});
