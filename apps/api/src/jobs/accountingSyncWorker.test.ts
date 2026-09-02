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

import {
  processAccountingSyncJob,
  enqueueAccountingInvoicePush,
  enqueueAccountingInvoiceVoid,
} from './accountingSyncWorker';
import { AccountingInvoicePushError, type AccountingInvoicePushErrorCode } from '../services/accounting/accountingInvoicePush';

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
