import { describe, expect, it } from 'vitest';
import { readEarliestUnauthorizedDetection, shouldQueueAutoRemediation } from './softwareComplianceWorker';

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
