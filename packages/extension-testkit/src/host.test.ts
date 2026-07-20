import { describe, expect, it } from 'vitest';
import { probeStockHost, type StockHostProbeOptions } from './host';

const COOKIE = 'breeze_session=super-secret-value';
const IMMUTABLE = 'private, max-age=31536000, immutable';

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

function baseOptions(fetchImpl: typeof fetch): StockHostProbeOptions {
  return {
    baseUrl: 'http://host',
    extensionName: 'acme',
    expectedDigest: 'sha256-abc',
    auth: { cookie: COOKIE },
    assetMember: 'index.html',
    fetchImpl,
  };
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
});
