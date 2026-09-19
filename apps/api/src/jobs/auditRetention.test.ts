/**
 * Unit tests for the audit-log retention worker (Task 29).
 *
 * Mirrors the oauthCleanup.test.ts mocking pattern — BullMQ + db are
 * stubbed so we can assert on schedule registration, processor
 * dispatch, and policy-loop control flow without a real Postgres.
 *
 * End-to-end DELETE behavior (the bypass role + session GUC + trigger
 * change) lives in
 * `__tests__/integration/audit-retention.integration.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  queueCloseMock,
  workerCloseMock,
  withSystemDbAccessContextMock,
  dbExecuteMock,
  capturedWorkerProcessor,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  dbExecuteMock: vi.fn(),
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
    db: {
      execute: (...args: unknown[]) => dbExecuteMock(...(args as [])),
    },
  };
});

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

import {
  __testOnly,
  createAuditRetentionWorker,
  initializeAuditRetentionWorker,
  pruneExpiredAuditLogs,
  scheduleAuditRetention,
  shutdownAuditRetentionWorker,
} from './auditRetention';

const ORIGINAL_FLAG = process.env.AUDIT_RETENTION_ENABLED;

/**
 * Bound parameter VALUES of a drizzle `sql` template, in order.
 *
 * This exists because `sqlText` below CANNOT SEE NUMBERS. Measured in this test
 * environment: `queryChunks` holds `StringChunk` objects (own `value: string[]`)
 * for literal SQL and raw primitives for bound params. `sqlText` returns a chunk
 * only when `typeof chunk === 'string'`, so string params are inlined verbatim
 * while NUMBER params map to ''. A statement binding `LIMIT ${maxBatches}`
 * instead of `LIMIT ${batchSize}` therefore flattens BYTE-IDENTICALLY, and no
 * text assertion can tell them apart. Assert through here when the value matters.
 */
function sqlParams(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) return [];
  // Anything that is not a StringChunk (own array-valued `.value`) is a param.
  return chunks.filter((chunk) => !Array.isArray((chunk as { value?: unknown } | null)?.value));
}

/**
 * Flatten a drizzle `sql` template to its literal SQL text.
 *
 * Caveat: NUMBER params vanish and STRING params are inlined verbatim (see
 * `sqlParams`), so `classify` matches against text containing fixture values
 * like `org-a`. Keep fixture strings free of SQL keywords.
 */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: Array<{ value?: unknown } | string> }).queryChunks;
  if (!Array.isArray(chunks)) return String(query);
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk;
      const value = (chunk as { value?: unknown }).value;
      return Array.isArray(value) ? (value as string[]).join('') : '';
    })
    .join(' ');
}

const executedSql = (): string[] => dbExecuteMock.mock.calls.map((call: unknown[]) => sqlText(call[0]));

type StatementKind = 'policySelect' | 'setRole' | 'setGuc' | 'cutoff' | 'prefixDelete' | 'unsealedSweep' | 'policyUpdate' | 'other';

