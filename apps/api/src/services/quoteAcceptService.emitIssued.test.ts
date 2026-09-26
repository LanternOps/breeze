import { describe, it, expect, vi, beforeEach } from 'vitest';

const { emitInvoiceEventMock, enqueuePdfMock, enqueueAccountingPushMock, captureExceptionMock } = vi.hoisted(() => ({
  emitInvoiceEventMock: vi.fn(),
  enqueuePdfMock: vi.fn(),
  enqueueAccountingPushMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));

vi.mock('../db', () => ({ db: {}, runOutsideDbContext: vi.fn(), withSystemDbAccessContext: vi.fn() }));
vi.mock('./invoiceEvents', () => ({ emitInvoiceEvent: emitInvoiceEventMock }));
vi.mock('../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: enqueuePdfMock }));
vi.mock('../jobs/accountingSyncWorker', () => ({ enqueueAccountingInvoicePush: enqueueAccountingPushMock }));
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));

import { emitAcceptInvoiceIssued } from './quoteAcceptService';

const quote = { id: 'q-1', orgId: 'org-1', partnerId: 'p-1' } as Parameters<typeof emitAcceptInvoiceIssued>[0]['quote'];

beforeEach(() => {
  vi.clearAllMocks();
  emitInvoiceEventMock.mockResolvedValue(undefined);
  enqueuePdfMock.mockResolvedValue(undefined);
  enqueueAccountingPushMock.mockResolvedValue(true);
});

// #7135: quote-issued invoices skipped the QuickBooks auto-push that
// invoiceService.issueInvoice enqueues after commit.
describe('emitAcceptInvoiceIssued', () => {
  it('enqueues the accounting auto-push for the issued invoice, like issueInvoice', async () => {
    await emitAcceptInvoiceIssued({ invoiceId: 'inv-1', invoiceIssued: true, quote }, 'u-1');
    expect(enqueueAccountingPushMock).toHaveBeenCalledWith('inv-1', 'p-1');
  });

  it('does nothing when the accept issued no invoice', async () => {
    await emitAcceptInvoiceIssued({ invoiceId: 'inv-1', invoiceIssued: false, quote }, 'u-1');
    expect(enqueueAccountingPushMock).not.toHaveBeenCalled();
    expect(emitInvoiceEventMock).not.toHaveBeenCalled();
  });

  it('a failed accounting enqueue is captured, never thrown (the accept already committed)', async () => {
    enqueueAccountingPushMock.mockRejectedValue(new Error('redis down'));
    await expect(emitAcceptInvoiceIssued({ invoiceId: 'inv-1', invoiceIssued: true, quote }, 'u-1')).resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it('a failed PDF enqueue does not stop the accounting push', async () => {
    enqueuePdfMock.mockRejectedValue(new Error('redis down'));
    await emitAcceptInvoiceIssued({ invoiceId: 'inv-1', invoiceIssued: true, quote }, 'u-1');
    expect(enqueueAccountingPushMock).toHaveBeenCalledWith('inv-1', 'p-1');
  });
});
