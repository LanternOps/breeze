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
    expect(__testOnly.DAILY_CRON).toBe('15 4 * * *');
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
      expect((opts.repeat as { pattern: string }).pattern).toBe('15 4 * * *');
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

    it('ignores unknown job names', async () => {
      const { createAuditChainVerifyWorker } = await import('./auditChainVerify');
      createAuditChainVerifyWorker();
      const result = await capturedWorkerProcessor.current!({ name: 'bogus' });
      expect((result as { skipped: boolean }).skipped).toBe(true);
      expect(dbExecuteMock).not.toHaveBeenCalled();
    });
  });
});
