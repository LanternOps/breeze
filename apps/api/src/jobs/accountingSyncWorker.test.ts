import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture queue.add calls without opening a socket, mirroring invoiceWorker.test.ts.
const { queueAddMock, queueGetJobMock, selectWhereMock, workerProcessors } = vi.hoisted(() => ({
  queueAddMock: vi.fn(), queueGetJobMock: vi.fn(), selectWhereMock: vi.fn(),
  workerProcessors: [] as Array<(job: unknown, token?: string) => Promise<unknown>>,
}));
vi.mock('bullmq', () => ({
  Queue: class { add = queueAddMock; getJob = queueGetJobMock; },
  Worker: class {
    constructor(_queue: string, processor: (job: unknown, token?: string) => Promise<unknown>) { workerProcessors.push(processor); }
  },
  Job: class {},
  DelayedError: class DelayedError extends Error { constructor() { super('bullmq:movedToDelayed'); this.name = 'DelayedError'; } },
}));

// Daily-budget deferral (Xero W01 Task 14). QuickBooks declares no daily budget,
// so the real helper never defers; the mock lets a test drive the W02 branch.
const { shouldDeferMock } = vi.hoisted(() => ({ shouldDeferMock: vi.fn(async (_p: string, _spec: unknown, _connectionId: string) => false) }));
vi.mock('../services/accounting/accountingRateLimit', () => ({ shouldDeferBackgroundWork: shouldDeferMock }));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));

const { captureExceptionMock } = vi.hoisted(() => ({ captureExceptionMock: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: captureExceptionMock }));

vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

