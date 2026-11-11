import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { redis } = vi.hoisted(() => ({
  redis: { get: vi.fn(), set: vi.fn() },
}));

vi.mock('./redis', () => ({ getRedis: vi.fn(() => redis) }));

import { IP_CLASSIFY_HOSTING_ASN_DEFAULT_URL, ipClassifyAsnDbUrl, ipClassifyHostingAsnUrl } from '../config/env';
import {
  LIST_MAX_AGE_MS,
  TOR_MAX_AGE_MS,
  __resetOfflineDataForTests,
  __setOfflineCacheDirForTests,
  ensureOfflineData,
  offlineBaselineComplete,
  offlineClassify,
  readOfflineClassifierStatus,
} from './ipClassifyOffline';
import { TOR_EXIT_SNAPSHOT } from './ipClassifyData/torExitSnapshot';
import { HOSTING_ASN_SNAPSHOT } from './ipClassifyData/hostingAsnSnapshot';

const SNAPSHOT_TOR_IP = TOR_EXIT_SNAPSHOT.split('\n').map((l) => l.trim()).find(Boolean)!;
const SNAPSHOT_TOR_SIZE = new Set(TOR_EXIT_SNAPSHOT.split('\n').map((l) => l.trim()).filter(Boolean)).size;
const SNAPSHOT_HOSTING_ASN = HOSTING_ASN_SNAPSHOT[0]!;

/** `count` IPv6 documentation-range addresses (2001:db8::/32), plus extras. */
const torList = (count = SNAPSHOT_TOR_SIZE, extra: string[] = []) =>
  [...Array.from({ length: count }, (_, i) => `2001:db8::${(i + 1).toString(16)}`), ...extra].join('\n');
/** The bundled hosting list plus extra ASNs (a download that only adds). */
const hostingList = (extra: number[] = [], base: readonly number[] = HOSTING_ASN_SNAPSHOT) =>
  ['ASN,Entity', ...base.map((a) => `${a},x`), ...extra.map((a) => `${a},"Example ${a}"`)].join('\n');
/** An ASN database with two known ranges plus `filler` routed ranges. */
function asnDb(filler = 10_000): Buffer {
  const rows = [
    '192.0.2.0\t192.0.2.255\t64500\tZZ\tEXAMPLE-HOSTING',
    '203.0.113.0\t203.0.113.255\t64501\tZZ\tEXAMPLE-ACCESS',
  ];
  for (let i = 0; i < filler; i += 1) {
    const a = 11 + Math.floor(i / 256);
    rows.push(`${a}.${i % 256}.0.0\t${a}.${i % 256}.255.255\t${70000 + i}\tZZ\tFILLER`);
  }
  return gzipSync(Buffer.from(rows.join('\n')));
}

type Route = { status?: number; body: string | Buffer; headers?: Record<string, string> } | 'hang' | 'throw';

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
    const status = route.status ?? 200;
    return new Response(status >= 300 && status < 400 ? null : new Uint8Array(body), { status, headers: route.headers });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const TOR_URL = 'https://tor.example.test/exits';
