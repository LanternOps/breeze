import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { redis } = vi.hoisted(() => ({
  redis: { get: vi.fn(), set: vi.fn() },
}));

vi.mock('./redis', () => ({ getRedis: vi.fn(() => redis) }));

import {
  __resetOfflineDataForTests,
  __setOfflineCacheDirForTests,
  ensureOfflineData,
  offlineClassify,
  readOfflineClassifierStatus,
} from './ipClassifyOffline';
import { TOR_EXIT_SNAPSHOT } from './ipClassifyData/torExitSnapshot';
import { HOSTING_ASN_SNAPSHOT } from './ipClassifyData/hostingAsnSnapshot';

const SNAPSHOT_TOR_IP = TOR_EXIT_SNAPSHOT.split('\n').map((l) => l.trim()).find(Boolean)!;

/** 60 documentation-range addresses: enough to clear the minimum-size guard. */
const torList = (extra: string[] = []) =>
  [...Array.from({ length: 60 }, (_, i) => `198.51.100.${i + 1}`), ...extra].join('\n');
const hostingList = (asns: number[]) =>
  ['ASN,Entity', ...asns.map((a) => `${a},"Example ${a}"`), ...Array.from({ length: 60 }, (_, i) => `${65000 + i},x`)].join('\n');
/** An ASN database large enough to clear its guard, with two known ranges. */
function asnDb(): Buffer {
  const rows = [
    '192.0.2.0\t192.0.2.255\t64500\tZZ\tEXAMPLE-HOSTING',
    '203.0.113.0\t203.0.113.255\t64501\tZZ\tEXAMPLE-ACCESS',
  ];
  for (let i = 0; i < 10_000; i += 1) {
    const a = 11 + Math.floor(i / 256);
    rows.push(`${a}.${i % 256}.0.0\t${a}.${i % 256}.255.255\t${70000 + i}\tZZ\tFILLER`);
  }
  return gzipSync(Buffer.from(rows.join('\n')));
}

type Route = { status?: number; body: string | Buffer } | 'hang' | 'throw';