// runOutsideDbContext/withSystemDbAccessContext are spied (not just passed
// through) so the worker's "the coordinator does NOT self-wrap — the worker
// must provide system context" contract is directly assertable, mirroring
// contractWorker.ts's pattern.
const { runOutsideDbContextMock, withSystemDbAccessContextMock } = vi.hoisted(() => ({
  runOutsideDbContextMock: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContextMock: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('../db', () => ({
  // The mapping sweep joins its connection (Xero W01) — same terminal `where`.
  db: { select: () => ({ from: () => ({ where: selectWhereMock, innerJoin: () => ({ where: selectWhereMock }) }) }) },
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

const { getConnectionMock } = vi.hoisted(() => ({ getConnectionMock: vi.fn() }));
// Xero W01: the worker resolves its connection through resolveJobConnection —
// by id (targeted jobs), by mapping row (payment jobs) or the partner's active
// row (legacy jobs). All three delegate to the ONE existing mock so every
// fixture below keeps driving the same branch it always did.
vi.mock('../services/accounting/accountingConnectionService', () => ({
  getConnection: getConnectionMock,
  resolveActiveConnection: (...args: unknown[]) => getConnectionMock(...args),
  getConnectionById: (...args: unknown[]) => getConnectionMock(...args),
  getConnectionForMapping: (...args: unknown[]) => getConnectionMock(...args),
}));
const getConnectionByIdMock = getConnectionMock;

const { providerSupportsMock } = vi.hoisted(() => ({ providerSupportsMock: vi.fn((_id: string, _cap: string) => true) }));
vi.mock('../services/accounting/providerRegistry', async (importOriginal) => ({
  providerSupports: providerSupportsMock,
  findAccountingProvider: (id: string) => ({ id, limits: { rate: { provider: id } } }),
  LEGACY_UNTARGETED_JOB_PROVIDER: 'quickbooks',
  // Real display names: the not-connected skip labels the row by its provider.
  accountingProviderDisplayName:
    (await importOriginal<typeof import('../services/accounting/providerRegistry')>()).accountingProviderDisplayName,
}));

const { pushInvoiceMock, voidInvoiceMock } = vi.hoisted(() => ({
  pushInvoiceMock: vi.fn(),
  voidInvoiceMock: vi.fn(),
}));
// Real AccountingInvoicePushError class is kept (not mocked) so instanceof
// checks in the worker's terminal/retryable branch actually exercise the real
// taxonomy, mirroring invoiceService.test.ts's CatalogServiceError pattern.
vi.mock('../services/accounting/accountingInvoicePush', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/accounting/accountingInvoicePush')>();
  return {
    ...actual,
    pushInvoiceToAccounting: pushInvoiceMock,
    voidInvoiceInAccounting: voidInvoiceMock,
  };
});

const { pushPaymentMock, deletePaymentMock, noteSkippedMock, awaitsRemoteRefMock } = vi.hoisted(() => ({
  pushPaymentMock: vi.fn(), deletePaymentMock: vi.fn(), noteSkippedMock: vi.fn(),
  awaitsRemoteRefMock: vi.fn(),
}));
// The REAL AccountingPaymentPushError class and PAYMENT_NOT_CONNECTED_MESSAGE
// are kept so the worker's instanceof/terminal branch exercises the real
// taxonomy and the skip test asserts the shipped string.
vi.mock('../services/accounting/accountingPaymentPush', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/accounting/accountingPaymentPush')>();
  return {
    ...actual,
    pushPaymentToAccounting: pushPaymentMock,
    deletePaymentInAccounting: deletePaymentMock,
    notePaymentJobSkipped: noteSkippedMock,
    paymentDeleteAwaitsRemoteRef: awaitsRemoteRefMock,
  };
});

import {
  processAccountingSyncJob,
  enqueueAccountingInvoicePush,
  enqueueAccountingInvoiceVoid,
  enqueueAccountingPaymentPush,
  enqueueAccountingPaymentDelete,
} from './accountingSyncWorker';
import { AccountingInvoicePushError, type AccountingInvoicePushErrorCode } from '../services/accounting/accountingInvoicePush';
import {
  AccountingPaymentPushError,
  PAYMENT_NOT_CONNECTED_MESSAGE,
  type AccountingPaymentPushErrorCode,
} from '../services/accounting/accountingPaymentPush';

const INV_ID = '11111111-1111-1111-1111-111111111111';
const PARTNER_ID = '22222222-2222-2222-2222-222222222222';

function connectionRow(overrides: Record<string, unknown> = {}) {
  return { id: 'conn-1', provider: 'quickbooks', status: 'connected', pushMode: 'auto', ...overrides };
}

describe('processAccountingSyncJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs outside any DB context and hands the coordinator a LABELLED system-context runner', async () => {
    getConnectionMock.mockResolvedValue(connectionRow());
    pushInvoiceMock.mockResolvedValue({});

    await processAccountingSyncJob({ type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID });

    expect(runOutsideDbContextMock).toHaveBeenCalledOnce();
    // Exactly ONE context so far — the connection gate read. The coordinator
    // opens the rest itself, per phase, through the runner it was handed.
    // Wrapping the whole job in one context (the old shape) held a pooled
    // connection across every QuickBooks call and rolled back the
    // coordinator's error markers.
    expect(withSystemDbAccessContextMock).toHaveBeenCalledOnce();
    expect(withSystemDbAccessContextMock).toHaveBeenCalledWith(expect.any(Function), 'accountingSync.push-invoice');

    const [invoiceId, partnerId, runInDbContext] = pushInvoiceMock.mock.calls[0]!;
    expect(invoiceId).toBe(INV_ID);
    expect(partnerId).toBe(PARTNER_ID);
    // The runner really opens a system context — not an identity passthrough
    // that would silently leave every phase contextless.
    withSystemDbAccessContextMock.mockClear();
    await (runInDbContext as <T>(fn: () => Promise<T>) => Promise<T>)(async () => 'phase');
    expect(withSystemDbAccessContextMock).toHaveBeenCalledWith(expect.any(Function), 'accountingSync.push-invoice');
  });

  it('returns without calling the coordinator when there is no QuickBooks connection', async () => {
    getConnectionMock.mockResolvedValue(null);

    await processAccountingSyncJob({ type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID });

    expect(pushInvoiceMock).not.toHaveBeenCalled();
    expect(voidInvoiceMock).not.toHaveBeenCalled();
  });

  it('returns without calling the coordinator when the connection is not status=connected', async () => {
    getConnectionMock.mockResolvedValue(connectionRow({ status: 'reauth_required' }));

    await processAccountingSyncJob({ type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID });
    await processAccountingSyncJob({ type: 'void-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID });

    expect(pushInvoiceMock).not.toHaveBeenCalled();
    expect(voidInvoiceMock).not.toHaveBeenCalled();
  });

  it('skips a push job when pushMode is manual', async () => {
    getConnectionMock.mockResolvedValue(connectionRow({ pushMode: 'manual' }));

    await processAccountingSyncJob({ type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID });

    expect(pushInvoiceMock).not.toHaveBeenCalled();
  });

  // #7251: pushMode gates AUTOMATIC pushes (issue / quote-accept hooks) only.
  // An operator who bulk-pushes in manual mode asked for exactly this push.
  it('runs an OPERATOR push job when pushMode is manual (#7251)', async () => {
    getConnectionMock.mockResolvedValue(connectionRow({ pushMode: 'manual' }));
    pushInvoiceMock.mockResolvedValue({});

    await processAccountingSyncJob({ type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID, connectionId: 'conn-1', requestedBy: 'operator' });

    expect(pushInvoiceMock).toHaveBeenCalledWith(INV_ID, PARTNER_ID, expect.any(Function), { connectionId: 'conn-1' });
  });

  it('still skips an AUTOMATIC push job (no marker — also every job enqueued before #7251) when pushMode is manual', async () => {
    getConnectionMock.mockResolvedValue(connectionRow({ pushMode: 'manual' }));

    await processAccountingSyncJob({ type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID, connectionId: 'conn-1' });

    expect(pushInvoiceMock).not.toHaveBeenCalled();
  });

  it('runs both operator and automatic push jobs when pushMode is auto', async () => {
    getConnectionMock.mockResolvedValue(connectionRow({ pushMode: 'auto' }));
    pushInvoiceMock.mockResolvedValue({});

    await processAccountingSyncJob({ type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID, connectionId: 'conn-1', requestedBy: 'operator' });
    await processAccountingSyncJob({ type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID, connectionId: 'conn-1' });

    expect(pushInvoiceMock).toHaveBeenCalledTimes(2);
  });

  it('still processes a void job when pushMode is manual — books must not keep a voided invoice open', async () => {
    getConnectionMock.mockResolvedValue(connectionRow({ pushMode: 'manual' }));
    voidInvoiceMock.mockResolvedValue(undefined);

    await processAccountingSyncJob({ type: 'void-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID });

    expect(voidInvoiceMock).toHaveBeenCalledWith(INV_ID, PARTNER_ID, expect.any(Function), { connectionId: 'conn-1' });
  });

  const terminalCodes: Array<[AccountingInvoicePushErrorCode, 404 | 409 | 502]> = [
    ['invoice_not_pushable', 409],
    ['customer_not_mapped', 409],
    ['home_currency_unknown', 409],
    ['currency_mismatch', 409],
    ['customer_currency_mismatch', 409],
    ['dependency_not_ready', 409],
    ['not_connected', 404],
    ['reauth_required', 409],
    ['record_failed', 502],
    // #5180: QuickBooks refusing to void an invoice a Payment settles is a
    // RULE, not an outage — five retries got five identical refusals and five
    // Sentry alerts in production.
    ['void_blocked_by_payments', 409],
    // #7161: the pushed lines do not sum to the invoice subtotal — a data
    // problem on the Breeze side that every retry would refuse identically.
    ['invoice_totals_mismatch', 409],
  ];

  it.each(terminalCodes)('is terminal for code=%s (%d) — logs and does NOT rethrow', async (code, status) => {
    getConnectionMock.mockResolvedValue(connectionRow());
    pushInvoiceMock.mockRejectedValue(new AccountingInvoicePushError(code, status, `boom ${code}`));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      processAccountingSyncJob({ type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID }),
    ).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it.each(['push_settings_incomplete', 'remote_missing', 'remote_locked', 'provider_permission'] as const)(
    'a %s push failure is terminal and not reported to Sentry (Xero W04)',
    async (code) => {
      getConnectionMock.mockResolvedValue(connectionRow());
      pushInvoiceMock.mockRejectedValue(new AccountingInvoicePushError(code, 409, 'user must act'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        processAccountingSyncJob({ type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID }),
      ).resolves.toBeUndefined();

      expect(pushInvoiceMock).toHaveBeenCalledTimes(1);
      expect(errSpy).toHaveBeenCalledWith('[AccountingSyncWorker] terminal failure, not retrying', expect.anything(), expect.anything(), `code=${code}`, 'user must act');
      expect(captureExceptionMock).not.toHaveBeenCalled();
      errSpy.mockRestore();
    },
  );

  it('remote_ambiguous is terminal and IS reported (it should never happen)', async () => {
    getConnectionMock.mockResolvedValue(connectionRow());
    pushInvoiceMock.mockRejectedValue(new AccountingInvoicePushError('remote_ambiguous', 409, 'two invoices'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      processAccountingSyncJob({ type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID }),
    ).resolves.toBeUndefined();

    expect(pushInvoiceMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('rethrows sync_in_progress (409) so BullMQ retries — a void that raced a mid-flight push is NOT terminal', async () => {
    getConnectionMock.mockResolvedValue(connectionRow());
    const err = new AccountingInvoicePushError('sync_in_progress', 409, 'push still in flight');
    voidInvoiceMock.mockRejectedValue(err);

    await expect(
      processAccountingSyncJob({ type: 'void-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID }),
    ).rejects.toBe(err);
  });

  it('rethrows provider_error (502) so BullMQ retries', async () => {
    getConnectionMock.mockResolvedValue(connectionRow());
    const err = new AccountingInvoicePushError('provider_error', 502, 'upstream QuickBooks failure');
    pushInvoiceMock.mockRejectedValue(err);

    await expect(
      processAccountingSyncJob({ type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID }),
    ).rejects.toBe(err);
  });

  it('treats the legacy quickbooks_error code as retryable (dead alias, Xero W01)', async () => {
    getConnectionMock.mockResolvedValue(connectionRow());
    const err = new AccountingInvoicePushError('quickbooks_error', 502, 'x');
    pushInvoiceMock.mockRejectedValue(err);

    await expect(
      processAccountingSyncJob({ type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID }),
    ).rejects.toBe(err);
  });

  it('rethrows an unexpected non-typed error so BullMQ retries', async () => {
    getConnectionMock.mockResolvedValue(connectionRow());
    const err = new Error('unexpected boom');
    pushInvoiceMock.mockRejectedValue(err);

    await expect(
      processAccountingSyncJob({ type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID }),
    ).rejects.toBe(err);
  });

  it('does NOT rethrow a void_blocked_by_payments void failure — no retry ladder on a QuickBooks rule (#5180)', async () => {
    // The sibling table above proves the code is terminal on the PUSH path.
    // This is the path the production incident actually took: the void job.
    getConnectionMock.mockResolvedValue(connectionRow());
    voidInvoiceMock.mockRejectedValue(new AccountingInvoicePushError(
      'void_blocked_by_payments', 409,
      'QuickBooks will not void this invoice because a payment is applied to it there',
    ));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      processAccountingSyncJob({ type: 'void-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID }),
    ).resolves.toBeUndefined();

    expect(voidInvoiceMock).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('a terminal void failure is also swallowed, not rethrown', async () => {
    getConnectionMock.mockResolvedValue(connectionRow());
    voidInvoiceMock.mockRejectedValue(new AccountingInvoicePushError('not_connected', 404, 'no connection'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      processAccountingSyncJob({ type: 'void-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID }),
    ).resolves.toBeUndefined();
    errSpy.mockRestore();
  });
});

describe('enqueueAccountingInvoicePush / enqueueAccountingInvoiceVoid (Redis-outage-safe)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enqueues a push-invoice job with a stable, colon-free jobId and the retry policy', async () => {
    queueAddMock.mockResolvedValue({ id: 'j1' });
    await enqueueAccountingInvoicePush(INV_ID, PARTNER_ID, 'conn-1');
    expect(queueAddMock).toHaveBeenCalledWith(
      'push-invoice',
      { type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID, connectionId: 'conn-1' },
      expect.objectContaining({
        jobId: `accounting-push-${INV_ID}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        // NOT a retained count: BullMQ silently drops an add() whose jobId is
        // still in the completed/failed sets, so retaining jobs made a
        // re-push of a fixed mapping a no-op the route still called
        // "enqueued". In-flight dedup (wait/active) is unaffected.
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
    const jobId = queueAddMock.mock.calls[0]![2].jobId as string;
    expect(jobId).not.toContain(':');
  });

  it('marks an operator push and gives it its OWN jobId so a pending automatic job cannot swallow it (#7251)', async () => {
    queueAddMock.mockResolvedValue({ id: 'j1' });
    await expect(enqueueAccountingInvoicePush(INV_ID, PARTNER_ID, 'conn-1', { requestedBy: 'operator' })).resolves.toBe(true);
    expect(queueAddMock).toHaveBeenCalledWith(
      'push-invoice',
      { type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID, connectionId: 'conn-1', requestedBy: 'operator' },
      expect.objectContaining({
        jobId: `accounting-push-operator-${INV_ID}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
    const jobId = queueAddMock.mock.calls[0]![2].jobId as string;
    // BullMQ dedupes on jobId: sharing `accounting-push-<id>` with the issue
    // hook's automatic job (which a manual-mode worker drops) would make the
    // operator's request a silent no-op while it sits in wait/delayed.
    expect(jobId).not.toBe(`accounting-push-${INV_ID}`);
    expect(jobId).not.toContain(':');
  });

  it('enqueues a void-invoice job with a stable, colon-free jobId and the retry policy', async () => {
    queueAddMock.mockResolvedValue({ id: 'j1' });
    await enqueueAccountingInvoiceVoid(INV_ID, PARTNER_ID, 'conn-1');
    expect(queueAddMock).toHaveBeenCalledWith(
      'void-invoice',
      { type: 'void-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID, connectionId: 'conn-1' },
      expect.objectContaining({ jobId: `accounting-void-${INV_ID}` }),
    );
    const opts = queueAddMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
    expect((opts.jobId as string)).not.toContain(':');
  });

  it('reports acceptance so the bulk route can count honestly', async () => {
    queueAddMock.mockResolvedValue({ id: 'j1' });
    await expect(enqueueAccountingInvoicePush(INV_ID, PARTNER_ID, 'conn-1')).resolves.toBe(true);
    await expect(enqueueAccountingInvoiceVoid(INV_ID, PARTNER_ID, 'conn-1')).resolves.toBe(true);
  });

  it('never throws when the queue add fails (e.g. Redis down) — push — and reports false', async () => {
    queueAddMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(enqueueAccountingInvoicePush(INV_ID, PARTNER_ID, 'conn-1')).resolves.toBe(false);
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it('never throws when the queue add fails (e.g. Redis down) — void — and reports false', async () => {
    queueAddMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(enqueueAccountingInvoiceVoid(INV_ID, PARTNER_ID, 'conn-1')).resolves.toBe(false);
    expect(captureExceptionMock).toHaveBeenCalled();
  });
});

const MAPPING_ID = '33333333-3333-3333-3333-333333333333';

describe('payment jobs', () => {
  beforeEach(() => {
    // The two sibling describes above each clear mocks in their own
    // beforeEach; this one does too, so a call left over from an earlier test
    // in THIS describe (e.g. the converted_to_delete enqueue below) can never
    // leak into the exact `queueAddMock.mock.calls` assertion further down.
    vi.clearAllMocks();
    getConnectionMock.mockResolvedValue({ id: 'c1', provider: 'quickbooks', status: 'connected', pushMode: 'auto', pullPayments: true, pushPayments: true });
    pushPaymentMock.mockResolvedValue('pushed');
    deletePaymentMock.mockResolvedValue('deleted');
    awaitsRemoteRefMock.mockResolvedValue(false);
  });

  it('runs a push-payment job through the coordinator with a SYSTEM runner and no ambient context', async () => {
    await processAccountingSyncJob({ type: 'push-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID });
    expect(runOutsideDbContextMock).toHaveBeenCalled();
    expect(pushPaymentMock).toHaveBeenCalledWith(MAPPING_ID, PARTNER_ID, expect.any(Function), { connectionId: 'c1' });
  });

  it('does NOT apply the pushMode gate to payment jobs — the coordinator owns that', async () => {
    // The pushMode gate exists for push-invoice only. requestPaymentPush already
    // refused to create the mapping in manual mode, so a payment job that EXISTS
    // in manual mode came from the manual fan-out and must run.
    getConnectionMock.mockResolvedValue({ id: 'c1', provider: 'quickbooks', status: 'connected', pushMode: 'manual', pushPayments: true });
    await processAccountingSyncJob({ type: 'push-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID });
    expect(pushPaymentMock).toHaveBeenCalled();
  });

  it('enqueues the follow-up delete when a push converted itself to one', async () => {
    pushPaymentMock.mockResolvedValueOnce('converted_to_delete');
    await processAccountingSyncJob({ type: 'push-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID });
    expect(queueAddMock).toHaveBeenCalledWith(
      'delete-payment',
      { type: 'delete-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID },
      expect.objectContaining({ jobId: `accounting-payment-${MAPPING_ID}-delete` }),
    );
  });

  it('RECORDS a payment job skipped because QuickBooks is not connected, instead of returning silently', async () => {
    // Finding I2. The mapping row is the OUTBOX, so a silent return left it
    // `pending` with an empty last_error while the 15-minute sweep re-enqueued
    // it forever against a realm that may have been disconnected for weeks.
    getConnectionMock.mockResolvedValue({ id: 'c1', provider: 'quickbooks', status: 'reauth_required', pushMode: 'auto', pushPayments: true });

    await processAccountingSyncJob({ type: 'push-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID });
    await processAccountingSyncJob({ type: 'delete-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID });

    expect(pushPaymentMock).not.toHaveBeenCalled();
    expect(deletePaymentMock).not.toHaveBeenCalled();
    expect(noteSkippedMock.mock.calls).toEqual([
      [MAPPING_ID, PARTNER_ID, PAYMENT_NOT_CONNECTED_MESSAGE],
      [MAPPING_ID, PARTNER_ID, PAYMENT_NOT_CONNECTED_MESSAGE],
    ]);
  });

  it('runs a delete-payment that has NO remote id through the coordinator even while disconnected', async () => {
    // deletePaymentInAccounting's PAYMENT_DELETE_UNRESOLVED_GRACE_MS drop-and-alert
    // path exists precisely for a row whose create was in flight when the payment
    // was destroyed, and it needs NO live realm — everything it does happens
    // before `resolveConnection`. Returning at the not-connected gate made it
    // unreachable, so such a row waited on a reconnect that may never come.
    getConnectionMock.mockResolvedValue({ id: 'c1', provider: 'quickbooks', status: 'reauth_required', pushMode: 'auto', pushPayments: true });
    awaitsRemoteRefMock.mockResolvedValue(true);
    deletePaymentMock.mockResolvedValue('unresolved_dropped');

    await processAccountingSyncJob({ type: 'delete-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID });

    expect(deletePaymentMock).toHaveBeenCalledWith(MAPPING_ID, PARTNER_ID, expect.any(Function), undefined);
    expect(noteSkippedMock).not.toHaveBeenCalled();
  });

  it('still records the skip for a disconnected delete-payment that DOES carry a remote id', async () => {
    // That one genuinely needs a live realm to reach QuickBooks with.
    getConnectionMock.mockResolvedValue({ id: 'c1', provider: 'quickbooks', status: 'reauth_required', pushMode: 'auto', pushPayments: true });
    awaitsRemoteRefMock.mockResolvedValue(false);

    await processAccountingSyncJob({ type: 'delete-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID });

    expect(deletePaymentMock).not.toHaveBeenCalled();
    expect(noteSkippedMock).toHaveBeenCalledWith(MAPPING_ID, PARTNER_ID, PAYMENT_NOT_CONNECTED_MESSAGE);
  });

  it('labels the not-connected skip with the row\'s OWN provider (Xero W05b F4)', async () => {
    // The mapping row binds to a Xero connection: stamping "QuickBooks is not
    // connected" on it would send the operator to the wrong integration.
    getConnectionMock.mockResolvedValue({ id: 'c1', provider: 'xero', status: 'reauth_required', pushMode: 'auto', pushPayments: true });
    awaitsRemoteRefMock.mockResolvedValue(false);

    await processAccountingSyncJob({ type: 'push-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID });
    await processAccountingSyncJob({ type: 'delete-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID });

    expect(noteSkippedMock.mock.calls).toEqual([
      [MAPPING_ID, PARTNER_ID, 'Xero is not connected'],
      [MAPPING_ID, PARTNER_ID, 'Xero is not connected'],
    ]);
  });

  it('records the same skip when there is no QuickBooks connection row at all', async () => {
    getConnectionMock.mockResolvedValue(null);

    await processAccountingSyncJob({ type: 'push-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID });

    expect(noteSkippedMock).toHaveBeenCalledWith(MAPPING_ID, PARTNER_ID, PAYMENT_NOT_CONNECTED_MESSAGE);
  });

  it('does NOT record a skip for an INVOICE job — those carry no mapping id to stamp', async () => {
    getConnectionMock.mockResolvedValue(null);

    await processAccountingSyncJob({ type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID });
    await processAccountingSyncJob({ type: 'void-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID });

    expect(noteSkippedMock).not.toHaveBeenCalled();
  });

  it('runs a delete-payment job even when the connection has both switches off', async () => {
    getConnectionMock.mockResolvedValue({ id: 'c1', provider: 'quickbooks', status: 'connected', pushMode: 'manual', pushPayments: false });
    await processAccountingSyncJob({ type: 'delete-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID });
    expect(deletePaymentMock).toHaveBeenCalledWith(MAPPING_ID, PARTNER_ID, expect.any(Function), { connectionId: 'c1' });
  });

  it('treats a delete-payment TERMINAL code (not_connected) as logged, not rethrown', async () => {
    deletePaymentMock.mockRejectedValueOnce(new AccountingPaymentPushError('not_connected', 404, 'gone'));
    await expect(processAccountingSyncJob({ type: 'delete-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID }))
      .resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it('rethrows a delete-payment RETRYABLE code (provider_error) so BullMQ retries', async () => {
    deletePaymentMock.mockRejectedValueOnce(new AccountingPaymentPushError('provider_error', 502, 'upstream'));
    await expect(processAccountingSyncJob({ type: 'delete-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID }))
      .rejects.toThrow('upstream');
  });

  it('enqueues nothing on a plain pushed outcome — the follow-up delete is only for converted_to_delete', async () => {
    pushPaymentMock.mockResolvedValueOnce('pushed');
    await processAccountingSyncJob({ type: 'push-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID });
    expect(queueAddMock).not.toHaveBeenCalled();
  });

  it.each<AccountingPaymentPushErrorCode>([
    'push_disabled', 'customer_not_mapped', 'currency_mismatch', 'home_currency_unknown',
    'invoice_void', 'record_failed', 'not_connected', 'reauth_required',
  ])('treats %s as TERMINAL — logged, not rethrown', async (code) => {
    pushPaymentMock.mockRejectedValueOnce(new AccountingPaymentPushError(code, 409, 'nope'));
    await expect(processAccountingSyncJob({ type: 'push-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID }))
      .resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it.each<AccountingPaymentPushErrorCode>([
    'push_settings_incomplete', 'remote_missing', 'remote_locked', 'provider_permission', 'amount_exceeds_due', 'remote_deleted',
  ])('treats %s as TERMINAL and QUIET — no retry, no Sentry (Xero W05 refinement 16)', async (code) => {
    pushPaymentMock.mockRejectedValueOnce(new AccountingPaymentPushError(code, 409, 'resolve it'));
    await expect(processAccountingSyncJob({ type: 'push-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID }))
      .resolves.toBeUndefined();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('remote_ambiguous is terminal and NOT re-reported by the worker (the coordinator already captured it)', async () => {
    // The coordinator's create-catch is the ONE Sentry report, with the
    // provider telemetry tags only it has; a second capture here doubled every
    // event (Xero W05b F3).
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    pushPaymentMock.mockRejectedValueOnce(new AccountingPaymentPushError('remote_ambiguous', 409, 'two'));
    await expect(processAccountingSyncJob({ type: 'push-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID }))
      .resolves.toBeUndefined();
    expect(pushPaymentMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      '[AccountingSyncWorker] terminal payment failure, not retrying',
      'type=push-payment', `mappingId=${MAPPING_ID}`, 'code=remote_ambiguous', 'two',
    );
    errorSpy.mockRestore();
  });

  it.each<AccountingPaymentPushErrorCode>(['record_failed', 'customer_not_mapped', 'invoice_void'])(
    'pre-W05 terminal %s still reaches Sentry from the worker (QuickBooks telemetry unchanged)', async (code) => {
      pushPaymentMock.mockRejectedValueOnce(new AccountingPaymentPushError(code, 409, 'x'));
      await expect(processAccountingSyncJob({ type: 'push-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID }))
        .resolves.toBeUndefined();
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each<AccountingPaymentPushErrorCode>(['provider_error', 'sync_in_progress', 'invoice_not_synced'])(
    'rethrows %s so BullMQ retries', async (code) => {
      pushPaymentMock.mockRejectedValueOnce(new AccountingPaymentPushError(code, 502, 'later'));
      await expect(processAccountingSyncJob({ type: 'push-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID }))
        .rejects.toThrow('later');
    });

  it('uses per-operation jobIds so a delete is never swallowed by a live push job', async () => {
    await enqueueAccountingPaymentPush(MAPPING_ID, PARTNER_ID);
    await enqueueAccountingPaymentDelete(MAPPING_ID, PARTNER_ID);
    const ids = queueAddMock.mock.calls.map((c) => (c[2] as { jobId: string }).jobId);
    expect(ids).toEqual([`accounting-payment-${MAPPING_ID}-push`, `accounting-payment-${MAPPING_ID}-delete`]);
    expect(ids.every((id) => !id.includes(':'))).toBe(true);
    expect(queueAddMock.mock.calls[0]![2]).toEqual({
      jobId: `accounting-payment-${MAPPING_ID}-push`,
      attempts: 5, backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true, removeOnFail: true,
    });
  });

  it('swallows a Redis outage into false rather than failing the caller', async () => {
    queueAddMock.mockRejectedValueOnce(new Error('redis down'));
    await expect(enqueueAccountingPaymentPush(MAPPING_ID, PARTNER_ID)).resolves.toBe(false);
    expect(captureExceptionMock).toHaveBeenCalled();
  });
});

const { syncMappingMock } = vi.hoisted(() => ({ syncMappingMock: vi.fn() }));
vi.mock('../services/accounting/accountingMappingService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/accounting/accountingMappingService')>();
  return { ...actual, syncMappedEntity: syncMappingMock };
});
import { AccountingMappingError, type AccountingMappingErrorCode } from '../services/accounting/accountingMappingService';
import { enqueueAccountingMappingSync, processMappingSweep } from './accountingSyncWorker';
import { PgDialect } from 'drizzle-orm/pg-core';

const mappingJob = { type: 'sync-mapping' as const, breezeEntityType: 'org' as const, breezeEntityId: INV_ID, partnerId: PARTNER_ID };
describe('mapping jobs and recovery sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueAddMock.mockResolvedValue({ id: 'job' });
    queueGetJobMock.mockResolvedValue(undefined);
    syncMappingMock.mockResolvedValue({});
    getConnectionMock.mockResolvedValue(connectionRow({ pushMode: 'manual' }));
  });
  it('syncs mappings outside the DB context with a system runner even in manual mode', async () => {
    await processAccountingSyncJob(mappingJob);
    expect(syncMappingMock).toHaveBeenCalledWith({ partnerId: PARTNER_ID, provider: 'quickbooks', breezeEntityType: 'org', breezeEntityId: INV_ID }, expect.any(Function), { connectionId: 'conn-1' });
    expect(runOutsideDbContextMock).toHaveBeenCalled();
    const runner = syncMappingMock.mock.calls[0]![1];
    await runner(async () => undefined);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledWith(expect.any(Function), 'accountingSync.sync-mapping');
  });
  it.each<AccountingMappingErrorCode>(['currency_mismatch', 'income_account_required', 'item_price_required', 'mapping_not_ready', 'mapping_conflict', 'entity_not_found', 'not_connected', 'reauth_required'])('does not retry terminal %s', async code => {
    syncMappingMock.mockRejectedValueOnce(new AccountingMappingError(code, 409, 'refused'));
    await expect(processAccountingSyncJob(mappingJob)).resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalled();
  });
  it.each<AccountingMappingErrorCode>(['duplicate_name', 'remote_archived', 'remote_missing', 'provider_permission'])(
    'does not retry user-resolvable %s and does not report it to Sentry (Xero W03)',
    async (code) => {
      syncMappingMock.mockRejectedValueOnce(new AccountingMappingError(code, 409, 'x'));
      await expect(processAccountingSyncJob(mappingJob)).resolves.toBeUndefined();
      expect(captureExceptionMock).not.toHaveBeenCalled();
    },
  );
  it('does not retry provider_rejected (a code-less provider validation error) and does not re-report it (#7292)', async () => {
    // The coordinator already sent the one Sentry event; a retry can never succeed.
    syncMappingMock.mockRejectedValueOnce(new AccountingMappingError('provider_rejected', 409, 'Xero rejected the customer sync'));
    await expect(processAccountingSyncJob(mappingJob)).resolves.toBeUndefined();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
  it('does not retry a remote write whose local persistence failed', async () => {
    syncMappingMock.mockRejectedValueOnce(new AccountingMappingError('record_failed', 502, 'remote write landed'));
    await expect(processAccountingSyncJob(mappingJob)).resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalled();
  });
  it('rethrows provider errors for the existing retry policy', async () => {
    syncMappingMock.mockRejectedValueOnce(new AccountingMappingError('provider_error', 502, 'retry'));
    await expect(processAccountingSyncJob(mappingJob)).rejects.toThrow('retry');
  });
  it('retries when an explicit client sync holds the mapping lease', async () => {
    syncMappingMock.mockRejectedValueOnce(new AccountingMappingError('sync_in_progress', 409, 'lease busy'));
    await expect(processAccountingSyncJob(mappingJob)).rejects.toThrow('lease busy');
  });
  it('rethrows unexpected failures so BullMQ retries', async () => {
    syncMappingMock.mockRejectedValueOnce(new Error('lock busy'));
    await expect(processAccountingSyncJob(mappingJob)).rejects.toThrow('lock busy');
  });
  it('lets the coordinator handle a disconnected mapping without suppressing its refusal', async () => {
    getConnectionMock.mockResolvedValueOnce(null);
    syncMappingMock.mockRejectedValueOnce(new AccountingMappingError('not_connected', 404, 'reconnect'));
    await expect(processAccountingSyncJob(mappingJob)).resolves.toBeUndefined();
    expect(syncMappingMock).toHaveBeenCalledOnce();
    expect(captureExceptionMock).toHaveBeenCalled();
  });
  it('enqueues with a tenant-qualified stable ID and queue retry policy', async () => {
    await expect(enqueueAccountingMappingSync('org', INV_ID, PARTNER_ID, 'conn-1')).resolves.toBe(true);
    expect(queueAddMock).toHaveBeenCalledWith('sync-mapping', { ...mappingJob, connectionId: 'conn-1' }, { jobId: `accounting-mapping-${PARTNER_ID}-org-${INV_ID}`, attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: true });
  });
  it('reports enqueue outages so the sweep can recover', async () => {
    queueAddMock.mockRejectedValueOnce(new Error('redis down'));
    await expect(enqueueAccountingMappingSync('org', INV_ID, PARTNER_ID, 'conn-1')).resolves.toBe(false);
  });
  it('sweeps only stale pending decisions and skips jobs already in flight', async () => {
    const now = new Date('2026-09-16T12:00:00Z');
    selectWhereMock.mockResolvedValueOnce([mappingJob, { ...mappingJob, breezeEntityId: MAPPING_ID }]);
    queueGetJobMock.mockResolvedValueOnce({ getState: async () => 'active' });
    await expect(processMappingSweep(now)).resolves.toEqual({ enqueued: 1, failed: 0, deferred: 0 });
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(queueAddMock.mock.calls[0]![1].breezeEntityId).toBe(MAPPING_ID);
    const query = new PgDialect().sqlToQuery(selectWhereMock.mock.calls[0]![0]);
    expect(query.sql).toContain('"sync_status" =');
    expect(query.sql).toContain('"updated_at" <');
    expect(query.params).toEqual(expect.arrayContaining(['pending', 'confirmed', 'create_new', 'org', 'catalog_item', '2026-09-16T11:45:00.000Z']));
  });
  it.each(['waiting', 'active', 'delayed', 'prioritized'])('does not enqueue an in-flight %s job', async state => {
    selectWhereMock.mockResolvedValueOnce([mappingJob]);
    queueGetJobMock.mockResolvedValueOnce({ getState: async () => state });
    await expect(processMappingSweep()).resolves.toEqual({ enqueued: 0, failed: 0, deferred: 0 });
    expect(queueAddMock).not.toHaveBeenCalled();
  });
  it('releases the sweep DB context before enqueue and reports Redis outages', async () => {
    let inContext = false;
    withSystemDbAccessContextMock.mockImplementationOnce(async fn => {
      inContext = true;
      try { return await fn(); } finally { inContext = false; }
    });
    selectWhereMock.mockResolvedValueOnce([mappingJob]);
    queueAddMock.mockImplementationOnce(async () => {
      expect(inContext).toBe(false);
      throw new Error('redis down');
    });
    await expect(processMappingSweep()).resolves.toEqual({ enqueued: 0, failed: 1, deferred: 0 });
    expect(runOutsideDbContextMock).toHaveBeenCalled();
  });
  it('dispatches the scheduled sweep and rethrows a failed DB read', async () => {
    selectWhereMock.mockRejectedValueOnce(new Error('db down'));
    await expect(processAccountingSyncJob({ type: 'mapping-sweep' })).rejects.toThrow('db down');
    expect(queueAddMock).not.toHaveBeenCalled();
  });
});

describe('connectionId + capability gates (Xero W01)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    pushInvoiceMock.mockResolvedValue({});
    syncMappingMock.mockResolvedValue({});
    queueAddMock.mockResolvedValue({ id: 'job' });
    queueGetJobMock.mockResolvedValue(undefined);
  });

  it('a job for a replaced connection completes without calling the coordinator', async () => {
    getConnectionByIdMock.mockResolvedValue(null);
    await processAccountingSyncJob({ type: 'push-invoice', invoiceId: 'i1', partnerId: 'p1', connectionId: 'c-old' });
    expect(pushInvoiceMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[AccountingSyncWorker] job dropped'), 'reason=connection_gone', 'type=push-invoice', expect.anything(), expect.anything());
  });

  it('a targeted job passes { connectionId } through to the coordinator', async () => {
    getConnectionByIdMock.mockResolvedValue(connectionRow({ id: 'c1', provider: 'quickbooks' }));
    await processAccountingSyncJob({ type: 'push-invoice', invoiceId: 'i1', partnerId: 'p1', connectionId: 'c1' });
    expect(pushInvoiceMock).toHaveBeenCalledWith('i1', 'p1', expect.any(Function), { connectionId: 'c1' });
  });

  it('a targeted void passes { connectionId } through to the coordinator', async () => {
    getConnectionByIdMock.mockResolvedValue(connectionRow({ id: 'c1' }));
    voidInvoiceMock.mockResolvedValue(undefined);
    await processAccountingSyncJob({ type: 'void-invoice', invoiceId: 'i1', partnerId: 'p1', connectionId: 'c1' });
    expect(voidInvoiceMock).toHaveBeenCalledWith('i1', 'p1', expect.any(Function), { connectionId: 'c1' });
  });

  it('drops a legacy (connectionId-less) job when the partner\'s active connection is not QuickBooks', async () => {
    getConnectionMock.mockResolvedValue(connectionRow({ id: 'c-xero', provider: 'xero' }));
    await processAccountingSyncJob({ type: 'push-invoice', invoiceId: 'i1', partnerId: 'p1' });
    await processAccountingSyncJob({ type: 'void-invoice', invoiceId: 'i1', partnerId: 'p1' });
    expect(pushInvoiceMock).not.toHaveBeenCalled();
    expect(voidInvoiceMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('[AccountingSyncWorker] job dropped', 'reason=legacy_non_quickbooks', 'type=push-invoice', 'partnerId=p1', 'connectionId=legacy');
  });

  it('drops a targeted job whose provider lacks the capability', async () => {
    getConnectionByIdMock.mockResolvedValue(connectionRow({ id: 'c-xero', provider: 'xero' }));
    providerSupportsMock.mockReturnValueOnce(false);
    await processAccountingSyncJob({ type: 'push-invoice', invoiceId: 'i1', partnerId: 'p1', connectionId: 'c-xero' });
    expect(providerSupportsMock).toHaveBeenCalledWith('xero', 'invoicePush');
    expect(pushInvoiceMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('[AccountingSyncWorker] job dropped', 'reason=capability_unavailable', 'type=push-invoice', 'partnerId=p1', 'connectionId=c-xero');
  });

  it('drops a payment job whose mapping\'s provider cannot push payments — no coordinator, no skip stamp', async () => {
    getConnectionMock.mockResolvedValue(connectionRow({ id: 'c-xero', provider: 'xero' }));
    providerSupportsMock.mockReturnValueOnce(false);
    await processAccountingSyncJob({ type: 'push-payment', mappingId: 'm1', partnerId: 'p1' });
    expect(providerSupportsMock).toHaveBeenCalledWith('xero', 'paymentPush');
    expect(pushPaymentMock).not.toHaveBeenCalled();
    expect(noteSkippedMock).not.toHaveBeenCalled();
  });

  it('a payment job targets the connection its mapping row belongs to', async () => {
    getConnectionMock.mockResolvedValue(connectionRow({ id: 'c-map' }));
    pushPaymentMock.mockResolvedValue('pushed');
    await processAccountingSyncJob({ type: 'push-payment', mappingId: 'm1', partnerId: 'p1' });
    expect(getConnectionMock).toHaveBeenCalledWith(expect.anything(), 'm1', 'p1');
    expect(pushPaymentMock).toHaveBeenCalledWith('m1', 'p1', expect.any(Function), { connectionId: 'c-map' });
  });

  it('a targeted sync-mapping job passes its target to syncMappedEntity and uses the row\'s provider', async () => {
    getConnectionByIdMock.mockResolvedValue(connectionRow({ id: 'c1' }));
    await processAccountingSyncJob({ ...mappingJob, connectionId: 'c1' });
    expect(providerSupportsMock).toHaveBeenCalledWith('quickbooks', 'mapping');
    expect(syncMappingMock).toHaveBeenCalledWith(
      { partnerId: PARTNER_ID, provider: 'quickbooks', breezeEntityType: 'org', breezeEntityId: INV_ID },
      expect.any(Function), { connectionId: 'c1' },
    );
  });

  it('drops a sync-mapping job whose connection is gone', async () => {
    getConnectionByIdMock.mockResolvedValue(null);
    await processAccountingSyncJob({ ...mappingJob, connectionId: 'c-old' });
    expect(syncMappingMock).not.toHaveBeenCalled();
  });

  it('enqueue helpers carry the connectionId in the payload and keep the job ids unchanged', async () => {
    await enqueueAccountingInvoicePush(INV_ID, PARTNER_ID, 'c1');
    await enqueueAccountingInvoiceVoid(INV_ID, PARTNER_ID, 'c1');
    await enqueueAccountingMappingSync('org', INV_ID, PARTNER_ID, 'c1');
    expect(queueAddMock.mock.calls.map((c) => [c[1], (c[2] as { jobId: string }).jobId])).toEqual([
      [{ type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID, connectionId: 'c1' }, `accounting-push-${INV_ID}`],
      [{ type: 'void-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID, connectionId: 'c1' }, `accounting-void-${INV_ID}`],
      [{ ...mappingJob, connectionId: 'c1' }, `accounting-mapping-${PARTNER_ID}-org-${INV_ID}`],
    ]);
  });

  it('the mapping sweep enqueues with each row\'s own connection and skips providers without mapping', async () => {
    selectWhereMock.mockResolvedValueOnce([
      { ...mappingJob, integrationId: 'c-qbo', provider: 'quickbooks' },
      { ...mappingJob, breezeEntityId: MAPPING_ID, integrationId: 'c-xero', provider: 'xero' },
    ]);
    providerSupportsMock.mockImplementation((id: string) => id === 'quickbooks');
    try {
      await expect(processMappingSweep()).resolves.toEqual({ enqueued: 1, failed: 0, deferred: 0 });
    } finally {
      providerSupportsMock.mockImplementation(() => true);
    }
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(queueAddMock.mock.calls[0]![1]).toEqual({ ...mappingJob, connectionId: 'c-qbo' });
  });
});

// ---------------------------------------------------------------------------
// Rate limiting (Xero W01 Task 14): a throttled job goes back to `delayed` at
// Retry-After via moveToDelayed(ts, token) + DelayedError — not a failure, no
// Sentry event, no console.error, and no attempt consumed.
// ---------------------------------------------------------------------------

import { createAccountingSyncWorker } from './accountingSyncWorker';
import { AccountingProviderError } from '../services/accounting/accountingProviderError';

describe('rate limiting (Xero W01 Task 14)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    queueAddMock.mockResolvedValue({ id: 'job' });
    queueGetJobMock.mockResolvedValue(undefined);
    shouldDeferMock.mockResolvedValue(false);
    awaitsRemoteRefMock.mockResolvedValue(false);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  const delayedJob = () => ({ id: 'j1', name: 'x', moveToDelayed: vi.fn(async (_ts: number, _token?: string) => undefined) });

  it('a rate-limited payment job is delayed, not failed (Review Focus 5)', async () => {
    getConnectionMock.mockResolvedValue({ id: 'c1', provider: 'quickbooks', status: 'connected', pushMode: 'auto', pushPayments: true });
    pushPaymentMock.mockRejectedValue(new AccountingPaymentPushError('rate_limited', 429, 'throttled', { retryAfterMs: 30_000 }));
    const job = { moveToDelayed: vi.fn(async () => undefined) };
    await expect(processAccountingSyncJob({ type: 'push-payment', mappingId: 'm1', partnerId: 'p1' }, { job: job as any, token: 't' }))
      .rejects.toMatchObject({ name: 'DelayedError' });
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 't');
  });

  it('a rate-limited delete-payment job is delayed at Retry-After, with no Sentry event and no error log', async () => {
    getConnectionMock.mockResolvedValue(connectionRow({ pushPayments: true }));
    deletePaymentMock.mockRejectedValue(new AccountingPaymentPushError('rate_limited', 429, 'throttled', { retryAfterMs: 30_000 }));
    const job = delayedJob();
    const before = Date.now();

    await expect(processAccountingSyncJob({ type: 'delete-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID }, { job: job as any, token: 'tok' }))
      .rejects.toMatchObject({ name: 'DelayedError' });

    expect(job.moveToDelayed.mock.calls[0]![0]).toBeGreaterThanOrEqual(before + 30_000);
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it.each(['push-invoice', 'void-invoice'] as const)('a rate-limited %s job is delayed, not failed', async (type) => {
    getConnectionMock.mockResolvedValue(connectionRow());
    const mock = type === 'push-invoice' ? pushInvoiceMock : voidInvoiceMock;
    mock.mockRejectedValue(new AccountingInvoicePushError('rate_limited', 429, 'QuickBooks is rate limiting requests; retrying automatically', { retryAfterMs: 20_000 }));
    const job = delayedJob();

    await expect(processAccountingSyncJob({ type, invoiceId: INV_ID, partnerId: PARTNER_ID, connectionId: 'conn-1' }, { job: job as any, token: 'tok' }))
      .rejects.toMatchObject({ name: 'DelayedError' });

    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'tok');
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('a rate-limited sync-mapping job is delayed, not failed', async () => {
    getConnectionMock.mockResolvedValue(connectionRow());
    syncMappingMock.mockRejectedValueOnce(new AccountingMappingError('rate_limited', 429, 'throttled', { retryAfterMs: 10_000 }));
    const job = delayedJob();

    await expect(processAccountingSyncJob({ ...mappingJob, connectionId: 'conn-1' }, { job: job as any, token: 'tok' }))
      .rejects.toMatchObject({ name: 'DelayedError' });

    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'tok');
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('a RAW provider rate limit (e.g. straight from a token refresh) is delayed too', async () => {
    getConnectionMock.mockResolvedValue(connectionRow());
    pushInvoiceMock.mockRejectedValue(new AccountingProviderError({ kind: 'rate_limited', provider: 'quickbooks', operation: 'x', retryAfterMs: 5_000 }));
    const job = delayedJob();

    await expect(processAccountingSyncJob({ type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID, connectionId: 'conn-1' }, { job: job as any, token: 'tok' }))
      .rejects.toMatchObject({ name: 'DelayedError' });
    expect(job.moveToDelayed).toHaveBeenCalledOnce();
  });

  it('without a job context (a direct call) the rate limit is rethrown for the normal retry ladder', async () => {
    getConnectionMock.mockResolvedValue(connectionRow());
    const err = new AccountingInvoicePushError('rate_limited', 429, 'throttled', { retryAfterMs: 20_000 });
    pushInvoiceMock.mockRejectedValue(err);

    await expect(processAccountingSyncJob({ type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID, connectionId: 'conn-1' }))
      .rejects.toBe(err);
  });

  it('a non-rate-limit provider_error still takes the retry ladder (never delayed)', async () => {
    getConnectionMock.mockResolvedValue(connectionRow());
    pushInvoiceMock.mockRejectedValue(new AccountingInvoicePushError('provider_error', 502, 'boom'));
    const job = delayedJob();

    await expect(processAccountingSyncJob({ type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID, connectionId: 'conn-1' }, { job: job as any, token: 'tok' }))
      .rejects.toMatchObject({ code: 'provider_error' });
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('the worker factory passes the job AND its lock token through to the handler', async () => {
    workerProcessors.length = 0;
    createAccountingSyncWorker();
    const processor = workerProcessors[0]!;
    getConnectionMock.mockResolvedValue(connectionRow({ pushPayments: true }));
    pushPaymentMock.mockRejectedValue(new AccountingPaymentPushError('rate_limited', 429, 'throttled', { retryAfterMs: 30_000 }));
    const job = { ...delayedJob(), data: { type: 'push-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID } };

    await expect(processor(job, 'lock-token')).rejects.toMatchObject({ name: 'DelayedError' });
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'lock-token');
  });

  it('the mapping sweep defers a row whose connection is low on daily budget, and reports the count', async () => {
    selectWhereMock.mockResolvedValueOnce([
      { ...mappingJob, integrationId: 'c-low', provider: 'quickbooks' },
      { ...mappingJob, breezeEntityId: MAPPING_ID, integrationId: 'c-ok', provider: 'quickbooks' },
    ]);
    shouldDeferMock.mockImplementation(async (_p: string, _spec: unknown, connectionId: string) => connectionId === 'c-low');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(processMappingSweep()).resolves.toEqual({ enqueued: 1, failed: 0, deferred: 1 });
      expect(logSpy.mock.calls.some((c) => c.some((a) => String(a).includes('deferred=1')))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
    expect(shouldDeferMock).toHaveBeenCalledWith('quickbooks', { provider: 'quickbooks' }, 'c-low');
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(queueAddMock.mock.calls[0]![1]).toMatchObject({ breezeEntityId: MAPPING_ID, connectionId: 'c-ok' });
  });

  it('a rate-limit-DELAYED mapping job is not duplicated by the sweep', async () => {
    selectWhereMock.mockResolvedValueOnce([{ ...mappingJob, integrationId: 'c1', provider: 'quickbooks' }]);
    const remove = vi.fn();
    queueGetJobMock.mockResolvedValueOnce({ getState: async () => 'delayed', remove });

    await expect(processMappingSweep()).resolves.toEqual({ enqueued: 0, failed: 0, deferred: 0 });
    expect(remove).not.toHaveBeenCalled();
    expect(queueAddMock).not.toHaveBeenCalled();
  });
});
