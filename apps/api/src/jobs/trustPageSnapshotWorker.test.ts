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
const w2 = vi.hoisted(() => ({ runDeclarationReminders: vi.fn(), pruneTrustAccessData: vi.fn() }));
vi.mock('../services/trustPage/declarationReminders', () => ({ runDeclarationReminders: w2.runDeclarationReminders }));
vi.mock('../services/trustPage/access/retention', () => ({ pruneTrustAccessData: w2.pruneTrustAccessData }));

import { runTrustPageSnapshotSweepOnce } from './trustPageSnapshotWorker';

describe('trust page snapshot sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbm.rows = [{ pageId: 'a' }, { pageId: 'b' }];
    dbm.executeResult = Object.assign([], { count: 3 });
    sset.rebuildServingSetFromDb.mockResolvedValue(3);
    w2.runDeclarationReminders.mockResolvedValue({ reminded: 2 });
    w2.pruneTrustAccessData.mockResolvedValue({ tokens: 4, requests: 1 });
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

  it('runs the W2 declaration reminders and access retention after the prune, with the sweep clock', async () => {
    pub.refreshPublishedPage.mockResolvedValue({ rebuilt: false, snapshotId: null });
    const now = new Date('2026-10-13T12:11:00Z');
    const out = await runTrustPageSnapshotSweepOnce(now);
    expect(out).toMatchObject({ reminded: 2, accessPruned: { tokens: 4, requests: 1 } });
    expect(w2.runDeclarationReminders).toHaveBeenCalledWith(now);
    expect(w2.pruneTrustAccessData).toHaveBeenCalledWith(now);
  });

  it('a failing W2 hook is captured and does not stop the other one', async () => {
    pub.refreshPublishedPage.mockResolvedValue({ rebuilt: false, snapshotId: null });
    w2.runDeclarationReminders.mockRejectedValueOnce(new Error('mail down'));
    const out = await runTrustPageSnapshotSweepOnce();
    expect(out).toMatchObject({ reminded: 0, accessPruned: { tokens: 4, requests: 1 }, pruned: 3 });
    expect(sentry.captureException).toHaveBeenCalled();
  });
});
