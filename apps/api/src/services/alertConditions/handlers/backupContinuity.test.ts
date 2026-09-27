import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
  },
}));

vi.mock('../../../db', () => ({
  db: mockDb,
}));

vi.mock('../../../db/schema', () => ({
  backupJobs: {
    deviceId: 'backupJobs.deviceId',
    status: 'backupJobs.status',
    startedAt: 'backupJobs.startedAt',
    completedAt: 'backupJobs.completedAt',
  },
}));

import { backupContinuityHandler } from './backupContinuity';

const DEVICE_ID = 'device-1';
const NOW = new Date('2026-09-13T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;

// Drives db.select({...}).from(...).where(...).orderBy(...).limit(...) to
// resolve with `rows`, in the (caller-supplied) newest-first order the real
// query's COALESCE(completed_at, started_at) DESC ordering would produce.
function setJobs(rows: Array<Record<string, unknown>>) {
  mockDb.select.mockReturnValue({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
    }),
  });
}

function hoursAgo(h: number): Date {
  return new Date(NOW.getTime() - h * HOUR);
}

describe('backupContinuityHandler', () => {
  beforeEach(() => {
    mockDb.select.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('declares the type "backup_continuity"', () => {
    expect(backupContinuityHandler.type).toBe('backup_continuity');
  });

  describe('no_successful_backup', () => {
    it('passes when the newest successful backup is older than maxAgeHours', async () => {
      setJobs([{ status: 'completed', startedAt: hoursAgo(30), completedAt: hoursAgo(30) }]);

      const result = await backupContinuityHandler.evaluate(
        { type: 'backup_continuity', check: 'no_successful_backup', maxAgeHours: 26 },
        DEVICE_ID
      );

      expect(result.passed).toBe(true);
      expect(result.actualValue).toBe(30);
    });

    it('does NOT pass when the newest successful backup is within maxAgeHours', async () => {
      setJobs([{ status: 'completed', startedAt: hoursAgo(20), completedAt: hoursAgo(20) }]);

      const result = await backupContinuityHandler.evaluate(
        { type: 'backup_continuity', check: 'no_successful_backup', maxAgeHours: 26 },
        DEVICE_ID
      );

      expect(result.passed).toBe(false);
      expect(result.actualValue).toBe(20);
    });

    // A device that has never had a backup job at all must not page anyone
    // at 3am through a fleet-wide monitor — that's a backup-config presence
    // check's job, not this monitor's. Distinguish it from "jobs exist but
    // none succeeded" (which DOES breach).
    it('does NOT pass and reports "no backup configured" when the device has zero backup jobs', async () => {
      setJobs([]);

      const result = await backupContinuityHandler.evaluate(
        { type: 'backup_continuity', check: 'no_successful_backup', maxAgeHours: 26 },
        DEVICE_ID
      );

      expect(result.passed).toBe(false);
      expect(result.description).toMatch(/no backup configured/i);
    });

    it('passes when jobs exist but none of them ever succeeded (distinct from never-backed-up)', async () => {
      setJobs([
        { status: 'failed', startedAt: hoursAgo(2), completedAt: hoursAgo(2) },
        { status: 'failed', startedAt: hoursAgo(4), completedAt: hoursAgo(4) },
      ]);

      const result = await backupContinuityHandler.evaluate(
        { type: 'backup_continuity', check: 'no_successful_backup', maxAgeHours: 26 },
        DEVICE_ID
      );

      expect(result.passed).toBe(true);
      expect(result.description).not.toMatch(/no backup configured/i);
      expect(result.description).toMatch(/no successful backup/i);
    });

    // A 'running'/'pending' job newer than the last success is still
    // in-flight (no terminal outcome) and must not reset or mask the age
    // clock measured off the last real success.
    it('does NOT let a newer in-flight (running) job reset the age clock', async () => {
      setJobs([
        { status: 'running', startedAt: hoursAgo(1), completedAt: null },
        { status: 'completed', startedAt: hoursAgo(30), completedAt: hoursAgo(30) },
      ]);

      const result = await backupContinuityHandler.evaluate(
        { type: 'backup_continuity', check: 'no_successful_backup', maxAgeHours: 26 },
        DEVICE_ID
      );

      expect(result.passed).toBe(true);
      expect(result.actualValue).toBe(30);
    });
  });

  describe('consecutive_failures', () => {
    it('passes when the newest N jobs are all failures', async () => {
      setJobs([
        { status: 'failed', startedAt: hoursAgo(1), completedAt: hoursAgo(1) },
        { status: 'failed', startedAt: hoursAgo(2), completedAt: hoursAgo(2) },
        { status: 'failed', startedAt: hoursAgo(3), completedAt: hoursAgo(3) },
      ]);

      const result = await backupContinuityHandler.evaluate(
        { type: 'backup_continuity', check: 'consecutive_failures', failureCount: 3 },
        DEVICE_ID
      );

      expect(result.passed).toBe(true);
      expect(result.actualValue).toBe(3);
    });

    it('does NOT pass when a success interrupts the failure streak', async () => {
      setJobs([
        { status: 'failed', startedAt: hoursAgo(1), completedAt: hoursAgo(1) },
        { status: 'completed', startedAt: hoursAgo(2), completedAt: hoursAgo(2) },
        { status: 'failed', startedAt: hoursAgo(3), completedAt: hoursAgo(3) },
      ]);

      const result = await backupContinuityHandler.evaluate(
        { type: 'backup_continuity', check: 'consecutive_failures', failureCount: 3 },
        DEVICE_ID
      );

      expect(result.passed).toBe(false);
      expect(result.actualValue).toBe(1);
    });

    it('skips cancelled/partial jobs without resetting or extending the streak', async () => {
      setJobs([
        { status: 'failed', startedAt: hoursAgo(1), completedAt: hoursAgo(1) },
        { status: 'cancelled', startedAt: hoursAgo(2), completedAt: hoursAgo(2) },
        { status: 'partial', startedAt: hoursAgo(3), completedAt: hoursAgo(3) },
        { status: 'failed', startedAt: hoursAgo(4), completedAt: hoursAgo(4) },
      ]);

      const result = await backupContinuityHandler.evaluate(
        { type: 'backup_continuity', check: 'consecutive_failures', failureCount: 2 },
        DEVICE_ID
      );

      expect(result.passed).toBe(true);
      expect(result.actualValue).toBe(2);
    });

    it('does NOT pass and reports "no backup configured" when the device has zero backup jobs', async () => {
      setJobs([]);

      const result = await backupContinuityHandler.evaluate(
        { type: 'backup_continuity', check: 'consecutive_failures', failureCount: 3 },
        DEVICE_ID
      );

      expect(result.passed).toBe(false);
      expect(result.description).toMatch(/no backup configured/i);
    });
  });

  // #5396: a run that produced a snapshot but had file failures under the
  // partial threshold. It IS a restore point (counts as success for the age
  // and streak checks), and it has its own check so an operator can choose to
  // page on it.
  describe('completed_with_errors (#5396)', () => {
    it('counts a completed_with_errors run as a successful backup for no_successful_backup', async () => {
      setJobs([
        { status: 'completed_with_errors', startedAt: hoursAgo(2), completedAt: hoursAgo(2) },
        { status: 'completed', startedAt: hoursAgo(50), completedAt: hoursAgo(50) },
      ]);
      const result = await backupContinuityHandler.evaluate(
        { type: 'backup_continuity', check: 'no_successful_backup', maxAgeHours: 26 },
        DEVICE_ID
      );
      expect(result.passed).toBe(false);
      expect(result.actualValue).toBe(2);
    });

    it('lets a completed_with_errors run break a consecutive_failures streak', async () => {
      setJobs([
        { status: 'failed', startedAt: hoursAgo(1), completedAt: hoursAgo(1) },
        { status: 'completed_with_errors', startedAt: hoursAgo(2), completedAt: hoursAgo(2) },
        { status: 'failed', startedAt: hoursAgo(3), completedAt: hoursAgo(3) },
      ]);
      const result = await backupContinuityHandler.evaluate(
        { type: 'backup_continuity', check: 'consecutive_failures', failureCount: 2 },
        DEVICE_ID
      );
      expect(result.passed).toBe(false);
      expect(result.actualValue).toBe(1);
    });

    it('fires the completed_with_errors check when the newest terminal run completed with errors', async () => {
      setJobs([
        { status: 'running', startedAt: hoursAgo(0), completedAt: null },
        { status: 'completed_with_errors', startedAt: hoursAgo(2), completedAt: hoursAgo(2) },
        { status: 'completed', startedAt: hoursAgo(26), completedAt: hoursAgo(26) },
      ]);
      const result = await backupContinuityHandler.evaluate(
        { type: 'backup_continuity', check: 'completed_with_errors' },
        DEVICE_ID
      );
      expect(result.passed).toBe(true);
      expect(result.description).toMatch(/completed with file errors/i);
    });

    it('does NOT fire the completed_with_errors check once a newer run is clean', async () => {
      setJobs([
        { status: 'completed', startedAt: hoursAgo(1), completedAt: hoursAgo(1) },
        { status: 'completed_with_errors', startedAt: hoursAgo(2), completedAt: hoursAgo(2) },
      ]);
      const result = await backupContinuityHandler.evaluate(
        { type: 'backup_continuity', check: 'completed_with_errors' },
        DEVICE_ID
      );
      expect(result.passed).toBe(false);
    });

    it('does NOT fire the completed_with_errors check for a failed or partial newest run (other checks own those)', async () => {
      for (const status of ['failed', 'partial']) {
        setJobs([{ status, startedAt: hoursAgo(1), completedAt: hoursAgo(1) }]);
        const result = await backupContinuityHandler.evaluate(
          { type: 'backup_continuity', check: 'completed_with_errors' },
          DEVICE_ID
        );
        expect(result.passed).toBe(false);
      }
    });

    it('accepts a completed_with_errors condition with no extra fields', () => {
      expect(backupContinuityHandler.validate({ check: 'completed_with_errors' }, 'c')).toEqual([]);
    });
  });

  describe('validate', () => {
    it('rejects an invalid check', () => {
      const errors = backupContinuityHandler.validate({ check: 'bogus' }, 'c');
      expect(errors).toContain('c.check: Invalid check');
    });

    it('rejects no_successful_backup without a positive maxAgeHours', () => {
      const errors = backupContinuityHandler.validate({ check: 'no_successful_backup' }, 'c');
      expect(errors).toContain('c.maxAgeHours: Must be a positive number');
    });

    it('rejects consecutive_failures without a positive failureCount', () => {
      const errors = backupContinuityHandler.validate({ check: 'consecutive_failures' }, 'c');
      expect(errors).toContain('c.failureCount: Must be a positive number');
    });

    it('accepts a valid no_successful_backup condition', () => {
      expect(
        backupContinuityHandler.validate({ check: 'no_successful_backup', maxAgeHours: 26 }, 'c')
      ).toEqual([]);
    });

    it('accepts a valid consecutive_failures condition', () => {
      expect(
        backupContinuityHandler.validate({ check: 'consecutive_failures', failureCount: 3 }, 'c')
      ).toEqual([]);
    });
  });
});
