import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteExpiredScreenshots: vi.fn(async () => 0),
  sweepOrphanedScreenshotFiles: vi.fn(async () => ({ scanned: 0, removed: 0, failed: 0, directoriesRemoved: 0 })),
}));

vi.mock('bullmq', () => ({ Queue: vi.fn(), Worker: vi.fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/screenshotStorage', () => ({
  deleteExpiredScreenshots: mocks.deleteExpiredScreenshots,
  sweepOrphanedScreenshotFiles: mocks.sweepOrphanedScreenshotFiles,
}));

import { runHelperScreenshotRetentionOnce } from './helperScreenshotRetention';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runHelperScreenshotRetentionOnce', () => {
  it('runs the expiry sweep and then the orphan-file sweep (#8117)', async () => {
    const order: string[] = [];
    mocks.deleteExpiredScreenshots.mockImplementationOnce(async () => {
      order.push('expiry');
      return 3;
    });
    mocks.sweepOrphanedScreenshotFiles.mockImplementationOnce(async () => {
      order.push('orphans');
      return { scanned: 5, removed: 2, failed: 0, directoriesRemoved: 1 };
    });

    const result = await runHelperScreenshotRetentionOnce();

    expect(order).toEqual(['expiry', 'orphans']);
    expect(result).toEqual({ deleted: 3, orphans: { scanned: 5, removed: 2, failed: 0, directoriesRemoved: 1 } });
  });

  it('fails the run when the orphan sweep cannot read rows, rather than reporting success', async () => {
    mocks.sweepOrphanedScreenshotFiles.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(runHelperScreenshotRetentionOnce()).rejects.toThrow('connection terminated');
  });
});
