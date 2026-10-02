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
  stampReconcileRunAtMock,
  stampReconcileRunErrorMock,
  backfillRealmFingerprintsMock,
  resolveConnectionAndTokenMock,
  reconcileChangesMock,
  getAccountingProviderMock,
  applyMock,
  reverseMock,
  reverseStaleMock,
  markInvoiceDeletedMock,
  listOwedPaymentMappingsMock,
  enqueuePaymentPushMock,
  enqueuePaymentDeleteMock,
  providerSupportsMock,
  getConnectionProvidersForMappingsMock,
  reapStalePendingTenantsMock,
  owesDeleteMock,
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
    workerInstances: [] as Array<{ queueName: string; opts: Record<string, unknown>; processor: (job: unknown, token?: string) => Promise<unknown> }>,
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
    stampReconcileRunAtMock: vi.fn(),
    stampReconcileRunErrorMock: vi.fn(),
    backfillRealmFingerprintsMock: vi.fn(),
    resolveConnectionAndTokenMock: vi.fn(),
    reconcileChangesMock: vi.fn(),
    getAccountingProviderMock: vi.fn(),
    applyMock: vi.fn(),
    reverseMock: vi.fn(),
    reverseStaleMock: vi.fn(),
    markInvoiceDeletedMock: vi.fn(),
    listOwedPaymentMappingsMock: vi.fn(),
    enqueuePaymentPushMock: vi.fn(),
    enqueuePaymentDeleteMock: vi.fn(),
    providerSupportsMock: vi.fn((_id: string, _cap: string) => true),
    getConnectionProvidersForMappingsMock: vi.fn(),
    reapStalePendingTenantsMock: vi.fn(),
    owesDeleteMock: vi.fn(async () => false),
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
      workerInstances.push({ queueName, opts, processor: _processor as (job: unknown, token?: string) => Promise<unknown> });
    }
  },
  Job: class {},
  DelayedError: class DelayedError extends Error { constructor() { super('bullmq:movedToDelayed'); this.name = 'DelayedError'; } },
}));

// Daily-budget deferral (Xero W01 Task 14): QuickBooks declares no daily
// budget, so the real helper never defers; the mock drives the W02 branch.
const { shouldDeferMock } = vi.hoisted(() => ({ shouldDeferMock: vi.fn(async (..._args: unknown[]) => false) }));
vi.mock('../services/accounting/accountingRateLimit', () => ({ shouldDeferBackgroundWork: shouldDeferMock }));

vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: captureExceptionMock }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: attachWorkerObservabilityMock }));

