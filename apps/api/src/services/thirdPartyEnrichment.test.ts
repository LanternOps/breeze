import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockCatalogRows = [
  {
    id: 'cat-firefox',
    source: 'third_party',
    packageId: 'Mozilla.Firefox',
    vendor: 'Mozilla',
    friendlyName: 'Mozilla Firefox',
    category: 'application',
    defaultSeverity: 'important',
  },
];

vi.mock('drizzle-orm', () => ({
  eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn().mockResolvedValue(mockCatalogRows),
    })),
  },
  // #8636 — invalidateCatalogCache goes through the cluster invalidator.
  runAfterDbContextExit: (_label: string, work: () => unknown) => { work(); },
  runAfterDbContextCommit: (_label: string, work: () => unknown) => { work(); },
}));

vi.mock('../db/schema', () => ({
  thirdPartyPackageCatalog: {
    id: 'cat.id',
    source: 'cat.source',
    packageId: 'cat.packageId',
    vendor: 'cat.vendor',
    friendlyName: 'cat.friendlyName',
    category: 'cat.category',
    defaultSeverity: 'cat.defaultSeverity',
  },
  patchSeverityEnum: {
    enumValues: ['critical', 'important', 'moderate', 'low', 'unknown'] as const,
  },
}));

import { db } from '../db';
import { ClusterCacheBus, __setClusterCacheBusForTests } from './clusterCacheBus';
import { getClusterCacheTarget } from './clusterCacheRegistry';
import { enrichFromCatalog, invalidateCatalogCache, primeCatalogCache } from './thirdPartyEnrichment';

describe('enrichFromCatalog', () => {
  beforeEach(async () => {
    await primeCatalogCache();
  });

  it('overrides title/vendor/category and applies catalog severity when agent severity is unknown', async () => {
    const out = await enrichFromCatalog({
      source: 'third_party',
      packageId: 'Mozilla.Firefox',
      title: 'firefox',
      vendor: null,
      severity: 'unknown',
    });
    expect(out.title).toBe('Mozilla Firefox');
    expect(out.vendor).toBe('Mozilla');
    expect(out.category).toBe('application');
    expect(out.severity).toBe('important');
    expect(out.matchedCatalogId).toBe('cat-firefox');
  });

  it('always applies the catalog severity on a hit, ignoring an agent-reported severity', async () => {
    // `severity` is classification, not identity: a curated match confirms
    // WHAT the package is, not how severe this particular agent thinks it is.
    // Only the catalog's own `defaultSeverity` may classify a shared row.
    const out = await enrichFromCatalog({
      source: 'third_party',
      packageId: 'Mozilla.Firefox',
      title: 'firefox',
      vendor: null,
      severity: 'critical',
    });
    expect(out.severity).toBe('important');
    expect(out.title).toBe('Mozilla Firefox');
  });

  it('passes through unchanged for non-third_party sources', async () => {
    const out = await enrichFromCatalog({
      source: 'microsoft',
      packageId: 'Mozilla.Firefox',
      title: 'Cumulative Update',
      vendor: null,
      severity: 'critical',
    });
    expect(out.matchedCatalogId).toBeNull();
    expect(out.title).toBe('Cumulative Update');
    expect(out.severity).toBe('critical');
  });

  it('passes through unchanged when packageId is null', async () => {
    const out = await enrichFromCatalog({
      source: 'third_party',
      packageId: null,
      title: 'something',
      vendor: 'X',
      severity: 'low',
    });
    expect(out.matchedCatalogId).toBeNull();
    expect(out.vendor).toBe('X');
  });

  it('passes through unchanged when catalog has no entry', async () => {
    const out = await enrichFromCatalog({
      source: 'third_party',
      packageId: 'Unknown.Package',
      title: 'Unknown',
      vendor: 'Acme',
      severity: 'low',
    });
    expect(out.matchedCatalogId).toBeNull();
    expect(out.title).toBe('Unknown');
    expect(out.vendor).toBe('Acme');
    expect(out.severity).toBe('low');
  });

  // #3559: agents report provider-prefixed ids (formatPatchID → "winget:...")
  // while the catalog stores bare ids. The prefixed id must still enrich.
  it('matches a provider-prefixed packageId against the bare catalog id', async () => {
    const out = await enrichFromCatalog({
      source: 'third_party',
      packageId: 'winget:Mozilla.Firefox',
      title: 'firefox',
      vendor: null,
      severity: 'unknown',
    });
    expect(out.matchedCatalogId).toBe('cat-firefox');
    expect(out.title).toBe('Mozilla Firefox');
    expect(out.vendor).toBe('Mozilla');
    expect(out.severity).toBe('important');
  });

  it('still misses when even the prefix-stripped packageId is not in the catalog', async () => {
    const out = await enrichFromCatalog({
      source: 'third_party',
      packageId: 'winget:Unknown.Package',
      title: 'Unknown',
      vendor: 'Acme',
      severity: 'low',
    });
    expect(out.matchedCatalogId).toBeNull();
    expect(out.title).toBe('Unknown');
    expect(out.vendor).toBe('Acme');
  });

  // Only the winget prefix is stripped. winget/chocolatey/homebrew all share
  // source 'third_party' and the catalog has no provider dimension, so a
  // non-winget provider must NOT inherit a winget-curated row (would be a
  // cross-provider mis-enrichment).
  it.each(['chocolatey:Mozilla.Firefox', 'homebrew:Mozilla.Firefox', 'anything:Mozilla.Firefox'])(
    'does not enrich a non-winget prefixed id (%s) from the winget catalog row',
    async (packageId) => {
      const out = await enrichFromCatalog({
        source: 'third_party',
        packageId,
        title: 'orig',
        vendor: 'orig-vendor',
        severity: 'low',
      });
      expect(out.matchedCatalogId).toBeNull();
      expect(out.title).toBe('orig');
      expect(out.vendor).toBe('orig-vendor');
    },
  );

  it('prefers an exact catalog match over prefix-stripping (bare id already matches)', async () => {
    // The bare id path still works unchanged.
    const out = await enrichFromCatalog({
      source: 'third_party',
      packageId: 'Mozilla.Firefox',
      title: 'firefox',
      vendor: null,
      severity: 'unknown',
    });
    expect(out.matchedCatalogId).toBe('cat-firefox');
  });
});

