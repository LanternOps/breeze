import { describe, expect, it, vi } from 'vitest';
import { UnifiApiError, type UnifiClient, type UnifiDeviceDto, type UnifiIspMetrics, type UnifiSite } from './unifiClient';
import {
  KEY_COLLECT_BUDGET_MS,
  KEY_COLLECT_CONCURRENCY,
  mergeKeyReads,
  readKey,
  readKeys,
  type KeyRead,
  type SiteRead,
} from './unifiKeyMerge';

const host = (id: string, name = id) => ({ id, name, type: 'console', model: null });
const site = (id: string, hostId: string, name = id): UnifiSite => ({ id, hostId, name });
const device = (id: string, name = id): UnifiDeviceDto => ({
  unifiDeviceId: id, mac: null, name, model: null, deviceType: null, ip: null,
  firmwareVersion: null, firmwareUpdatable: null, adoptionState: null, uptimeSeconds: null, raw: { id, name },
});
const metric = (latencyMs: number): UnifiIspMetrics => ({ latencyMs, packetLoss: 0, uptimePercent: 100, isp: null, raw: { latencyMs } });
const siteRead = (sites: UnifiSite[], extra: Partial<SiteRead> = {}): SiteRead => ({
  sites, hostsWithDroppedRows: new Set<string>(), rowsWithoutHostId: 0, ...extra,
});

function fakeClient(over: Partial<UnifiClient> = {}): UnifiClient {
  return {
    listHosts: vi.fn(async () => [host('h1')]),
    listSites: vi.fn(async () => [site('s1', 'h1')]),
    listSitesForSync: vi.fn(async () => siteRead([site('s1', 'h1')])),
    listDevicesByHost: vi.fn(async () => new Map([['h1', [device('d1')]]])),
    listIspMetricsBySite: vi.fn(async () => new Map([['h1::s1', metric(1)]])),
    ...over,
  };
}

function okRead(keyId: string, over: Partial<Extract<KeyRead, { ok: true }>> = {}): KeyRead {
  return { keyId, label: keyId.toUpperCase(), ok: true, hosts: [], ...over };
}

describe('readKey', () => {
  it('readKey marks 401 and 403 as auth failures and a TypeError as not', async () => {
    for (const [err, auth] of [
      [new UnifiApiError('nope', 401), true],
      [new UnifiApiError('forbidden', 403), true],
      [new UnifiApiError('down', 502), false],
      [new TypeError('fetch failed'), false],
    ] as const) {
      const read = await readKey('k1', 'K1', fakeClient({ listHosts: async () => { throw err; } }), { mode: 'sync' });
      expect(read.ok).toBe(false);
      if (read.ok) throw new Error('unreachable');
      expect(read.authFailure).toBe(auth);
      expect(read.error).toBe(err.message);
      expect(read.cause).toBe(err);
    }
  });

  it('readKey in hosts mode does not call sites, devices or metrics', async () => {
    const client = fakeClient();
    const read = await readKey('k1', 'K1', client, { mode: 'hosts' });
    expect(read).toMatchObject({ ok: true, hosts: [host('h1')] });
    expect(client.listSites).not.toHaveBeenCalled();
    expect(client.listSitesForSync).not.toHaveBeenCalled();
    expect(client.listDevicesByHost).not.toHaveBeenCalled();
    expect(client.listIspMetricsBySite).not.toHaveBeenCalled();
  });

  it('readKey in mapping mode reads hosts and sites only', async () => {
    const client = fakeClient();
    const read = await readKey('k1', 'K1', client, { mode: 'mapping' });
    expect(read).toMatchObject({ ok: true, hosts: [host('h1')], siteRead: { sites: [site('s1', 'h1')] } });
    expect(client.listDevicesByHost).not.toHaveBeenCalled();
    expect(client.listIspMetricsBySite).not.toHaveBeenCalled();
  });

  it('readKey keeps a key ok when only metrics fail', async () => {
    const read = await readKey('k1', 'K1', fakeClient({
      listIspMetricsBySite: async () => { throw new Error('metrics timeout'); },
    }), { mode: 'sync' });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('unreachable');
    expect(read.metricsBySite).toBeUndefined();
    expect(read.metricsError).toBe('UniFi ISP metrics read failed: metrics timeout');
    expect(read.devicesByHost?.get('h1')).toEqual([device('d1')]);
  });

  it('readKey keeps siteRead when the devices read fails after sites succeeded', async () => {
    const client = fakeClient({ listDevicesByHost: async () => { throw new UnifiApiError('device timeout', 504); } });
    const read = await readKey('k1', 'K1', client, { mode: 'sync' });
    expect(read).toMatchObject({
      ok: false,
      error: 'UniFi /v1/devices read failed: device timeout',
      authFailure: false,
      hosts: [host('h1')],
      siteRead: { sites: [site('s1', 'h1')] },
    });
    expect(client.listIspMetricsBySite).not.toHaveBeenCalled();
  });

  it('readKey stops after a failed sites read, keeping the hosts it read', async () => {
    const client = fakeClient({ listSitesForSync: async () => { throw new Error('sites timeout'); } });
    const read = await readKey('k1', 'K1', client, { mode: 'sync' });
    expect(read).toMatchObject({ ok: false, error: 'UniFi /v1/sites read failed: sites timeout', hosts: [host('h1')] });
    expect(read.ok ? null : read.siteRead).toBeUndefined();
    expect(client.listDevicesByHost).not.toHaveBeenCalled();
  });
});

