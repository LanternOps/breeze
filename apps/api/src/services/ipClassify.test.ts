import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { redis } = vi.hoisted(() => ({
  redis: { get: vi.fn(), set: vi.fn() },
}));

const { offlineClassify } = vi.hoisted(() => ({ offlineClassify: vi.fn() }));

vi.mock('./redis', () => ({
  getRedis: vi.fn(() => redis),
  getBullMQConnection: vi.fn(() => ({})),
}));
vi.mock('./ipClassifyOffline', () => ({ offlineClassify }));

import { classifyIp, ipCachePrefix } from './ipClassify';

describe('classifyIp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.IP_CLASSIFY_PROVIDER;
    delete process.env.IP_CLASSIFY_API_KEY;
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
  });

  afterEach(() => {
    delete process.env.IP_CLASSIFY_PROVIDER;
    delete process.env.IP_CLASSIFY_API_KEY;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('delegates to the offline baseline when no provider is configured, never the keyed path', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    offlineClassify.mockResolvedValue({ ipClass: 'unknown', asn: 64501, provider: 'offline' });

    await expect(classifyIp('203.0.113.10')).resolves.toEqual({
      ipClass: 'unknown', asn: 64501, provider: 'offline',
    });
    expect(offlineClassify).toHaveBeenCalledWith('203.0.113.10', { waitMs: expect.any(Number) });
    // The keyed provider's per-prefix cache and HTTP lookup are not involved.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('never reports residential from the offline path, even if the baseline misbehaves', async () => {
    offlineClassify.mockResolvedValue({ ipClass: 'residential', asn: 64501, provider: 'offline' });

    await expect(classifyIp('203.0.113.10')).resolves.toEqual({
      ipClass: 'unknown', asn: 64501, provider: 'offline-partial',
    });
  });

  it('returns unknown with no source when the offline baseline throws', async () => {
    offlineClassify.mockRejectedValue(new Error('boom'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(classifyIp('203.0.113.10')).resolves.toEqual({
      ipClass: 'unknown', asn: null, provider: 'none',
    });
  });

  it('warns once and uses the offline fallback when a provider has no key', async () => {
    process.env.IP_CLASSIFY_PROVIDER = 'ipinfo';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    offlineClassify.mockResolvedValue({ ipClass: 'unknown', asn: null, provider: 'offline-partial' });

    await classifyIp('203.0.113.10');
    await classifyIp('203.0.113.11');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(offlineClassify).toHaveBeenCalledTimes(2);
  });

  it('maps ipinfo privacy, business, residential, and ASN responses', async () => {
    process.env.IP_CLASSIFY_PROVIDER = 'ipinfo';
    process.env.IP_CLASSIFY_API_KEY = 'secret';
    const responses = [
      { privacy: { hosting: true }, asn: { asn: 'AS64500' } },
      { privacy: { vpn: true } },
      { privacy: { tor: true } },
      { privacy: {}, company: { type: 'business' } },
      { privacy: {} },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => responses.shift(),
    })));

    await expect(classifyIp('198.51.100.1')).resolves.toMatchObject({ ipClass: 'hosting', asn: 64500 });
    await expect(classifyIp('198.51.101.1')).resolves.toMatchObject({ ipClass: 'vpn' });
    await expect(classifyIp('198.51.102.1')).resolves.toMatchObject({ ipClass: 'tor' });
    await expect(classifyIp('198.51.103.1')).resolves.toMatchObject({ ipClass: 'business' });
    await expect(classifyIp('198.51.104.1')).resolves.toMatchObject({ ipClass: 'residential' });
  });

  it('returns unknown when ipinfo omits the privacy object entirely', async () => {
    // A token without privacy detection returns no `privacy` key at all.
    // Absent evidence is NOT evidence of a residential address — every
    // hosting/VPN abuser would otherwise pass the promotion gate.
    process.env.IP_CLASSIFY_PROVIDER = 'ipinfo';
    process.env.IP_CLASSIFY_API_KEY = 'secret';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ asn: { asn: 'AS64500' }, company: { type: 'business' } }),
    })));

    await expect(classifyIp('198.51.100.1')).resolves.toEqual({
      ipClass: 'unknown', asn: 64500, provider: 'ipinfo',
    });
  });

  it('returns unknown when the ipinfo privacy field is not an object', async () => {
    process.env.IP_CLASSIFY_PROVIDER = 'ipinfo';
    process.env.IP_CLASSIFY_API_KEY = 'secret';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ privacy: null, asn: 64500 }),
    })));

    await expect(classifyIp('198.51.105.1')).resolves.toMatchObject({ ipClass: 'unknown' });
  });

  it('returns unknown when ipdata omits the threat object entirely', async () => {
    process.env.IP_CLASSIFY_PROVIDER = 'ipdata';
    process.env.IP_CLASSIFY_API_KEY = 'secret';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ asn: { asn: 64501 }, company: { type: 'business' } }),
    })));

    await expect(classifyIp('203.0.113.8')).resolves.toEqual({
      ipClass: 'unknown', asn: 64501, provider: 'ipdata',
    });
  });

  it('still classifies when the evidence object is present but empty', async () => {
    // Positive control for the two tests above: `privacy: {}` IS evidence —
    // the provider looked and found no privacy flags — so residential stands.
    process.env.IP_CLASSIFY_PROVIDER = 'ipinfo';
    process.env.IP_CLASSIFY_API_KEY = 'secret';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ privacy: {}, asn: 64500 }),
    })));

    await expect(classifyIp('198.51.106.1')).resolves.toMatchObject({ ipClass: 'residential' });
  });

  it('maps ipdata threat fields', async () => {
    process.env.IP_CLASSIFY_PROVIDER = 'ipdata';
    process.env.IP_CLASSIFY_API_KEY = 'secret';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ threat: { is_datacenter: true }, asn: { asn: 64501 } }),
    })));
    await expect(classifyIp('203.0.113.8')).resolves.toEqual({
      ipClass: 'hosting', asn: 64501, provider: 'ipdata',
    });
  });

  it('returns a cache hit without fetching', async () => {
    process.env.IP_CLASSIFY_PROVIDER = 'ipinfo';
    process.env.IP_CLASSIFY_API_KEY = 'secret';
    redis.get.mockResolvedValue(JSON.stringify({ ipClass: 'vpn', asn: 64502, provider: 'ipinfo' }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(classifyIp('198.51.100.99')).resolves.toMatchObject({ ipClass: 'vpn', asn: 64502 });
    expect(redis.get).toHaveBeenCalledWith('ipclass:v1:198.51.100.0/24');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns unknown instead of throwing on provider failure', async () => {
    process.env.IP_CLASSIFY_PROVIDER = 'ipinfo';
    process.env.IP_CLASSIFY_API_KEY = 'secret';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    await expect(classifyIp('198.51.100.1')).resolves.toEqual({
      ipClass: 'unknown', asn: null, provider: 'ipinfo',
    });
  });

  it('folds IPv4 to /24 and IPv6 to /48 cache prefixes', () => {
    expect(ipCachePrefix('192.0.2.199')).toBe('192.0.2.0/24');
    expect(ipCachePrefix('2001:db8:abcd:1234::1')).toBe('2001:0db8:abcd::/48');
  });
});
