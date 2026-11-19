import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  inContext: false,
  deferred: [] as Array<() => unknown>,
  committed: [] as Array<() => unknown>,
}));

vi.mock('../db', () => ({
  runAfterDbContextExit: (_label: string, work: () => unknown) => {
    if (dbState.inContext) dbState.deferred.push(work);
    else work();
  },
  runAfterDbContextCommit: (_label: string, work: () => unknown) => {
    if (dbState.inContext) dbState.committed.push(work);
    else work();
  },
}));

import { ClusterCacheBus, __setClusterCacheBusForTests } from './clusterCacheBus';
import { getClusterCacheTarget } from './clusterCacheRegistry';
import { registerClusterInvalidator } from './clusterInvalidator';

describe('registerClusterInvalidator (#8636)', () => {
  let published: Array<[string, string | null]>;
  let dropped: Array<string | undefined>;

  beforeEach(() => {
    published = [];
    dropped = [];
    dbState.inContext = false;
    dbState.deferred = [];
    dbState.committed = [];
    const bus = new ClusterCacheBus({ origin: 'unit', getPublisher: () => null, createSubscriber: () => null });
    vi.spyOn(bus, 'publish').mockImplementation(async (cache: string, key: string | null) => {
      published.push([cache, key]);
      return 'published';
    });
    __setClusterCacheBusForTests(bus);
  });
  afterEach(() => __setClusterCacheBusForTests(null));

  it('registers a bus target whose invalidate is the local drop (what a remote message runs)', () => {
    registerClusterInvalidator('unit-target', (key) => dropped.push(key));
    getClusterCacheTarget('unit-target')!.invalidate('k1');
    getClusterCacheTarget('unit-target')!.invalidate();
    expect(dropped).toEqual(['k1', undefined]);
    expect(published).toEqual([]);
  });

  it('outside a DB context: drops locally and publishes the key once', () => {
    const inv = registerClusterInvalidator('unit-outside', (key) => dropped.push(key));
    inv.invalidateAroundCommit('k1');
    expect(dropped).toEqual(['k1', 'k1']);
    expect(published).toEqual([['unit-outside', 'k1']]);
  });

  it('no key publishes null (whole cache)', () => {
    registerClusterInvalidator('unit-all', (key) => dropped.push(key)).invalidateAroundCommit();
    expect(published).toEqual([['unit-all', null]]);
  });

  it('inside a context: drops now, drops again on exit, publishes only on COMMIT', () => {
    const inv = registerClusterInvalidator('unit-commit', (key) => dropped.push(key));
    dbState.inContext = true;
    inv.invalidateAroundCommit('k1');
    expect(dropped).toEqual(['k1']);
    expect(published).toEqual([]);
    dbState.inContext = false;
    for (const w of dbState.deferred.splice(0)) w();
    for (const w of dbState.committed.splice(0)) w();
    expect(dropped).toEqual(['k1', 'k1']);
    expect(published).toEqual([['unit-commit', 'k1']]);
  });

  it('a ROLLBACK publishes nothing; the local drops still run', () => {
    const inv = registerClusterInvalidator('unit-rollback', (key) => dropped.push(key));
    dbState.inContext = true;
    inv.invalidateAroundCommit('k1');
    dbState.inContext = false;
    dbState.committed = [];
    for (const w of dbState.deferred.splice(0)) w();
    expect(dropped).toEqual(['k1', 'k1']);
    expect(published).toEqual([]);
  });

  it('a throwing local drop does not fail the writer, and the publish still goes out', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const inv = registerClusterInvalidator('unit-throw', () => {
      throw new Error('boom');
    });
    expect(() => inv.invalidateAroundCommit('k1')).not.toThrow();
    expect(published).toEqual([['unit-throw', 'k1']]);
    error.mockRestore();
  });
});
