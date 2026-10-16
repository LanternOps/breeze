import { beforeEach, describe, expect, it, vi } from 'vitest';

// Ordered Drizzle mock: every awaited `db.select(...)...` chain resolves with
// the next queued row set, in source order.
const selectQueue: unknown[][] = [];
function chainable(rows: unknown[]) {
  const obj: Record<string, unknown> = {
    from: () => obj,
    where: () => obj,
    then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return obj;
}
const selectMock = vi.fn(() => chainable(selectQueue.shift() ?? []));
const systemContextMock = vi.fn((fn: () => unknown) => fn());
vi.mock('../db', () => ({
  db: { select: selectMock },
  withSystemDbAccessContext: systemContextMock,
}));

const { listIdentityKeyRoots, keyRootsIndexAllowsOrigin } = await import('./backupKeyRoots');
const { LEGACY_FLAT_ROOT } = await import('./backupKeyLayout');

const IDENTITY = 's3::https://s3.example.test::shared-bucket';

/** Queues, in order: snapshots, NULL-identity snapshots (only when config ids are passed), reservations, unswept retirements, erasure targets. */
function queue(rows: {
  snapshots?: unknown[];
  nullIdentitySnapshots?: unknown[];
  reservations?: unknown[];
  retirements?: unknown[];
  erasureTargets?: unknown[];
}, withNullIdentity = false) {
  selectQueue.push(rows.snapshots ?? []);
  if (withNullIdentity) selectQueue.push(rows.nullIdentitySnapshots ?? []);
  selectQueue.push(rows.reservations ?? []);
  selectQueue.push(rows.retirements ?? []);
  selectQueue.push(rows.erasureTargets ?? []);
}

const legacy = (snapshotId: string) => ({ snapshotId, keyLayout: 'legacy_flat', keyPrefix: null });
const prefixed = (snapshotId: string, keyPrefix: string) => ({ snapshotId, keyLayout: 'prefixed_flat', keyPrefix });

describe('listIdentityKeyRoots', () => {
  beforeEach(() => {
    selectQueue.length = 0;
    selectMock.mockClear();
    systemContextMock.mockClear();
  });

  it('a legacy-only identity has exactly the legacy root', async () => {
    queue({ snapshots: [legacy('a1'), legacy('a2')], retirements: [legacy('a3')] });
    const result = await listIdentityKeyRoots({ storageIdentity: IDENTITY });
    expect(result.roots).toEqual([LEGACY_FLAT_ROOT]);
    expect(result.invalid).toEqual([]);
    expect([...result.rootIdsBySnapshotId.get('a1')!]).toEqual(['legacy']);
    expect(systemContextMock).toHaveBeenCalledTimes(1);
  });

  it('an identity with no rows at all still has the legacy root', async () => {
    queue({});
    const result = await listIdentityKeyRoots({ storageIdentity: IDENTITY });
    expect(result.roots).toEqual([LEGACY_FLAT_ROOT]);
    expect(result.rootIdsBySnapshotId.size).toBe(0);
  });

  it('collects every recorded root, sorted by keyRootId', async () => {
    queue({
      snapshots: [prefixed('b1', 'orgB'), legacy('a1')],
      retirements: [prefixed('c1', 'msp/acme')],
    });
    const result = await listIdentityKeyRoots({ storageIdentity: IDENTITY });
    expect(result.roots).toEqual([
      LEGACY_FLAT_ROOT,
      { layout: 'prefixed_flat', prefix: 'msp/acme' },
      { layout: 'prefixed_flat', prefix: 'orgB' },
    ]);
  });

  it('includes a root recorded only on a reservation', async () => {
    queue({ reservations: [prefixed('r1', 'orgB')] });
    const result = await listIdentityKeyRoots({ storageIdentity: IDENTITY });
    expect(result.roots).toEqual([LEGACY_FLAT_ROOT, { layout: 'prefixed_flat', prefix: 'orgB' }]);
    expect([...result.rootIdsBySnapshotId.get('r1')!]).toEqual(['prefixed:orgB']);
  });

  it('includes a root recorded only on an erasure target, reading a NULL root as legacy', async () => {
    queue({
      erasureTargets: [
        prefixed('e1', 'orgB'),
        { snapshotId: 'e2', keyLayout: null, keyPrefix: null },
      ],
    });
    const result = await listIdentityKeyRoots({ storageIdentity: IDENTITY });
    expect(result.roots).toEqual([LEGACY_FLAT_ROOT, { layout: 'prefixed_flat', prefix: 'orgB' }]);
    expect([...result.rootIdsBySnapshotId.get('e2')!]).toEqual(['legacy']);
    expect(result.invalid).toEqual([]);
  });

  it('reads NULL-identity snapshot rows of the given configurations', async () => {
    queue({ nullIdentitySnapshots: [prefixed('n1', 'orgB')] }, true);
    const result = await listIdentityKeyRoots({ storageIdentity: IDENTITY, nullIdentityConfigIds: ['cfg-1'] });
    expect(result.roots).toEqual([LEGACY_FLAT_ROOT, { layout: 'prefixed_flat', prefix: 'orgB' }]);
    expect(selectMock).toHaveBeenCalledTimes(5);
  });

  it('does not query NULL-identity rows when no configuration is given', async () => {
    queue({});
    await listIdentityKeyRoots({ storageIdentity: IDENTITY, nullIdentityConfigIds: [] });
    expect(selectMock).toHaveBeenCalledTimes(4);
  });

  it('records every root an id is named under', async () => {
    queue({ snapshots: [legacy('x1')], reservations: [prefixed('x1', 'orgB')] });
    const result = await listIdentityKeyRoots({ storageIdentity: IDENTITY });
    expect([...result.rootIdsBySnapshotId.get('x1')!].sort()).toEqual(['legacy', 'prefixed:orgB']);
  });

  it.each([
    ['a prefixed row with no prefix', { snapshotId: 'bad', keyLayout: 'prefixed_flat', keyPrefix: null }],
    ['a prefixed row whose prefix is not in normalized form', { snapshotId: 'bad', keyLayout: 'prefixed_flat', keyPrefix: 'a//b' }],
    ['a prefixed row whose prefix has a snapshots segment', { snapshotId: 'bad', keyLayout: 'prefixed_flat', keyPrefix: 'x/snapshots' }],
    ['a legacy row carrying a prefix', { snapshotId: 'bad', keyLayout: 'legacy_flat', keyPrefix: 'p' }],
    ['an unknown layout', { snapshotId: 'bad', keyLayout: 'device_scoped', keyPrefix: null }],
  ])('reports %s as invalid and adds no root for it', async (_name, row) => {
    queue({ snapshots: [legacy('ok'), row] });
    const result = await listIdentityKeyRoots({ storageIdentity: IDENTITY });
    expect(result.roots).toEqual([LEGACY_FLAT_ROOT]);
    expect(result.invalid).toEqual([
      { source: 'snapshot', snapshotId: 'bad', keyLayout: row.keyLayout, keyPrefix: row.keyPrefix },
    ]);
  });

  it('reports an invalid erasure-target root with its source', async () => {
    queue({ erasureTargets: [{ snapshotId: 'bad', keyLayout: 'prefixed_flat', keyPrefix: null }] });
    const result = await listIdentityKeyRoots({ storageIdentity: IDENTITY });
    expect(result.invalid).toEqual([{ source: 'erasure_target', snapshotId: 'bad', keyLayout: 'prefixed_flat', keyPrefix: null }]);
  });
});

describe('keyRootsIndexAllowsOrigin', () => {
  const P = { layout: 'prefixed_flat', prefix: 'orgB' } as const;
  const index = new Map<string, Set<string>>([
    ['legacy-origin', new Set(['legacy'])],
    ['p-origin', new Set(['prefixed:orgB'])],
    ['both', new Set(['legacy', 'prefixed:orgB'])],
  ]);

  it('allows an origin recorded only under the same root', () => {
    expect(keyRootsIndexAllowsOrigin(index, LEGACY_FLAT_ROOT, 'legacy-origin')).toBe(true);
    expect(keyRootsIndexAllowsOrigin(index, P, 'p-origin')).toBe(true);
  });

  it('refuses an origin recorded under another root, or under several', () => {
    expect(keyRootsIndexAllowsOrigin(index, LEGACY_FLAT_ROOT, 'p-origin')).toBe(false);
    expect(keyRootsIndexAllowsOrigin(index, P, 'legacy-origin')).toBe(false);
    expect(keyRootsIndexAllowsOrigin(index, LEGACY_FLAT_ROOT, 'both')).toBe(false);
    expect(keyRootsIndexAllowsOrigin(index, P, 'both')).toBe(false);
  });

  it('an origin with no recorded root is allowed only under the legacy root', () => {
    expect(keyRootsIndexAllowsOrigin(index, LEGACY_FLAT_ROOT, 'unknown')).toBe(true);
    expect(keyRootsIndexAllowsOrigin(index, P, 'unknown')).toBe(false);
  });
});