describe('readKeys', () => {
  function deferredClient() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    return { client: fakeClient({ listHosts: async () => { await gate; return [host('h1')]; } }), release };
  }

  it('readKeys returns input order when the later key finishes first', async () => {
    const slow = deferredClient();
    const pending = readKeys([
      { id: 'a', label: 'A', client: slow.client },
      { id: 'b', label: 'B', client: fakeClient() },
    ], { mode: 'hosts' });
    await new Promise((r) => setTimeout(r, 0));
    slow.release();
    const reads = await pending;
    expect(reads.map((r) => r.keyId)).toEqual(['a', 'b']);
  });

  it('readKeys never runs more than 4 keys at once', async () => {
    expect(KEY_COLLECT_CONCURRENCY).toBe(4);
    let inFlight = 0;
    let peak = 0;
    const keys = Array.from({ length: 9 }, (_, i) => ({
      id: `k${i}`,
      label: `K${i}`,
      client: fakeClient({
        listHosts: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
          return [host('h1')];
        },
      }),
    }));
    const reads = await readKeys(keys, { mode: 'hosts' });
    expect(reads).toHaveLength(9);
    expect(reads.every((r) => r.ok)).toBe(true);
    expect(peak).toBe(4);
  });

  it('readKeys records keys not started before the budget as skipped', async () => {
    expect(KEY_COLLECT_BUDGET_MS).toBe(200_000);
    let clock = 0;
    const tick = (ms: number) => async () => { clock += ms; return [host('h1')]; };
    const lateClient = fakeClient();
    const reads = await readKeys([
      { id: 'a', label: 'A', client: fakeClient({ listHosts: tick(150_000) }) },
      { id: 'b', label: 'B', client: fakeClient({ listHosts: tick(60_000) }) },
      { id: 'c', label: 'C', client: lateClient },
    ], { mode: 'hosts', now: () => clock, budgetMs: 200_000, concurrency: 1 });
    expect(reads.map((r) => r.ok)).toEqual([true, true, false]);
    expect(reads[2]).toMatchObject({ ok: false, skipped: true, authFailure: false, error: 'sync time budget exhausted' });
    expect(lateClient.listHosts).not.toHaveBeenCalled();
  });

  it('readKeys turns a decrypt failure into a failed read without calling UniFi', async () => {
    const reads = await readKeys([
      { id: 'a', label: 'A', client: null, decryptError: 'The stored API key could not be decrypted' },
    ], { mode: 'sync' });
    expect(reads).toEqual([expect.objectContaining({
      keyId: 'a', label: 'A', ok: false, authFailure: false, error: 'The stored API key could not be decrypted',
    })]);
  });
});

