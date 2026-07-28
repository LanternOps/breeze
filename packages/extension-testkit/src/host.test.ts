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

function detailFor(result: { observations: Array<{ name: string; detail: string }> }, name: string): string {
  const observation = result.observations.find((o) => o.name === name);
  if (!observation) throw new Error(`no observation named "${name}"`);
  return observation.detail;
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
      expect(detailFor(result, 'health')).toContain('sent header "authorization: [redacted]"');
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

    it('redacts a secret echoed into a SUCCESSFUL probe, not just a thrown one', async () => {
      // assetImmutable interpolates the response Cache-Control verbatim, so a host,
      // WAF or proxy reflecting a credential leaks it into an ok:true report — the
      // report a user is most likely to paste into an issue.
      const fetchImpl = goodFetch((url) =>
        url.includes('/assets/')
          ? new Response('<html>', { status: 200, headers: { 'cache-control': `${IMMUTABLE}, echo=${API_KEY}` } })
          : undefined,
      );
      const result = await probeStockHost(baseOptions(fetchImpl, { headers: { 'x-api-key': API_KEY } }));
      const asset = result.observations.find((o) => o.name === 'assetImmutable');
      expect(asset?.ok).toBe(true); // still a passing observation …
      expect(asset?.detail).toContain('[redacted]'); // … but the echo is scrubbed
      expect(JSON.stringify(result)).not.toContain('super-secret-api-key');
    });

    it('does not garble output when a header value is empty', async () => {
      // ''.split('') would insert a marker between every character.
      const result = await probeStockHost(
        baseOptions(throwingFetch('boom'), { headers: { 'x-empty': '', authorization: BEARER } }),
      );
      expect(detailFor(result, 'health')).toBe('connect ECONNREFUSED; boom');
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

    it('orders longest-first so a full value is replaced before its own substring', async () => {
      // Insertion order is deliberately adverse: the SHORT secret is added first,
      // so an unsorted Set would return it first and half-replace the long one.
      const short = 'tok12345678';
      const long = `prefix-${short}-suffix`;
      const auth: StockHostProbeAuth = { headers: { 'x-a': short, 'x-b': long } };
      expect(collectProbeSecrets(auth).indexOf(long)).toBeLessThan(collectProbeSecrets(auth).indexOf(short));

      // The contract that ordering exists to protect.
      const result = await probeStockHost(baseOptions(throwingFetch(`echo ${long}`), auth));
      expect(detailFor(result, 'health')).toContain('echo [redacted]');
      expect(detailFor(result, 'health')).not.toContain('prefix-[redacted]-suffix');
    });

    it.each([
      ['exactly at the floor (8 chars)', 'abcd1234', true],
      ['one below the floor (7 chars)', 'abcd123', false],
    ])('applies MIN_SECRET_LENGTH %s', (_label, value, redacted) => {
      // Pins the boundary AND the deliberate tradeoff: a sub-floor value is left
      // in the clear on purpose, because blanket-replacing it would garble the
      // status codes and digests the probe exists to report.
      expect(collectProbeSecrets({ headers: { 'x-k': value } }).includes(value)).toBe(redacted);
    });

    it('ignores non-string header values (this package is consumable from plain JS)', () => {
      const headers = { 'x-num': 42 as unknown as string, 'x-ok': 'Tag longenough' };
      expect(collectProbeSecrets({ headers })).toEqual(['Tag longenough']);
    });

    it('never yields an empty secret and skips blank/short values', () => {
      const secrets = collectProbeSecrets({ cookie: '', headers: { 'x-empty': '', 'x-short': 'abc', 'x-ok': 'Tag longenough' } });
      expect(secrets).not.toContain('');
      expect(secrets).not.toContain('abc'); // under the 8-char floor
      expect(secrets).toEqual(['Tag longenough']);
    });

    it('collects each cookie pair and pair value, so an echoed pair cannot leak', () => {
      const secrets = collectProbeSecrets({ cookie: `csrf=ab; breeze_session=${TOKEN}` });
      expect(secrets).toContain(`breeze_session=${TOKEN}`);
      expect(secrets).toContain(TOKEN);
      expect(secrets).not.toContain('csrf=ab'); // 7 chars — under the floor
    });

    it('derives the credential only for real auth schemes, not any spaced value', () => {
      const secrets = collectProbeSecrets({
        headers: { authorization: BEARER, 'user-agent': 'probe/1.0 conformance-suite' },
      });
      expect(secrets).toContain(TOKEN);
      // Deriving off every space would make an ordinary header value a secret.
      expect(secrets).not.toContain('conformance-suite');
    });

    it('derives through leading whitespace on the header value', () => {
      // A stray space from an env var must not silently disable derivation.
      expect(collectProbeSecrets({ headers: { authorization: `  ${BEARER}` } })).toContain(TOKEN);
    });
  });

  describe('auth preconditions', () => {
    // Probing anonymously would blame the host for missing credentials.
    it.each([
      ['an empty headers record', { headers: {} }],
      ['a blank cookie', { cookie: '   ' }],
      ['a blank header value', { headers: { authorization: '' } }],
    ])('throws when auth supplies no usable credentials: %s', async (_label, auth) => {
      await expect(probeStockHost(baseOptions(goodFetch(), auth as StockHostProbeAuth)))
        .rejects.toThrow(/no usable credentials/);
    });

    it('lets an explicit cookie override a case-variant cookie key in headers', async () => {
      const { fetchImpl, sent } = recordingFetch(goodFetch());
      await probeStockHost(baseOptions(fetchImpl, { cookie: COOKIE, headers: { Cookie: 'stale=session' } }));
      // Two keys differing only in case would be joined into "stale; fresh".
      expect(headersFor(sent, '/api/v1/extensions/registry')).toEqual({ cookie: COOKIE });
    });
  });

  describe('verdicts under a fumbled credential', () => {
    // Header auth makes these the likely failure modes: a bad Bearer token gets
    // an HTML login page or a 401, not a clean JSON "not listed".
    it('fails admin state when the body is not JSON (an HTML login page)', async () => {
      const fetchImpl = goodFetch((url) =>
        url.endsWith('/api/v1/admin/extensions')
          ? new Response('<html>sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } })
          : undefined,
      );
      const result = await probeStockHost(baseOptions(fetchImpl));
      expect(result.observations.find((o) => o.name === 'adminState')?.ok).toBe(false);
    });

    it('fails admin state on a 401 even when the body lists the extension', async () => {
      const fetchImpl = goodFetch((url) =>
        url.endsWith('/api/v1/admin/extensions') ? json({ extensions: [{ name: 'acme' }] }, { status: 401 }) : undefined,
      );
      const result = await probeStockHost(baseOptions(fetchImpl));
      expect(result.observations.find((o) => o.name === 'adminState')?.ok).toBe(false);
    });

    it('fails the registry probe on a non-2xx', async () => {
      const fetchImpl = goodFetch((url) =>
        url.endsWith('/api/v1/extensions/registry') ? json({ error: 'nope' }, { status: 500 }) : undefined,
      );
      const result = await probeStockHost(baseOptions(fetchImpl));
      expect(result.observations.find((o) => o.name === 'registry')?.ok).toBe(false);
    });

    it.each([401, 403])('accepts %i as the extension namespace rejecting anonymous access', async (status) => {
      const fetchImpl = goodFetch((url) =>
        url.includes('/api/v1/ext/acme') ? json({ error: 'denied' }, { status }) : undefined,
      );
      const result = await probeStockHost(baseOptions(fetchImpl));
      expect(result.observations.find((o) => o.name === 'routeAuth')?.ok).toBe(true);
    });
  });

  describe('diagnostic quality', () => {
    it('does not garble details when a short non-secret header rides along', async () => {
      // Blanket-replacing "1" would rewrite every status code and digest.
      const { fetchImpl } = recordingFetch(goodFetch());
      const result = await probeStockHost(
        baseOptions(fetchImpl, { headers: { authorization: BEARER, 'x-tenant': '1' } }),
      );
      expect(result.observations.find((o) => o.name === 'registry')?.detail)
        .toBe('GET /api/v1/extensions/registry -> 200');
      expect(result.ok).toBe(true);
    });

    it('surfaces the fetch cause and still redacts secrets inside it', async () => {
      // Real fetch failures carry a bare "fetch failed" message; the reason is on `cause`.
      const fetchImpl = (async () => {
        throw new Error('fetch failed', { cause: new Error(`connect ECONNREFUSED; token ${TOKEN}`) });
      }) as typeof fetch;
      const result = await probeStockHost(baseOptions(fetchImpl, { headers: { authorization: BEARER } }));
      const detail = detailFor(result, 'health');
      expect(detail).toContain('ECONNREFUSED');
      expect(detail).not.toContain('super-secret-token');
    });
  });
});