function stubFetch(routes: Record<string, Route>) {
  const fetchMock = vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
    const route = routes[url];
    if (!route || route === 'throw') throw new Error(`network down for ${url}`);
    if (route === 'hang') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    const body = typeof route.body === 'string' ? Buffer.from(route.body) : route.body;
    return new Response(new Uint8Array(body), { status: route.status ?? 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const TOR_URL = 'https://tor.example.test/exits';
const HOSTING_URL = 'https://hosting.example.test/asns.csv';
const ASN_URL = 'https://asn.example.test/db.tsv.gz';

describe('offline IP classifier data', () => {
  let cacheDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    cacheDir = mkdtempSync(join(tmpdir(), 'ipclassify-test-'));
    __resetOfflineDataForTests();
    __setOfflineCacheDirForTests(cacheDir);
    process.env.IP_CLASSIFY_TOR_LIST_URL = TOR_URL;
    process.env.IP_CLASSIFY_HOSTING_ASN_URL = HOSTING_URL;
    process.env.IP_CLASSIFY_ASN_DB_URL = ASN_URL;
  });

  afterEach(() => {
    delete process.env.IP_CLASSIFY_TOR_LIST_URL;
    delete process.env.IP_CLASSIFY_HOSTING_ASN_URL;
    delete process.env.IP_CLASSIFY_ASN_DB_URL;
    vi.unstubAllGlobals();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('falls back to the bundled Tor snapshot when every download fails', async () => {
    stubFetch({});
    await ensureOfflineData({ waitMs: 5_000 });

    await expect(offlineClassify(SNAPSHOT_TOR_IP)).resolves.toEqual({
      ipClass: 'tor', asn: null, provider: 'offline-partial',
    });
    // No ASN data → the hosting check could not run → partial, never residential.
    await expect(offlineClassify('203.0.113.10')).resolves.toEqual({
      ipClass: 'unknown', asn: null, provider: 'offline-partial',
    });
  });

  it('classifies tor, hosting and "checked, nothing found" once all three sources load', async () => {
    stubFetch({
      [TOR_URL]: { body: torList(['203.0.113.66']) },
      [HOSTING_URL]: { body: hostingList([64500]) },
      [ASN_URL]: { body: asnDb() },
    });
    await ensureOfflineData({ waitMs: 10_000 });

    await expect(offlineClassify('203.0.113.66')).resolves.toEqual({ ipClass: 'tor', asn: 64501, provider: 'offline' });
    await expect(offlineClassify('192.0.2.10')).resolves.toEqual({ ipClass: 'hosting', asn: 64500, provider: 'offline' });
    await expect(offlineClassify('203.0.113.10')).resolves.toEqual({ ipClass: 'unknown', asn: 64501, provider: 'offline' });
    await expect(offlineClassify('10.0.0.5')).resolves.toEqual({ ipClass: 'unknown', asn: null, provider: 'none' });
    // The downloaded Tor list replaces the snapshot rather than merging with it.
    await expect(offlineClassify(SNAPSHOT_TOR_IP)).resolves.toMatchObject({ ipClass: expect.not.stringMatching(/^tor$/) });
  });

  it('rejects a download too small to be the real list and keeps the snapshot', async () => {
    stubFetch({
      [TOR_URL]: { body: '<html>captive portal</html>\n203.0.113.66' },
      [HOSTING_URL]: { body: 'ASN,Entity\n64500,x' },
    });
    await ensureOfflineData({ waitMs: 5_000 });

    await expect(offlineClassify(SNAPSHOT_TOR_IP)).resolves.toMatchObject({ ipClass: 'tor' });
    await expect(offlineClassify('203.0.113.66')).resolves.toMatchObject({ ipClass: 'unknown' });
    const status = await readOfflineClassifierStatus();
    expect(status).toMatchObject({
      tor: { source: 'snapshot' },
      hosting: { source: 'snapshot', entries: HOSTING_ASN_SNAPSHOT.length },
    });
  });

  it('treats a corrupt gzip ASN database as a failed download instead of hanging', async () => {
    const corrupt = Buffer.concat([gzipSync(Buffer.from('x')).subarray(0, 10), Buffer.from('not really gzip at all')]);
    stubFetch({
      [TOR_URL]: { body: torList() },
      [HOSTING_URL]: { body: hostingList([64500]) },
      [ASN_URL]: { body: corrupt },
    });
    await ensureOfflineData({ waitMs: 5_000 });

    const status = await readOfflineClassifierStatus();
    expect(status?.asn).toMatchObject({ source: 'unavailable', lastError: expect.any(String) });
    await expect(offlineClassify('203.0.113.10')).resolves.toMatchObject({ provider: 'offline-partial' });
  });

  it('never fetches a source whose URL is set to none', async () => {
    process.env.IP_CLASSIFY_TOR_LIST_URL = 'none';
    process.env.IP_CLASSIFY_HOSTING_ASN_URL = 'none';
    process.env.IP_CLASSIFY_ASN_DB_URL = 'none';
    const fetchMock = stubFetch({});
    await ensureOfflineData({ waitMs: 1_000 });

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(offlineClassify(SNAPSHOT_TOR_IP)).resolves.toMatchObject({ ipClass: 'tor' });
  });

  it('passes an abort signal and does not block a lookup on a hanging download', async () => {
    const fetchMock = stubFetch({ [TOR_URL]: 'hang', [HOSTING_URL]: 'hang', [ASN_URL]: 'hang' });
    const started = Date.now();
    await expect(offlineClassify('203.0.113.10')).resolves.toEqual({
      ipClass: 'unknown', asn: null, provider: 'offline-partial',
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(fetchMock).toHaveBeenCalled();
    for (const call of fetchMock.mock.calls) expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not retry a failed download on every lookup', async () => {
    const fetchMock = stubFetch({});
    await ensureOfflineData({ waitMs: 5_000 });
    const calls = fetchMock.mock.calls.length;
    await ensureOfflineData({ waitMs: 5_000 });
    await offlineClassify('203.0.113.10');
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('reuses the on-disk ASN cache instead of downloading again', async () => {
    stubFetch({
      [TOR_URL]: { body: torList() },
      [HOSTING_URL]: { body: hostingList([64500]) },
      [ASN_URL]: { body: asnDb() },
    });
    await ensureOfflineData({ waitMs: 10_000 });

    __resetOfflineDataForTests();
    __setOfflineCacheDirForTests(cacheDir);
    const fetchMock = stubFetch({});
    await ensureOfflineData({ waitMs: 10_000 });

    expect(fetchMock.mock.calls.map((c) => c[0])).not.toContain(ASN_URL);
    await expect(offlineClassify('192.0.2.10')).resolves.toMatchObject({ asn: 64500, provider: 'offline' });
  });

  it('publishes its status to Redis so another process can show it', async () => {
    stubFetch({
      [TOR_URL]: { body: torList() },
      [HOSTING_URL]: { body: hostingList([64500]) },
      [ASN_URL]: { body: asnDb() },
    });
    await ensureOfflineData({ waitMs: 10_000 });

    const [, payload] = redis.set.mock.calls.at(-1)!;
    const published = JSON.parse(payload as string);
    expect(published).toMatchObject({
      tor: { source: 'download', entries: 60 },
      hosting: { source: 'download', entries: 61 },
      asn: { source: 'download', entries: 10_002 },
    });

    redis.get.mockResolvedValue(payload);
    await expect(readOfflineClassifierStatus()).resolves.toMatchObject({ asn: { entries: 10_002 } });
  });
});
