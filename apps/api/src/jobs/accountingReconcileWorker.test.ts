import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The Phase-D QuickBooks CDC reconcile worker (Task 4 —
 * .superpowers/sdd/2026-09-02-quickbooks-phase-d-payment-pullback/task-4-brief.md).
 *
 * Mocking follows the neighbouring `accountingSyncWorker.test.ts` (bullmq,
 * redis, sentry and observability stubbed; the handler exported for direct
 * unit testing) plus the `ctx.depth` instrumentation from
 * `accountingPaymentPull.test.ts` / `accountingInvoicePush.test.ts`.
 *
 * `ctx.depth` counts OPEN DB ACCESS CONTEXTS — i.e. real transactions — and is
 * deliberately NOT reset by the `runOutsideDbContext` mock. That mirrors the
 * contract `dbContextGuard.ts` documents: `runOutsideDbContext` only re-routes
 * the AsyncLocalStorage lookup, it cannot commit or even suspend a transaction
 * the caller already opened, so a pooled connection held across a QuickBooks
 * round trip stays held (#1105). Modelling it as a passthrough is what makes
 * "no context is open at the provider call" a DISCRIMINATING assertion instead
 * of one the worker could satisfy by wrapping the whole job in a context and
 * then calling `runOutsideDbContext` around the HTTP call.
 */

const {
  ctx,
  record,
  queueAddMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  queueCloseMock,
  workerInstances,
  workerCloseMock,
  captureExceptionMock,
  attachWorkerObservabilityMock,
  runOutsideDbContextMock,
  withSystemDbAccessContextMock,
  getConnectionMock,
  listReconcilableConnectionsMock,
  advanceReconcileCursorMock,
  stampReconcileRunErrorMock,
  backfillRealmFingerprintsMock,
  resolveConnectionAndTokenMock,
  reconcileChangesMock,
  getAccountingProviderMock,
  applyMock,
  reverseMock,
  reverseStaleMock,
  markInvoiceDeletedMock,
} = vi.hoisted(() => {
  const ctx = { depth: 0, order: [] as string[], depths: [] as number[] };
  const record = (name: string) => {
    ctx.order.push(name);
    ctx.depths.push(ctx.depth);
  };
  return {
    ctx,
    record,
    queueAddMock: vi.fn(),
    getRepeatableJobsMock: vi.fn(),
    removeRepeatableByKeyMock: vi.fn(),
    queueCloseMock: vi.fn(async () => {}),
    workerInstances: [] as Array<{ queueName: string; opts: Record<string, unknown> }>,
    workerCloseMock: vi.fn(async () => {}),
    captureExceptionMock: vi.fn(),
    attachWorkerObservabilityMock: vi.fn(),
    // Passthrough on purpose — see the header. It does NOT decrement depth.
    runOutsideDbContextMock: vi.fn(async (fn: () => unknown) => fn()),
    withSystemDbAccessContextMock: vi.fn(async (fn: () => unknown) => {
      ctx.depth++;
      try {
        return await fn();
      } finally {
        ctx.depth--;
      }
    }),
    getConnectionMock: vi.fn(),
    listReconcilableConnectionsMock: vi.fn(),
    advanceReconcileCursorMock: vi.fn(),
    stampReconcileRunErrorMock: vi.fn(),
    backfillRealmFingerprintsMock: vi.fn(),
    resolveConnectionAndTokenMock: vi.fn(),
    reconcileChangesMock: vi.fn(),
    getAccountingProviderMock: vi.fn(),
    applyMock: vi.fn(),
    reverseMock: vi.fn(),
    reverseStaleMock: vi.fn(),
    markInvoiceDeletedMock: vi.fn(),
  };
});

vi.mock('bullmq', () => ({
  Queue: class {
    add = queueAddMock;
    getRepeatableJobs = getRepeatableJobsMock;
    removeRepeatableByKey = removeRepeatableByKeyMock;
    close = queueCloseMock;
  },
  Worker: class {
    on = vi.fn();
    close = workerCloseMock;
    constructor(queueName: string, _processor: unknown, opts: Record<string, unknown>) {
      workerInstances.push({ queueName, opts });
    }
  },
  Job: class {},
}));

vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: captureExceptionMock }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: attachWorkerObservabilityMock }));

