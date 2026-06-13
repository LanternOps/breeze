/**
 * Unit tests for the audit-chain external anchor worker (issue #916).
 *
 * Mirrors auditChainVerify.test.ts: BullMQ, the db module, the event bus and
 * Sentry are stubbed so we assert scheduling, the per-org anchor+verify loop,
 * the anchor-write path, and incident-raising on divergence — without a real
 * Postgres.
 *
 * The SQL functions themselves (audit_chain_anchor_head /
 * audit_chain_verify_anchor) and the append-only grants are exercised by the
 * audit-chain integration tests, not here.
 *
 * Per-sweep dbExecute call order: 1 enumeration, then for EACH target (system
 * chain first, then each org) three calls in order: verify, readHead,
 * writeAnchor. mockSweep() wires this up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  queueCloseMock,
  workerCloseMock,
  withSystemDbAccessContextMock,
  runOutsideDbContextMock,
  dbExecuteMock,
  dbInsertMock,
  insertValuesMock,
  insertReturningMock,
  publishEventMock,
  captureExceptionMock,
  capturedWorkerProcessor,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  dbExecuteMock: vi.fn(),
  dbInsertMock: vi.fn(),
  insertValuesMock: vi.fn(),
  insertReturningMock: vi.fn(),
  publishEventMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  capturedWorkerProcessor: { current: null as null | ((job: unknown) => Promise<unknown>) },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    add = (...args: unknown[]) => addMock(...(args as []));
    getRepeatableJobs = () => getRepeatableJobsMock();
    removeRepeatableByKey = (...args: unknown[]) => removeRepeatableByKeyMock(...(args as []));
    close = () => queueCloseMock();
  },
  Worker: class {
    name: string;
    constructor(name: string, processor: (job: unknown) => Promise<unknown>) {
      this.name = name;
      capturedWorkerProcessor.current = processor;
    }
    on = vi.fn();
    close = () => workerCloseMock();
  },
  Job: class {},
}));

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    withSystemDbAccessContext: (fn: () => Promise<unknown>) => withSystemDbAccessContextMock(fn),
    runOutsideDbContext: (fn: () => Promise<unknown>) => runOutsideDbContextMock(fn),
    db: {
      execute: (...args: unknown[]) => dbExecuteMock(...(args as [])),
      insert: (...args: unknown[]) => dbInsertMock(...(args as [])),
    },
  };
});

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...(args as [])),
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: (...args: unknown[]) => publishEventMock(...(args as [])),
}));

import {
  __testOnly,
  scheduleAuditChainAnchor,
  shutdownAuditChainAnchorWorker,
  runAnchorSweep,
} from './auditChainAnchor';

const ORIGINAL_FLAG = process.env.AUDIT_CHAIN_ANCHOR_ENABLED;
const ORIGINAL_SIGN_KEY = process.env.AUDIT_ANCHOR_SIGNING_KEY;

/** Re-arm the chained Drizzle insert builder for one .insert() call. */
function primeInsert(returnedId = 'incident-1') {
  insertReturningMock.mockResolvedValue([{ id: returnedId }]);
  insertValuesMock.mockReturnValue({ returning: insertReturningMock });
  dbInsertMock.mockReturnValue({ values: insertValuesMock });
}

type HeadRow = { head_chain_seq: number; head_chain_checksum: string | null; entry_count: number };
type DivRow = Record<string, unknown>;

/** Default intact head + anchor-write result for a target. */
const intactHead: HeadRow = { head_chain_seq: 10, head_chain_checksum: 'head10', entry_count: 10 };
function anchorWriteRow(signed = false) {
  return [
    {
      anchor_seq: 1,
      head_chain_seq: 10,
      head_chain_checksum: 'head10',
      entry_count: 10,
      anchored_at: '2026-06-13T04:45:00.000Z',
      signed,
    },
  ];
}

/**
 * Wire dbExecute for one full sweep. `targets` describes, in order (system
 * chain is the implicit first target with no org id), the verify result and
 * head for each. The enumeration result is derived from the org ids.
 */
