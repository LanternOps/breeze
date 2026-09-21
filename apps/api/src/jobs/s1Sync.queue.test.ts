import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  getJob: vi.fn(),
  processor: null as null | ((job: { data: { type: string } }) => Promise<unknown>),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = mocks.add;
    getJob = mocks.getJob;
    getRepeatableJobs = vi.fn().mockResolvedValue([]);
    close = vi.fn();
  },
  Worker: class {
    constructor(_name: string, processor: typeof mocks.processor) {
      mocks.processor = processor;
    }

    on = vi.fn();
    close = vi.fn();
  },
}));
vi.mock('../db', () => ({
  db: { select: () => ({ from: () => ({ where: async () => [{ id: 'integration-1' }] }) }) },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('../services/sentinelOne/metrics', () => ({ recordS1SyncRun: vi.fn() }));

const { scheduleS1Sync, initializeS1SyncJob, shutdownS1SyncJob } = await import('./s1Sync');

describe('SentinelOne queue dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getJob.mockResolvedValue(null);
    mocks.add.mockImplementation(async (_name, _data, options) => {
      // Match the installed BullMQ validator, including its legacy exception.
      const id = (options as { jobId?: string }).jobId;
      if (id?.includes(':') && id.split(':').length !== 3) {
        throw new Error('Custom Id cannot contain :');
      }
      return { id: id ?? 'repeat-job' };
    });
  });

  afterEach(() => shutdownS1SyncJob());

  it('manual sync enqueues agents and threats with a valid job ID', async () => {
    await scheduleS1Sync('integration-1');
    expect(mocks.add).toHaveBeenCalledWith(
      'sync-integration',
      {
        type: 'sync-integration',
        integrationId: 'integration-1',
        syncAgents: true,
        syncThreats: true,
      },
      expect.objectContaining({ jobId: 's1-sync-integration-integration-1-full' }),
    );
  });

  it.each([
    ['sync-all-agents', true, false],
    ['sync-all-threats', false, true],
  ] as const)('the %s scheduler enqueues a valid incremental job', async (type, syncAgents, syncThreats) => {
    await initializeS1SyncJob();
    mocks.add.mockClear();
    await expect(mocks.processor!({ data: { type } })).resolves.toEqual({ queued: 1 });
    expect(mocks.add).toHaveBeenCalledWith(
      'sync-integration',
      {
        type: 'sync-integration',
        integrationId: 'integration-1',
        syncAgents,
        syncThreats,
      },
      expect.objectContaining({
        jobId: `s1-sync-integration-integration-1-${syncAgents ? 'agents' : 'none'}-${syncThreats ? 'threats' : 'none'}`,
      }),
    );
  });
});