vi.mock('../db', () => ({
  db: {},
  hasDbAccessContext: () => ctx.depth > 0,
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

vi.mock('../services/accounting/accountingConnectionService', () => ({
  getConnection: getConnectionMock,
  listReconcilableConnections: listReconcilableConnectionsMock,
  advanceReconcileCursor: advanceReconcileCursorMock,
  stampReconcileRunError: stampReconcileRunErrorMock,
  backfillRealmFingerprints: backfillRealmFingerprintsMock,
}));

vi.mock('../services/accounting/accountingMappingService', () => ({
  resolveConnectionAndToken: resolveConnectionAndTokenMock,
}));

vi.mock('../services/accounting/providerRegistry', () => ({
  getAccountingProvider: getAccountingProviderMock,
}));

vi.mock('../services/accounting/accountingPaymentPull', () => ({
  applyAccountingPayment: applyMock,
  reverseAccountingPayment: reverseMock,
  reverseStaleAllocations: reverseStaleMock,
  markInvoiceDeletedRemotely: markInvoiceDeletedMock,
}));

import type { AccountingConnection } from '../services/accounting/accountingConnectionService';
import type { PaymentPullOutcome, PaymentPullResult } from '../services/accounting/accountingPaymentPull';
import type { ChangeSet, ChangeSetPaymentLine } from '../services/accounting/types';
import {
  ACCOUNTING_RECONCILE_QUEUE,
  RECONCILE_SWEEP_INTERVAL_MS,
  enqueueAccountingReconcile,
  initializeAccountingReconcileWorkers,
  processReconcileConnectionJob,
  processReconcileSweep,
  shutdownAccountingReconcileWorkers,
  type ReconcileConnectionJobData,
} from './accountingReconcileWorker';

const PARTNER_ID = '22222222-2222-2222-2222-222222222222';
const CONN_ID = 'c1';
const CURSOR_BEFORE = new Date('2026-09-02T19:55:00.000Z');

const EMPTY_CHANGESET: ChangeSet = {
  cursor: new Date('2026-09-02T20:10:00.000Z'),
  payments: [],
  deletedPayments: [],
  deletedInvoices: [],
  overflowed: false,
};

function line(overrides: Partial<ChangeSetPaymentLine> = {}): ChangeSetPaymentLine {
  return {
    remoteInvoiceId: '145',
    remotePaymentId: '180',
    amountMinor: 12_500,
    currency: 'USD',
    txnDate: '2026-09-02',
    remotePaymentSyncToken: '0',
    paymentMethodName: 'Check',
    paymentRefNum: '4471',
    ...overrides,
  };
}

function connectionRow(overrides: Partial<AccountingConnection> = {}): AccountingConnection {
  return {
    id: CONN_ID,
    partnerId: PARTNER_ID,
    provider: 'quickbooks',
    status: 'connected',
    pullPayments: true,
    cdcCursor: CURSOR_BEFORE,
    lastReconcileAt: null,
    realmIdFingerprint: 'fp1:legacy:abc',
    ...overrides,
  } as unknown as AccountingConnection;
}

let repeatables: Array<{ name: string; key: string }> = [];

const JOB: ReconcileConnectionJobData = {
  type: 'reconcile-connection',
  connectionId: CONN_ID,
  partnerId: PARTNER_ID,
  trigger: 'sweep',
};

function result(outcome: PaymentPullOutcome, remotePaymentId = '180'): PaymentPullResult {
  return { outcome, remotePaymentId, remoteInvoiceId: '145', invoiceId: null, invoicePaymentId: null };
}

/**
 * Every applier/DB mock records its own name AND the ambient context depth at
 * call time into the same two parallel arrays, so ordering and the
 * "no context held" contract are asserted against one real trace.
 */
const APPLIER_NAMES = ['markInvoiceDeletedRemotely', 'reverseAccountingPayment', 'applyAccountingPayment', 'reverseStaleAllocations'];

/** Depth recorded at each call of `name`. */
function depthsOf(name: string): number[] {
  return ctx.order.flatMap((n, i) => (n === name ? [ctx.depths[i]!] : []));
}

/** The trace with the DB-side entries filtered out — just the applier sequence. */
function applierOrder(): string[] {
  return ctx.order.filter((n) => APPLIER_NAMES.includes(n));
}

/** Applier mock returning `outcomes` in order (the last repeats). */
function applyReturns(...outcomes: PaymentPullOutcome[]): void {
  let i = 0;
  applyMock.mockImplementation(async () => {
    record('applyAccountingPayment');
    return result(outcomes[Math.min(i++, outcomes.length - 1)] ?? 'applied');
  });
}

function reverseReturns(...outcomes: PaymentPullOutcome[]): void {
  reverseMock.mockImplementation(async (_conn: unknown, remotePaymentId: string) => {
    record('reverseAccountingPayment');
    return outcomes.map((o) => result(o, remotePaymentId));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ctx.depth = 0;
  ctx.order.length = 0;
  ctx.depths.length = 0;
  workerInstances.length = 0;

  repeatables = [];

  queueAddMock.mockImplementation(async () => {
    record('queue.add');
    return { id: 'job-1' };
  });
  getRepeatableJobsMock.mockImplementation(async () => {
    record('queue.getRepeatableJobs');
    return repeatables;
  });
  removeRepeatableByKeyMock.mockImplementation(async () => {
    record('queue.removeRepeatableByKey');
  });
  advanceReconcileCursorMock.mockImplementation(async () => {
    record('advanceReconcileCursor');
    return true;
  });
  stampReconcileRunErrorMock.mockImplementation(async () => {
    record('stampReconcileRunError');
  });
  backfillRealmFingerprintsMock.mockImplementation(async () => {
    record('backfillRealmFingerprints');
    return { scanned: 3, updated: 2, skipped: 1 };
  });

  getConnectionMock.mockResolvedValue(connectionRow());
  resolveConnectionAndTokenMock.mockImplementation(async () => ({
    conn: connectionRow(),
    liveConn: { ...connectionRow(), accessToken: 'tok' },
  }));
  reconcileChangesMock.mockResolvedValue(EMPTY_CHANGESET);
  getAccountingProviderMock.mockReturnValue({ reconcileChanges: reconcileChangesMock });
  markInvoiceDeletedMock.mockImplementation(async () => {
    record('markInvoiceDeletedRemotely');
    return 'marked';
  });
  reverseStaleMock.mockImplementation(async () => {
    record('reverseStaleAllocations');
    return [];
  });
  reverseReturns();
  applyReturns('applied');
});

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

describe('processReconcileConnectionJob: gating', () => {
  // Issue #4543: all four short-circuits used to collapse into one silent
  // `return null` — indistinguishable from the outside. Each must now log a
  // structured `reason=` line, and `logSpy` asserts on the exact call shape
  // so a future short-circuit that forgets to log fails these tests.
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('returns null, logs reason=missing, and never calls the provider when there is no QuickBooks connection', async () => {
    getConnectionMock.mockResolvedValue(null);

    await expect(processReconcileConnectionJob(JOB)).resolves.toBeNull();

    expect(reconcileChangesMock).not.toHaveBeenCalled();
    expect(advanceReconcileCursorMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('run skipped'),
      'reason=missing',
      `connectionId=${CONN_ID}`,
      `partnerId=${PARTNER_ID}`,
      'trigger=sweep',
    );
    // No live connection row to stamp.
    expect(stampReconcileRunErrorMock).not.toHaveBeenCalled();
  });

  it('returns null, logs reason=not_connected, and never calls the provider when the connection is not status=connected', async () => {
    getConnectionMock.mockResolvedValue(connectionRow({ status: 'reauth_required' }));

    await expect(processReconcileConnectionJob(JOB)).resolves.toBeNull();

    expect(reconcileChangesMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('run skipped'),
      'reason=not_connected',
      `connectionId=${CONN_ID}`,
      `partnerId=${PARTNER_ID}`,
      'trigger=sweep',
    );
    // `status` already surfaces this on the existing status route — no
    // separate last_error stamp needed.
    expect(stampReconcileRunErrorMock).not.toHaveBeenCalled();
  });

  it('returns null, logs reason=pull_disabled, stamps the connection, and never resolves a token when pull_payments is off', async () => {
    getConnectionMock.mockResolvedValue(connectionRow({ pullPayments: false }));

    await expect(processReconcileConnectionJob(JOB)).resolves.toBeNull();

    expect(reconcileChangesMock).not.toHaveBeenCalled();
    // No token refresh for a switched-off connection: the refresh itself is a
    // QuickBooks round trip and a write, and doing it here would keep a
    // disabled connection's tokens alive forever.
    expect(resolveConnectionAndTokenMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('run skipped'),
      'reason=pull_disabled',
      `connectionId=${CONN_ID}`,
      `partnerId=${PARTNER_ID}`,
      'trigger=sweep',
    );
    // The one reason with no other visible signal: stamp it on last_error
    // (finding-H mechanism) so the sync-status surface shows it too.
    expect(stampReconcileRunErrorMock).toHaveBeenCalledWith(
      // The mock captures the RAW message — `stampReconcileRunError`'s own
      // `RECONCILE_RUN_ERROR_PREFIX` ("Payment pull: ") is applied inside the
      // (mocked-out) real function, not visible here.
      {}, CONN_ID, PARTNER_ID, expect.stringMatching(/disabled/i),
    );
  });

  it('returns null, logs reason=connection_mismatch, and never calls the provider when the resolved connection is not the one the job names', async () => {
    getConnectionMock.mockResolvedValue(connectionRow({ id: 'some-other-connection' }));

    await expect(processReconcileConnectionJob(JOB)).resolves.toBeNull();

    expect(reconcileChangesMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('run skipped'),
      'reason=connection_mismatch',
      `connectionId=${CONN_ID}`,
      `partnerId=${PARTNER_ID}`,
      'trigger=sweep',
      // The live connection that superseded the job's stale target — lets a
      // debugger correlate without a separate query (review finding).
      'liveConnectionId=some-other-connection',
    );
    // The live connection is a DIFFERENT row than this stale job named —
    // nothing to safely stamp.
    expect(stampReconcileRunErrorMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DB context contract
// ---------------------------------------------------------------------------

describe('processReconcileConnectionJob: DB context contract', () => {
  it('holds NO db access context across the QuickBooks CDC call', async () => {
    let depthAtProviderCall = -1;
    reconcileChangesMock.mockImplementationOnce(async () => {
      depthAtProviderCall = ctx.depth;
      return EMPTY_CHANGESET;
    });

    await processReconcileConnectionJob(JOB);

    expect(depthAtProviderCall).toBe(0);
    expect(ctx.depth).toBe(0);
  });

  it('runs the whole job outside any ambient context and labels its system contexts', async () => {
    await processReconcileConnectionJob(JOB);

    expect(runOutsideDbContextMock).toHaveBeenCalled();
    expect(withSystemDbAccessContextMock).toHaveBeenCalledWith(expect.any(Function), 'accountingReconcile.sweep');
  });

  it('calls every applier with no ambient context open, and the cursor write inside one', async () => {
    reconcileChangesMock.mockResolvedValue({
      ...EMPTY_CHANGESET,
      payments: [line()],
      deletedPayments: ['181'],
      deletedInvoices: ['145'],
    });
    reverseReturns('reversed');

    await processReconcileConnectionJob(JOB);

    for (const name of APPLIER_NAMES) {
      expect(depthsOf(name), `${name} must be entered with no ambient context`).toEqual([0]);
    }
    // The sync-state write is the one thing that DOES need its own short
    // context — it is a real transaction that must commit on its own.
    expect(depthsOf('advanceReconcileCursor')).toEqual([1]);
  });

  it('hands the appliers a runner that really opens a system context', async () => {
    reconcileChangesMock.mockResolvedValue({ ...EMPTY_CHANGESET, payments: [line()] });

    await processReconcileConnectionJob(JOB);

    const runner = applyMock.mock.calls[0]![2] as <T>(fn: () => Promise<T>) => Promise<T>;
    withSystemDbAccessContextMock.mockClear();
    let depthInside = -1;
    await runner(async () => {
      depthInside = ctx.depth;
    });
    expect(depthInside).toBe(1);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledWith(expect.any(Function), 'accountingReconcile.sweep');
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('processReconcileConnectionJob: ordering', () => {
  it('applies deletions BEFORE additions within one CDC window', async () => {
    reconcileChangesMock.mockResolvedValue({
      ...EMPTY_CHANGESET,
      payments: [line()],
      deletedPayments: ['181'],
      deletedInvoices: ['145'],
    });
    reverseReturns('reversed');

    await processReconcileConnectionJob(JOB);

    expect(applierOrder()).toEqual([
      'markInvoiceDeletedRemotely',
      'reverseAccountingPayment',
      'applyAccountingPayment',
      // Per-payment stale-allocation sweep (finding B) closes each payment.
      'reverseStaleAllocations',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Cursor advance
// ---------------------------------------------------------------------------

describe('processReconcileConnectionJob: cursor', () => {
  it('advances the cursor once on a clean run and reports it in the summary', async () => {
    const changes: ChangeSet = {
      ...EMPTY_CHANGESET,
      payments: [line({ remotePaymentId: '180' }), line({ remotePaymentId: '181' }), line({ remotePaymentId: '182' }), line({ remotePaymentId: '183' }), line({ remotePaymentId: '184' })],
    };
    reconcileChangesMock.mockResolvedValue(changes);
    // Every clean outcome, including the two "recorded permanent" ones and
    // invoice_void, which Task 3 added after the brief was written.
    applyReturns('applied', 'replayed', 'skipped_unmapped', 'currency_mismatch', 'invoice_void');

    const summary = await processReconcileConnectionJob(JOB);

    expect(advanceReconcileCursorMock).toHaveBeenCalledTimes(1);
    expect(advanceReconcileCursorMock).toHaveBeenCalledWith(
      {}, CONN_ID, PARTNER_ID, 'fp1:legacy:abc', changes.cursor, expect.any(Date),
    );
    expect(summary).toEqual({
      applied: 1,
      updated: 0,
      replayed: 1,
      reversed: 0,
      skippedUnmapped: 1,
      currencyMismatch: 1,
      invoiceVoid: 1,
      realmChanged: 0,
      failed: 0,
      invoicesMarkedDeleted: 0,
      cursorBefore: CURSOR_BEFORE,
      cursorAfter: changes.cursor,
    });
  });

  it('counts an invoice marked deleted and a reversal in the summary', async () => {
    reconcileChangesMock.mockResolvedValue({
      ...EMPTY_CHANGESET,
      deletedPayments: ['181'],
      deletedInvoices: ['145', '146'],
    });
    markInvoiceDeletedMock
      .mockImplementationOnce(async () => 'marked')
      .mockImplementationOnce(async () => 'skipped_unmapped');
    reverseReturns('reversed', 'reversed');

    const summary = await processReconcileConnectionJob(JOB);

    expect(summary?.invoicesMarkedDeleted).toBe(1);
    expect(summary?.reversed).toBe(2);
    expect(advanceReconcileCursorMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT advance the cursor and rethrows when an applier throws', async () => {
    reconcileChangesMock.mockResolvedValue({ ...EMPTY_CHANGESET, payments: [line()] });
    applyMock.mockRejectedValue(new Error('boom'));

    await expect(processReconcileConnectionJob(JOB)).rejects.toThrow(/failed item/);

    expect(advanceReconcileCursorMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      { service: 'accountingPaymentPull', connectionId: CONN_ID, remotePaymentId: '180' },
    );
  });

  it('treats a reversal that REPORTS failed the same as a thrown apply', async () => {
    reconcileChangesMock.mockResolvedValue({ ...EMPTY_CHANGESET, deletedPayments: ['181'] });
    reverseReturns('failed');

    await expect(processReconcileConnectionJob(JOB)).rejects.toThrow(/failed item/);

    expect(advanceReconcileCursorMock).not.toHaveBeenCalled();
  });

  it('reports the lost CAS to Sentry and still completes the job when the realm changed mid-run', async () => {
    reconcileChangesMock.mockResolvedValue(EMPTY_CHANGESET);
    advanceReconcileCursorMock.mockResolvedValueOnce(false);

    const summary = await processReconcileConnectionJob(JOB);

    expect(summary).toBeDefined();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      { service: 'accountingReconcileWorker', connectionId: CONN_ID, trigger: JOB.trigger },
    );
  });

  it('reverses the allocations QuickBooks removed from a payment it still holds', async () => {
    // Finding B: the CDC window carries payment 180 settling invoice 145 only.
    // Any OTHER 180/<invoice> mapping in Breeze is an allocation QBO dropped.
    reconcileChangesMock.mockResolvedValue({
      ...EMPTY_CHANGESET,
      payments: [
        line({ remotePaymentId: '180', remoteInvoiceId: '145' }),
        line({ remotePaymentId: '181', remoteInvoiceId: '146' }),
        line({ remotePaymentId: '181', remoteInvoiceId: '147' }),
      ],
    });
    reverseStaleMock.mockImplementation(async (_conn: unknown, remotePaymentId: string) => {
      record('reverseStaleAllocations');
      return remotePaymentId === '180' ? [result('reversed', '180')] : [];
    });

    const summary = await processReconcileConnectionJob(JOB);

    // Once per PAYMENT, not once per line, with that payment's full current set.
    expect(reverseStaleMock).toHaveBeenCalledTimes(2);
    expect(reverseStaleMock).toHaveBeenCalledWith(expect.anything(), '180', ['145'], expect.any(Function), 'fp1:legacy:abc');
    expect(reverseStaleMock).toHaveBeenCalledWith(expect.anything(), '181', ['146', '147'], expect.any(Function), 'fp1:legacy:abc');
    expect(summary?.reversed).toBe(1);
    expect(summary?.applied).toBe(3);
    // Stale reversal runs AFTER that payment's own lines are applied.
    expect(applierOrder()).toEqual([
      'applyAccountingPayment', 'reverseStaleAllocations',
      'applyAccountingPayment', 'applyAccountingPayment', 'reverseStaleAllocations',
    ]);
    expect(depthsOf('reverseStaleAllocations')).toEqual([0, 0]);
  });

  it('turns the run dirty when a stale-allocation reversal reports failed', async () => {
    reconcileChangesMock.mockResolvedValue({ ...EMPTY_CHANGESET, payments: [line()] });
    reverseStaleMock.mockImplementation(async () => {
      record('reverseStaleAllocations');
      return [result('failed')];
    });

    await expect(processReconcileConnectionJob(JOB)).rejects.toThrow(/failed item/);

    expect(advanceReconcileCursorMock).not.toHaveBeenCalled();
  });

  it('passes the run-start realm fingerprint to every applier (finding C)', async () => {
    reconcileChangesMock.mockResolvedValue({
      ...EMPTY_CHANGESET, payments: [line()], deletedPayments: ['181'], deletedInvoices: ['145'],
    });
    reverseReturns('reversed');

    await processReconcileConnectionJob(JOB);

    expect(applyMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.any(Function), 'fp1:legacy:abc');
    expect(reverseMock).toHaveBeenCalledWith(expect.anything(), '181', expect.any(Function), 'fp1:legacy:abc');
    expect(markInvoiceDeletedMock).toHaveBeenCalledWith(expect.anything(), '145', expect.any(Function), 'fp1:legacy:abc');
    expect(reverseStaleMock).toHaveBeenCalledWith(expect.anything(), '180', ['145'], expect.any(Function), 'fp1:legacy:abc');
  });

  it('logs and skips — never throws — when the cursor CAS loses to a realm reconnect', async () => {
    reconcileChangesMock.mockResolvedValue({ ...EMPTY_CHANGESET, payments: [line()] });
    advanceReconcileCursorMock.mockImplementation(async () => {
      record('advanceReconcileCursor');
      return false;
    });

    const summary = await processReconcileConnectionJob(JOB);

    // The run completed; only the watermark was not claimed.
    expect(summary?.applied).toBe(1);
    expect(summary?.cursorAfter).toBeNull();
  });

  it('counts a realm_changed item as clean and still lets the run finish', async () => {
    reconcileChangesMock.mockResolvedValue({ ...EMPTY_CHANGESET, payments: [line()] });
    applyReturns('realm_changed');

    const summary = await processReconcileConnectionJob(JOB);

    expect(summary?.realmChanged).toBe(1);
    expect(summary?.failed).toBe(0);
  });

  it('clears the connection last_error on a clean run (finding H)', async () => {
    reconcileChangesMock.mockResolvedValue({ ...EMPTY_CHANGESET, payments: [line()] });

    await processReconcileConnectionJob(JOB);

    expect(stampReconcileRunErrorMock).toHaveBeenCalledWith({}, CONN_ID, PARTNER_ID, null);
    expect(depthsOf('stampReconcileRunError')).toEqual([1]);
  });

  it('stamps a sanitized one-liner on the connection when items failed (finding H)', async () => {
    reconcileChangesMock.mockResolvedValue({ ...EMPTY_CHANGESET, payments: [line()] });
    applyMock.mockRejectedValue(new Error('QuickBooks said <realm secrets>'));

    await expect(processReconcileConnectionJob(JOB)).rejects.toThrow(/failed item/);

    const stamped = stampReconcileRunErrorMock.mock.calls.at(-1)![3] as string;
    expect(stamped).toMatch(/1 item/);
    // Counts only — never a QuickBooks response body.
    expect(stamped).not.toMatch(/realm secrets/);
  });

  it('stamps a truncated-window one-liner when the CDC window overflowed (finding H)', async () => {
    reconcileChangesMock.mockResolvedValue({ ...EMPTY_CHANGESET, overflowed: true });

    await expect(processReconcileConnectionJob(JOB)).rejects.toThrow(/could not be fully enumerated/);

    expect(stampReconcileRunErrorMock.mock.calls.at(-1)![3]).toMatch(/truncat/i);
  });

  it('holds the cursor and rethrows when the CDC window could not be fully enumerated', async () => {
    // Finding A, belt-and-braces arm: the provider could not drain a truncated
    // CDC entity even through /query. Advancing the cursor here would skip
    // every change QuickBooks withheld, permanently.
    reconcileChangesMock.mockResolvedValue({ ...EMPTY_CHANGESET, overflowed: true, payments: [line()] });

    await expect(processReconcileConnectionJob(JOB)).rejects.toThrow(/could not be fully enumerated/);

    expect(advanceReconcileCursorMock).not.toHaveBeenCalled();
    // The rows QBO DID return are still real changes and are still applied.
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      expect.objectContaining({ service: 'accountingReconcileWorker', connectionId: CONN_ID }),
    );
  });

  it('keeps processing the remaining payment lines after one fails', async () => {
    reconcileChangesMock.mockResolvedValue({
      ...EMPTY_CHANGESET,
      payments: [line({ remotePaymentId: '180' }), line({ remotePaymentId: '181' })],
    });
    let call = 0;
    applyMock.mockImplementation(async () => {
      if (call++ === 0) throw new Error('boom');
      return result('applied', '181');
    });

    await expect(processReconcileConnectionJob(JOB)).rejects.toThrow(/1 failed item/);

    expect(applyMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

describe('processReconcileSweep', () => {
  it('enqueues one sweep job per reconcilable connection, with nothing held', async () => {
    listReconcilableConnectionsMock.mockImplementation(async () => {
      record('listReconcilableConnections');
      return [
        { id: 'c1', partnerId: 'p1' },
        { id: 'c2', partnerId: 'p2' },
        { id: 'c3', partnerId: 'p3' },
      ];
    });

    const outcome = await processReconcileSweep();

    expect(outcome).toEqual({ enqueued: 3, failed: 0 });
    expect(queueAddMock).toHaveBeenCalledTimes(3);
    for (const call of queueAddMock.mock.calls) {
      expect(call[1]).toMatchObject({ type: 'reconcile-connection', trigger: 'sweep' });
    }
    // The list read happens INSIDE one short system context...
    expect(depthsOf('listReconcilableConnections')).toEqual([1]);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    // ...and every Redis enqueue happens with that context already closed.
    expect(depthsOf('queue.add')).toEqual([0, 0, 0]);
  });

  it('counts a refused enqueue into failed rather than reporting it as queued', async () => {
    listReconcilableConnectionsMock.mockResolvedValue([
      { id: 'c1', partnerId: 'p1' },
      { id: 'c2', partnerId: 'p2' },
    ]);
    queueAddMock.mockRejectedValueOnce(new Error('redis down'));

    await expect(processReconcileSweep()).resolves.toEqual({ enqueued: 1, failed: 1 });
  });
});

// ---------------------------------------------------------------------------
// Enqueue helper
// ---------------------------------------------------------------------------

describe('enqueueAccountingReconcile', () => {
  it('uses a colon-free deterministic jobId and drops the job record on completion', async () => {
    await expect(enqueueAccountingReconcile('c1', 'p1', 'webhook')).resolves.toBe(true);

    const [name, data, opts] = queueAddMock.mock.calls[0]!;
    expect(name).toBe('reconcile-connection');
    expect(data).toEqual({ type: 'reconcile-connection', connectionId: 'c1', partnerId: 'p1', trigger: 'webhook' });
    expect(opts).toEqual({
      jobId: 'accounting-reconcile-c1',
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
    expect((opts as { jobId: string }).jobId).not.toContain(':');
  });

  it('returns false (never a false "queued") and reports when the queue refuses the job', async () => {
    queueAddMock.mockRejectedValueOnce(new Error('redis down'));

    await expect(enqueueAccountingReconcile('c1', 'p1', 'manual')).resolves.toBe(false);
    expect(captureExceptionMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('initializeAccountingReconcileWorkers', () => {
  it('backfills fingerprints, then re-registers the repeat job remove-then-add', async () => {
    repeatables = [
      { name: 'sweep', key: 'stale-key' },
      { name: 'something-else', key: 'other-key' },
    ];

    await initializeAccountingReconcileWorkers();

    expect(ctx.order).toEqual([
      'backfillRealmFingerprints',
      'queue.getRepeatableJobs',
      'queue.removeRepeatableByKey',
      'queue.add',
    ]);
    expect(removeRepeatableByKeyMock).toHaveBeenCalledExactlyOnceWith('stale-key');

    const [name, data, opts] = queueAddMock.mock.calls[0]!;
    expect(name).toBe('sweep');
    expect(data).toEqual({ type: 'sweep' });
    expect(opts).toEqual({
      repeat: { every: RECONCILE_SWEEP_INTERVAL_MS },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 30 },
    });

    expect(workerInstances).toHaveLength(1);
    expect(workerInstances[0]!.queueName).toBe(ACCOUNTING_RECONCILE_QUEUE);
    expect(workerInstances[0]!.opts).toMatchObject({ concurrency: 2 });
    expect(attachWorkerObservabilityMock).toHaveBeenCalledWith(expect.anything(), 'accountingReconcileWorker');

    await shutdownAccountingReconcileWorkers();
  });

  it('boots anyway when the fingerprint backfill fails', async () => {
    backfillRealmFingerprintsMock.mockRejectedValueOnce(new Error('backfill exploded'));

    await expect(initializeAccountingReconcileWorkers()).resolves.toBeUndefined();

    expect(captureExceptionMock).toHaveBeenCalled();
    expect(queueAddMock).toHaveBeenCalledWith('sweep', { type: 'sweep' }, expect.objectContaining({
      repeat: { every: RECONCILE_SWEEP_INTERVAL_MS },
    }));

    await shutdownAccountingReconcileWorkers();
  });

  it('exposes the queue name and a 15-minute sweep interval', () => {
    expect(ACCOUNTING_RECONCILE_QUEUE).toBe('accounting-reconcile');
    expect(RECONCILE_SWEEP_INTERVAL_MS).toBe(15 * 60 * 1000);
  });
});