function mockSweep(
  orgIds: string[],
  perTarget: Array<{ verify: DivRow[]; head?: HeadRow; signed?: boolean }>,
) {
  // 1) enumeration
  dbExecuteMock.mockResolvedValueOnce(orgIds.map((id) => ({ id })));
  // 2) per target: verify, readHead, writeAnchor
  for (const t of perTarget) {
    dbExecuteMock.mockResolvedValueOnce(t.verify);
    dbExecuteMock.mockResolvedValueOnce([t.head ?? intactHead]);
    dbExecuteMock.mockResolvedValueOnce(anchorWriteRow(t.signed ?? false));
  }
}

describe('auditChainAnchor worker', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    runOutsideDbContextMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    getRepeatableJobsMock.mockResolvedValue([]);
    addMock.mockResolvedValue(undefined);
    removeRepeatableByKeyMock.mockResolvedValue(undefined);
    queueCloseMock.mockResolvedValue(undefined);
    workerCloseMock.mockResolvedValue(undefined);
    dbExecuteMock.mockResolvedValue([]);
    publishEventMock.mockResolvedValue('evt-1');
    primeInsert();
    capturedWorkerProcessor.current = null;
    delete process.env.AUDIT_CHAIN_ANCHOR_ENABLED;
    delete process.env.AUDIT_ANCHOR_SIGNING_KEY;
  });

  afterEach(async () => {
    await shutdownAuditChainAnchorWorker();
    if (ORIGINAL_FLAG === undefined) delete process.env.AUDIT_CHAIN_ANCHOR_ENABLED;
    else process.env.AUDIT_CHAIN_ANCHOR_ENABLED = ORIGINAL_FLAG;
    if (ORIGINAL_SIGN_KEY === undefined) delete process.env.AUDIT_ANCHOR_SIGNING_KEY;
    else process.env.AUDIT_ANCHOR_SIGNING_KEY = ORIGINAL_SIGN_KEY;
  });

  it('exposes a daily cron offset after the in-chain verifier', () => {
    expect(__testOnly.DAILY_CRON).toBe('45 4 * * *');
    expect(__testOnly.JOB_NAME).toBe('audit-chain-anchor');
    expect(__testOnly.REPEAT_JOB_ID).toBe('audit-chain-anchor');
  });

  it('isEnabled defaults ON and accepts standard falsy values', () => {
    delete process.env.AUDIT_CHAIN_ANCHOR_ENABLED;
    expect(__testOnly.isEnabled()).toBe(true);
    process.env.AUDIT_CHAIN_ANCHOR_ENABLED = 'false';
    expect(__testOnly.isEnabled()).toBe(false);
    process.env.AUDIT_CHAIN_ANCHOR_ENABLED = '0';
    expect(__testOnly.isEnabled()).toBe(false);
    process.env.AUDIT_CHAIN_ANCHOR_ENABLED = 'true';
    expect(__testOnly.isEnabled()).toBe(true);
  });

  describe('scheduleAuditChainAnchor', () => {
    it('registers a daily repeatable with a stable jobId', async () => {
      await scheduleAuditChainAnchor();
      expect(addMock).toHaveBeenCalledTimes(1);
      const [, , opts] = addMock.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
      expect((opts.repeat as { pattern: string }).pattern).toBe('45 4 * * *');
      expect(opts.jobId).toBe('audit-chain-anchor');
    });

    it('clears any prior repeatable before registering', async () => {
      getRepeatableJobsMock.mockResolvedValue([
        { name: 'audit-chain-anchor', key: 'old-key' },
        { name: 'something-else', key: 'keep' },
      ]);
      await scheduleAuditChainAnchor();
      expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('old-key');
      expect(removeRepeatableByKeyMock).not.toHaveBeenCalledWith('keep');
    });

    it('skips registration when disabled by env flag', async () => {
      process.env.AUDIT_CHAIN_ANCHOR_ENABLED = 'false';
      await scheduleAuditChainAnchor();
      expect(addMock).not.toHaveBeenCalled();
    });
  });

  describe('runAnchorSweep', () => {
    it('anchors the system chain plus every org and raises no incident when consistent', async () => {
      // system chain has no anchor yet (no_anchor), org-1 consistent (empty divergence).
      mockSweep(
        ['org-1'],
        [
          { verify: [{ reason: 'no_anchor' }] }, // system chain
          { verify: [] }, // org-1 consistent
        ],
      );

      const stats = await runAnchorSweep();

      // 2 targets anchored (system + org-1).
      expect(stats.orgsAnchored).toBe(2);
      expect(stats.divergencesFound).toBe(0); // no_anchor is informational, not counted
      expect(stats.incidentsRaised).toBe(0);
      expect(dbInsertMock).not.toHaveBeenCalled();
      expect(publishEventMock).not.toHaveBeenCalled();
    });

    it('raises a P1 incident when an org chain regressed below its anchor', async () => {
      mockSweep(
        ['org-1', 'org-2'],
        [
          { verify: [] }, // system chain consistent
          { verify: [] }, // org-1 consistent
          {
            // org-2: head moved backwards → tamper
            verify: [
              {
                reason: 'seq_regressed',
                anchor_seq: 7,
                anchored_head_seq: 100,
                anchored_entry_count: 100,
                live_head_seq: 40,
                live_entry_count: 40,
                anchored_head_checksum: 'h100',
                live_head_checksum: 'h40',
              },
            ],
          },
        ],
      );

      const stats = await runAnchorSweep();

      expect(stats.divergencesFound).toBe(1);
      expect(stats.incidentsRaised).toBe(1);
      expect(stats.orgsAnchored).toBe(3); // system + org-1 + org-2 all still anchored forward

      // Exactly one incident, for org-2, p1 / detected / audit_integrity.
      expect(dbInsertMock).toHaveBeenCalledTimes(1);
      const values = insertValuesMock.mock.calls[0]![0] as Record<string, unknown>;
      expect(values.orgId).toBe('org-2');
      expect(values.severity).toBe('p1');
      expect(values.status).toBe('detected');
      expect(values.classification).toBe('audit_integrity');
      expect(String(values.summary)).toContain('seq_regressed');

      // incident.created published once for org-2 with the divergence reason.
      expect(publishEventMock).toHaveBeenCalledTimes(1);
      const [type, orgId, payload, source] = publishEventMock.mock.calls[0] as [
        string,
        string,
        Record<string, unknown>,
        string,
      ];
      expect(type).toBe('incident.created');
      expect(orgId).toBe('org-2');
      expect(source).toBe('audit-chain-anchor');
      expect(payload.reason).toBe('seq_regressed');

      // Sentry captures the divergence too.
      expect(captureExceptionMock).toHaveBeenCalled();
    });

    it('detects a deleted sealed head (anchored_head_missing) as tamper', async () => {
      mockSweep(
        ['org-1'],
        [
          { verify: [] }, // system
          {
            verify: [
              {
                reason: 'anchored_head_missing',
                anchor_seq: 3,
                anchored_head_seq: 50,
                anchored_entry_count: 50,
                live_head_seq: 49,
                live_entry_count: 49,
                anchored_head_checksum: 'h50',
                live_head_checksum: 'h49',
              },
            ],
          },
        ],
      );

      const stats = await runAnchorSweep();
      expect(stats.incidentsRaised).toBe(1);
      expect(__testOnly.TAMPER_REASONS.has('anchored_head_missing')).toBe(true);
    });

    it('treats count_shrank with an intact head as benign retention (no incident)', async () => {
      mockSweep(
        ['org-1'],
        [
          { verify: [] }, // system
          {
            verify: [
              {
                reason: 'count_shrank',
                anchor_seq: 4,
                anchored_head_seq: 80,
                anchored_entry_count: 80,
                live_head_seq: 80, // head unchanged → just a shorter prefix
                live_entry_count: 60,
                anchored_head_checksum: 'h80',
                live_head_checksum: 'h80',
              },
            ],
          },
        ],
      );

      const stats = await runAnchorSweep();
      // Counted as a divergence observation but NOT a tamper incident.
      expect(stats.divergencesFound).toBe(1);
      expect(stats.incidentsRaised).toBe(0);
      expect(dbInsertMock).not.toHaveBeenCalled();
      expect(__testOnly.TAMPER_REASONS.has('count_shrank')).toBe(false);
    });

    it('signs anchors and counts them when a signing key is configured', async () => {
      // 32-byte base64 seed (deterministic for the test).
      process.env.AUDIT_ANCHOR_SIGNING_KEY = Buffer.alloc(32, 7).toString('base64');
      mockSweep(
        ['org-1'],
        [
          { verify: [{ reason: 'no_anchor' }], signed: true }, // system
          { verify: [], signed: true }, // org-1
        ],
      );

      const stats = await runAnchorSweep();
      expect(stats.orgsAnchored).toBe(2);
      expect(stats.anchorsSigned).toBe(2);
    });

    it('isolates a per-target failure without aborting the sweep', async () => {
      dbExecuteMock.mockResolvedValueOnce([{ id: 'org-1' }]); // enumeration
      // system chain target: verify throws.
      dbExecuteMock.mockRejectedValueOnce(new Error('verify boom'));
      // org-1 target proceeds normally: verify, readHead, writeAnchor.
      dbExecuteMock.mockResolvedValueOnce([]);
      dbExecuteMock.mockResolvedValueOnce([intactHead]);
      dbExecuteMock.mockResolvedValueOnce(anchorWriteRow(false));

      const stats = await runAnchorSweep();

      expect(stats.errors).toBe(1);
      expect(stats.orgsAnchored).toBe(1); // org-1 still anchored
      expect(captureExceptionMock).toHaveBeenCalled();
    });

    it('runs the per-target sweep outside the long-held enumeration txn', async () => {
      mockSweep(['org-1'], [{ verify: [] }, { verify: [] }]);
      await runAnchorSweep();
      expect(runOutsideDbContextMock).toHaveBeenCalled();
    });

    it('does not raise an org incident for a divergence on the system chain', async () => {
      // System chain (orgId null) regressed — surfaced via Sentry, but no
      // org-scoped incident row can be created for it.
      dbExecuteMock.mockResolvedValueOnce([]); // enumeration: no orgs
      dbExecuteMock.mockResolvedValueOnce([
        {
          reason: 'seq_regressed',
          anchor_seq: 1,
          anchored_head_seq: 5,
          anchored_entry_count: 5,
          live_head_seq: 2,
          live_entry_count: 2,
          anchored_head_checksum: 'h5',
          live_head_checksum: 'h2',
        },
      ]); // system verify → tamper
      dbExecuteMock.mockResolvedValueOnce([intactHead]); // readHead
      dbExecuteMock.mockResolvedValueOnce(anchorWriteRow(false)); // writeAnchor

      const stats = await runAnchorSweep();

      expect(stats.divergencesFound).toBe(1);
      expect(stats.incidentsRaised).toBe(0); // no org incident for the system chain
      expect(dbInsertMock).not.toHaveBeenCalled();
      expect(captureExceptionMock).toHaveBeenCalled(); // but Sentry still fires
    });
  });

  describe('worker processor', () => {
    it('runs the sweep for the scheduled job name', async () => {
      const { createAuditChainAnchorWorker } = await import('./auditChainAnchor');
      createAuditChainAnchorWorker();
      expect(capturedWorkerProcessor.current).toBeTypeOf('function');

      mockSweep([], [{ verify: [{ reason: 'no_anchor' }] }]); // just the system chain

      const result = await capturedWorkerProcessor.current!({ name: 'audit-chain-anchor' });
      expect((result as { orgsAnchored: number }).orgsAnchored).toBe(1);
    });

    it('ignores unknown job names', async () => {
      const { createAuditChainAnchorWorker } = await import('./auditChainAnchor');
      createAuditChainAnchorWorker();
      const result = await capturedWorkerProcessor.current!({ name: 'bogus' });
      expect((result as { skipped: boolean }).skipped).toBe(true);
      expect(dbExecuteMock).not.toHaveBeenCalled();
    });
  });
});
