import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * jobs/wispGrantReconciler.ts — the 5-minute tick. W2 (#11085) adds the
 * specialist post-back re-sweep after the grant reconcile; it must never fail
 * the tick (the grant half is what the job exists for).
 */
const h = vi.hoisted(() => ({
  wispEnabled: vi.fn(() => true),
  reconcileActiveGrants: vi.fn(),
  resweepSpecialistResults: vi.fn(),
  resweepFirstLookPosts: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../config/env', async (orig) => ({ ...(await orig<typeof import('../config/env')>()), wispEnabled: h.wispEnabled }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/wisp/grantLifecycle', () => ({ reconcileActiveGrants: h.reconcileActiveGrants }));
vi.mock('../services/wisp/specialistResult', () => ({ resweepSpecialistResults: h.resweepSpecialistResults }));
vi.mock('../services/wisp/firstLook', () => ({ resweepFirstLookPosts: h.resweepFirstLookPosts }));
vi.mock('../services/sentry', () => ({ captureException: h.captureException }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('bullmq', () => ({ Queue: vi.fn(), Worker: vi.fn() }));

import { processWispGrantReconcile } from './wispGrantReconciler';

const grants = { scanned: 2, paused: 0, resumed: 0, expired: 0, failed: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  h.wispEnabled.mockReturnValue(true);
  h.reconcileActiveGrants.mockResolvedValue(grants);
  h.resweepSpecialistResults.mockResolvedValue({ scanned: 1, posted: 1, failed: 0 });
  h.resweepFirstLookPosts.mockResolvedValue({ scanned: 0, posted: 0, failed: 0, skipped: {} });
});

describe('processWispGrantReconcile', () => {
  it('re-sweeps missing specialist posts after reconciling grants', async () => {
    const result = await processWispGrantReconcile();
    expect(h.resweepSpecialistResults).toHaveBeenCalledTimes(1);
    expect(h.resweepSpecialistResults.mock.invocationCallOrder[0]!)
      .toBeGreaterThan(h.reconcileActiveGrants.mock.invocationCallOrder[0]!);
    expect(result).toEqual({ skipped: false, ...grants, specialistPosts: 1, firstLookPosts: 0 });
  });

  it('a throwing re-sweep is reported and never fails the tick', async () => {
    h.resweepSpecialistResults.mockRejectedValue(new Error('db down'));
    await expect(processWispGrantReconcile()).resolves.toEqual({ skipped: false, ...grants, specialistPosts: 0, firstLookPosts: 0 });
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });

  it('#10402: sweeps missing first-look posts too, whatever the specialist half did', async () => {
    h.resweepFirstLookPosts.mockResolvedValue({ scanned: 2, posted: 1, failed: 0, skipped: {} });
    h.resweepSpecialistResults.mockRejectedValue(new Error('db down'));
    await expect(processWispGrantReconcile()).resolves.toEqual({ skipped: false, ...grants, specialistPosts: 0, firstLookPosts: 1 });
    expect(h.resweepFirstLookPosts).toHaveBeenCalledTimes(1);
  });

  it('#10402: logs a grant whose batch finished without looking at anything, which posts nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    h.resweepFirstLookPosts.mockResolvedValue({ scanned: 1, posted: 0, failed: 0, skipped: { nothing_looked_at: 1 } });
    await processWispGrantReconcile();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('nothingLookedAt=1'));
    log.mockRestore();
  });

  it("#11145: a couldn't-look post counts as a post and is named in the log", async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    h.resweepFirstLookPosts.mockResolvedValue({ scanned: 1, posted: 1, couldntLook: 1, failed: 0, skipped: {} });
    await expect(processWispGrantReconcile()).resolves.toMatchObject({ firstLookPosts: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('couldntLook=1'));
    log.mockRestore();
  });

  it('#10402: a throwing first-look sweep is reported and never fails the tick', async () => {
    h.resweepFirstLookPosts.mockRejectedValue(new Error('db down'));
    await expect(processWispGrantReconcile()).resolves.toEqual({ skipped: false, ...grants, specialistPosts: 1, firstLookPosts: 0 });
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });

  it('with Wisp off neither half runs', async () => {
    h.wispEnabled.mockReturnValue(false);
    await expect(processWispGrantReconcile()).resolves.toEqual({ skipped: true });
    expect(h.reconcileActiveGrants).not.toHaveBeenCalled();
    expect(h.resweepSpecialistResults).not.toHaveBeenCalled();
    expect(h.resweepFirstLookPosts).not.toHaveBeenCalled();
  });
});
