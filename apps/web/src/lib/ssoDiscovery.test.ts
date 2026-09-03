import { beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverOrgSso } from './ssoDiscovery';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const VALID = {
  providerName: 'Authentik',
  loginUrl: '/api/v1/sso/login/00000000-0000-4000-8000-0000000000a1',
  enforceSSO: true,
};

describe('discoverOrgSso (#3229)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('POSTs the address to the discovery endpoint', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({ sso: null }));
    vi.stubGlobal('fetch', fetchMock);

    await discoverOrgSso('tech@acme.example');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/api/v1/auth/sso-discovery');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ email: 'tech@acme.example' });
  });

  it('returns the provider on a positive answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ sso: VALID })));

    await expect(discoverOrgSso('tech@acme.example')).resolves.toEqual(VALID);
  });

  it('returns null on the negative answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ sso: null })));

    await expect(discoverOrgSso('nobody@unknown.example')).resolves.toBeNull();
  });

  // Every non-200 (429 rate limited, 400 validation, 5xx) must leave the
  // password form in place rather than throwing into the login page.
  it.each([400, 429, 500, 503])('returns null on HTTP %i', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'nope' }, status)));

    await expect(discoverOrgSso('tech@acme.example')).resolves.toBeNull();
  });

  it('returns null and warns when the request fails outright', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    await expect(discoverOrgSso('tech@acme.example')).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  // loginUrl is handed to a top-level navigation, so a response that does not
  // look like the org SSO entry route must be discarded, not followed.
  describe('rejects a loginUrl that is not the org SSO entry route', () => {
    it.each([
      ['an absolute URL to another origin', 'https://evil.example/api/v1/sso/login/x'],
      ['a protocol-relative URL', '//evil.example'],
      ['a protocol-relative URL smuggled under the prefix', '/api/v1/sso/login//evil.example'],
      ['an unrelated path', '/settings'],
      ['a non-string', 42],
    ])('%s', async (_label, loginUrl) => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ sso: { ...VALID, loginUrl } })));

      await expect(discoverOrgSso('tech@acme.example')).resolves.toBeNull();
    });
  });

  it('rejects a response with no provider name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ sso: { loginUrl: VALID.loginUrl } })));

    await expect(discoverOrgSso('tech@acme.example')).resolves.toBeNull();
  });
});