vi.mock('../db', () => ({
  db: {},
  hasDbAccessContext: () => ctx.depth > 0,
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

// Xero W01: the job loads its connection BY ID (`getConnectionById`) instead of
// (partner, 'quickbooks'); the existing mock drives it so every fixture keeps
// its branch. `getConnectionProvidersForMappings` feeds the owed-row capability
// filter — empty by default, i.e. every owed row is enqueued exactly as before.
vi.mock('../services/accounting/accountingConnectionService', () => ({
  getConnectionById: getConnectionMock,
  getConnectionProvidersForMappings: getConnectionProvidersForMappingsMock,
  listReconcilableConnections: listReconcilableConnectionsMock,
  advanceReconcileCursor: advanceReconcileCursorMock,
  stampReconcileRunAt: stampReconcileRunAtMock,
  stampReconcileRunError: stampReconcileRunErrorMock,
  backfillRealmFingerprints: backfillRealmFingerprintsMock,
}));

vi.mock('../services/accounting/accountingMappingService', () => ({
  resolveConnectionAndToken: resolveConnectionAndTokenMock,
}));

vi.mock('../services/accounting/providerRegistry', () => ({
  getAccountingProvider: getAccountingProviderMock,
  findAccountingProvider: (id: string) => ({ id, limits: { rate: { provider: id } } }),
  providerSupports: providerSupportsMock,
  accountingProviderDisplayName: (id: string) => ({ quickbooks: 'QuickBooks', xero: 'Xero' } as Record<string, string>)[id] ?? `UNKNOWN_PROVIDER:${id}`,
}));

vi.mock('../services/accounting/accountingPaymentPull', () => ({
  applyAccountingPayment: applyMock,
  reverseAccountingPayment: reverseMock,
  reverseStaleAllocations: reverseStaleMock,
  markInvoiceDeletedRemotely: markInvoiceDeletedMock,
}));

vi.mock('../services/accounting/accountingPaymentPush', () => ({
  listOwedPaymentMappings: listOwedPaymentMappingsMock,
  connectionOwesUnresolvedPaymentDelete: owesDeleteMock,
}));

vi.mock('./accountingSyncWorker', () => ({
  enqueueAccountingPaymentPush: enqueuePaymentPushMock,
  enqueueAccountingPaymentDelete: enqueuePaymentDeleteMock,
}));

// Xero W02 Task 9: the sweep's pass 3 (pending_tenant reaper).
vi.mock('../services/accounting/accountingTenantSelection', () => ({
  reapStalePendingTenants: reapStalePendingTenantsMock,
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
  unappliedPayments: [],
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
    remotePaymentVersion: '0',
    paymentMethodName: 'Check',
    method: 'check',
    paymentRefNum: '4471',
    breezePaymentId: null,
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
    pushPayments: true,
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

  listOwedPaymentMappingsMock.mockResolvedValue([]);
  getConnectionProvidersForMappingsMock.mockResolvedValue(new Map());
  providerSupportsMock.mockImplementation(() => true);
  enqueuePaymentPushMock.mockResolvedValue(true);
  enqueuePaymentDeleteMock.mockResolvedValue(true);

  // Defaults so processReconcileSweep tests never depend on execution order
  // (ruling F14): every test that cares about the reaper or the connection
  // list overrides these explicitly.
  listReconcilableConnectionsMock.mockResolvedValue([]);
  reapStalePendingTenantsMock.mockResolvedValue({ stale: 0, reaped: 0, kept: 0 });
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

  // Phase D2 (spec decision 6): `pull_payments` off ALONE is not a skip any
  // more — see the "gate: pull OR push" describe below. Only both switches
  // off short-circuits.
  it('returns null, logs reason=both_switches_off, stamps the connection, and never resolves a token when BOTH switches are off', async () => {
    getConnectionMock.mockResolvedValue(connectionRow({ pullPayments: false, pushPayments: false }));

    await expect(processReconcileConnectionJob(JOB)).resolves.toBeNull();

    expect(reconcileChangesMock).not.toHaveBeenCalled();
    // No token refresh for a switched-off connection: the refresh itself is a
    // QuickBooks round trip and a write, and doing it here would keep a
    // disabled connection's tokens alive forever.
    expect(resolveConnectionAndTokenMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('run skipped'),
      'reason=both_switches_off',
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

  it('defers a WEBHOOK run when the provider daily budget is low, before any token work (Xero W05 refinement 6)', async () => {
    getConnectionMock.mockResolvedValue(connectionRow({ provider: 'xero' }));
    shouldDeferMock.mockResolvedValueOnce(true);
    const log = vi.spyOn(console, 'log');

    await expect(processReconcileConnectionJob({ ...JOB, trigger: 'webhook' })).resolves.toBeNull();

    expect(shouldDeferMock).toHaveBeenCalledWith('xero', expect.anything(), JOB.connectionId);
    expect(resolveConnectionAndTokenMock).not.toHaveBeenCalled();
    expect(reconcileChangesMock).not.toHaveBeenCalled();
    expect(log.mock.calls.some((c) => c.includes('reason=daily_budget_low'))).toBe(true);
  });

  it('does NOT defer a webhook run while the connection owes a delete only a pull can resolve (quorum finding 3)', async () => {
    getConnectionMock.mockResolvedValue(connectionRow({ provider: 'xero' }));
    shouldDeferMock.mockResolvedValueOnce(true);
    owesDeleteMock.mockResolvedValueOnce(true);
    await processReconcileConnectionJob({ ...JOB, trigger: 'webhook' });
    expect(reconcileChangesMock).toHaveBeenCalledTimes(1);
  });

  it.each(['sweep', 'manual'] as const)('never consults the budget for a %s run (the sweep deferred at enqueue; Sync now is interactive)', async (trigger) => {
    shouldDeferMock.mockResolvedValue(true);
    await processReconcileConnectionJob({ ...JOB, trigger });
    expect(shouldDeferMock).not.toHaveBeenCalled();
    expect(reconcileChangesMock).toHaveBeenCalledTimes(1);
    shouldDeferMock.mockResolvedValue(false);
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
      adopted: 0,
      breezeOriginDiverged: 0,
      skippedBreezeOrigin: 0,
      skippedPullDisabled: 0,
      breezeOriginRemovedRemotely: 0,
      invoicesSelfVoided: 0,
      cursorBefore: CURSOR_BEFORE,
      cursorAfter: changes.cursor,
    });
  });

  it('FREEZES the cursor when pull is off, so re-enabling pull can still backfill the window', async () => {
    // The gate widened to pull-OR-push, so a pull-off/push-on realm now runs the
    // CDC pass and skips every QuickBooks-origin change as
    // `skipped_pull_disabled`. Advancing the cursor past those windows made the
    // suppression PERMANENT: turning pull back on would resume from a watermark
    // that already stepped over everything it never imported.
    const conn = connectionRow({ pullPayments: false, pushPayments: true });
    getConnectionMock.mockResolvedValue(conn);
    resolveConnectionAndTokenMock.mockImplementation(async () => ({
      conn, liveConn: { ...conn, accessToken: 'tok' },
    }));
    reconcileChangesMock.mockResolvedValue({
      ...EMPTY_CHANGESET,
      payments: [line({ remotePaymentId: '180' })],
    });
    applyReturns('skipped_pull_disabled');

    const summary = await processReconcileConnectionJob(JOB);

    expect(advanceReconcileCursorMock).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      skippedPullDisabled: 1,
      cursorBefore: CURSOR_BEFORE,
      cursorAfter: CURSOR_BEFORE, // unchanged — the window stays replayable
    });
    // ...but the run DID happen. advanceReconcileCursor is the only writer of
    // last_reconcile_at, so skipping it froze the integration card's "Last
    // reconciled" at the moment pull was switched off — a healthy connection
    // looking permanently stalled.
    expect(stampReconcileRunAtMock).toHaveBeenCalledWith(
      {}, CONN_ID, PARTNER_ID, expect.any(Date),
    );
  });

  it('ADVANCES the cursor on a pull-ON run, as before', async () => {
    reconcileChangesMock.mockResolvedValue({
      ...EMPTY_CHANGESET,
      payments: [line({ remotePaymentId: '180' })],
    });
    applyReturns('applied');

    const summary = await processReconcileConnectionJob(JOB);

    expect(advanceReconcileCursorMock).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ cursorAfter: (await reconcileChangesMock.mock.results[0]!.value).cursor });
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

  it('tallies every Phase D2 outcome and still advances the cursor — all five are CLEAN', async () => {
    applyReturns('adopted', 'breeze_origin_diverged', 'skipped_breeze_origin', 'skipped_pull_disabled');
    reverseReturns('breeze_origin_removed_remotely');
    markInvoiceDeletedMock.mockImplementation(async () => {
      record('markInvoiceDeletedRemotely');
      return 'invoice_void';
    });
    reconcileChangesMock.mockResolvedValue({
      ...EMPTY_CHANGESET,
      deletedInvoices: ['145'],
      deletedPayments: ['181'],
      payments: [line(), line(), line(), line()],
    });

    const summary = await processReconcileConnectionJob(JOB);

    expect(summary).toMatchObject({
      adopted: 1,
      breezeOriginDiverged: 1,
      skippedBreezeOrigin: 1,
      skippedPullDisabled: 1,
      breezeOriginRemovedRemotely: 1,
      // Breeze's OWN void echoing back is never "deleted in QuickBooks".
      invoicesSelfVoided: 1,
      invoicesMarkedDeleted: 0,
      failed: 0,
    });
    expect(advanceReconcileCursorMock).toHaveBeenCalledTimes(1);
    expect(stampReconcileRunErrorMock).toHaveBeenCalledWith({}, CONN_ID, PARTNER_ID, null);
  });

  it('reports the pull-disabled skips ONCE on the run line, not once per suppressed payment', async () => {
    // A CDC window against a pull-off connection is ALL skips. Logging each one
    // would bury the run in noise it repeats every 15 minutes (#4543 asks for a
    // visible reason, not a per-item trace).
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      applyReturns('skipped_pull_disabled');
      reconcileChangesMock.mockResolvedValue({
        ...EMPTY_CHANGESET,
        payments: [line(), line(), line()],
      });

      const summary = await processReconcileConnectionJob(JOB);

      expect(summary?.skippedPullDisabled).toBe(3);
      const runLines = logSpy.mock.calls.filter((c) => String(c[0]).includes('run complete'));
      expect(runLines).toHaveLength(1);
      expect(runLines[0]).toContain('skippedPullDisabled=3');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('does NOT advance the cursor and rethrows when an applier throws', async () => {
    reconcileChangesMock.mockResolvedValue({ ...EMPTY_CHANGESET, payments: [line()] });
    applyMock.mockRejectedValue(new Error('boom'));

    await expect(processReconcileConnectionJob(JOB)).rejects.toThrow(/failed item/);

    expect(advanceReconcileCursorMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      { service: 'accountingPaymentPull', accounting_connection_id: CONN_ID, remote_entity_id: '180' },
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
      { service: 'accountingReconcileWorker', accounting_connection_id: CONN_ID, accounting_trigger: JOB.trigger },
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

  it('routes an UNAPPLIED payment through the stale sweep with an EMPTY keep-set, never through the deleter', async () => {
    // Finding C1. A voided/unapplied QuickBooks Payment still EXISTS, so it must
    // NOT reach `reverseAccountingPayment` — that path clears a Breeze-origin
    // row's remote id, and the invoice fan-out then pushes a duplicate Payment.
    reconcileChangesMock.mockResolvedValue({
      ...EMPTY_CHANGESET,
      unappliedPayments: ['183'],
    });
    reverseStaleMock.mockImplementation(async () => {
      record('reverseStaleAllocations');
      return [result('reversed', '183')];
    });

    const summary = await processReconcileConnectionJob(JOB);

    expect(reverseMock).not.toHaveBeenCalled();
    expect(reverseStaleMock).toHaveBeenCalledTimes(1);
    expect(reverseStaleMock).toHaveBeenCalledWith(expect.anything(), '183', [], expect.any(Function), 'fp1:legacy:abc');
    expect(depthsOf('reverseStaleAllocations')).toEqual([0]);
    expect(summary?.reversed).toBe(1);
  });

  it('runs unapplied payments AFTER the lined payments and after the deletions', async () => {
    reconcileChangesMock.mockResolvedValue({
      ...EMPTY_CHANGESET,
      payments: [line({ remotePaymentId: '180', remoteInvoiceId: '145' })],
      deletedPayments: ['181'],
      deletedInvoices: ['145'],
      unappliedPayments: ['183'],
    });
    reverseReturns('reversed');
    reverseStaleMock.mockImplementation(async () => {
      record('reverseStaleAllocations');
      return [];
    });

    await processReconcileConnectionJob(JOB);

    expect(applierOrder()).toEqual([
      'markInvoiceDeletedRemotely',
      'reverseAccountingPayment',
      'applyAccountingPayment',
      'reverseStaleAllocations',
      // ...and the unapplied sweep last.
      'reverseStaleAllocations',
    ]);
    expect(reverseStaleMock.mock.calls.map((c) => [c[1], c[2]]))
      .toEqual([['180', ['145']], ['183', []]]);
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
    expect(stampReconcileRunErrorMock.mock.calls.at(-1)![3]).toBe(
      'QuickBooks truncated the last change window and the backfill did not complete; payments may be missing',
    );
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
      expect.objectContaining({ service: 'accountingReconcileWorker', accounting_connection_id: CONN_ID }),
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
        { id: 'c1', partnerId: 'p1', provider: 'quickbooks' },
        { id: 'c2', partnerId: 'p2', provider: 'quickbooks' },
        { id: 'c3', partnerId: 'p3', provider: 'quickbooks' },
      ];
    });

    const outcome = await processReconcileSweep();

    expect(outcome).toEqual({ enqueued: 3, failed: 0, deferred: 0, pendingOpsEnqueued: 0, pendingOpsFailed: 0, pendingTenantsReaped: 0, pendingTenantsKept: 0 });
    expect(queueAddMock).toHaveBeenCalledTimes(3);
    for (const call of queueAddMock.mock.calls) {
      expect(call[1]).toMatchObject({ type: 'reconcile-connection', trigger: 'sweep' });
    }
    // The list read happens INSIDE one short system context...
    expect(depthsOf('listReconcilableConnections')).toEqual([1]);
    // ...and the pass-2 owed-mappings read opens its own SEPARATE short context
    // (never held across pass 1's Redis enqueues, and never the same context).
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(2);
    // ...and every Redis enqueue happens with that context already closed.
    expect(depthsOf('queue.add')).toEqual([0, 0, 0]);
  });

  it('counts a refused enqueue into failed rather than reporting it as queued', async () => {
    listReconcilableConnectionsMock.mockResolvedValue([
      { id: 'c1', partnerId: 'p1', provider: 'quickbooks' },
      { id: 'c2', partnerId: 'p2', provider: 'quickbooks' },
    ]);
    queueAddMock.mockRejectedValueOnce(new Error('redis down'));

    await expect(processReconcileSweep()).resolves.toEqual({ enqueued: 1, failed: 1, deferred: 0, pendingOpsEnqueued: 0, pendingOpsFailed: 0, pendingTenantsReaped: 0, pendingTenantsKept: 0 });
  });

  it('a failed connection-list read does not suppress the pending-op pass — it still enqueues, and the job rethrows so BullMQ retries', async () => {
    listReconcilableConnectionsMock.mockRejectedValue(new Error('connections read boom'));
    listOwedPaymentMappingsMock.mockResolvedValue([{ id: 'm1', partnerId: 'p1', pendingOp: 'push' }]);

    await expect(processReconcileSweep()).rejects.toThrow();

    expect(queueAddMock).not.toHaveBeenCalled();
    expect(enqueuePaymentPushMock).toHaveBeenCalledWith('m1', 'p1');
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it('a failed owed-mappings read does not suppress the connection fan-out — it still enqueues, and the job rethrows so BullMQ retries', async () => {
    listReconcilableConnectionsMock.mockResolvedValue([{ id: 'c1', partnerId: 'p1', provider: 'quickbooks' }]);
    listOwedPaymentMappingsMock.mockRejectedValue(new Error('owed read boom'));

    await expect(processReconcileSweep()).rejects.toThrow();

    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(enqueuePaymentPushMock).not.toHaveBeenCalled();
    expect(enqueuePaymentDeleteMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it('a low-budget connection that owes an unresolved payment delete is still enqueued (quorum finding 3)', async () => {
    // Arrange the sweep exactly as the file's first sweep test does, with ONE reconcilable connection.
    listReconcilableConnectionsMock.mockImplementation(async () => {
      record('listReconcilableConnections');
      return [{ id: 'c1', partnerId: 'p1', provider: 'xero' }];
    });
    shouldDeferMock.mockResolvedValue(true);
    owesDeleteMock.mockResolvedValue(true);
    const result = await processReconcileSweep();
    expect(result.deferred).toBe(0);
    expect(result.enqueued).toBe(1);
    shouldDeferMock.mockResolvedValue(false);
    owesDeleteMock.mockResolvedValue(false);
  });

  it('isolates a failed owed-delete check to its own connection — the sweep still resolves, that connection is enqueued (fail toward pulling), and later passes still run', async () => {
    listReconcilableConnectionsMock.mockResolvedValue([
      { id: 'c1', partnerId: 'p1', provider: 'xero' },
      { id: 'c2', partnerId: 'p2', provider: 'xero' },
    ]);
    shouldDeferMock.mockResolvedValue(true);
    owesDeleteMock
      .mockRejectedValueOnce(new Error('owed-delete check boom'))
      .mockResolvedValueOnce(false);

    const result = await processReconcileSweep();

    expect(result.enqueued).toBe(1);
    expect(result.deferred).toBe(1);
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error), undefined, {
      service: 'accountingReconcileWorker', accounting_reconcile_phase: 'sweep.owedDelete',
    });
    // Pass 2/3 still ran despite pass 1's owed-delete error.
    expect(listOwedPaymentMappingsMock).toHaveBeenCalled();
    expect(reapStalePendingTenantsMock).toHaveBeenCalled();

    shouldDeferMock.mockResolvedValue(false);
    owesDeleteMock.mockReset();
    owesDeleteMock.mockResolvedValue(false);
    captureExceptionMock.mockClear();
  });
});

describe('pending_tenant reaper (Xero W02)', () => {
  it('reaps stale pending rows on every sweep and reports the count', async () => {
    reapStalePendingTenantsMock.mockResolvedValueOnce({ stale: 2, reaped: 2, kept: 0 });

    const out = await processReconcileSweep();

    expect(reapStalePendingTenantsMock).toHaveBeenCalledTimes(1);
    expect(out.pendingTenantsReaped).toBe(2);
  });

  it('#7289: reports stale rows KEPT because they still owe payment deletes (returned and logged)', async () => {
    reapStalePendingTenantsMock.mockResolvedValueOnce({ stale: 3, reaped: 1, kept: 2 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const out = await processReconcileSweep();

    expect(out.pendingTenantsReaped).toBe(1);
    expect(out.pendingTenantsKept).toBe(2);
    const sweepLine = log.mock.calls.find((call) => call[0] === '[AccountingReconcileWorker] sweep complete');
    expect(sweepLine).toContain('pendingTenantsKept=2');
    log.mockRestore();
  });

  it('a reap failure never fails the sweep or blocks the other passes', async () => {
    reapStalePendingTenantsMock.mockRejectedValueOnce(new Error('db down'));

    const out = await processReconcileSweep();

    expect(out.pendingTenantsReaped).toBe(0);
    expect(out).toHaveProperty('enqueued');
    expect(captureExceptionMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Phase D2: pull-or-push gate + the stale pending_op sweep
// ---------------------------------------------------------------------------

describe('gate: pull OR push (spec decision 6)', () => {
  it('still runs the CDC pass when pull is off but push is on — proceeds past the gate to resolveConnectionAndToken', async () => {
    getConnectionMock.mockResolvedValue({ id: 'c1', status: 'connected', pullPayments: false, pushPayments: true, realmIdFingerprint: 'fp', cdcCursor: null });
    reconcileChangesMock.mockResolvedValue(EMPTY_CHANGESET);
    await expect(processReconcileConnectionJob({ type: 'reconcile-connection', connectionId: 'c1', partnerId: 'p1', trigger: 'sweep' }))
      .resolves.not.toBeNull();
    expect(resolveConnectionAndTokenMock).toHaveBeenCalled();
    expect(reconcileChangesMock).toHaveBeenCalled();
  });

  it('returns null and touches nothing when BOTH switches are off', async () => {
    getConnectionMock.mockResolvedValue({ id: 'c1', status: 'connected', pullPayments: false, pushPayments: false });
    await expect(processReconcileConnectionJob({ type: 'reconcile-connection', connectionId: 'c1', partnerId: 'p1', trigger: 'sweep' }))
      .resolves.toBeNull();
    expect(reconcileChangesMock).not.toHaveBeenCalled();
    expect(resolveConnectionAndTokenMock).not.toHaveBeenCalled();
  });

  it('pins the four short-circuit reason strings in the info log', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    getConnectionMock.mockResolvedValue(null);
    await processReconcileConnectionJob(JOB);

    getConnectionMock.mockResolvedValue(connectionRow({ id: 'some-other-connection' }));
    await processReconcileConnectionJob(JOB);

    getConnectionMock.mockResolvedValue(connectionRow({ status: 'reauth_required' }));
    await processReconcileConnectionJob(JOB);

    getConnectionMock.mockResolvedValue(connectionRow({ pullPayments: false, pushPayments: false }));
    await processReconcileConnectionJob(JOB);

    const reasons = logSpy.mock.calls
      .filter((call) => call[0] === '[AccountingReconcileWorker] run skipped')
      .map((call) => call.find((arg) => typeof arg === 'string' && arg.startsWith('reason=')));
    expect(reasons).toEqual([
      'reason=missing',
      'reason=connection_mismatch',
      'reason=not_connected',
      'reason=both_switches_off',
    ]);

    logSpy.mockRestore();
  });
});

describe('stale pending_op sweep', () => {
  it('re-enqueues every owed mapping by its own operation, with nothing held', async () => {
    listReconcilableConnectionsMock.mockResolvedValue([]);
    listOwedPaymentMappingsMock.mockResolvedValue([
      { id: 'm1', partnerId: 'p1', pendingOp: 'push' },
      { id: 'm2', partnerId: 'p2', pendingOp: 'delete' },
    ]);
    let depthAtEnqueue = -1;
    enqueuePaymentPushMock.mockImplementation(async () => { depthAtEnqueue = ctx.depth; return true; });

    const summary = await processReconcileSweep();

    expect(enqueuePaymentPushMock).toHaveBeenCalledWith('m1', 'p1');
    expect(enqueuePaymentDeleteMock).toHaveBeenCalledWith('m2', 'p2');
    expect(summary.pendingOpsEnqueued).toBe(2);
    // Redis work never happens inside a DB context.
    expect(depthAtEnqueue).toBe(0);
  });

  it('counts a refused enqueue as failed rather than reporting it as queued', async () => {
    listReconcilableConnectionsMock.mockResolvedValue([]);
    listOwedPaymentMappingsMock.mockResolvedValue([{ id: 'm1', partnerId: 'p1', pendingOp: 'push' }]);
    enqueuePaymentPushMock.mockResolvedValue(false);
    await expect(processReconcileSweep()).resolves.toMatchObject({ pendingOpsEnqueued: 0, pendingOpsFailed: 1 });
  });

  it('sweeps owed mappings even when NO connection is reconcilable (deletes must still propagate)', async () => {
    listReconcilableConnectionsMock.mockResolvedValue([]);
    listOwedPaymentMappingsMock.mockResolvedValue([{ id: 'm2', partnerId: 'p2', pendingOp: 'delete' }]);
    await processReconcileSweep();
    expect(enqueuePaymentDeleteMock).toHaveBeenCalledWith('m2', 'p2');
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

  it('adds a delay only when asked, and keeps the jobId (Xero W05 refinement 5)', async () => {
    await expect(enqueueAccountingReconcile('c1', 'p1', 'webhook', { delayMs: 30_000 })).resolves.toBe(true);
    const [, , opts] = queueAddMock.mock.calls.at(-1)!;
    expect(opts).toEqual({
      jobId: 'accounting-reconcile-c1',
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: true,
      delay: 30_000,
    });
  });

  it('a zero or absent delay leaves the add() options byte-identical to pre-W05 (QuickBooks pin)', async () => {
    await enqueueAccountingReconcile('c1', 'p1', 'webhook', { delayMs: 0 });
    await enqueueAccountingReconcile('c1', 'p1', 'webhook');
    for (const call of queueAddMock.mock.calls.slice(-2)) {
      expect(call[2]).not.toHaveProperty('delay');
    }
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

// ---------------------------------------------------------------------------
// Xero W01: the job loads its connection by id; capability gates
// ---------------------------------------------------------------------------

describe('connection by id + capability gates (Xero W01)', () => {
  it('loads the connection the job NAMES, by id and partner, and targets the token resolve at it', async () => {
    await expect(processReconcileConnectionJob(JOB)).resolves.not.toBeNull();
    expect(getConnectionMock).toHaveBeenCalledWith({}, CONN_ID, PARTNER_ID);
    expect(resolveConnectionAndTokenMock).toHaveBeenCalledWith(PARTNER_ID, { connectionId: CONN_ID }, expect.any(Function));
  });

  it('skips with reason=capability_unavailable, before any token work, when the provider cannot pull payments', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    getConnectionMock.mockResolvedValue(connectionRow({ provider: 'xero' } as Partial<AccountingConnection>));
    providerSupportsMock.mockImplementation((id: string) => id === 'quickbooks');

    await expect(processReconcileConnectionJob(JOB)).resolves.toBeNull();

    expect(providerSupportsMock).toHaveBeenCalledWith('xero', 'paymentPull');
    expect(resolveConnectionAndTokenMock).not.toHaveBeenCalled();
    expect(reconcileChangesMock).not.toHaveBeenCalled();
    expect(stampReconcileRunErrorMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      '[AccountingReconcileWorker] run skipped',
      'reason=capability_unavailable',
      `connectionId=${CONN_ID}`,
      `partnerId=${PARTNER_ID}`,
      'trigger=sweep',
    );
    logSpy.mockRestore();
  });

  it('the sweep fans out only to connections whose provider can pull payments', async () => {
    listReconcilableConnectionsMock.mockResolvedValue([
      { id: 'c1', partnerId: 'p1', provider: 'quickbooks' },
      { id: 'c2', partnerId: 'p2', provider: 'xero' },
    ]);
    providerSupportsMock.mockImplementation((id: string) => id === 'quickbooks');

    await expect(processReconcileSweep()).resolves.toMatchObject({ enqueued: 1, failed: 0 });

    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(queueAddMock.mock.calls[0]![1]).toMatchObject({ connectionId: 'c1', partnerId: 'p1' });
  });

  it('the sweep skips an owed payment row whose connection cannot push payments, in the SAME read context', async () => {
    listReconcilableConnectionsMock.mockResolvedValue([]);
    listOwedPaymentMappingsMock.mockResolvedValue([
      { id: 'm1', partnerId: 'p1', pendingOp: 'push' },
      { id: 'm2', partnerId: 'p2', pendingOp: 'delete' },
    ]);
    let lookupDepth = -1;
    getConnectionProvidersForMappingsMock.mockImplementation(async () => {
      lookupDepth = ctx.depth;
      return new Map([['m1', 'quickbooks'], ['m2', 'xero']]);
    });
    providerSupportsMock.mockImplementation((id: string) => id === 'quickbooks');

    await expect(processReconcileSweep()).resolves.toMatchObject({ pendingOpsEnqueued: 1, pendingOpsFailed: 0 });

    expect(getConnectionProvidersForMappingsMock).toHaveBeenCalledWith({}, ['m1', 'm2']);
    expect(lookupDepth).toBe(1);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(2);
    expect(enqueuePaymentPushMock).toHaveBeenCalledWith('m1', 'p1');
    expect(enqueuePaymentDeleteMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rate limiting (Xero W01 Task 14): a throttled reconcile is delayed at
// Retry-After (moveToDelayed + DelayedError), never counted as a failure, and
// the sweep defers a connection whose daily budget is nearly spent.
// ---------------------------------------------------------------------------

import { createAccountingReconcileWorker } from './accountingReconcileWorker';
import { AccountingProviderError } from '../services/accounting/accountingProviderError';

describe('rate limiting (Xero W01 Task 14)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    shouldDeferMock.mockImplementation(async () => false);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  const throttle = (retryAfterMs = 30_000) => new AccountingProviderError({
    kind: 'rate_limited', provider: 'quickbooks', operation: 'QuickBooks CDC', httpStatus: 429, retryAfterMs,
  });
  const delayedJob = () => ({ id: 'j1', moveToDelayed: vi.fn(async (_ts: number, _token?: string) => undefined) });

  it('a throttled CDC read delays the job at Retry-After, with no Sentry event, no error log, and the cursor untouched', async () => {
    reconcileChangesMock.mockRejectedValueOnce(throttle(30_000));
    const job = delayedJob();
    const before = Date.now();

    await expect(processReconcileConnectionJob(JOB, { job: job as never, token: 'tok' })).rejects.toMatchObject({ name: 'DelayedError' });

    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'tok');
    expect(job.moveToDelayed.mock.calls[0]![0]).toBeGreaterThanOrEqual(before + 30_000);
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(advanceReconcileCursorMock).not.toHaveBeenCalled();
    expect(stampReconcileRunErrorMock).not.toHaveBeenCalled();
  });

  it('a throttled token refresh (resolveConnectionAndToken) delays the job too', async () => {
    resolveConnectionAndTokenMock.mockRejectedValueOnce(
      Object.assign(new Error('QuickBooks is rate limiting requests; try again shortly'), { code: 'rate_limited', retryAfterMs: 12_000 }),
    );
    const job = delayedJob();

    await expect(processReconcileConnectionJob(JOB, { job: job as never, token: 'tok' })).rejects.toMatchObject({ name: 'DelayedError' });
    expect(job.moveToDelayed).toHaveBeenCalledOnce();
    expect(reconcileChangesMock).not.toHaveBeenCalled();
  });

  it('a non-throttle failure is NOT delayed (the retry ladder still applies)', async () => {
    reconcileChangesMock.mockRejectedValueOnce(new Error('boom'));
    const job = delayedJob();

    await expect(processReconcileConnectionJob(JOB, { job: job as never, token: 'tok' })).rejects.toThrow('boom');
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('without a job context the throttle is rethrown unchanged', async () => {
    const err = throttle();
    reconcileChangesMock.mockRejectedValueOnce(err);

    await expect(processReconcileConnectionJob(JOB)).rejects.toBe(err);
  });

  it('the worker factory passes the job AND its lock token through', async () => {
    createAccountingReconcileWorker();
    const processor = workerInstances.at(-1)!.processor;
    reconcileChangesMock.mockRejectedValueOnce(throttle());
    const job = { ...delayedJob(), data: JOB };

    await expect(processor(job, 'lock-token')).rejects.toMatchObject({ name: 'DelayedError' });
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'lock-token');
  });

  it('the sweep defers a connection whose daily budget is nearly spent, and reports it', async () => {
    listReconcilableConnectionsMock.mockResolvedValue([
      { id: 'c-low', partnerId: 'p1', provider: 'quickbooks' },
      { id: 'c-ok', partnerId: 'p2', provider: 'quickbooks' },
    ]);
    shouldDeferMock.mockImplementation(async (...args: unknown[]) => args[2] === 'c-low');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(processReconcileSweep()).resolves.toEqual({
        enqueued: 1, failed: 0, deferred: 1, pendingOpsEnqueued: 0, pendingOpsFailed: 0, pendingTenantsReaped: 0, pendingTenantsKept: 0,
      });
      expect(logSpy.mock.calls.some((c) => c.some((a) => String(a).includes('deferred=1')))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
    expect(shouldDeferMock).toHaveBeenCalledWith('quickbooks', { provider: 'quickbooks' }, 'c-low');
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(queueAddMock.mock.calls[0]![1]).toMatchObject({ connectionId: 'c-ok' });
  });

  it('the sweep\'s pending-op pass is never deferred (a delete must still go out)', async () => {
    listReconcilableConnectionsMock.mockResolvedValue([{ id: 'c-low', partnerId: 'p1', provider: 'quickbooks' }]);
    listOwedPaymentMappingsMock.mockResolvedValue([{ id: 'm1', partnerId: 'p1', pendingOp: 'delete' }]);
    shouldDeferMock.mockImplementation(async () => true);

    await expect(processReconcileSweep()).resolves.toMatchObject({ deferred: 1, pendingOpsEnqueued: 1 });
    expect(enqueuePaymentDeleteMock).toHaveBeenCalledWith('m1', 'p1');
  });
});

it('A3 advances after an imported overpayment but holds the cursor for a reservation conflict', async () => {
  reconcileChangesMock.mockResolvedValue({ ...EMPTY_CHANGESET, payments: [line({ amountMinor: 20000 })] });
  applyReturns('applied');
  await processReconcileConnectionJob(JOB);
  expect(advanceReconcileCursorMock).toHaveBeenCalledOnce();
  advanceReconcileCursorMock.mockClear();
  applyMock.mockRejectedValueOnce(Object.assign(new Error('collection in progress'), { code: 'COLLECTION_IN_PROGRESS' }));
  await expect(processReconcileConnectionJob(JOB)).rejects.toThrow(/failed item/);
  expect(advanceReconcileCursorMock).not.toHaveBeenCalled();
});
