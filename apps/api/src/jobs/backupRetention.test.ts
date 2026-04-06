import { describe, expect, it } from 'vitest';
import { computeExpiresAt } from './backupRetention';

describe('backup retention', () => {
  it('uses retentionDays when no GFS tiers are configured', () => {
    const expiresAt = computeExpiresAt(
      new Date('2026-03-31T00:00:00.000Z'),
      { daily: true },
      { retentionDays: 30 },
    );

    expect(expiresAt?.toISOString()).toBe('2026-04-30T00:00:00.000Z');
  });

  it('prefers the longest GFS-derived retention over retentionDays', () => {
    const expiresAt = computeExpiresAt(
      new Date('2026-03-31T00:00:00.000Z'),
      { daily: true, monthly: true },
      { retentionDays: 10, monthly: 2 },
    );

    expect(expiresAt?.toISOString()).toBe('2026-05-30T00:00:00.000Z');
  });
});
