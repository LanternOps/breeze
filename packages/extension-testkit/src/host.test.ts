import { describe, expect, it } from 'vitest';
import {
  collectProbeSecrets,
  probeStockHost,
  type StockHostProbeAuth,
  type StockHostProbeOptions,
} from './host';

const COOKIE = 'breeze_session=super-secret-value';
const TOKEN = 'eyJhbGciOi.super-secret-token.sig';
const BEARER = `Bearer ${TOKEN}`;
const API_KEY = 'bzk_live_super-secret-api-key';
const IMMUTABLE = 'private, max-age=31536000, immutable';

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

function baseOptions(
  fetchImpl: typeof fetch,
  auth: StockHostProbeAuth = { cookie: COOKIE },
): StockHostProbeOptions {
  return {
    baseUrl: 'http://host',
    extensionName: 'acme',
    expectedDigest: 'sha256-abc',
    auth,
    assetMember: 'index.html',
    fetchImpl,
  };
}

/** A fetch that always throws, echoing `leaked` the way a real host/socket would. */
function throwingFetch(leaked: string): typeof fetch {
  return (async () => {
    throw new Error(`connect ECONNREFUSED; ${leaked}`);
  }) as typeof fetch;
}

/** Records the headers each probe actually sent, keyed by URL. */
function recordingFetch(inner: typeof fetch): { fetchImpl: typeof fetch; sent: Array<{ url: string; headers: Record<string, string> }> } {
  const sent: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    sent.push({ url: String(input), headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
    return inner(input as string, init);
  }) as typeof fetch;
  return { fetchImpl, sent };
}

function headersFor(sent: Array<{ url: string; headers: Record<string, string> }>, fragment: string): Record<string, string> {
  const entry = sent.find((call) => call.url.includes(fragment));
  if (!entry) throw new Error(`no probe hit a URL containing "${fragment}"`);
  return entry.headers;
}