describe('mergeKeyReads', () => {
  it("mergeKeyReads de-duplicates a host and a site seen by two keys; first key's payload wins", () => {
    const merged = mergeKeyReads([
      okRead('a', { hosts: [host('h1', 'From A')], siteRead: siteRead([site('s1', 'h1', 'Site A')]) }),
      okRead('b', { hosts: [host('h1', 'From B')], siteRead: siteRead([site('s1', 'h1', 'Site B')]) }),
    ]);
    expect(merged.hosts).toEqual([host('h1', 'From A')]);
    expect(merged.siteRead?.sites).toEqual([site('s1', 'h1', 'Site A')]);
    expect(merged.hostKeyIds.get('h1')).toEqual(['a', 'b']);
    expect(merged.siteKeyIds.get('h1::s1')).toEqual(['a', 'b']);
  });

  it('mergeKeyReads keeps sites with the same id on different hosts apart', () => {
    const merged = mergeKeyReads([
      okRead('a', { hosts: [host('h1')], siteRead: siteRead([site('default', 'h1')]) }),
      okRead('b', { hosts: [host('h2')], siteRead: siteRead([site('default', 'h2')]) }),
    ]);
    expect(merged.siteRead?.sites).toEqual([site('default', 'h1'), site('default', 'h2')]);
    expect(merged.siteKeyIds.get('h1::default')).toEqual(['a']);
    expect(merged.siteKeyIds.get('h2::default')).toEqual(['b']);
  });

  it('mergeKeyReads unions devices of one host across keys by unifiDeviceId', () => {
    const merged = mergeKeyReads([
      okRead('a', { hosts: [host('h1')], devicesByHost: new Map([['h1', [device('d1', 'A'), device('d2')]]]) }),
      okRead('b', { hosts: [host('h1')], devicesByHost: new Map([['h1', [device('d1', 'B'), device('d3')]]]) }),
    ]);
    expect(merged.devicesByHost?.get('h1')).toEqual([device('d1', 'A'), device('d2'), device('d3')]);
  });

  it('mergeKeyReads quarantines a device id seen under two hosts', () => {
    const merged = mergeKeyReads([
      okRead('a', { hosts: [host('h1')], devicesByHost: new Map([['h1', [device('d1'), device('d2')]]]) }),
      okRead('b', { hosts: [host('h2')], devicesByHost: new Map([['h2', [device('d1'), device('d3')]]]) }),
    ]);
    expect(merged.devicesByHost?.get('h1')).toEqual([device('d2')]);
    expect(merged.devicesByHost?.get('h2')).toEqual([device('d3')]);
    expect([...merged.conflictingDeviceIds]).toEqual(['d1']);
  });

  it('mergeKeyReads leaves a device one key reports under two hosts as the single-key engine did', () => {
    const merged = mergeKeyReads([
      okRead('a', { hosts: [host('h1'), host('h2')], devicesByHost: new Map([['h1', [device('d1')]], ['h2', [device('d1')]]]) }),
    ]);
    expect(merged.conflictingDeviceIds.size).toBe(0);
    expect(merged.devicesByHost?.get('h1')).toEqual([device('d1')]);
    expect(merged.devicesByHost?.get('h2')).toEqual([device('d1')]);
    // A second key reporting it under one of those hosts makes it a conflict.
    const withB = mergeKeyReads([
      okRead('a', { hosts: [host('h1'), host('h2')], devicesByHost: new Map([['h1', [device('d1')]], ['h2', [device('d1')]]]) }),
      okRead('b', { hosts: [host('h1')], devicesByHost: new Map([['h1', [device('d1')]]]) }),
    ]);
    expect([...withB.conflictingDeviceIds]).toEqual(['d1']);
  });

  it('mergeKeyReads marks a coverage gap when a key lists a host but returns no device group for it', () => {
    const merged = mergeKeyReads([
      okRead('a', { hosts: [host('h1')], siteRead: siteRead([site('s1', 'h1')]), devicesByHost: new Map([['h1', [device('d1')]]]) }),
      okRead('b', { hosts: [host('h1'), host('h2')], siteRead: siteRead([site('s1', 'h1'), site('s2', 'h2')]), devicesByHost: new Map([['h2', [device('d2')]]]) }),
    ]);
    expect([...merged.coverageGapHostIds]).toEqual(['h1']);
    expect(merged.coverageGapKeyIds.get('h1')).toEqual(['b']);
    // A host no key returned devices for is not a gap: the per-mapping "not present" error covers it.
    const none = mergeKeyReads([
      okRead('a', { hosts: [host('h1')], siteRead: siteRead([site('s1', 'h1')]), devicesByHost: new Map() }),
    ]);
    expect(none.coverageGapHostIds.size).toBe(0);
  });

  it("mergeKeyReads drops all metrics when any ok key's metrics read failed", () => {
    const merged = mergeKeyReads([
      okRead('a', { metricsBySite: new Map([['h1::s1', metric(1)]]) }),
      okRead('b', { metricsError: 'UniFi ISP metrics read failed: timeout' }),
    ]);
    expect(merged.metricsBySite).toBeUndefined();
    expect(merged.metricsError).toBe('"B": UniFi ISP metrics read failed: timeout');
    // One key: the message is passed through unchanged.
    const single = mergeKeyReads([okRead('a', { metricsError: 'UniFi ISP metrics read failed: timeout' })]);
    expect(single.metricsError).toBe('UniFi ISP metrics read failed: timeout');
  });

  it('mergeKeyReads drops a bare-site-id metrics entry supplied by two keys', () => {
    const merged = mergeKeyReads([
      okRead('a', { metricsBySite: new Map([['default', metric(1)], ['h1::s1', metric(2)], ['solo', metric(5)]]) }),
      okRead('b', { metricsBySite: new Map([['default', metric(3)], ['h1::s1', metric(4)]]) }),
    ]);
    expect(merged.metricsBySite?.has('default')).toBe(false);
    expect(merged.metricsBySite?.get('h1::s1')).toEqual(metric(2));
    expect(merged.metricsBySite?.get('solo')).toEqual(metric(5));
  });

  it("mergeKeyReads counts a failed key's siteRead for the multi-site guard but not its devices", () => {
    const merged = mergeKeyReads([
      okRead('a', { hosts: [host('h1')], siteRead: siteRead([site('s1', 'h1')]), devicesByHost: new Map([['h1', [device('d1')]]]) }),
      {
        keyId: 'b', label: 'B', ok: false, error: 'UniFi /v1/devices read failed: boom', authFailure: false, httpStatus: null, cause: undefined,
        hosts: [host('h1')], siteRead: siteRead([site('s2', 'h1')], { hostsWithDroppedRows: new Set(['h9']), rowsWithoutHostId: 1 }),
      },
    ]);
    expect(merged.siteRead?.sites).toEqual([site('s1', 'h1'), site('s2', 'h1')]);
    expect([...merged.siteRead!.hostsWithDroppedRows]).toEqual(['h9']);
    expect(merged.siteRead?.rowsWithoutHostId).toBe(1);
    expect(merged.devicesByHost?.get('h1')).toEqual([device('d1')]);
    expect(merged.failedKeys.map((f) => f.keyId)).toEqual(['b']);
    // The failed key's devices never existed, so it is not a coverage gap.
    expect(merged.coverageGapHostIds.size).toBe(0);
  });

  it('mergeKeyReads counts each key\'s distinct sites per host, including a key that lists the host with none', () => {
    const merged = mergeKeyReads([
      okRead('a', { hosts: [host('h1')], siteRead: siteRead([site('s1', 'h1'), site('s1', 'h1')]), devicesByHost: new Map([['h1', [device('d1')]]]) }),
      okRead('b', { hosts: [host('h1')], siteRead: siteRead([]), devicesByHost: new Map() }),
      okRead('c', { hosts: [], siteRead: siteRead([]), devicesByHost: new Map([['h1', [device('d1')]]]) }),
    ]);
    expect(merged.hostSiteCounts.get('h1')).toEqual(new Map([['a', 1], ['b', 0], ['c', 0]]));
  });
});