const HOSTING_URL = 'https://hosting.example.test/asns.csv';
const ASN_URL = 'https://asn.example.test/db.tsv.gz';
const allFresh = (extraTor: string[] = [], extraHosting: number[] = [64500]): Record<string, Route> => ({
  [TOR_URL]: { body: torList(SNAPSHOT_TOR_SIZE, extraTor) },
  [HOSTING_URL]: { body: hostingList(extraHosting) },
  [ASN_URL]: { body: asnDb() },
});

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
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.IP_CLASSIFY_TOR_LIST_URL;
    delete process.env.IP_CLASSIFY_HOSTING_ASN_URL;
    delete process.env.IP_CLASSIFY_ASN_DB_URL;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  it('classifies tor, hosting and "checked, nothing found" once all three sources are fresh downloads', async () => {
    stubFetch(allFresh(['203.0.113.66']));
    await ensureOfflineData({ waitMs: 10_000 });

    expect(offlineBaselineComplete()).toBe(true);
    await expect(offlineClassify('203.0.113.66')).resolves.toEqual({ ipClass: 'tor', asn: 64501, provider: 'offline' });
    await expect(offlineClassify('192.0.2.10')).resolves.toEqual({ ipClass: 'hosting', asn: 64500, provider: 'offline' });
    await expect(offlineClassify('203.0.113.10')).resolves.toEqual({ ipClass: 'unknown', asn: 64501, provider: 'offline' });
    await expect(offlineClassify('10.0.0.5')).resolves.toEqual({ ipClass: 'unknown', asn: null, provider: 'none' });
    // The downloaded Tor list replaces the snapshot rather than merging with it.
    await expect(offlineClassify(SNAPSHOT_TOR_IP)).resolves.toMatchObject({ ipClass: expect.not.stringMatching(/^tor$/) });
  });

  it('never clears an address from the bundled snapshots alone, even with a fresh ASN database', async () => {
    stubFetch({ [ASN_URL]: { body: asnDb() } });
    await ensureOfflineData({ waitMs: 10_000 });

    expect(offlineBaselineComplete()).toBe(false);
    await expect(offlineClassify('203.0.113.10')).resolves.toEqual({
      ipClass: 'unknown', asn: 64501, provider: 'offline-partial',
    });
    await expect(readOfflineClassifierStatus()).resolves.toMatchObject({ current: false });
  });

  it('falls back to partial once a download is past its maximum age and refreshes keep failing', async () => {
    stubFetch(allFresh());
    await ensureOfflineData({ waitMs: 10_000 });
    await expect(offlineClassify('203.0.113.10')).resolves.toMatchObject({ provider: 'offline' });

    stubFetch({});
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + TOR_MAX_AGE_MS + 60_000 });
    await ensureOfflineData({ waitMs: 5_000 });

    await expect(offlineClassify('203.0.113.10')).resolves.toEqual({
      ipClass: 'unknown', asn: 64501, provider: 'offline-partial',
    });
    expect(LIST_MAX_AGE_MS).toBeGreaterThan(TOR_MAX_AGE_MS);
  });

  it('rejects a Tor download that shrank below 80% of the last accepted list, keeping the old data and its age', async () => {
    stubFetch(allFresh(['203.0.113.66']));
    await ensureOfflineData({ waitMs: 10_000 });
    const before = (await readOfflineClassifierStatus())!.tor;

    // A truncated/tampered list that drops the known exit.
    stubFetch({ [TOR_URL]: { body: torList(Math.floor(SNAPSHOT_TOR_SIZE * 0.5)) } });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 25 * 60 * 60 * 1_000 });
    await ensureOfflineData({ waitMs: 5_000 });

    const after = (await readOfflineClassifierStatus())!.tor;
    expect(after.entries).toBe(before.entries);
    // Freshness did not advance on the rejected download.
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.lastError).toMatch(/expected at least/);
    await expect(offlineClassify('203.0.113.66')).resolves.toMatchObject({ ipClass: 'tor' });
  });

  it('rejects an undersized first Tor download against the snapshot', async () => {
    stubFetch({ ...allFresh(), [TOR_URL]: { body: torList(60, ['203.0.113.66']) } });
    await ensureOfflineData({ waitMs: 10_000 });

    await expect(offlineClassify(SNAPSHOT_TOR_IP)).resolves.toMatchObject({ ipClass: 'tor', provider: 'offline-partial' });
    await expect(readOfflineClassifierStatus()).resolves.toMatchObject({ tor: { source: 'snapshot' }, current: false });
  });

  it('unions the hosting download with the snapshot: a download can add an ASN, never remove one', async () => {
    // The download drops a bundled ASN and adds a new one.
    stubFetch({ ...allFresh(), [HOSTING_URL]: { body: hostingList([64500], HOSTING_ASN_SNAPSHOT.slice(1)) } });
    await ensureOfflineData({ waitMs: 10_000 });

    const status = await readOfflineClassifierStatus();
    expect(status?.hosting).toMatchObject({ source: 'download', entries: HOSTING_ASN_SNAPSHOT.length + 1 });
    await expect(offlineClassify('192.0.2.10')).resolves.toMatchObject({ ipClass: 'hosting' });
    expect(new Set(HOSTING_ASN_SNAPSHOT).has(SNAPSHOT_HOSTING_ASN)).toBe(true);
  });

  it('rejects a hosting download far smaller than the snapshot', async () => {
    stubFetch({ ...allFresh(), [HOSTING_URL]: { body: hostingList([64500], HOSTING_ASN_SNAPSHOT.slice(0, 100)) } });
    await ensureOfflineData({ waitMs: 10_000 });

    await expect(readOfflineClassifierStatus()).resolves.toMatchObject({
      hosting: { source: 'snapshot', entries: HOSTING_ASN_SNAPSHOT.length }, current: false,
    });
  });

  it('rejects an ASN database that shrank below 80% of the last accepted copy', async () => {
    stubFetch(allFresh());
    await ensureOfflineData({ waitMs: 10_000 });

    stubFetch({ ...allFresh(), [ASN_URL]: { body: asnDb(20_000) } });
    // Not yet due → nothing re-downloaded; jump past the weekly refresh.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 8 * 24 * 60 * 60 * 1_000 });
    await ensureOfflineData({ waitMs: 10_000 });
    const grown = (await readOfflineClassifierStatus())!.asn;
    expect(grown.entries).toBe(20_002);

    stubFetch({ ...allFresh(), [ASN_URL]: { body: asnDb(10_000) } });
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1_000);
    await ensureOfflineData({ waitMs: 10_000 });
    const after = (await readOfflineClassifierStatus())!.asn;
    // 10,002 is half of the 20,002 accepted last time: rejected.
    expect(after.entries).toBe(20_002);
    expect(after.updatedAt).toBe(grown.updatedAt);
    expect(after.lastError).toMatch(/expected at least/);
  });

  it('treats a corrupt gzip ASN database as a failed download instead of hanging', async () => {
    const corrupt = Buffer.concat([gzipSync(Buffer.from('x')).subarray(0, 10), Buffer.from('not really gzip at all')]);
    stubFetch({ ...allFresh(), [ASN_URL]: { body: corrupt } });
    await ensureOfflineData({ waitMs: 5_000 });

    const status = await readOfflineClassifierStatus();
    expect(status?.asn).toMatchObject({ source: 'unavailable', lastError: expect.any(String) });
    await expect(offlineClassify('203.0.113.10')).resolves.toMatchObject({ provider: 'offline-partial' });
  });

  it('follows an https redirect but refuses one to plain http', async () => {
    stubFetch({
      ...allFresh(),
      [ASN_URL]: { status: 302, body: '', headers: { location: 'https://mirror.example.test/db.tsv.gz' } },
      'https://mirror.example.test/db.tsv.gz': { body: asnDb() },
    });
    await ensureOfflineData({ waitMs: 10_000 });
    await expect(readOfflineClassifierStatus()).resolves.toMatchObject({ asn: { source: 'download' } });

    __resetOfflineDataForTests();
    __setOfflineCacheDirForTests(mkdtempSync(join(tmpdir(), 'ipclassify-test-')));
    const fetchMock = stubFetch({
      ...allFresh(),
      [ASN_URL]: { status: 302, body: '', headers: { location: 'http://mirror.example.test/db.tsv.gz' } },
      'http://mirror.example.test/db.tsv.gz': { body: asnDb() },
    });
    await ensureOfflineData({ waitMs: 10_000 });
    expect(fetchMock.mock.calls.map((c) => c[0])).not.toContain('http://mirror.example.test/db.tsv.gz');
    await expect(readOfflineClassifierStatus()).resolves.toMatchObject({
      asn: { source: 'unavailable', lastError: 'refusing a non-https URL' },
    });
  });

  it('accepts only https source URLs and pins the default hosting list to a commit', () => {
    expect(ipClassifyAsnDbUrl({ IP_CLASSIFY_ASN_DB_URL: 'http://mirror.example.test/db.tsv.gz' })).toBeNull();
    expect(ipClassifyAsnDbUrl({ IP_CLASSIFY_ASN_DB_URL: 'https://mirror.example.test/db.tsv.gz' }))
      .toBe('https://mirror.example.test/db.tsv.gz');
    expect(ipClassifyHostingAsnUrl({})).toBe(IP_CLASSIFY_HOSTING_ASN_DEFAULT_URL);
    expect(IP_CLASSIFY_HOSTING_ASN_DEFAULT_URL).toMatch(
      /^https:\/\/raw\.githubusercontent\.com\/brianhama\/bad-asn-list\/[0-9a-f]{40}\/bad-asn-list\.csv$/,
    );
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
    stubFetch(allFresh());
    await ensureOfflineData({ waitMs: 10_000 });

    __resetOfflineDataForTests();
    __setOfflineCacheDirForTests(cacheDir);
    const fetchMock = stubFetch({ [TOR_URL]: { body: torList() }, [HOSTING_URL]: { body: hostingList([64500]) } });
    await ensureOfflineData({ waitMs: 10_000 });

    expect(fetchMock.mock.calls.map((c) => c[0])).not.toContain(ASN_URL);
    await expect(offlineClassify('192.0.2.10')).resolves.toMatchObject({ asn: 64500, provider: 'offline' });
  });

  it('publishes its status to Redis so another process can show it', async () => {
    stubFetch(allFresh());
    await ensureOfflineData({ waitMs: 10_000 });

    const [, payload] = redis.set.mock.calls.at(-1)!;
    const published = JSON.parse(payload as string);
    expect(published).toMatchObject({
      tor: { source: 'download', entries: SNAPSHOT_TOR_SIZE },
      hosting: { source: 'download', entries: HOSTING_ASN_SNAPSHOT.length + 1 },
      asn: { source: 'download', entries: 10_002 },
      current: true,
    });

    __resetOfflineDataForTests();
    redis.get.mockResolvedValue(payload);
    await expect(readOfflineClassifierStatus()).resolves.toMatchObject({ asn: { entries: 10_002 }, current: true });
  });
});
