import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock } = vi.hoisted(() => ({
  addMock: vi.fn(async () => ({ id: 'queued-job-1' })),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = addMock;
  },
  Worker: class {
    on = vi.fn();
    close = vi.fn();
  },
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({})),
}));

import {
  readEarliestUnauthorizedDetection,
  scheduleSoftwareComplianceCheck,
  shouldQueueAutoRemediation,
} from './softwareComplianceWorker';

const NOW = new Date('2025-01-15T12:00:00Z');
const PAST_VIOLATION = [{ type: 'unauthorized', detectedAt: '2025-01-01T00:00:00Z' }];
const RECENT_VIOLATION = [{ type: 'unauthorized', detectedAt: '2025-01-15T11:00:00Z' }];

describe('shouldQueueAutoRemediation', () => {
  it('returns queue:false when status is in_progress', () => {
    const result = shouldQueueAutoRemediation({
      violations: PAST_VIOLATION,
      previousRemediationStatus: 'in_progress',
      lastRemediationAttempt: null,
      now: NOW,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: false, reason: 'in_progress' });
  });

  it('returns queue:false when status is pending', () => {
    const result = shouldQueueAutoRemediation({
      violations: PAST_VIOLATION,
      previousRemediationStatus: 'pending',
      lastRemediationAttempt: null,
      now: NOW,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: false, reason: 'in_progress' });
  });

  it('returns queue:false when inside grace period', () => {
    const result = shouldQueueAutoRemediation({
      violations: RECENT_VIOLATION,
      previousRemediationStatus: null,
      lastRemediationAttempt: null,
      now: NOW,
      gracePeriodHours: 24,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: false, reason: 'grace_period' });
  });

  it('returns queue:true when outside grace period', () => {
    const result = shouldQueueAutoRemediation({
      violations: PAST_VIOLATION,
      previousRemediationStatus: null,
      lastRemediationAttempt: null,
      now: NOW,
      gracePeriodHours: 24,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: true });
  });

  it('returns queue:false when inside cooldown window', () => {
    const lastAttempt = new Date(NOW.getTime() - 30 * 60 * 1000);
    const result = shouldQueueAutoRemediation({
      violations: PAST_VIOLATION,
      previousRemediationStatus: null,
      lastRemediationAttempt: lastAttempt,
      now: NOW,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: false, reason: 'cooldown' });
  });

  it('returns queue:true when past cooldown window', () => {
    const lastAttempt = new Date(NOW.getTime() - 200 * 60 * 1000);
    const result = shouldQueueAutoRemediation({
      violations: PAST_VIOLATION,
      previousRemediationStatus: null,
      lastRemediationAttempt: lastAttempt,
      now: NOW,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: true });
  });

  it('returns queue:true with no previous state and no grace/cooldown', () => {
    const result = shouldQueueAutoRemediation({
      violations: PAST_VIOLATION,
      previousRemediationStatus: null,
      lastRemediationAttempt: null,
      now: NOW,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: true });
  });

  it('skips grace period check when gracePeriodHours is 0', () => {
    const result = shouldQueueAutoRemediation({
      violations: RECENT_VIOLATION,
      previousRemediationStatus: null,
      lastRemediationAttempt: null,
      now: NOW,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: true });
  });
});

describe('readEarliestUnauthorizedDetection', () => {
  it('returns null for non-array input', () => {
    expect(readEarliestUnauthorizedDetection(null)).toBeNull();
    expect(readEarliestUnauthorizedDetection('string')).toBeNull();
    expect(readEarliestUnauthorizedDetection({})).toBeNull();
  });

  it('returns null for empty array', () => {
    expect(readEarliestUnauthorizedDetection([])).toBeNull();
  });

  it('returns null when no unauthorized violations', () => {
    const violations = [{ type: 'missing', detectedAt: '2025-01-01T00:00:00Z' }];
    expect(readEarliestUnauthorizedDetection(violations)).toBeNull();
  });

  it('returns the earliest unauthorized detection date', () => {
    const violations = [
      { type: 'unauthorized', detectedAt: '2025-01-10T00:00:00Z' },
      { type: 'unauthorized', detectedAt: '2025-01-01T00:00:00Z' },
      { type: 'unauthorized', detectedAt: '2025-01-15T00:00:00Z' },
    ];
    const result = readEarliestUnauthorizedDetection(violations);
    expect(result?.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });

  it('skips violations with invalid detectedAt strings', () => {
    const violations = [
      { type: 'unauthorized', detectedAt: 'not-a-date' },
      { type: 'unauthorized', detectedAt: '2025-01-05T00:00:00Z' },
    ];
    const result = readEarliestUnauthorizedDetection(violations);
    expect(result?.toISOString()).toBe('2025-01-05T00:00:00.000Z');
  });
});

describe('scheduleSoftwareComplianceCheck jobId', () => {
  beforeEach(() => {
    addMock.mockClear();
    addMock.mockResolvedValue({ id: 'queued-job-1' });
  });

  // Regression for "Custom Id cannot contain :" — BullMQ rejects a custom
  // jobId whose colon-split length !== 3. The per-policy id is 4 parts and
  // would throw, silently dropping the compliance-check enqueue.
  it('does not use a colon in the per-policy BullMQ job id', async () => {
    await scheduleSoftwareComplianceCheck('policy-1', ['device-1']);

    expect(addMock).toHaveBeenCalled();
    const [, , opts] = addMock.mock.calls[0] as unknown as [string, unknown, { jobId?: string }];
    expect(opts.jobId).toBeDefined();
    expect(String(opts.jobId)).not.toContain(':');
    expect(String(opts.jobId)).toMatch(/^software-compliance-policy-1-[a-z0-9]+-[a-z0-9]+$/);
  });
});
