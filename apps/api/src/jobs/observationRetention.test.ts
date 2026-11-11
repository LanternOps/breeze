import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { upsertJobSchedulerMock, runTargetsMock, captureExceptionMock, workerOnMock } = vi.hoisted(() => ({
  upsertJobSchedulerMock: vi.fn(),
  runTargetsMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  workerOnMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    upsertJobScheduler = upsertJobSchedulerMock;
    close = vi.fn();
  },
  Worker: class {
    constructor(public name: string, public processor: unknown, public opts: unknown) {}
    on = workerOnMock;
    close = vi.fn();
  },
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: captureExceptionMock, captureMessage: vi.fn() }));
vi.mock('./retentionTarget', () => ({ runRetentionTargets: runTargetsMock }));
vi.mock('../db', () => ({
  db: { execute: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const CUTOFF = '2026-01-01T00:00:00.000Z';
const NOW = '2026-05-01T00:00:00.000Z';

const load = () => import('./observationRetention');

type Entry = { target: { table: string }; knobs: Record<string, unknown> };
const reportFor = (table: string) => ({
  mode: 'report', table, retentionDays: 90, eligible: 0, eligibleCapped: false, durationMs: 1,
});

describe('observation retention (#11737)', () => {
  // Each test re-imports after vi.resetModules(); transform the module graph
  // once up front so the first test does not pay it against the 5 s timeout.
  beforeAll(async () => { await load(); }, 60_000);

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    runTargetsMock.mockImplementation(async (entries: Entry[]) => entries.map((e) => reportFor(e.target.table)));
  });
  afterEach(() => vi.unstubAllEnvs());

  describe('agent_health_observations predicate', () => {
    it('ages by server receipt time and never selects the row the latest projection points at', async () => {
      const { AGENT_HEALTH_OBSERVATION_RETENTION_TARGET: t } = await load();
      expect(t.table).toBe('agent_health_observations');
      expect(t.action).toEqual({ kind: 'delete' });
      expect(t.metricName).toBe('agent_health_observation_retention');
      const q = new PgDialect().sqlToQuery(t.where(CUTOFF, NOW));
      const s = flat(q.sql);
      expect(s).toMatch(/^agent_health_observations\.received_at < \$1::timestamptz AND NOT EXISTS \(/);
      // device_agent_health_latest.observation_id is ON DELETE CASCADE: deleting
      // the row it points at would delete the device's health projection.
      expect(s).toContain('FROM device_agent_health_latest latest');
      expect(s).toContain('latest.device_id = agent_health_observations.device_id');
      expect(s).toContain('latest.observation_id = agent_health_observations.id');
      expect(q.params).toEqual([CUTOFF]);
    });
  });

  describe('software_inventory_observations predicate', () => {
    it('ages by server receipt time and never selects a row any other row still references', async () => {
      const { SOFTWARE_INVENTORY_OBSERVATION_RETENTION_TARGET: t } = await load();
      expect(t.table).toBe('software_inventory_observations');
      expect(t.action).toEqual({ kind: 'delete' });
      expect(t.metricName).toBe('software_inventory_observation_retention');
      const q = new PgDialect().sqlToQuery(t.where(CUTOFF, NOW));
      const s = flat(q.sql);
      expect(s).toMatch(/^software_inventory_observations\.received_at < \$1::timestamptz AND NOT EXISTS \(/);
      // The state row's three pointers (ON DELETE SET NULL): latest drives the
      // out-of-order check on ingest, latest_accepted feeds vulnerability
      // correlation, visible is what the software tab shows.
      expect(s).toContain('FROM device_software_inventory_state state');
      expect(s).toContain('state.device_id = software_inventory_observations.device_id');
      for (const col of ['latest_observation_id', 'latest_accepted_observation_id', 'visible_observation_id']) {
        expect(s).toContain(`state.${col}`);
      }
      // Projection lineage and vulnerability resolution evidence.
      expect(s).toContain('FROM software_inventory si WHERE si.observation_id = software_inventory_observations.id');
      expect(s).toContain('FROM device_vulnerabilities dv WHERE dv.resolved_observation_id = software_inventory_observations.id');
      expect(s.match(/NOT EXISTS/g)).toHaveLength(3);
      expect(q.params).toEqual([CUTOFF]);
    });
  });

  it('defaults: 90 days (cap 365) for both, sized per table, report-only, hourly', async () => {
    const { __testOnly } = await load();
    expect(__testOnly.QUEUE_NAME).toBe('observation-retention');
    expect(__testOnly.ENTRIES.map((e) => ({
      table: e.target.table,
      enforceVar: e.enforceVar,
      maxRetentionDays: e.maxRetentionDays,
      knobs: e.knobs,
    }))).toEqual([
      {
        table: 'agent_health_observations',
        enforceVar: 'AGENT_HEALTH_OBSERVATION_RETENTION_ENFORCE',
        maxRetentionDays: 365,
        knobs: { retentionDays: 90, batchSize: 5000, maxBatches: 200, enforce: false },
      },
      {
        table: 'software_inventory_observations',
        enforceVar: 'SOFTWARE_INVENTORY_OBSERVATION_RETENTION_ENFORCE',
        maxRetentionDays: 365,
        knobs: { retentionDays: 90, batchSize: 500, maxBatches: 100, enforce: false },
      },
    ]);
  });

  it('reads each window from its own env var, capped, with garbage falling back to the default', async () => {
    vi.stubEnv('AGENT_HEALTH_OBSERVATION_RETENTION_DAYS', '14');
    vi.stubEnv('SOFTWARE_INVENTORY_OBSERVATION_RETENTION_DAYS', '99999');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let { __testOnly } = await load();
    expect(__testOnly.ENTRIES.map((e) => e.knobs.retentionDays)).toEqual([14, 365]);

    vi.resetModules();
    vi.stubEnv('AGENT_HEALTH_OBSERVATION_RETENTION_DAYS', '0');
    vi.stubEnv('SOFTWARE_INVENTORY_OBSERVATION_RETENTION_DAYS', 'nonsense');
    ({ __testOnly } = await load());
    expect(__testOnly.ENTRIES.map((e) => e.knobs.retentionDays)).toEqual([90, 90]);
    warn.mockRestore();
  });

  it('runs each target on its own, with its own flag named in its log line', async () => {
    const { runObservationRetention } = await load();
    const results = await runObservationRetention();
    expect(runTargetsMock).toHaveBeenCalledTimes(2);
    type Call = [Entry[], Record<string, unknown>];
    const [[first, firstOpts], [second, secondOpts]] = runTargetsMock.mock.calls as [Call, Call];
    expect(first.map((e) => e.target.table)).toEqual(['agent_health_observations']);
    expect(firstOpts).toMatchObject({ enforceVar: 'AGENT_HEALTH_OBSERVATION_RETENTION_ENFORCE', label: 'observationRetention' });
    expect(second.map((e) => e.target.table)).toEqual(['software_inventory_observations']);
    expect(secondOpts).toMatchObject({ enforceVar: 'SOFTWARE_INVENTORY_OBSERVATION_RETENTION_ENFORCE' });
    expect(results.map((r) => r.table)).toEqual(['agent_health_observations', 'software_inventory_observations']);
  });

  it('enforces a target only when its own flag is set, and forceReport turns every target back off', async () => {
    vi.stubEnv('SOFTWARE_INVENTORY_OBSERVATION_RETENTION_ENFORCE', 'true');
    const { runObservationRetention } = await load();
    await runObservationRetention();
    const enforced = (runTargetsMock.mock.calls as [Entry[]][]).map(([entries]) => entries[0]!.knobs.enforce);
    expect(enforced).toEqual([false, true]);

    runTargetsMock.mockClear();
    await runObservationRetention({ forceReport: true });
    const forced = (runTargetsMock.mock.calls as [Entry[]][]).map(([entries]) => entries[0]!.knobs.enforce);
    expect(forced).toEqual([false, false]);
  });

  it('a malformed enforce value stays report-only', async () => {
    vi.stubEnv('AGENT_HEALTH_OBSERVATION_RETENTION_ENFORCE', 'yes');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { __testOnly } = await load();
    expect(__testOnly.ENTRIES[0]!.knobs.enforce).toBe(false);
    warn.mockRestore();
  });

  it('a payload can reshape batches but never set a window or turn enforcement on', async () => {
    const { runObservationRetention } = await load();
    await runObservationRetention({ batchSize: 7, maxBatches: 3, retentionDays: 1, enforce: true } as never);
    for (const [entries] of runTargetsMock.mock.calls as [Entry[]][]) {
      expect(entries[0]!.knobs).toEqual({ retentionDays: 90, batchSize: 7, maxBatches: 3, enforce: false });
    }
  });

  it('runs the second target when the first fails, then fails the job naming the failed table', async () => {
    runTargetsMock
      .mockImplementationOnce(async (entries: Entry[]) => [{ table: entries[0]!.target.table, error: 'statement timeout' }])
      .mockImplementationOnce(async (entries: Entry[]) => entries.map((e) => reportFor(e.target.table)));
    const { runObservationRetention, ObservationRetentionTargetsFailedError } = await load();
    const err = await runObservationRetention().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ObservationRetentionTargetsFailedError);
    expect((err as Error).message).toContain('agent_health_observations');
    expect(runTargetsMock).toHaveBeenCalledTimes(2);
  });

  it('leaves failure reporting to attachWorkerObservability (no second log/capture per failed job)', async () => {
    const { initializeObservationRetention } = await load();
    const { attachWorkerObservability } = await import('./workerObservability');
    await initializeObservationRetention();
    expect(attachWorkerObservability).toHaveBeenCalledWith(expect.anything(), 'observationRetention');
    expect(workerOnMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('schedules hourly on its registry slot, carrying only the batch shape', async () => {
    const { initializeObservationRetention } = await load();
    const { jobSchedule } = await import('./scheduleRegistry');
    expect(jobSchedule('observation-retention')).toBe('41 * * * *');
    await initializeObservationRetention();
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      'observation-retention',
      { pattern: '41 * * * *' },
      expect.objectContaining({ data: {} }),
    );
  });
});
