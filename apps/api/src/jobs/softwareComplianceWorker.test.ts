import { describe, expect, it } from 'vitest';
import { shouldQueueAutoRemediation } from './softwareComplianceWorker';

describe('shouldQueueAutoRemediation', () => {
  const now = new Date('2026-02-20T12:00:00Z');

  it('returns queue=false when remediation is already in_progress', () => {
    const result = shouldQueueAutoRemediation({
      violations: [],
      previousRemediationStatus: 'in_progress',
      lastRemediationAttempt: null,
      now,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result.queue).toBe(false);
    expect(result.reason).toBe('in_progress');
  });

  it('returns queue=false when remediation is pending', () => {
    const result = shouldQueueAutoRemediation({
      violations: [],
      previousRemediationStatus: 'pending',
      lastRemediationAttempt: null,
      now,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result.queue).toBe(false);
    expect(result.reason).toBe('in_progress');
  });

  it('returns queue=false during grace period', () => {
    const recentViolation = [{
      type: 'unauthorized',
      software: { name: 'TeamViewer Host', version: '15.2' },
      severity: 'critical',
      detectedAt: new Date('2026-02-20T11:00:00Z').toISOString(),
    }];

    const result = shouldQueueAutoRemediation({
      violations: recentViolation,
      previousRemediationStatus: null,
      lastRemediationAttempt: null,
      now,
      gracePeriodHours: 24,
      cooldownMinutes: 120,
    });
    expect(result.queue).toBe(false);
    expect(result.reason).toBe('grace_period');
  });

  it('returns queue=true when grace period has expired', () => {
    const oldViolation = [{
      type: 'unauthorized',
      software: { name: 'TeamViewer Host', version: '15.2' },
      severity: 'critical',
      detectedAt: new Date('2026-02-18T12:00:00Z').toISOString(),
    }];

    const result = shouldQueueAutoRemediation({
      violations: oldViolation,
      previousRemediationStatus: null,
      lastRemediationAttempt: null,
      now,
      gracePeriodHours: 24,
      cooldownMinutes: 120,
    });
    expect(result.queue).toBe(true);
  });

  it('returns queue=false within cooldown window', () => {
    const result = shouldQueueAutoRemediation({
      violations: [],
      previousRemediationStatus: 'failed',
      lastRemediationAttempt: new Date('2026-02-20T11:30:00Z'),
      now,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result.queue).toBe(false);
    expect(result.reason).toBe('cooldown');
  });

  it('returns queue=true when cooldown has elapsed', () => {
    const result = shouldQueueAutoRemediation({
      violations: [],
      previousRemediationStatus: 'failed',
      lastRemediationAttempt: new Date('2026-02-20T09:00:00Z'),
      now,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result.queue).toBe(true);
  });

  it('skips grace period check when gracePeriodHours is 0', () => {
    const recentViolation = [{
      type: 'unauthorized',
      software: { name: 'TeamViewer Host' },
      severity: 'critical',
      detectedAt: new Date('2026-02-20T11:59:00Z').toISOString(),
    }];

    const result = shouldQueueAutoRemediation({
      violations: recentViolation,
      previousRemediationStatus: null,
      lastRemediationAttempt: null,
      now,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result.queue).toBe(true);
  });
});
