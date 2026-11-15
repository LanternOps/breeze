import { PgDialect } from 'drizzle-orm/pg-core';
import { type SQL } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { upsertJobSchedulerMock, attachMock, runTargetsMock } = vi.hoisted(() => ({
  upsertJobSchedulerMock: vi.fn(),
  attachMock: vi.fn(),
  runTargetsMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    upsertJobScheduler = upsertJobSchedulerMock;
    close = vi.fn();
  },
  Worker: class {
    constructor(public name: string, public processor: unknown, public opts: unknown) {}
    on = vi.fn();
    close = vi.fn();
  },
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: attachMock }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../services/retentionMetrics', () => ({ recordRetentionRun: vi.fn() }));
vi.mock('./retentionTarget', () => ({ runRetentionTargets: runTargetsMock }));
vi.mock('../db', () => ({
  db: { execute: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

import { jobSchedule } from './scheduleRegistry';
import {
  ALERT_CORRELATION_GROUP_TARGET,
  ALERT_RETENTION_TARGET,
  __testOnly,
  initializeAlertRetention,
  runAlertRetention,
} from './alertRetention';
import type { RetentionKnobs, RetentionTarget } from './retentionTarget';

const CUTOFF = '2026-01-01T00:00:00.000Z';
const NOW = '2027-01-01T00:00:00.000Z';
const dialect = new PgDialect();
const render = (s: SQL) => dialect.sqlToQuery(s);
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

type Call = { target: RetentionTarget; knobs: RetentionKnobs };
const calls = (): Call[] => runTargetsMock.mock.calls[0]![0] as Call[];

describe('alerts-family retention (#4342 W3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runTargetsMock.mockImplementation(async (targets: Call[]) =>
      targets.map(({ target, knobs }) => ({
        mode: 'report', table: target.table, retentionDays: knobs.retentionDays,
        eligible: 0, eligibleCapped: false, durationMs: 1,
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('alert predicate', () => {
    const q = render(ALERT_RETENTION_TARGET.where(CUTOFF, NOW));
    const text = flat(q.sql);

    it('deletes from alerts under its own metric', () => {
      expect(ALERT_RETENTION_TARGET.table).toBe('alerts');
      expect(ALERT_RETENTION_TARGET.action).toEqual({ kind: 'delete' });
      expect(ALERT_RETENTION_TARGET.metricName).toBe('alert_retention');
    });

    it('is closed alerts only, aged by close time as UTC wall time', () => {
      expect(text).toContain("alerts.status IN ('resolved', 'dismissed')");
      expect(text).toContain('COALESCE(alerts.resolved_at, alerts.dismissed_at) <');
      expect(text).toContain("::timestamptz AT TIME ZONE 'UTC'");
      expect(q.params).toContain(CUTOFF);
      expect(text).not.toMatch(/'active'|'acknowledged'|'suppressed'/);
    });

    it('keeps the newest closed alert per (rule, owner kind, device, subject), NULL device included', () => {
      expect(text).toContain('alerts.rule_id IS NULL OR EXISTS');
      expect(text).toContain('n.rule_id = alerts.rule_id');
      expect(text).toContain('n.owner_kind = alerts.owner_kind');
      expect(text).toContain('n.device_id IS NOT DISTINCT FROM alerts.device_id');
      expect(text).toContain("COALESCE(n.subject_key, '') = COALESCE(alerts.subject_key, '')");
      expect(text).toContain("n.status IN ('resolved', 'dismissed')");
      // Strictly newer by the cursor reader's ordering: ties are all kept.
      expect(text).toContain('COALESCE(n.resolved_at, n.dismissed_at) > COALESCE(alerts.resolved_at, alerts.dismissed_at)');
    });

    it('exempts an alert linked by any of the three ticket link tables', () => {
      for (const table of ['ticket_alert_links', 'psa_ticket_mappings', 'alert_external_refs']) {
        expect(text).toMatch(new RegExp(`NOT EXISTS \\(SELECT 1 FROM ${table} \\w+ WHERE \\w+\\.alert_id = alerts\\.id\\)`));
      }
    });

    it('refers to the outer table by its bare name, never an alias', () => {
      expect(text).not.toMatch(/\ba\.\w+/);
    });
  });

  describe('correlation group predicate', () => {
    const q = render(ALERT_CORRELATION_GROUP_TARGET.where(CUTOFF, NOW));
    const text = flat(q.sql);

    it('deletes orphaned, stale groups under its own metric', () => {
      expect(ALERT_CORRELATION_GROUP_TARGET.table).toBe('alert_correlation_groups');
      expect(ALERT_CORRELATION_GROUP_TARGET.action).toEqual({ kind: 'delete' });
      expect(ALERT_CORRELATION_GROUP_TARGET.metricName).toBe('alert_correlation_group_retention');
      expect(text).toContain('alert_correlation_groups.root_alert_id IS NULL');
      expect(text).toContain('NOT EXISTS (SELECT 1 FROM alert_correlation_members m WHERE m.group_id = alert_correlation_groups.id)');
      expect(text).toContain("alert_correlation_groups.last_seen_at < (");
      expect(text).toContain("::timestamptz AT TIME ZONE 'UTC'");
      expect(q.params).toEqual([CUTOFF]);
    });
  });

  describe('runAlertRetention', () => {
    it('runs alerts first, then groups, with the same knobs, report-only by default', async () => {
      await runAlertRetention();
      expect(runTargetsMock).toHaveBeenCalledTimes(1);
      const c = calls();
      expect(c.map((x) => x.target)).toEqual([ALERT_RETENTION_TARGET, ALERT_CORRELATION_GROUP_TARGET]);
      for (const { knobs } of c) {
        expect(knobs).toEqual({
          retentionDays: 365, batchSize: __testOnly.BATCH_SIZE, maxBatches: __testOnly.MAX_BATCHES, enforce: false,
        });
      }
      const opts = runTargetsMock.mock.calls[0]![1];
      expect(opts).toMatchObject({ enforceVar: 'ALERT_RETENTION_ENFORCE' });
    });

    it('clamps a payload window to the max, and payload batch knobs to >= 1', async () => {
      await runAlertRetention({ retentionDays: 5000, batchSize: 0, maxBatches: -3 });
      for (const { knobs } of calls()) {
        expect(knobs.retentionDays).toBe(1095);
        expect(knobs.batchSize).toBe(1);
        expect(knobs.maxBatches).toBe(1);
      }
    });

    it('fails the job after every target ran when one target errored', async () => {
      runTargetsMock.mockResolvedValueOnce([
        { table: 'alerts', error: 'boom' },
        { mode: 'report', table: 'alert_correlation_groups', retentionDays: 365, eligible: 0, eligibleCapped: false, durationMs: 1 },
      ]);
      await expect(runAlertRetention()).rejects.toThrow(/alerts: boom/);
    });
  });

  describe('enforce flag', () => {
    it('defaults: 365 / 1095, report-only', () => {
      expect(__testOnly.DEFAULT_RETENTION_DAYS).toBe(365);
      expect(__testOnly.MAX_RETENTION_DAYS).toBe(1095);
      expect(__testOnly.ENFORCE).toBe(false);
    });

    it('enforces only with ALERT_RETENTION_ENFORCE=true, and forceReport turns it back off', async () => {
      vi.stubEnv('ALERT_RETENTION_ENFORCE', 'true');
      vi.resetModules();
      const fresh = await import('./alertRetention');
      expect(fresh.__testOnly.ENFORCE).toBe(true);

      await fresh.runAlertRetention();
      expect((runTargetsMock.mock.calls[0]![0] as Call[]).every((x) => x.knobs.enforce)).toBe(true);

      runTargetsMock.mockClear();
      await fresh.runAlertRetention({ forceReport: true });
      expect((runTargetsMock.mock.calls[0]![0] as Call[]).every((x) => !x.knobs.enforce)).toBe(true);
    });

    it('a malformed value reports', async () => {
      vi.stubEnv('ALERT_RETENTION_ENFORCE', 'yes');
      vi.resetModules();
      const fresh = await import('./alertRetention');
      expect(fresh.__testOnly.ENFORCE).toBe(false);
    });
  });

  it('schedules the registry slot with a report-safe payload', async () => {
    await initializeAlertRetention();
    expect(upsertJobSchedulerMock).toHaveBeenCalledTimes(1);
    const [queue, repeat, template] = upsertJobSchedulerMock.mock.calls[0]!;
    expect(queue).toBe(__testOnly.QUEUE_NAME);
    expect(repeat).toEqual({ pattern: jobSchedule('alert-retention') });
    expect(template.data).toEqual({
      retentionDays: __testOnly.DEFAULT_RETENTION_DAYS, batchSize: __testOnly.BATCH_SIZE, maxBatches: __testOnly.MAX_BATCHES,
    });
    expect(attachMock).toHaveBeenCalledWith(expect.anything(), 'alertRetention');
  });
});
