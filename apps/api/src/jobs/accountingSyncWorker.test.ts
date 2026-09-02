import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture queue.add calls without opening a socket, mirroring invoiceWorker.test.ts.
const { queueAddMock } = vi.hoisted(() => ({ queueAddMock: vi.fn() }));
vi.mock('bullmq', () => ({
  Queue: class { add = queueAddMock; },
  Worker: class {},
  Job: class {},
}));
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
  db: {},
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

const { getConnectionMock } = vi.hoisted(() => ({ getConnectionMock: vi.fn() }));
vi.mock('../services/accounting/accountingConnectionService', () => ({
  getConnection: getConnectionMock,
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

const { pushPaymentMock, deletePaymentMock } = vi.hoisted(() => ({
  pushPaymentMock: vi.fn(), deletePaymentMock: vi.fn(),
}));
// The REAL AccountingPaymentPushError class is kept so the worker's
// instanceof/terminal branch exercises the real taxonomy.
vi.mock('../services/accounting/accountingPaymentPush', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/accounting/accountingPaymentPush')>();
  return { ...actual, pushPaymentToAccounting: pushPaymentMock, deletePaymentInAccounting: deletePaymentMock };
});

import {
  processAccountingSyncJob,
  enqueueAccountingInvoicePush,
  enqueueAccountingInvoiceVoid,
  enqueueAccountingPaymentPush,
  enqueueAccountingPaymentDelete,
} from './accountingSyncWorker';
import { AccountingInvoicePushError, type AccountingInvoicePushErrorCode } from '../services/accounting/accountingInvoicePush';
import { AccountingPaymentPushError, type AccountingPaymentPushErrorCode } from '../services/accounting/accountingPaymentPush';

const INV_ID = '11111111-1111-1111-1111-111111111111';
const PARTNER_ID = '22222222-2222-2222-2222-222222222222';

function connectionRow(overrides: Record<string, unknown> = {}) {
  return { id: 'conn-1', status: 'connected', pushMode: 'auto', ...overrides };
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

  it('still processes a void job when pushMode is manual — books must not keep a voided invoice open', async () => {
    getConnectionMock.mockResolvedValue(connectionRow({ pushMode: 'manual' }));
    voidInvoiceMock.mockResolvedValue(undefined);

    await processAccountingSyncJob({ type: 'void-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID });

    expect(voidInvoiceMock).toHaveBeenCalledWith(INV_ID, PARTNER_ID, expect.any(Function));
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

  it('rethrows sync_in_progress (409) so BullMQ retries — a void that raced a mid-flight push is NOT terminal', async () => {
    getConnectionMock.mockResolvedValue(connectionRow());
    const err = new AccountingInvoicePushError('sync_in_progress', 409, 'push still in flight');
    voidInvoiceMock.mockRejectedValue(err);

    await expect(
      processAccountingSyncJob({ type: 'void-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID }),
    ).rejects.toBe(err);
  });

  it('rethrows quickbooks_error (502) so BullMQ retries', async () => {
    getConnectionMock.mockResolvedValue(connectionRow());
    const err = new AccountingInvoicePushError('quickbooks_error', 502, 'upstream QuickBooks failure');
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
    await enqueueAccountingInvoicePush(INV_ID, PARTNER_ID);
    expect(queueAddMock).toHaveBeenCalledWith(
      'push-invoice',
      { type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID },
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

  it('enqueues a void-invoice job with a stable, colon-free jobId and the retry policy', async () => {
    queueAddMock.mockResolvedValue({ id: 'j1' });
    await enqueueAccountingInvoiceVoid(INV_ID, PARTNER_ID);
    expect(queueAddMock).toHaveBeenCalledWith(
      'void-invoice',
      { type: 'void-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID },
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
    await expect(enqueueAccountingInvoicePush(INV_ID, PARTNER_ID)).resolves.toBe(true);
    await expect(enqueueAccountingInvoiceVoid(INV_ID, PARTNER_ID)).resolves.toBe(true);
  });

  it('never throws when the queue add fails (e.g. Redis down) — push — and reports false', async () => {
    queueAddMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(enqueueAccountingInvoicePush(INV_ID, PARTNER_ID)).resolves.toBe(false);
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it('never throws when the queue add fails (e.g. Redis down) — void — and reports false', async () => {
    queueAddMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(enqueueAccountingInvoiceVoid(INV_ID, PARTNER_ID)).resolves.toBe(false);
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
    getConnectionMock.mockResolvedValue({ id: 'c1', status: 'connected', pushMode: 'auto', pullPayments: true, pushPayments: true });
    pushPaymentMock.mockResolvedValue('pushed');
    deletePaymentMock.mockResolvedValue('deleted');
  });

  it('runs a push-payment job through the coordinator with a SYSTEM runner and no ambient context', async () => {
    await processAccountingSyncJob({ type: 'push-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID });
    expect(runOutsideDbContextMock).toHaveBeenCalled();
    expect(pushPaymentMock).toHaveBeenCalledWith(MAPPING_ID, PARTNER_ID, expect.any(Function));
  });

  it('does NOT apply the pushMode gate to payment jobs — the coordinator owns that', async () => {
    // The pushMode gate exists for push-invoice only. requestPaymentPush already
    // refused to create the mapping in manual mode, so a payment job that EXISTS
    // in manual mode came from the manual fan-out and must run.
    getConnectionMock.mockResolvedValue({ id: 'c1', status: 'connected', pushMode: 'manual', pushPayments: true });
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

  it('runs a delete-payment job even when the connection has both switches off', async () => {
    getConnectionMock.mockResolvedValue({ id: 'c1', status: 'connected', pushMode: 'manual', pushPayments: false });
    await processAccountingSyncJob({ type: 'delete-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID });
    expect(deletePaymentMock).toHaveBeenCalledWith(MAPPING_ID, PARTNER_ID, expect.any(Function));
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

  it.each<AccountingPaymentPushErrorCode>(['quickbooks_error', 'sync_in_progress', 'invoice_not_synced'])(
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