function classify(text: string): StatementKind {
  if (/SELECT id, org_id, retention_days/.test(text)) return 'policySelect';
  if (/SET LOCAL ROLE/.test(text)) return 'setRole';
  if (/SET LOCAL breeze\.allow_audit_retention/.test(text)) return 'setGuc';
  if (/AS cutoff_seq/.test(text)) return 'cutoff';
  if (/UPDATE audit_retention_policies/.test(text)) return 'policyUpdate';
  if (/NOT EXISTS \(SELECT 1 FROM audit_log_chain/.test(text)) return 'unsealedSweep';
  if (/DELETE FROM audit_logs/.test(text)) return 'prefixDelete';
  return 'other';
}

const executedKinds = (): StatementKind[] => executedSql().map(classify);

/**
 * Route the shared `db.execute` mock by statement kind instead of by call
 * ordinal. Ordinal mocking cannot express the batch loops (their call count is
 * data-dependent), and a miscount would silently shift every later expectation.
 *
 * BATCH SCRIPT SEMANTICS: `prefixBatches`/`unsealedBatches` are consumed one per
 * call, and the LAST element is STICKY — it repeats forever. That is deliberate:
 * `[10]` with a ceiling models "always a full batch" for the backlog tests. The
 * corollary is that a script whose last element is >= batchSize never ends the
 * loop naturally, so end it with a short batch when you mean "then it drained".
 */
function mockByStatement(handlers: {
  policies?: Array<{ id: string; org_id: string; retention_days: number }>;
  cutoffSeq?: string | null;
  prefixBatches?: number[];
  unsealedBatches?: number[];
}) {
  const prefix = [...(handlers.prefixBatches ?? [0])];
  const unsealed = [...(handlers.unsealedBatches ?? [0])];
  dbExecuteMock.mockImplementation(async (query: unknown) => {
    switch (classify(sqlText(query))) {
      case 'policySelect':
        return handlers.policies ?? [];
      case 'cutoff':
        return 'cutoffSeq' in handlers ? [{ cutoff_seq: handlers.cutoffSeq }] : [{ cutoff_seq: '1000' }];
      case 'prefixDelete':
        return { count: prefix.length > 1 ? prefix.shift()! : (prefix[0] ?? 0) };
      case 'unsealedSweep':
        return { count: unsealed.length > 1 ? unsealed.shift()! : (unsealed[0] ?? 0) };
      default:
        return [];
    }
  });
}

describe('auditRetention worker', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    getRepeatableJobsMock.mockResolvedValue([]);
    addMock.mockResolvedValue(undefined);
    removeRepeatableByKeyMock.mockResolvedValue(undefined);
    queueCloseMock.mockResolvedValue(undefined);
    workerCloseMock.mockResolvedValue(undefined);
    dbExecuteMock.mockResolvedValue([]);
    capturedWorkerProcessor.current = null;
    delete process.env.AUDIT_RETENTION_ENABLED;
  });

  afterEach(async () => {
    await shutdownAuditRetentionWorker();
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.AUDIT_RETENTION_ENABLED;
    } else {
      process.env.AUDIT_RETENTION_ENABLED = ORIGINAL_FLAG;
    }
  });

  it('exposes the daily cron pattern at 03:30 UTC', () => {
    expect(__testOnly.DAILY_CRON).toBe('28 3 * * *');
    expect(__testOnly.JOB_NAME).toBe('audit-log-retention');
    expect(__testOnly.REPEAT_JOB_ID).toBe('audit-log-retention');
  });

  it('isRetentionEnabled defaults ON and accepts standard falsy values', () => {
    delete process.env.AUDIT_RETENTION_ENABLED;
    expect(__testOnly.isRetentionEnabled()).toBe(true);
    process.env.AUDIT_RETENTION_ENABLED = 'false';
    expect(__testOnly.isRetentionEnabled()).toBe(false);
    process.env.AUDIT_RETENTION_ENABLED = '0';
    expect(__testOnly.isRetentionEnabled()).toBe(false);
    process.env.AUDIT_RETENTION_ENABLED = 'off';
    expect(__testOnly.isRetentionEnabled()).toBe(false);
    process.env.AUDIT_RETENTION_ENABLED = 'true';
    expect(__testOnly.isRetentionEnabled()).toBe(true);
  });

  it('scheduleAuditRetention registers the daily cron with a stable jobId for multi-replica dedup', async () => {
    await scheduleAuditRetention();
    expect(addMock).toHaveBeenCalledTimes(1);
    const [name, data, opts] = addMock.mock.calls[0]!;
    expect(name).toBe('audit-log-retention');
    expect(data).toEqual({});
    expect(opts).toMatchObject({
      jobId: 'audit-log-retention',
      repeat: { pattern: '28 3 * * *' },
    });
  });

  it('scheduleAuditRetention removes prior repeatable jobs before adding a fresh one', async () => {
    getRepeatableJobsMock.mockResolvedValue([
      { name: 'audit-log-retention', key: 'old-key' },
      { name: 'unrelated-job', key: 'other-key' },
    ]);
    await scheduleAuditRetention();
    expect(removeRepeatableByKeyMock).toHaveBeenCalledTimes(1);
    expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('old-key');
    expect(addMock).toHaveBeenCalledTimes(1);
  });

  it('scheduleAuditRetention skips registration when AUDIT_RETENTION_ENABLED is false', async () => {
    process.env.AUDIT_RETENTION_ENABLED = 'false';
    await scheduleAuditRetention();
    expect(addMock).not.toHaveBeenCalled();
  });

  it('worker processor delegates to pruneExpiredAuditLogs for the right job name', async () => {
    dbExecuteMock.mockResolvedValueOnce([]); // empty policy list
    createAuditRetentionWorker();
    expect(capturedWorkerProcessor.current).toBeTypeOf('function');
    const result = (await capturedWorkerProcessor.current!({
      name: 'audit-log-retention',
      id: 'j1',
    })) as { policies: number; rowsDeleted: number };
    expect(result.policies).toBe(0);
    expect(result.rowsDeleted).toBe(0);
  });

  it('worker processor ignores unknown job names', async () => {
    createAuditRetentionWorker();
    const result = (await capturedWorkerProcessor.current!({
      name: 'something-else',
      id: 'j2',
    })) as { skipped: boolean };
    expect(result.skipped).toBe(true);
    expect(dbExecuteMock).not.toHaveBeenCalled();
  });

  describe('pruneExpiredAuditLogs', () => {
    it('returns zero-stats when no policies exist', async () => {
      dbExecuteMock.mockResolvedValueOnce([]);
      const stats = await pruneExpiredAuditLogs();
      expect(stats.policies).toBe(0);
      expect(stats.orgsPruned).toBe(0);
      expect(stats.rowsDeleted).toBe(0);
      expect(stats.errors).toBe(0);
    });

    it('issues SET LOCAL ROLE + SET LOCAL GUC before the cutoff read and both DELETEs, with no UPDATE of the audit tables', async () => {
      mockByStatement({
        policies: [{ id: 'p1', org_id: 'org-a', retention_days: 30 }],
        cutoffSeq: '1000',
        prefixBatches: [5],
        unsealedBatches: [0],
      });

      const stats = await pruneExpiredAuditLogs();
      expect(stats.policies).toBe(1);
      expect(stats.orgsPruned).toBe(1);
      expect(stats.rowsDeleted).toBe(5);
      expect(stats.errors).toBe(0);

      // Both bypass layers must be armed BEFORE anything touches audit_logs.
      expect(executedKinds()).toEqual([
        'policySelect',
        'setRole',
        'setGuc',
        'cutoff',
        'prefixDelete',
        'unsealedSweep',
        'policyUpdate',
      ]);

      const texts = executedSql();
      expect(texts[4]).toMatch(/SELECT c\.audit_id/);
      expect(texts[4]).toMatch(/FROM audit_log_chain c/);
      // The deferred-sealing design (issue #1002) never re-anchors: retention
      // must issue NO UPDATE of audit_logs or audit_log_chain — the only
      // UPDATE in the whole pass is the last_cleanup_at bookkeeping.
      const updates = texts.filter((t) => /UPDATE/i.test(t));
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatch(/UPDATE audit_retention_policies/);
    });

    it('never issues an UPDATE even when no rows were deleted (no re-anchor exists)', async () => {
      mockByStatement({
        policies: [{ id: 'p1', org_id: 'org-a', retention_days: 30 }],
        cutoffSeq: '1000',
        prefixBatches: [0],
      });

      const stats = await pruneExpiredAuditLogs();
      expect(stats.rowsDeleted).toBe(0);
      // Design guarantee (issue #1002): retention never UPDATEs audit_logs or
      // audit_log_chain — verify treats the first surviving entry's prev as
      // the trusted anchor, so no re-anchor rewrite is ever issued.
      expect(
        executedSql().some((t) => /UPDATE audit_logs|UPDATE audit_log_chain|prev_checksum/.test(t)),
      ).toBe(false);
    });

    // Issue #4239: the cutoff arm must never be a MIN() over the full
    // audit_log_chain ⋈ audit_logs join. MIN has to consume the whole join
    // before it can answer and the arm cannot constrain a2.org_id, which is
    // what made the planner pick a Seq Scan of audit_logs per policy.
    it('computes the prefix bound with an ordered early-stop, not MIN() over the full join', async () => {
      mockByStatement({
        policies: [{ id: 'p1', org_id: 'org-a', retention_days: 30 }],
        cutoffSeq: '1000',
      });

      await pruneExpiredAuditLogs();

      const cutoff = executedSql().find((t) => /AS cutoff_seq/.test(t));
      expect(cutoff).toBeDefined();
      expect(cutoff).toMatch(/ORDER BY c2\.chain_seq\s+LIMIT 1/);
      // The regression itself: no MIN() aggregate anywhere in the cutoff read.
      expect(cutoff).not.toMatch(/MIN\s*\(/i);
      // The all-old fallback (MAX+1) stays. Expected to plan as an index scan on
      // (org_id, chain_seq DESC), though this test asserts only the SQL shape —
      // no plan is verified here.
      expect(cutoff).toMatch(/MAX\(c3\.chain_seq\) \+ 1/);
      // Hoisted out of the DELETE so the bound is computed once per policy
      // rather than re-planned inside every batch.
      const prefixDelete = executedSql().find((t) => classify(t) === 'prefixDelete');
      expect(prefixDelete).not.toMatch(/AS cutoff_seq|MAX\(c3/);
    });

    // Issue #4239 + #1002 together: batching is only safe because each batch
    // takes the LOWEST remaining chain_seq values. Drop the ORDER BY and a
    // maxBatches stop would leave holes mid-chain — a permanent linkage break.
    it('deletes the prefix in ordered, LIMIT-bounded batches', async () => {
      mockByStatement({
        policies: [{ id: 'p1', org_id: 'org-a', retention_days: 30 }],
        cutoffSeq: '1000',
      });

      await pruneExpiredAuditLogs();

      const prefixDelete = executedSql().find((t) => classify(t) === 'prefixDelete');
      expect(prefixDelete).toBeDefined();
      expect(prefixDelete).toMatch(/ORDER BY c\.chain_seq\s+LIMIT/);
      // Trailing space matters: `/c\.chain_seq </` also matches `<=`, which
      // would delete the first YOUNG row and break the prefix invariant.
      expect(prefixDelete).toMatch(/c\.chain_seq < /);

      const sweep = executedSql().find((t) => classify(t) === 'unsealedSweep');
      expect(sweep).toMatch(/LIMIT/);
    });

    // The LIMIT bound is a NUMBER param, so it is invisible to the flattened
    // SQL text — a statement binding `LIMIT ${maxBatches}` reads identically.
    // Without this control, that mutant survives the whole suite and ships a job
    // that deletes `maxBatches` rows per batch while the short-batch check still
    // compares against `batchSize`, terminating after ONE batch and reporting
    // success. Assert the bound VALUE, not the text.
    it('binds the batch LIMIT to batchSize (not maxBatches) in both DELETEs', async () => {
      mockByStatement({
        policies: [{ id: 'p1', org_id: 'org-a', retention_days: 30 }],
        cutoffSeq: '1000',
      });

      await pruneExpiredAuditLogs({ batchSize: 37, maxBatches: 9 });

      const call = (kind: StatementKind) =>
        dbExecuteMock.mock.calls.find((c: unknown[]) => classify(sqlText(c[0])) === kind)?.[0];

      const prefixParams = sqlParams(call('prefixDelete'));
      expect(prefixParams).toContain(37);
      expect(prefixParams).not.toContain(9);

      const sweepParams = sqlParams(call('unsealedSweep'));
      expect(sweepParams).toContain(37);
      expect(sweepParams).not.toContain(9);
    });

    it('keeps issuing prefix batches until one comes back short of the limit', async () => {
      mockByStatement({
        policies: [{ id: 'p1', org_id: 'org-a', retention_days: 30 }],
        cutoffSeq: '1000',
        prefixBatches: [10, 10, 3],
      });

      const stats = await pruneExpiredAuditLogs({ batchSize: 10, maxBatches: 50 });

      expect(stats.rowsDeleted).toBe(23);
      expect(executedKinds().filter((k) => k === 'prefixDelete')).toHaveLength(3);
      // A short batch ends the loop — no wasted round-trip after it.
      expect(stats.orgsWithBacklog).toBe(0);
      expect(stats.batches).toBe(4); // 3 prefix + 1 sweep
    });

    it('stops at the maxBatches ceiling and reports the org as still backlogged', async () => {
      mockByStatement({
        policies: [{ id: 'p1', org_id: 'org-a', retention_days: 30 }],
        cutoffSeq: '1000',
        prefixBatches: [10],
      });

      const stats = await pruneExpiredAuditLogs({ batchSize: 10, maxBatches: 2 });

      // Ceiling honoured — not a runaway loop.
      expect(executedKinds().filter((k) => k === 'prefixDelete')).toHaveLength(2);
      expect(stats.rowsDeleted).toBe(20);
      // Full batches were still coming back when the ceiling hit, so rows remain.
      expect(stats.orgsWithBacklog).toBe(1);
      // Still counted as pruned — the pass succeeded, it just did not finish.
      expect(stats.orgsPruned).toBe(1);
      expect(stats.errors).toBe(0);
    });

    it('skips the prefix DELETE entirely when the org has no chain rows, but still sweeps', async () => {
      mockByStatement({
        policies: [{ id: 'p1', org_id: 'org-a', retention_days: 30 }],
        cutoffSeq: null,
      });

      const stats = await pruneExpiredAuditLogs();

      expect(executedKinds()).toEqual([
        'policySelect',
        'setRole',
        'setGuc',
        'cutoff',
        'unsealedSweep',
        'policyUpdate',
      ]);
      expect(stats.rowsDeleted).toBe(0);
      expect(stats.errors).toBe(0);
    });

    // A broken driver/adapter must not look like "this org has nothing to
    // prune". Collapsing the two would silently skip the prefix DELETE and
    // retain expired audit rows past policy while reporting success.
    it('raises instead of silently skipping the prefix DELETE when the cutoff read comes back empty', async () => {
      dbExecuteMock.mockImplementation(async (query: unknown) => {
        switch (classify(sqlText(query))) {
          case 'policySelect':
            return [{ id: 'p1', org_id: 'org-a', retention_days: 30 }];
          case 'cutoff':
            return []; // impossible for a FROM-less SELECT — driver/mock is broken
          default:
            return [];
        }
      });

      const stats = await pruneExpiredAuditLogs();

      expect(stats.errors).toBe(1);
      expect(stats.orgsPruned).toBe(0);
      // The failure must abort this org's prune, not fall through to the DELETEs.
      expect(executedKinds()).not.toContain('prefixDelete');
      expect(executedKinds()).not.toContain('unsealedSweep');
    });

    it('raises when the cutoff row is present but the column is missing', async () => {
      dbExecuteMock.mockImplementation(async (query: unknown) => {
        switch (classify(sqlText(query))) {
          case 'policySelect':
            return [{ id: 'p1', org_id: 'org-a', retention_days: 30 }];
          case 'cutoff':
            return [{}]; // column renamed / adapter reshaped the row
          default:
            return [];
        }
      });

      const stats = await pruneExpiredAuditLogs();

      expect(stats.errors).toBe(1);
      expect(executedKinds()).not.toContain('prefixDelete');
    });

    // A DELETE always carries a driver row count. `extractRowCount` returns 0 for
    // an unrecognised shape, and a 0 ENDS the batch loop — so without this guard
    // a driver/adapter change silently retains expired rows and reports success.
    it('raises when a batch DELETE returns no driver row count', async () => {
      dbExecuteMock.mockImplementation(async (query: unknown) => {
        switch (classify(sqlText(query))) {
          case 'policySelect':
            return [{ id: 'p1', org_id: 'org-a', retention_days: 30 }];
          case 'cutoff':
            return [{ cutoff_seq: '1000' }];
          case 'prefixDelete':
            return { command: 'DELETE' }; // no rowCount, no count
          default:
            return [];
        }
      });

      const stats = await pruneExpiredAuditLogs();

      expect(stats.errors).toBe(1);
      expect(stats.orgsPruned).toBe(0);
      expect(stats.rowsDeleted).toBe(0);
    });

    it('flags an org backlogged on the unsealed sweep, not just on the prefix', async () => {
      mockByStatement({
        policies: [{ id: 'p1', org_id: 'org-a', retention_days: 30 }],
        cutoffSeq: '1000',
        prefixBatches: [0],
        unsealedBatches: [10],
      });

      const stats = await pruneExpiredAuditLogs({ batchSize: 10, maxBatches: 2 });

      expect(stats.unsealedRowsDeleted).toBe(20);
      expect(stats.orgsWithBacklog).toBe(1);
      expect(stats.backloggedOrgIds).toEqual(['org-a']);
    });

    it('accumulates stats across several succeeding policies', async () => {
      const policies = [
        { id: 'p1', org_id: 'org-a', retention_days: 30 },
        { id: 'p2', org_id: 'org-b', retention_days: 60 },
      ];
      dbExecuteMock.mockImplementation(async (query: unknown) => {
        switch (classify(sqlText(query))) {
          case 'policySelect':
            return policies;
          case 'cutoff':
            return [{ cutoff_seq: '1000' }];
          case 'prefixDelete':
            return { count: 5 }; // always full at batchSize 5 -> both backlog
          case 'unsealedSweep':
            return { count: 1 };
          default:
            return [];
        }
      });

      const stats = await pruneExpiredAuditLogs({ batchSize: 5, maxBatches: 2 });

      // Sums, not last-write-wins: 2 policies x 2 prefix batches x 5 rows.
      expect(stats.policies).toBe(2);
      expect(stats.orgsPruned).toBe(2);
      expect(stats.rowsDeleted).toBe(20);
      expect(stats.unsealedRowsDeleted).toBe(2);
      expect(stats.batches).toBe(6); // (2 prefix + 1 sweep) x 2 policies
      expect(stats.orgsWithBacklog).toBe(2);
      expect(stats.backloggedOrgIds).toEqual(['org-a', 'org-b']);
      expect(stats.errors).toBe(0);
    });

    it('counts a bookkeeping failure separately and does not call it a prune failure', async () => {
      dbExecuteMock.mockImplementation(async (query: unknown) => {
        switch (classify(sqlText(query))) {
          case 'policySelect':
            return [{ id: 'p1', org_id: 'org-a', retention_days: 30 }];
          case 'cutoff':
            return [{ cutoff_seq: '1000' }];
          case 'prefixDelete':
            return { count: 4 };
          case 'unsealedSweep':
            return { count: 0 };
          case 'policyUpdate':
            throw new Error('bookkeeping write failed');
          default:
            return [];
        }
      });

      const stats = await pruneExpiredAuditLogs();

      // The rows really were deleted — this must not read as a failed prune.
      expect(stats.rowsDeleted).toBe(4);
      expect(stats.orgsPruned).toBe(1);
      expect(stats.errors).toBe(0);
      expect(stats.bookkeepingErrors).toBe(1);
      // Invariant: an org is pruned or errored, never both.
      expect(stats.orgsPruned + stats.errors).toBe(stats.policies);
    });

    it('treats a NULL cutoff (org has no chain rows) as legitimate, not an error', async () => {
      mockByStatement({
        policies: [{ id: 'p1', org_id: 'org-a', retention_days: 30 }],
        cutoffSeq: null,
      });

      const stats = await pruneExpiredAuditLogs();

      expect(stats.errors).toBe(0);
      expect(stats.orgsPruned).toBe(1);
    });

    it('reports unsealed-sweep deletions separately instead of dropping them', async () => {
      mockByStatement({
        policies: [{ id: 'p1', org_id: 'org-a', retention_days: 30 }],
        cutoffSeq: '1000',
        prefixBatches: [2],
        unsealedBatches: [7],
      });

      const stats = await pruneExpiredAuditLogs({ batchSize: 100, maxBatches: 5 });

      expect(stats.rowsDeleted).toBe(2);
      expect(stats.unsealedRowsDeleted).toBe(7);
    });

    it('continues to the next policy when one fails', async () => {
      const policies = [
        { id: 'p1', org_id: 'org-a', retention_days: 30 },
        { id: 'p2', org_id: 'org-b', retention_days: 365 },
      ];
      let cutoffReads = 0;
      dbExecuteMock.mockImplementation(async (query: unknown) => {
        switch (classify(sqlText(query))) {
          case 'policySelect':
            return policies;
          case 'cutoff':
            // org-a's cutoff read blows up; org-b's succeeds.
            cutoffReads += 1;
            if (cutoffReads === 1) throw new Error('connection lost');
            return [{ cutoff_seq: '1000' }];
          case 'prefixDelete':
            return { count: 3 };
          case 'unsealedSweep':
            return { count: 0 };
          default:
            return [];
        }
      });

      const stats = await pruneExpiredAuditLogs();
      expect(stats.policies).toBe(2);
      expect(stats.orgsPruned).toBe(1); // only org-b succeeded
      expect(stats.rowsDeleted).toBe(3);
      expect(stats.errors).toBe(1);
    });

    it('records last_cleanup_at outside the role-switched transaction', async () => {
      mockByStatement({
        policies: [{ id: 'p1', org_id: 'org-a', retention_days: 30 }],
        cutoffSeq: '1000',
        prefixBatches: [0],
      });

      await pruneExpiredAuditLogs();

      // The retention-policy update must run in a separate
      // withSystemDbAccessContext call from the DELETE so it commits
      // independently. Mock invocations: 1 for policy SELECT, 1 for
      // role-switch+DELETE tx, 1 for UPDATE tx = 3 total.
      expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(3);
      expect(executedSql().at(-1)).toMatch(/UPDATE audit_retention_policies/);
    });
  });

  describe('batch limits', () => {
    it('defaults to the documented batch size and ceiling', () => {
      // Compared against the module's own declared defaults rather than bare
      // literals: BATCH_SIZE/MAX_BATCHES are read from env at import, so an
      // AUDIT_RETENTION_* var set in a CI or dev environment would otherwise red
      // this test for a reason unrelated to the code.
      const envOverridden =
        process.env.AUDIT_RETENTION_BATCH_SIZE || process.env.AUDIT_RETENTION_MAX_BATCHES;
      if (!envOverridden) {
        expect(__testOnly.BATCH_SIZE).toBe(__testOnly.DEFAULT_BATCH_SIZE);
        expect(__testOnly.MAX_BATCHES).toBe(__testOnly.DEFAULT_MAX_BATCHES);
      }
      expect(__testOnly.BATCH_SIZE).toBeGreaterThan(0);
      expect(__testOnly.MAX_BATCHES).toBeGreaterThan(0);
    });

    it('parsePositiveIntEnv rejects non-positive, unparsable and partially-parsable values', () => {
      const KEY = 'AUDIT_RETENTION_TEST_KNOB';
      const cases: Array<[string | undefined, number]> = [
        [undefined, 42],
        ['', 42],
        ['0', 42],
        ['-5', 42],
        ['banana', 42],
        // Number.parseInt truncates these; without whole-string validation
        // "1e9" silently becomes 1 — batches of a single row.
        ['1e9', 42],
        ['5,000', 42],
        ['5000x', 42],
        ['3.7', 42],
        ['250', 250],
        ['  250  ', 250],
      ];
      for (const [raw, expected] of cases) {
        if (raw === undefined) delete process.env[KEY];
        else process.env[KEY] = raw;
        expect(__testOnly.parsePositiveIntEnv(KEY, 42)).toBe(expected);
      }
      delete process.env[KEY];
    });

    // Job data is untrusted JSON off Redis. `Math.max(1, "abc")` is NaN, and
    // `batches < NaN` is false, so the old clamp issued ZERO deletes and still
    // reported orgsPruned:1, errors:0 — a silent no-op wearing a success.
    it('resolveLimit rejects non-integer job-data values instead of producing NaN', () => {
      expect(__testOnly.resolveLimit('batchSize', undefined, 5000)).toBe(5000);
      expect(__testOnly.resolveLimit('batchSize', Number.NaN, 5000)).toBe(5000);
      expect(__testOnly.resolveLimit('batchSize', 'abc' as unknown as number, 5000)).toBe(5000);
      expect(__testOnly.resolveLimit('batchSize', null as unknown as number, 5000)).toBe(5000);
      expect(__testOnly.resolveLimit('batchSize', 0, 5000)).toBe(5000);
      expect(__testOnly.resolveLimit('batchSize', -10, 5000)).toBe(5000);
      expect(__testOnly.resolveLimit('batchSize', 2.5, 5000)).toBe(5000);
      expect(__testOnly.resolveLimit('batchSize', Infinity, 5000)).toBe(5000);
      expect(__testOnly.resolveLimit('batchSize', 250, 5000)).toBe(250);
    });

    it('a non-numeric job-data limit still prunes, using the defaults', async () => {
      mockByStatement({
        policies: [{ id: 'p1', org_id: 'org-a', retention_days: 30 }],
        cutoffSeq: '1000',
        prefixBatches: [0],
      });

      const stats = await pruneExpiredAuditLogs({
        batchSize: 'abc' as unknown as number,
        maxBatches: Number.NaN,
      });

      // The regression: NaN limits used to issue no DELETE at all.
      expect(executedKinds().filter((k) => k === 'prefixDelete')).toHaveLength(1);
      expect(stats.errors).toBe(0);
      expect(stats.orgsPruned).toBe(1);
    });

    it('a zero limit falls back to the default rather than disabling pruning', async () => {
      mockByStatement({
        policies: [{ id: 'p1', org_id: 'org-a', retention_days: 30 }],
        cutoffSeq: '1000',
        prefixBatches: [0],
      });

      const stats = await pruneExpiredAuditLogs({ batchSize: 0, maxBatches: 0 });

      expect(executedKinds().filter((k) => k === 'prefixDelete')).toHaveLength(1);
      expect(stats.errors).toBe(0);
    });

    it('worker processor forwards batch overrides from the job payload', async () => {
      mockByStatement({
        policies: [{ id: 'p1', org_id: 'org-a', retention_days: 30 }],
        cutoffSeq: '1000',
      });
      createAuditRetentionWorker();

      await capturedWorkerProcessor.current!({
        name: 'audit-log-retention',
        id: 'j3',
        data: { batchSize: 1, maxBatches: 1 },
      });

      // maxBatches 1 must cap the prefix loop at exactly one statement.
      expect(executedKinds().filter((k) => k === 'prefixDelete')).toHaveLength(1);
      const prefixCall = dbExecuteMock.mock.calls.find(
        (c: unknown[]) => classify(sqlText(c[0])) === 'prefixDelete',
      )?.[0];
      expect(sqlParams(prefixCall)).toContain(1);
    });
  });

  it('initializeAuditRetentionWorker creates worker, schedules cron, and is idempotent on shutdown', async () => {
    await initializeAuditRetentionWorker();
    expect(addMock).toHaveBeenCalledTimes(1);
    await shutdownAuditRetentionWorker();
    expect(workerCloseMock).toHaveBeenCalled();
    expect(queueCloseMock).toHaveBeenCalled();
    // Second shutdown must not throw or double-close.
    await shutdownAuditRetentionWorker();
  });
});
