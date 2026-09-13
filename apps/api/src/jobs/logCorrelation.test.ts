import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getJobMock, addMock, closeMock } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    close = closeMock;
  },
  Worker: class {
    close = closeMock;
    on = vi.fn();
  },
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/logSearch', () => ({
  detectPatternCorrelation: vi.fn(),
  runCorrelationRules: vi.fn(),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../services/logReadAuthority', () => ({
  revalidateLogReadAuthority: vi.fn(),
}));

vi.mock('../db', () => ({
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import {
  enqueueAdHocPatternCorrelationDetection,
  enqueueLogCorrelationDetection,
  processLogCorrelationJob,
  shutdownLogCorrelationWorker,
} from './logCorrelation';
import { detectPatternCorrelation } from '../services/logSearch';
import { revalidateLogReadAuthority } from '../services/logReadAuthority';

describe('log correlation queue helpers', () => {
  const authority = {
    version: 1 as const,
    requesterId: 'user-1',
    partnerId: 'partner-1',
    orgId: 'org-1',
    scope: 'organization' as const,
    siteIds: null,
    authEpoch: 1,
    mfaEpoch: 1,
    mfaClaim: true,
    fingerprint: 'fingerprint',
  };
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
    getJobMock.mockReset();
    addMock.mockReset();
    closeMock.mockReset();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    await shutdownLogCorrelationWorker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a stable BullMQ job id for rules detection and normalizes rule ids', async () => {
    await enqueueLogCorrelationDetection({ orgId: 'org-1', ruleIds: ['r2', 'r1', 'r2'] });

    expect(addMock).toHaveBeenCalledWith(
      'rules-detect',
      expect.objectContaining({ orgId: 'org-1', ruleIds: ['r1', 'r2'] }),
      expect.objectContaining({
        jobId: expect.stringMatching(/^log-correlation-rules-org-1-[a-z0-9]+-[a-z0-9]+$/),
      }),
    );
  });

  it('reuses an active ad hoc pattern detection job within the dedupe window', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-pattern-job',
      getState: vi.fn().mockResolvedValue('active'),
    });

    const jobId = await enqueueAdHocPatternCorrelationDetection({
      orgId: 'org-1',
      pattern: 'powershell',
      minDevices: 2,
      authority,
    });

    expect(jobId).toBe('existing-pattern-job');
    expect(addMock).not.toHaveBeenCalled();
  });

  it('fails closed for a legacy or malformed queued pattern job', async () => {
    vi.mocked(revalidateLogReadAuthority).mockResolvedValue(null);
    await expect(processLogCorrelationJob({
      type: 'pattern', orgId: 'org-1', pattern: 'powershell', isRegex: false,
      queuedAt: new Date().toISOString(), authority,
    })).rejects.toThrow('authority is no longer valid');
    expect(detectPatternCorrelation).not.toHaveBeenCalled();
    await expect(processLogCorrelationJob({
      type: 'pattern', orgId: 'org-1', pattern: '', isRegex: false,
      queuedAt: new Date().toISOString(), authority,
    })).rejects.toThrow('job is malformed');
  });

  it('passes the live current-device ceiling to pattern detection', async () => {
    vi.mocked(revalidateLogReadAuthority).mockResolvedValue({
      authority, allowedDeviceIds: ['device-visible'], allowedSiteIds: ['site-visible'],
    });
    vi.mocked(detectPatternCorrelation).mockResolvedValue(null);
    await expect(processLogCorrelationJob({
      type: 'pattern', orgId: 'org-1', pattern: 'powershell', isRegex: false,
      queuedAt: new Date().toISOString(), authority,
    })).resolves.toMatchObject({ mode: 'pattern', detected: false });
    expect(detectPatternCorrelation).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1', allowedDeviceIds: ['device-visible'], allowedSiteIds: ['site-visible'],
    }));
  });
});
