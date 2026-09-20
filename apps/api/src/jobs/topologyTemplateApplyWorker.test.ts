import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ drain: vi.fn(), report: vi.fn() }));
vi.mock('../services/topology/templateApplicationExecution', () => ({
  drainTopologyTemplateApplications: mocks.drain,
}));
vi.mock('../services/sentry', () => ({ captureException: mocks.report }));
import {
  initializeTopologyTemplateApplyWorker,
  shutdownTopologyTemplateApplyWorker,
} from './topologyTemplateApplyWorker';
afterEach(async () => {
  await shutdownTopologyTemplateApplyWorker();
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe('template application repair worker', () => {
  it('does not overlap drains and waits for admitted work during shutdown', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    mocks.drain.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    initializeTopologyTemplateApplyWorker();
    initializeTopologyTemplateApplyWorker();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.drain).toHaveBeenCalledTimes(1);
    let stopped = false;
    const closing = shutdownTopologyTemplateApplyWorker().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await closing;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.drain).toHaveBeenCalledTimes(1);
  });
  it('reports failure and retries durable pending work on a later tick', async () => {
    vi.useFakeTimers();
    mocks.drain
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue(0);
    initializeTopologyTemplateApplyWorker();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(mocks.drain).toHaveBeenCalledTimes(2);
    expect(mocks.report).toHaveBeenCalledTimes(1);
  });
});
