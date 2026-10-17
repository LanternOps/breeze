import { describe, it, expect, vi, beforeEach } from 'vitest';

const pub = vi.hoisted(() => ({ refreshPublishedPage: vi.fn() }));
vi.mock('../services/trustPage/publication', () => pub);
const sset = vi.hoisted(() => ({ rebuildServingSetFromDb: vi.fn() }));
vi.mock('../services/trustPage/servingSet', () => sset);
vi.mock('../services/trustPage/predicate', () => ({ livePublicationPredicate: () => ({}) }));
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../services/sentry', () => sentry);
const dbm = vi.hoisted(() => ({ rows: [] as unknown[], executeResult: { count: 0 } as unknown }));
vi.mock('../db', () => ({
  db: {
    select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => dbm.rows }) }) }),
    execute: async () => dbm.executeResult,
  },
  runOutsideDbContext: (fn: any) => fn(),
  withSystemDbAccessContext: (fn: any) => fn(),
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));

import { runTrustPageSnapshotSweepOnce } from './trustPageSnapshotWorker';

describe('trust page snapshot sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbm.rows = [{ pageId: 'a' }, { pageId: 'b' }];
    dbm.executeResult = Object.assign([], { count: 3 });
    sset.rebuildServingSetFromDb.mockResolvedValue(3);
  });

  it('refreshes every live page, rebuilds the serving set once, prunes old snapshots', async () => {
    pub.refreshPublishedPage
      .mockResolvedValueOnce({ rebuilt: true, snapshotId: 's' })
      .mockResolvedValueOnce({ rebuilt: false, snapshotId: 's2' });
    const out = await runTrustPageSnapshotSweepOnce(new Date('2026-10-13T12:11:00Z'));
    expect(out).toMatchObject({ pages: 2, rebuilt: 1, failed: 0, pruned: 3, servingMembers: 3 });
    expect(sset.rebuildServingSetFromDb).toHaveBeenCalledTimes(1);
  });

  it('one page failing does not stop the sweep, and the serving set is still rebuilt', async () => {
    pub.refreshPublishedPage
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ rebuilt: false, snapshotId: null });
    const out = await runTrustPageSnapshotSweepOnce();
    expect(out).toMatchObject({ pages: 2, failed: 1 });
    expect(pub.refreshPublishedPage).toHaveBeenCalledTimes(2);
    expect(sentry.captureException).toHaveBeenCalled();
    expect(sset.rebuildServingSetFromDb).toHaveBeenCalledTimes(1);
  });
});
