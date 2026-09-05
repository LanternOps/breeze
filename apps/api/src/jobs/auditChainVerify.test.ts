/**
 * Unit tests for the audit-chain verification worker (issue #916 bonus /
 * #917 L-2).
 *
 * Mirrors auditRetention.test.ts: BullMQ, the db module, the event bus and
 * Sentry are stubbed so we can assert scheduling, the per-org verify loop,
 * and incident-raising behavior without a real Postgres.
 *
 * The verify_chain SQL itself (and the deferred commit-time sealing from
 * #1002 that makes a non-empty result trustworthy) are exercised by the
 * audit-chain integration tests, not here.
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
  scheduleAuditChainVerify,
  shutdownAuditChainVerifyWorker,
  verifyAuditChains,
} from './auditChainVerify';

const ORIGINAL_FLAG = process.env.AUDIT_CHAIN_VERIFY_ENABLED;

/** Re-arm the chained Drizzle insert builder for one .insert() call. */
function primeInsert(returnedId = 'incident-1') {
  insertReturningMock.mockResolvedValue([{ id: returnedId }]);
  insertValuesMock.mockReturnValue({ returning: insertReturningMock });
  dbInsertMock.mockReturnValue({ values: insertValuesMock });
}

describe('auditChainVerify worker', () => {
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
    delete process.env.AUDIT_CHAIN_VERIFY_ENABLED;
  });

  afterEach(async () => {
    await shutdownAuditChainVerifyWorker();
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.AUDIT_CHAIN_VERIFY_ENABLED;
    } else {
      process.env.AUDIT_CHAIN_VERIFY_ENABLED = ORIGINAL_FLAG;
    }
  });

  it('exposes a daily cron and stable identifiers', () => {
    expect(__testOnly.DAILY_CRON).toBe('13 4 * * *');
    expect(__testOnly.JOB_NAME).toBe('audit-chain-verify');
    expect(__testOnly.REPEAT_JOB_ID).toBe('audit-chain-verify');
  });

  it('isEnabled defaults ON and accepts standard falsy values', () => {
    delete process.env.AUDIT_CHAIN_VERIFY_ENABLED;
    expect(__testOnly.isEnabled()).toBe(true);
    process.env.AUDIT_CHAIN_VERIFY_ENABLED = 'false';
    expect(__testOnly.isEnabled()).toBe(false);
    process.env.AUDIT_CHAIN_VERIFY_ENABLED = '0';
    expect(__testOnly.isEnabled()).toBe(false);
    process.env.AUDIT_CHAIN_VERIFY_ENABLED = 'off';
    expect(__testOnly.isEnabled()).toBe(false);
    process.env.AUDIT_CHAIN_VERIFY_ENABLED = 'true';
    expect(__testOnly.isEnabled()).toBe(true);
  });

  describe('scheduleAuditChainVerify', () => {
    it('registers a daily repeatable with a stable jobId', async () => {
      await scheduleAuditChainVerify();
      expect(addMock).toHaveBeenCalledTimes(1);
      const [, , opts] = addMock.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
      expect((opts.repeat as { pattern: string }).pattern).toBe('13 4 * * *');
      expect(opts.jobId).toBe('audit-chain-verify');
    });

    it('clears any prior repeatable before registering', async () => {
      getRepeatableJobsMock.mockResolvedValue([
        { name: 'audit-chain-verify', key: 'old-key' },
        { name: 'something-else', key: 'keep' },
      ]);
      await scheduleAuditChainVerify();
      expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('old-key');
      expect(removeRepeatableByKeyMock).not.toHaveBeenCalledWith('keep');
    });

    it('skips registration when disabled by env flag', async () => {
      process.env.AUDIT_CHAIN_VERIFY_ENABLED = 'false';
      await scheduleAuditChainVerify();
      expect(addMock).not.toHaveBeenCalled();
    });
  });

  describe('verifyAuditChains', () => {
    // dbExecuteMock is called once for the org enumeration, then once per
    // org for SELECT * FROM audit_log_verify_chain(org). Wire the calls in
    // order via mockResolvedValueOnce.
    function mockOrgs(orgIds: string[]) {
      dbExecuteMock.mockResolvedValueOnce(orgIds.map((id) => ({ id })));
    }

    it('raises no incident when every chain is intact', async () => {
      mockOrgs(['org-1', 'org-2']);
      dbExecuteMock.mockResolvedValueOnce([]); // org-1 verify → clean
      dbExecuteMock.mockResolvedValueOnce([]); // org-2 verify → clean

      const stats = await verifyAuditChains();

      expect(stats.orgsChecked).toBe(2);
      expect(stats.orgsBroken).toBe(0);
      expect(stats.alertsRaised).toBe(0);
      expect(dbInsertMock).not.toHaveBeenCalled();
      expect(publishEventMock).not.toHaveBeenCalled();
      expect(captureExceptionMock).not.toHaveBeenCalled();
    });

    it('raises exactly one incident for an org whose chain is broken', async () => {
      mockOrgs(['org-1', 'org-2']);
      dbExecuteMock.mockResolvedValueOnce([]); // org-1 clean
      dbExecuteMock.mockResolvedValueOnce([
        { broken_id: 'row-aaa', expected: 'exp1', actual: 'act1' },
        { broken_id: 'row-bbb', expected: 'exp2', actual: 'act2' },
      ]); // org-2 → 2 breaks

      const stats = await verifyAuditChains();

      expect(stats.orgsChecked).toBe(2);
      expect(stats.orgsBroken).toBe(1);
      expect(stats.alertsRaised).toBe(1);

      // Exactly one incident inserted, for org-2, p1 / detected / audit_integrity.
      expect(dbInsertMock).toHaveBeenCalledTimes(1);
      const values = insertValuesMock.mock.calls[0]![0] as Record<string, unknown>;
      expect(values.orgId).toBe('org-2');
      expect(values.severity).toBe('p1');
      expect(values.status).toBe('detected');
      expect(values.classification).toBe('audit_integrity');
      // First broken_id and the break count must be carried in the payload.
      expect(String(values.summary)).toContain('row-aaa');
      expect(String(values.summary)).toContain('2');

      // The incident.created event is published once for the broken org.
      expect(publishEventMock).toHaveBeenCalledTimes(1);
      const [type, orgId, payload, source] = publishEventMock.mock.calls[0] as [
        string,
        string,
        Record<string, unknown>,
        string,
      ];
      expect(type).toBe('incident.created');
      expect(orgId).toBe('org-2');
      expect(source).toBe('audit-chain-verify');
      expect(payload.brokenId).toBe('row-aaa');
      expect(payload.breakCount).toBe(2);
    });

    it('isolates a per-org verify failure without aborting the sweep', async () => {
      mockOrgs(['org-1', 'org-2']);
      dbExecuteMock.mockRejectedValueOnce(new Error('verify boom')); // org-1 throws
      dbExecuteMock.mockResolvedValueOnce([]); // org-2 still checked → clean

      const stats = await verifyAuditChains();

      // org-1 threw (counted as an error, not a successful check); org-2 was
      // still reached and verified clean — the sweep did not abort.
      expect(stats.orgsChecked).toBe(1);
      expect(stats.errors).toBe(1);
      expect(stats.orgsBroken).toBe(0);
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    });

    it('runs the per-org verify outside the long-held enumeration txn', async () => {
      mockOrgs(['org-1']);
      dbExecuteMock.mockResolvedValueOnce([]);

      await verifyAuditChains();

      // The org list is read in one short system txn; the per-org sweep runs
      // via runOutsideDbContext so we never hold a connection idle-in-txn
      // across the loop (#1105 pattern).
      expect(runOutsideDbContextMock).toHaveBeenCalled();
    });
  });

  describe('verify plan (incremental vs full)', () => {
    const ORIGINAL_MODE = process.env.AUDIT_CHAIN_VERIFY_MODE;
    const ORIGINAL_SLICES = process.env.AUDIT_CHAIN_VERIFY_RESCAN_SLICES;

    function mockOrgs(orgIds: string[]) {
      dbExecuteMock.mockResolvedValueOnce(orgIds.map((id) => ({ id })));
    }

    afterEach(() => {
      if (ORIGINAL_MODE === undefined) delete process.env.AUDIT_CHAIN_VERIFY_MODE;
      else process.env.AUDIT_CHAIN_VERIFY_MODE = ORIGINAL_MODE;
      if (ORIGINAL_SLICES === undefined) delete process.env.AUDIT_CHAIN_VERIFY_RESCAN_SLICES;
      else process.env.AUDIT_CHAIN_VERIFY_RESCAN_SLICES = ORIGINAL_SLICES;
      vi.useRealTimers();
    });

    /** Flatten a drizzle `sql` tag into its text plus bound params, in order. */
    function flatten(q: unknown): { text: string; params: unknown[] } {
      const sqlObj = q as { queryChunks?: Array<unknown> };
      const params: unknown[] = [];
      const text = (sqlObj.queryChunks ?? [])
        .map((c) => {
          // StringChunk carries its literal text in `value: string[]`; every
          // other chunk is an interpolated parameter.
          if (c && typeof c === 'object' && Array.isArray((c as { value?: unknown }).value)) {
            return ((c as { value: string[] }).value).join('');
          }
          params.push(c);
          return '?';
        })
        .join('');
      return { text, params };
    }

    it('defaults to the bounded incremental verifier with a 30-slice rolling re-scan', async () => {
      delete process.env.AUDIT_CHAIN_VERIFY_MODE;
      delete process.env.AUDIT_CHAIN_VERIFY_RESCAN_SLICES;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-17T04:13:00Z'));

      mockOrgs(['org-1']);
      dbExecuteMock.mockResolvedValueOnce([]);

      await verifyAuditChains();

      const { text, params } = flatten(dbExecuteMock.mock.calls[1]![0]);
      expect(text).toMatch(/audit_log_verify_chain_incremental\(/);
      expect(text).not.toMatch(/audit_log_verify_chain\(/);
      expect(params).toEqual(['org-1', 30, Math.floor(Date.UTC(2026, 8, 17) / 86_400_000) % 30]);
    });

    it('advances one slice per UTC day and wraps at the slice count', () => {
      const day = (iso: string) => __testOnly.rescanSliceIndex(7, new Date(iso));
      expect(day('2026-02-28T04:13:00Z') + 1).toBe(day('2026-03-01T04:13:00Z') === 0 ? 7 : day('2026-03-01T04:13:00Z'));
      expect(day('2026-03-01T04:13:00Z')).toBe((day('2026-02-28T04:13:00Z') + 1) % 7);
      expect(__testOnly.rescanSlices()).toBe(30);
      expect(__testOnly.verifyMode()).toBe('incremental');
    });

    it('honours AUDIT_CHAIN_VERIFY_RESCAN_SLICES and wraps the slice index', async () => {
      process.env.AUDIT_CHAIN_VERIFY_RESCAN_SLICES = '7';
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-30T04:13:00Z'));

      mockOrgs(['org-1']);
      dbExecuteMock.mockResolvedValueOnce([]);

      await verifyAuditChains();

      const { params } = flatten(dbExecuteMock.mock.calls[1]![0]);
      expect(params).toEqual(['org-1', 7, Math.floor(Date.UTC(2026, 8, 30) / 86_400_000) % 7]);
    });

    it('AUDIT_CHAIN_VERIFY_MODE=full keeps the legacy whole-chain walk', async () => {
      process.env.AUDIT_CHAIN_VERIFY_MODE = 'full';

      mockOrgs(['org-1']);
      dbExecuteMock.mockResolvedValueOnce([]);

      await verifyAuditChains();

      const { text, params } = flatten(dbExecuteMock.mock.calls[1]![0]);
      expect(text).toMatch(/audit_log_verify_chain\(/);
      expect(text).not.toMatch(/audit_log_verify_chain_incremental/);
      expect(params).toEqual(['org-1']);
    });

    it('still raises an incident from an incremental break row', async () => {
      mockOrgs(['org-1']);
      dbExecuteMock.mockResolvedValueOnce([{ broken_id: 'row-x', expected: 'e', actual: 'a' }]);

      const stats = await verifyAuditChains();

      expect(stats.orgsBroken).toBe(1);
      expect(stats.alertsRaised).toBe(1);
      expect(dbInsertMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('worker processor', () => {
    it('runs the sweep for the scheduled job name', async () => {
      // Build the worker to capture its processor.
      const { createAuditChainVerifyWorker } = await import('./auditChainVerify');
      createAuditChainVerifyWorker();
      expect(capturedWorkerProcessor.current).toBeTypeOf('function');

      dbExecuteMock.mockResolvedValueOnce([{ id: 'org-1' }]); // enumeration
      dbExecuteMock.mockResolvedValueOnce([]); // org-1 clean

      const result = await capturedWorkerProcessor.current!({ name: 'audit-chain-verify' });
      expect((result as { orgsChecked: number }).orgsChecked).toBe(1);
    });

    // The kill switch must stop the SWEEP, not just the schedule. A job that
    // is already in Redis (queued, or active at the moment the container is
    // recreated — BullMQ hands a stalled job straight back to the next worker)
    // was re-run in full on US on 2026-09-03 with the flag set, 13 h of DB IO.
    it('does not consume the queue at all when disabled by env flag', async () => {
      process.env.AUDIT_CHAIN_VERIFY_ENABLED = 'false';
      const { initializeAuditChainVerifyWorker } = await import('./auditChainVerify');
      await initializeAuditChainVerifyWorker();
      expect(capturedWorkerProcessor.current).toBeNull();
      expect(workerCloseMock).not.toHaveBeenCalled();
    });

    it('skips a delivered job without touching the DB when disabled by env flag', async () => {
      const { createAuditChainVerifyWorker } = await import('./auditChainVerify');
      createAuditChainVerifyWorker();
      process.env.AUDIT_CHAIN_VERIFY_ENABLED = 'false';
      const result = await capturedWorkerProcessor.current!({ name: 'audit-chain-verify' });
      expect(result).toMatchObject({ skipped: true, orgsChecked: 0 });
      expect(dbExecuteMock).not.toHaveBeenCalled();
    });

    it('ignores unknown job names', async () => {
      const { createAuditChainVerifyWorker } = await import('./auditChainVerify');
      createAuditChainVerifyWorker();
      const result = await capturedWorkerProcessor.current!({ name: 'bogus' });
      expect((result as { skipped: boolean }).skipped).toBe(true);
      expect(dbExecuteMock).not.toHaveBeenCalled();
    });
  });
});
