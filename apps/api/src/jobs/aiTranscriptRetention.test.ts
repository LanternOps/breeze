import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { recordRunMock, captureMessageMock, upsertJobSchedulerMock } = vi.hoisted(() => ({
  recordRunMock: vi.fn(),
  captureMessageMock: vi.fn(),
  upsertJobSchedulerMock: vi.fn(),
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
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: captureMessageMock }));
// The real default deleter calls the agent SDK on this machine's disk: never in a unit test.
vi.mock('./aiToolOutputRetention', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiToolOutputRetention')>()),
  deleteSdkTranscript: vi.fn(async () => { throw new Error('real deleter reached in a unit test'); }),
}));
vi.mock('../services/retentionMetrics', () => ({ recordRetentionRun: recordRunMock }));
vi.mock('../db', () => ({
  // Every select resolves to no rows: the worker test below runs the real
  // loader, which then yields no orgs (and no batch can run).
  db: { execute: vi.fn(), select: vi.fn(() => ({ from: vi.fn(async () => []) })) },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

import type { OrgTranscriptWindows, TranscriptRetentionOps } from './aiTranscriptRetention';

const load = () => import('./aiTranscriptRetention');
const dialect = new PgDialect();
const NOW = new Date('2026-06-01T00:00:00.000Z');
const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';

function makeOps(windows: Array<[string, OrgTranscriptWindows]>, overrides: Partial<TranscriptRetentionOps> = {}) {
  const calls: string[] = [];
  const ops: TranscriptRetentionOps = {
    loadWindows: vi.fn(async () => new Map(windows)),
    countEligible: vi.fn(async (o) => {
      const s = dialect.sqlToQuery(o.where).sql;
      calls.push(`count:${s.includes('transcript_purged_at IS NOT NULL') ? 'stubDelete' : s.includes('NOT IN') ? 'technician' : 'client'}`);
      return { eligible: 2, capped: false };
    }),
    stubBatch: vi.fn(async (kind) => {
      calls.push(`stub:${kind}`);
      return { stubbed: 1, clearedSdkSessionIds: [`sdk-${kind}`] };
    }),
    deleteStubs: vi.fn(async () => {
      calls.push('delete');
      return 1;
    }),
    ...overrides,
  };
  return { ops, calls };
}

/** Never let a unit test reach the real SDK transcript deleter. */
const fakeDeleter = vi.fn(async () => 'deleted' as const);
const ALL: OrgTranscriptWindows = { technicianDays: 365, clientDays: 30, auditDays: 400 };

describe('runAiTranscriptRetention (#4342 W4)', () => {
  beforeAll(async () => { await load(); }, 60_000);
  beforeEach(() => vi.clearAllMocks());

  it('report mode never stubs or deletes, counts every phase and records rowsEligible', async () => {
    const { runAiTranscriptRetention } = await load();
    const { ops, calls } = makeOps([[ORG_A, ALL]]);
    const s = await runAiTranscriptRetention({ batchSize: 10, maxBatches: 3, enforce: false, now: NOW, deleteTranscript: fakeDeleter }, ops);
    expect(ops.stubBatch).not.toHaveBeenCalled();
    expect(ops.deleteStubs).not.toHaveBeenCalled();
    expect(calls).toEqual(['count:technician', 'count:client', 'count:stubDelete']);
    expect(ops.countEligible).toHaveBeenCalledWith(expect.objectContaining({ table: 'ai_sessions', cap: 30 }));
    expect(s.eligible).toEqual({ technician: 2, client: 2, stubDelete: 2, capped: false });
    expect(s.mode).toBe('report');
    expect(recordRunMock).toHaveBeenCalledWith('ai_transcript_retention', { rowsEligible: 6 });
  });

  it('enforce mode runs phases in order: technician stub → client stub → stub delete', async () => {
    const { runAiTranscriptRetention } = await load();
    const { ops, calls } = makeOps([[ORG_A, ALL]]);
    const deleter = vi.fn(async () => 'deleted' as const);
    const s = await runAiTranscriptRetention({ batchSize: 10, maxBatches: 3, enforce: true, now: NOW, deleteTranscript: deleter }, ops);
    expect(calls).toEqual(['stub:technician', 'stub:client', 'delete']);
    expect(ops.countEligible).not.toHaveBeenCalled();
    expect(s.stubbed).toEqual({ technician: 1, client: 1 });
    expect(s.stubsDeleted).toBe(1);
    expect(s.transcripts.deleted).toBe(2);
    expect(recordRunMock).toHaveBeenCalledWith('ai_transcript_retention', { rowsDeleted: 3, incomplete: false });
  });

  it('passes each phase its own window as the cutoff', async () => {
    const { runAiTranscriptRetention } = await load();
    const { ops } = makeOps([[ORG_A, ALL]]);
    await runAiTranscriptRetention({ batchSize: 10, maxBatches: 3, enforce: true, now: NOW, deleteTranscript: fakeDeleter }, ops);
    const day = 24 * 60 * 60 * 1000;
    expect(ops.stubBatch).toHaveBeenCalledWith('technician', ORG_A, new Date(NOW.getTime() - 365 * day).toISOString(), NOW, 10);
    expect(ops.stubBatch).toHaveBeenCalledWith('client', ORG_A, new Date(NOW.getTime() - 30 * day).toISOString(), NOW, 10);
    expect(ops.deleteStubs).toHaveBeenCalledWith(ORG_A, new Date(NOW.getTime() - 400 * day).toISOString(), NOW, 10);
  });

  it('an org with both windows NULL is skipped for phases 1–2 but still runs phase 3', async () => {
    const { runAiTranscriptRetention } = await load();
    const { ops, calls } = makeOps([[ORG_A, { technicianDays: null, clientDays: null, auditDays: 400 }]]);
    await runAiTranscriptRetention({ batchSize: 10, maxBatches: 3, enforce: true, now: NOW, deleteTranscript: fakeDeleter }, ops);
    expect(calls).toEqual(['delete']);
  });

  it('decision B: an org with no audit policy row runs phases 1–2, skips phase 3 and is counted', async () => {
    const { runAiTranscriptRetention } = await load();
    const noAudit: OrgTranscriptWindows = { technicianDays: 365, clientDays: 30, auditDays: null };
    for (const enforce of [false, true]) {
      const { ops, calls } = makeOps([[ORG_A, noAudit], [ORG_B, ALL]]);
      const s = await runAiTranscriptRetention({ batchSize: 10, maxBatches: 3, enforce, now: NOW, deleteTranscript: fakeDeleter }, ops);
      expect(s.orgsWithoutAuditPolicy).toBe(1);
      expect(s.incomplete).toBe(false);
      if (enforce) {
        expect(ops.deleteStubs).toHaveBeenCalledTimes(1);
        expect(ops.deleteStubs).toHaveBeenCalledWith(ORG_B, expect.any(String), NOW, 10);
        expect(calls).toEqual(['stub:technician', 'stub:client', 'stub:technician', 'stub:client', 'delete']);
      } else {
        // ORG_A contributes zero phase-3 eligible rows: only ORG_B is counted.
        expect(calls.filter((c) => c === 'count:stubDelete')).toHaveLength(1);
        expect(s.eligible.stubDelete).toBe(2);
      }
    }
  });

  it('drains batches until a short batch, and flags a full final batch as incomplete', async () => {
    const { runAiTranscriptRetention } = await load();
    const full = vi.fn(async () => ({ stubbed: 10, clearedSdkSessionIds: [] }));
    const { ops } = makeOps([[ORG_A, { technicianDays: 365, clientDays: null, auditDays: null }]], { stubBatch: full });
    const s = await runAiTranscriptRetention({ batchSize: 10, maxBatches: 3, enforce: true, now: NOW, deleteTranscript: fakeDeleter }, ops);
    expect(full).toHaveBeenCalledTimes(3);
    expect(s.stubbed.technician).toBe(30);
    expect(s.incomplete).toBe(true);
  });

  it('the transcript deleter runs only after a batch resolves, and a throwing deleter counts as failed without failing the org', async () => {
    const { runAiTranscriptRetention } = await load();
    const order: string[] = [];
    const stubBatch = vi.fn(async () => {
      await Promise.resolve();
      order.push('batch-resolved');
      return { stubbed: 1, clearedSdkSessionIds: ['sdk-1'] };
    });
    const deleter = vi.fn(async () => {
      order.push('deleter');
      throw new Error('disk gone');
    });
    const { ops } = makeOps([[ORG_A, { technicianDays: 365, clientDays: null, auditDays: null }]], { stubBatch });
    const s = await runAiTranscriptRetention({ batchSize: 10, maxBatches: 3, enforce: true, now: NOW, deleteTranscript: deleter }, ops);
    expect(order).toEqual(['batch-resolved', 'deleter']);
    expect(s.transcripts.failed).toBe(1);
    expect(s.orgsFailed).toBe(0);
    expect(s.stubbed.technician).toBe(1);
    expect(s.incomplete).toBe(true);
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
  });

  it('a failing org is counted and does not stop the next org; one bounded Sentry event, no org ids', async () => {
    const { runAiTranscriptRetention } = await load();
    const stubBatch = vi.fn(async (_k: string, orgId: string) => {
      if (orgId === ORG_A) throw new Error('boom');
      return { stubbed: 1, clearedSdkSessionIds: [] };
    });
    const { ops } = makeOps([[ORG_A, ALL], [ORG_B, ALL]], { stubBatch: stubBatch as TranscriptRetentionOps['stubBatch'] });
    const s = await runAiTranscriptRetention({ batchSize: 10, maxBatches: 3, enforce: true, now: NOW, deleteTranscript: fakeDeleter }, ops);
    expect(s.orgsFailed).toBe(1);
    expect(s.stubbed.technician).toBe(1);
    expect(ops.deleteStubs).toHaveBeenCalledWith(ORG_B, expect.any(String), NOW, 10);
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    const [msg] = captureMessageMock.mock.calls[0]!;
    expect(msg).not.toContain(ORG_A);
    expect(recordRunMock).toHaveBeenCalledWith('ai_transcript_retention', expect.objectContaining({ incomplete: true }));
  });

  it('report mode with a failed org records only { incomplete: true }, never an understated rowsEligible', async () => {
    const { runAiTranscriptRetention } = await load();
    const countEligible = vi.fn(async (o: { label: string }) => {
      if (o.label.endsWith('technician')) throw new Error('replica unreachable');
      return { eligible: 2, capped: false };
    });
    const { ops } = makeOps([[ORG_A, ALL]], { countEligible: countEligible as TranscriptRetentionOps['countEligible'] });
    const s = await runAiTranscriptRetention({ batchSize: 10, maxBatches: 3, enforce: false, now: NOW, deleteTranscript: fakeDeleter }, ops);
    expect(s.orgsFailed).toBe(1);
    expect(s.incomplete).toBe(true);
    expect(recordRunMock).toHaveBeenCalledTimes(1);
    expect(recordRunMock).toHaveBeenCalledWith('ai_transcript_retention', { incomplete: true });
  });

  it('counts batches that committed before a later batch threw', async () => {
    const { runAiTranscriptRetention } = await load();
    let calls = 0;
    const stubBatch = vi.fn(async () => {
      calls += 1;
      if (calls === 3) throw new Error('lock timeout');
      return { stubbed: 10, clearedSdkSessionIds: [] };
    });
    const { ops } = makeOps([[ORG_A, { technicianDays: 365, clientDays: null, auditDays: null }]], { stubBatch });
    const s = await runAiTranscriptRetention({ batchSize: 10, maxBatches: 5, enforce: true, now: NOW, deleteTranscript: fakeDeleter }, ops);
    expect(s.stubbed.technician).toBe(20);
    expect(s.orgsFailed).toBe(1);
    expect(recordRunMock).toHaveBeenCalledWith('ai_transcript_retention', { rowsDeleted: 20, incomplete: true });
  });

  it('a failing phase does not skip the org\'s other phases', async () => {
    const { runAiTranscriptRetention } = await load();
    const stubBatch = vi.fn(async (kind: string) => {
      if (kind === 'technician') throw new Error('boom');
      return { stubbed: 1, clearedSdkSessionIds: [] };
    });
    const { ops } = makeOps([[ORG_A, ALL]], { stubBatch: stubBatch as TranscriptRetentionOps['stubBatch'] });
    const s = await runAiTranscriptRetention({ batchSize: 10, maxBatches: 3, enforce: true, now: NOW, deleteTranscript: fakeDeleter }, ops);
    expect(stubBatch).toHaveBeenCalledWith('client', ORG_A, expect.any(String), NOW, 10);
    expect(ops.deleteStubs).toHaveBeenCalledTimes(1);
    expect(s.stubbed.client).toBe(1);
    expect(s.stubsDeleted).toBe(1);
    expect(s.orgsFailed).toBe(1);
    expect(s.phasesFailed).toBe(1);
  });

  it('an unusable window skips only that phase and marks the run incomplete', async () => {
    const { runAiTranscriptRetention } = await load();
    const { ops, calls } = makeOps([[ORG_A, { technicianDays: 0, clientDays: 30, auditDays: 400 }]]);
    const s = await runAiTranscriptRetention({ batchSize: 10, maxBatches: 3, enforce: true, now: NOW, deleteTranscript: fakeDeleter }, ops);
    expect(calls).toEqual(['stub:client', 'delete']);
    expect(s.orgsInvalidWindow).toBe(1);
    expect(s.incomplete).toBe(true);
  });

  it('a capped report count is surfaced', async () => {
    const { runAiTranscriptRetention } = await load();
    const { ops } = makeOps([[ORG_A, ALL]], { countEligible: vi.fn(async () => ({ eligible: 30, capped: true })) });
    const s = await runAiTranscriptRetention({ batchSize: 10, maxBatches: 3, enforce: false, now: NOW, deleteTranscript: fakeDeleter }, ops);
    expect(s.eligible.capped).toBe(true);
  });
});

describe('AI transcript retention wiring', () => {
  it('defaults to report-only and schedules the registry slot', async () => {
    vi.resetModules();
    vi.stubEnv('AI_TRANSCRIPT_RETENTION_ENFORCE', '');
    const mod = await load();
    expect(mod.__testOnly.ENFORCE).toBe(false);
    await mod.initializeAiTranscriptRetention();
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      'ai-transcript-retention',
      { pattern: '8 15 * * *' },
      expect.objectContaining({ name: 'sweep' }),
    );
    await mod.shutdownAiTranscriptRetention();
    vi.unstubAllEnvs();
  });

  it.each([
    ['unset', undefined, {}, 'report'],
    ['unset, payload cannot turn it on', undefined, { forceReport: false }, 'report'],
    ['true', 'true', {}, 'enforce'],
    ['true + forceReport', 'true', { forceReport: true }, 'report'],
    ['garbage', 'yes', {}, 'report'],
  ] as const)('the worker processor runs in the right mode: ENFORCE %s', async (_n, raw, data, mode) => {
    vi.resetModules();
    if (raw !== undefined) vi.stubEnv('AI_TRANSCRIPT_RETENTION_ENFORCE', raw);
    const mod = await load();
    const worker = mod.createAiTranscriptRetentionWorker() as unknown as {
      processor: (job: { data: Record<string, unknown> }) => Promise<{ mode: string }>;
    };
    expect((await worker.processor({ data })).mode).toBe(mode);
    vi.unstubAllEnvs();
  });

  it.each([['yes', false], ['TRUE', true], [' 1 ', true]])('ENFORCE=%j → %s', async (raw, expected) => {
    vi.resetModules();
    vi.stubEnv('AI_TRANSCRIPT_RETENTION_ENFORCE', raw);
    expect((await load()).__testOnly.ENFORCE).toBe(expected);
    vi.unstubAllEnvs();
  });
});