describe('cluster cache binding (#8636)', () => {
  const NAME = 'third-party-package-catalog';
  const firefox = (friendlyName: string) => ({ ...mockCatalogRows[0]!, friendlyName });
  const enrichFirefox = () => enrichFromCatalog({
    source: 'third_party',
    packageId: 'Mozilla.Firefox',
    title: 'firefox',
    vendor: null,
    severity: 'unknown',
  });
  let published: Array<[string, string | null]>;

  beforeEach(() => {
    published = [];
    const bus = new ClusterCacheBus({ origin: 'unit', getPublisher: () => null, createSubscriber: () => null });
    vi.spyOn(bus, 'publish').mockImplementation(async (cache: string, key: string | null) => {
      published.push([cache, key]);
      return 'published';
    });
    __setClusterCacheBusForTests(bus);
    invalidateCatalogCache();
    published.length = 0;
  });
  afterEach(() => __setClusterCacheBusForTests(null));

  it('a remote drop makes the next lookup reload the catalog from the DB', async () => {
    await primeCatalogCache();
    const selectsAfterPrime = vi.mocked(db.select).mock.calls.length;
    await enrichFirefox();
    expect(vi.mocked(db.select).mock.calls.length).toBe(selectsAfterPrime);

    getClusterCacheTarget(NAME)!.invalidate();

    await enrichFirefox();
    expect(vi.mocked(db.select).mock.calls.length).toBe(selectsAfterPrime + 1);
  });

  it('the writer call publishes [name, null] (the catalog is global)', () => {
    invalidateCatalogCache();
    expect(published).toEqual([[NAME, null]]);
  });

  it('a load in flight when a remote drop lands is not stored: the caller gets the reloaded rows', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(db.select)
      .mockImplementationOnce((() => ({ from: () => gate.then(() => [firefox('Old Firefox')]) })) as never)
      .mockImplementationOnce((() => ({ from: () => Promise.resolve([firefox('New Firefox')]) })) as never);
    const selectsBefore = vi.mocked(db.select).mock.calls.length;
    const inFlight = enrichFirefox();

    getClusterCacheTarget(NAME)!.invalidate();
    release();

    expect((await inFlight).title).toBe('New Firefox');
    // The pre-drop load was discarded, the reload is what is cached now.
    expect((await enrichFirefox()).title).toBe('New Firefox');
    expect(vi.mocked(db.select).mock.calls.length).toBe(selectsBefore + 2);
  });
});
