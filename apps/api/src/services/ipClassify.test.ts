import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { redis } = vi.hoisted(() => ({
  redis: { get: vi.fn(), set: vi.fn() },
}));

vi.mock('./redis', () => ({
  getRedis: vi.fn(() => redis),
  getBullMQConnection: vi.fn(() => ({})),
}));

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

  it('uses the static private-range fallback with no provider and never fetches', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(classifyIp('127.0.0.1')).resolves.toEqual({
      ipClass: 'residential', asn: null, provider: 'none',
    });
    await expect(classifyIp('203.0.113.10')).resolves.toEqual({
      ipClass: 'unknown', asn: null, provider: 'none',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('warns once and uses the offline fallback when a provider has no key', async () => {
    process.env.IP_CLASSIFY_PROVIDER = 'ipinfo';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await classifyIp('203.0.113.10');
    await classifyIp('203.0.113.11');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
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
