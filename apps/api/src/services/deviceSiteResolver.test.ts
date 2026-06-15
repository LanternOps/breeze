import { describe, it, expect, vi, beforeEach } from 'vitest';

// Chainable Drizzle-style select mock: select().from().where().limit() → rows.
// `limitResult` is what the final `.limit(1)` resolves to.
const limitMock = vi.fn();

vi.mock('../db', () => {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: (...args: unknown[]) => limitMock(...args),
  };
  return {
    db: {
      select: vi.fn(() => chain),
    },
  };
});

vi.mock('../db/schema', () => ({
  devices: { id: 'devices.id', siteId: 'devices.site_id' },
}));

describe('deviceSiteResolver', () => {
  let resolveDeviceSiteId: typeof import('./deviceSiteResolver')['resolveDeviceSiteId'];
  let _clearDeviceSiteCache: typeof import('./deviceSiteResolver')['_clearDeviceSiteCache'];
  let _primeDeviceSiteCache: typeof import('./deviceSiteResolver')['_primeDeviceSiteCache'];

  beforeEach(async () => {
    vi.resetModules();
    limitMock.mockReset();
    const mod = await import('./deviceSiteResolver');
    resolveDeviceSiteId = mod.resolveDeviceSiteId;
    _clearDeviceSiteCache = mod._clearDeviceSiteCache;
    _primeDeviceSiteCache = mod._primeDeviceSiteCache;
    _clearDeviceSiteCache();
  });

  it('returns undefined for a null/undefined/empty deviceId without hitting the DB', async () => {
    expect(await resolveDeviceSiteId(undefined)).toBeUndefined();
    expect(await resolveDeviceSiteId(null)).toBeUndefined();
    expect(await resolveDeviceSiteId('')).toBeUndefined();
    expect(limitMock).not.toHaveBeenCalled();
  });

  it('resolves siteId via a single PK lookup and caches it (second call skips the DB)', async () => {
    limitMock.mockResolvedValueOnce([{ siteId: 'site-a' }]);

    expect(await resolveDeviceSiteId('dev-1')).toBe('site-a');
    expect(limitMock).toHaveBeenCalledTimes(1);

    // Cached — no second DB round-trip.
    expect(await resolveDeviceSiteId('dev-1')).toBe('site-a');
    expect(limitMock).toHaveBeenCalledTimes(1);
  });

  it('caches a "not found" result as undefined (no repeated lookups for unknown devices)', async () => {
    limitMock.mockResolvedValueOnce([]);

    expect(await resolveDeviceSiteId('ghost')).toBeUndefined();
    expect(await resolveDeviceSiteId('ghost')).toBeUndefined();
    expect(limitMock).toHaveBeenCalledTimes(1);
  });

  it('fails open to undefined when the DB lookup throws (event still publishes org-level)', async () => {
    limitMock.mockRejectedValueOnce(new Error('db down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await resolveDeviceSiteId('dev-err')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('serves a primed cache entry without any DB call', async () => {
    _primeDeviceSiteCache('dev-primed', 'site-z');

    expect(await resolveDeviceSiteId('dev-primed')).toBe('site-z');
    expect(limitMock).not.toHaveBeenCalled();
  });
});
