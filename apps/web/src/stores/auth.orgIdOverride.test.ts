import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyOrgId, fetchWithAuth, registerOrgIdProvider, useAuthStore } from './auth';

/**
 * `orgIdOverride` (#5075 W01) is what lets the organization RECORD page pin
 * every request to the org in the URL while the OrgSwitcher points somewhere
 * else. Two separable contracts are pinned here:
 *
 *   1. `applyOrgId` — the pure URL rewrite. Ambient injection must be
 *      byte-for-byte what it was before the option existed (the whole app
 *      depends on it), the override must win, and a URL that already names a
 *      DIFFERENT org must throw rather than silently pick one — a wrong-org
 *      read is a tenant-isolation-shaped bug, not a UI glitch.
 *   2. The custom option keys must never reach native `fetch`. They used to
 *      ride along harmlessly; `orgIdOverride` makes the spread load-bearing,
 *      and an unknown key in a `RequestInit` is silently ignored by the
 *      platform — exactly the failure that never shows up in a stack trace.
 */

describe('applyOrgId', () => {
  it('injects the ambient org when the URL names none (existing behaviour)', () => {
    expect(applyOrgId('/tickets', { ambient: 'a' })).toBe('/tickets?orgId=a');
  });

  it('leaves a URL that already names an org alone under ambient injection', () => {
    expect(applyOrgId('/tickets?orgId=x', { ambient: 'a' })).toBe('/tickets?orgId=x');
  });

  it('appends the override alongside existing query params', () => {
    expect(applyOrgId('/tickets?status=open', { orgIdOverride: 'p', ambient: 'a' })).toBe(
      '/tickets?status=open&orgId=p',
    );
  });

  it('is a no-op when the URL already names the same org as the override', () => {
    expect(applyOrgId('/tickets?orgId=p', { orgIdOverride: 'p', ambient: 'a' })).toBe('/tickets?orgId=p');
  });

  it('throws when the URL names a DIFFERENT org than the override', () => {
    expect(() => applyOrgId('/tickets?orgId=x', { orgIdOverride: 'p', ambient: 'a' })).toThrow(
      /orgId=x.*orgIdOverride=p|x.*p/,
    );
    // Both ids must appear in the message — a bare "conflict" is undebuggable.
    try {
      applyOrgId('/tickets?orgId=x', { orgIdOverride: 'p', ambient: 'a' });
      expect.unreachable('expected a throw');
    } catch (err) {
      expect(String((err as Error).message)).toContain('x');
      expect(String((err as Error).message)).toContain('p');
    }
  });

  it('injects nothing when orgIdOverride is null', () => {
    expect(applyOrgId('/fleet/findings', { orgIdOverride: null, ambient: 'a' })).toBe('/fleet/findings');
  });

  it('injects nothing when skipOrgIdInjection is set (back-compat alias)', () => {
    expect(applyOrgId('/fleet/findings', { skipOrgIdInjection: true, ambient: 'a' })).toBe('/fleet/findings');
  });

  it('injects nothing when there is no ambient org and no override', () => {
    expect(applyOrgId('/tickets', { ambient: null })).toBe('/tickets');
  });

  it('keeps the fragment after the query string', () => {
    expect(applyOrgId('/tickets#billing', { orgIdOverride: 'p', ambient: null })).toBe('/tickets?orgId=p#billing');
  });

  it('does not treat an orgId inside the fragment as the URL naming an org', () => {
    expect(applyOrgId('/tickets/new#orgId=x', { orgIdOverride: 'p', ambient: null })).toBe(
      '/tickets/new?orgId=p#orgId=x',
    );
  });
});

describe('fetchWithAuth — custom options never reach native fetch', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    registerOrgIdProvider(() => 'ambient-org');
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

  it('strips orgIdOverride / skipOrgIdInjection / skipUnauthorizedRetry from the RequestInit', async () => {
    await fetchWithAuth('/x', { orgIdOverride: 'pinned-org', skipUnauthorizedRetry: true, method: 'GET' });

    const init = fetchSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(init).toBeDefined();
    expect(init).not.toHaveProperty('orgIdOverride');
    expect(init).not.toHaveProperty('skipOrgIdInjection');
    expect(init).not.toHaveProperty('skipUnauthorizedRetry');
    expect(init.method).toBe('GET');
  });

  it('pins the request to the override org even when the ambient provider names another', async () => {
    await fetchWithAuth('/devices', { orgIdOverride: 'pinned-org' });
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain('orgId=pinned-org');
    expect(url).not.toContain('ambient-org');
  });

  it('strips the custom keys on the post-401 refresh retry too', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      // /auth/refresh
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: 'new-token', expiresIn: 900 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await fetchWithAuth('/devices', { orgIdOverride: 'pinned-org' });

    for (const call of fetchSpy.mock.calls) {
      const init = call[1] as Record<string, unknown> | undefined;
      if (!init) continue;
      expect(init).not.toHaveProperty('orgIdOverride');
      expect(init).not.toHaveProperty('skipOrgIdInjection');
      expect(init).not.toHaveProperty('skipUnauthorizedRetry');
    }
  });
});