// A well-behaved host, with a single overridable endpoint for negative tests.
function goodFetch(overrides: (url: string) => Response | undefined = () => undefined): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    const override = overrides(url);
    if (override) return override;
    if (url.endsWith('/health')) return json({ ok: true });
    if (url.endsWith('/api/v1/admin/extensions')) return json({ extensions: [{ name: 'acme' }] });
    if (url.endsWith('/api/v1/extensions/registry')) return json({ pages: [], navigation: [], slots: [] });
    if (url.includes('/assets/')) return new Response('<html>', { status: 200, headers: { 'cache-control': IMMUTABLE } });
    if (url.includes('/api/v1/ext/acme')) return json({ error: 'unauthorized' }, { status: 401 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('probeStockHost', () => {
  it('reports all-green observations against a well-behaved host', async () => {
    const result = await probeStockHost(baseOptions(goodFetch()));
    expect(result.ok).toBe(true);
    expect(result.observations.map((observation) => observation.name)).toEqual(
      expect.arrayContaining(['health', 'adminState', 'registry', 'assetImmutable', 'routeAuth']),
    );
  });

  it('fails the asset probe when Cache-Control is not immutable', async () => {
    const fetchImpl = goodFetch((url) =>
      url.includes('/assets/') ? new Response('<html>', { status: 200, headers: { 'cache-control': 'no-store' } }) : undefined,
    );
    const result = await probeStockHost(baseOptions(fetchImpl));
    expect(result.observations.find((o) => o.name === 'assetImmutable')?.ok).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('flags the extension namespace when it does NOT reject unauthenticated access', async () => {
    const fetchImpl = goodFetch((url) =>
      url.includes('/api/v1/ext/acme') ? json({ leaked: true }, { status: 200 }) : undefined,
    );
    const result = await probeStockHost(baseOptions(fetchImpl));
    expect(result.observations.find((o) => o.name === 'routeAuth')?.ok).toBe(false);
  });

  it('flags admin state when the extension is not listed', async () => {
    const fetchImpl = goodFetch((url) =>
      url.endsWith('/api/v1/admin/extensions') ? json({ extensions: [{ name: 'other' }] }) : undefined,
    );
    const result = await probeStockHost(baseOptions(fetchImpl));
    expect(result.observations.find((o) => o.name === 'adminState')?.ok).toBe(false);
  });

  it('never leaks the auth cookie, even when a probe throws', async () => {
    // Load-bearing: if redaction is removed, the cookie flows into `detail` and this fails.
    const fetchImpl = (async () => {
      throw new Error(`connect ECONNREFUSED; sent header "cookie: ${COOKIE}"`);
    }) as typeof fetch;
    const result = await probeStockHost(baseOptions(fetchImpl));
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
    expect(result.observations.length).toBeGreaterThan(0);
    expect(result.observations.every((o) => !o.detail.includes('super-secret-value'))).toBe(true);
  });

  it('sends the cookie as a cookie header on authed probes only', async () => {
    const { fetchImpl, sent } = recordingFetch(goodFetch());
    await probeStockHost(baseOptions(fetchImpl));
    expect(headersFor(sent, '/api/v1/admin/extensions').cookie).toBe(COOKIE);
    // The health and route-auth probes are deliberately anonymous.
    expect(headersFor(sent, '/health')).toEqual({});
    expect(headersFor(sent, '/api/v1/ext/acme')).toEqual({});
  });

  describe('header auth', () => {
    it('reports all-green observations when authenticating with a Bearer header', async () => {
      const result = await probeStockHost(baseOptions(goodFetch(), { headers: { authorization: BEARER } }));
      expect(result.ok).toBe(true);
    });

    it('sends the supplied headers on authed probes and nothing on the anonymous ones', async () => {
      const { fetchImpl, sent } = recordingFetch(goodFetch());
      await probeStockHost(baseOptions(fetchImpl, { headers: { authorization: BEARER, 'x-api-key': API_KEY } }));
      for (const authed of ['/api/v1/admin/extensions', '/api/v1/extensions/registry', '/assets/']) {
        expect(headersFor(sent, authed)).toEqual({ authorization: BEARER, 'x-api-key': API_KEY });
      }
      expect(headersFor(sent, '/health')).toEqual({});
      expect(headersFor(sent, '/api/v1/ext/acme')).toEqual({});
    });

    it('never leaks a Bearer header value, even when a probe throws', async () => {
      // Load-bearing: header secrets used to bypass redact(), which only knew the cookie.
      const result = await probeStockHost(
        baseOptions(throwingFetch(`sent header "authorization: ${BEARER}"`), { headers: { authorization: BEARER } }),
      );
      expect(JSON.stringify(result)).not.toContain('super-secret-token');
      expect(result.observations.every((o) => !o.detail.includes(TOKEN))).toBe(true);
      // The whole scheme+credential is one secret, so it collapses to a single marker.
      expect(result.observations[0]?.detail).toContain('sent header "authorization: [redacted]"');
    });

    it('never leaks an API-key header value', async () => {
      const result = await probeStockHost(
        baseOptions(throwingFetch(`rejected key ${API_KEY}`), { headers: { 'x-api-key': API_KEY } }),
      );
      expect(JSON.stringify(result)).not.toContain('super-secret-api-key');
    });

    it('redacts the bare token when the host echoes it back without the scheme', async () => {
      const result = await probeStockHost(
        baseOptions(throwingFetch(`invalid token: ${TOKEN}`), { headers: { authorization: BEARER } }),
      );
      expect(JSON.stringify(result)).not.toContain('super-secret-token');
    });

    it('redacts both secrets when a cookie and headers are combined', async () => {
      const auth: StockHostProbeAuth = { cookie: COOKIE, headers: { 'x-api-key': API_KEY } };
      const { fetchImpl, sent } = recordingFetch(goodFetch());
      await probeStockHost(baseOptions(fetchImpl, auth));
      expect(headersFor(sent, '/api/v1/extensions/registry')).toEqual({ cookie: COOKIE, 'x-api-key': API_KEY });

      const result = await probeStockHost(baseOptions(throwingFetch(`${COOKIE} / ${API_KEY}`), auth));
      expect(JSON.stringify(result)).not.toContain('super-secret-value');
      expect(JSON.stringify(result)).not.toContain('super-secret-api-key');
    });

    it('does not garble output when a header value is empty', async () => {
      // ''.split('') would insert a marker between every character.
      const result = await probeStockHost(
        baseOptions(throwingFetch('boom'), { headers: { 'x-empty': '', authorization: BEARER } }),
      );
      expect(result.observations[0]?.detail).toBe('connect ECONNREFUSED; boom');
    });
  });

  describe('collectProbeSecrets', () => {
    it('collects the cookie, every header value, and the post-scheme credential', () => {
      const secrets = collectProbeSecrets({ cookie: COOKIE, headers: { authorization: BEARER, 'x-api-key': API_KEY } });
      expect(secrets).toContain(COOKIE);
      expect(secrets).toContain(BEARER);
      expect(secrets).toContain(TOKEN);
      expect(secrets).toContain(API_KEY);
    });

    it('orders longest-first so a full value is replaced before its own substring', () => {
      const secrets = collectProbeSecrets({ headers: { authorization: BEARER } });
      expect(secrets.indexOf(BEARER)).toBeLessThan(secrets.indexOf(TOKEN));
    });

    it('never yields an empty secret and skips too-generic derived fragments', () => {
      const secrets = collectProbeSecrets({ cookie: '', headers: { 'x-empty': '', 'x-short': 'Tag short' } });
      expect(secrets).not.toContain('');
      expect(secrets).not.toContain('short'); // under the 8-char derivation floor
      expect(secrets).toEqual(['Tag short']);
    });
  });
});
