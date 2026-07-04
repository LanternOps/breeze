import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// getLoginContext memoizes in module scope, so each test that cares about
// memoization behavior needs a fresh module instance — vi.resetModules() +
// dynamic import() per test (see monacoLoader.test.ts for the same pattern).

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('loginContext', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the parsed body on the happy path', async () => {
    const body = {
      branding: { logoUrl: 'https://x/logo.png', accentColor: '#112233', headline: 'Acme IT' },
      partnerSso: { providerName: 'Okta', loginUrl: '/api/v1/sso/login/partner/p1', enforceSSO: true },
    };
    vi.mocked(fetch).mockResolvedValue(jsonResponse(body));

    const { getLoginContext } = await import('./loginContext');
    const ctx = await getLoginContext();

    expect(ctx).toEqual(body);
  });

  it('returns EMPTY when the response is not ok', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({}, false, 500));

    const { getLoginContext } = await import('./loginContext');
    const ctx = await getLoginContext();

    expect(ctx).toEqual({ branding: null, partnerSso: null });
  });

  it('returns EMPTY and warns when fetch throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));

    const { getLoginContext } = await import('./loginContext');
    const ctx = await getLoginContext();

    expect(ctx).toEqual({ branding: null, partnerSso: null });
    expect(warnSpy).toHaveBeenCalledWith(
      '[login] login-context fetch failed; falling back to stock branding',
      expect.any(Error)
    );
  });

  it('memoizes: two getLoginContext() calls issue exactly one fetch', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ branding: null, partnerSso: null }));

    const { getLoginContext } = await import('./loginContext');
    await getLoginContext();
    await getLoginContext();

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('coalesces missing body fields to null', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({}));

    const { getLoginContext } = await import('./loginContext');
    const ctx = await getLoginContext();

    expect(ctx).toEqual({ branding: null, partnerSso: null });
  });
});
