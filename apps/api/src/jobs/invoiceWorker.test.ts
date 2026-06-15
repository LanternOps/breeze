import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the service layer the handlers delegate to — we test the handler wiring,
// not the (separately covered) render/sweep logic. We deliberately DO NOT enqueue
// through a live BullMQ queue: handlers are called directly (see test-Redis note).
const { renderInvoicePdfMock, runOverdueSweepMock } = vi.hoisted(() => ({
  renderInvoicePdfMock: vi.fn(),
  runOverdueSweepMock: vi.fn(),
}));
vi.mock('../services/invoicePdf', () => ({ renderInvoicePdf: renderInvoicePdfMock }));
vi.mock('../services/invoiceService', () => ({ runOverdueSweep: runOverdueSweepMock }));

// Capture queue.add calls without opening a socket. getBullMQConnection returns a
// dummy; the Queue constructor is stubbed so no real connection is created.
const { queueAddMock } = vi.hoisted(() => ({ queueAddMock: vi.fn() }));
vi.mock('bullmq', () => ({
  Queue: class { add = queueAddMock; },
  Worker: class {},
  Job: class {},
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

// withSystemDbAccessContext present → handlers run inside it (we just pass through).
vi.mock('../db', () => ({ withSystemDbAccessContext: (fn: () => unknown) => fn() }));

import { processRenderPdf, processOverdueSweep, enqueueInvoicePdfRender } from './invoiceWorker';

const INV_ID = '11111111-1111-1111-1111-111111111111';

describe('invoiceWorker handlers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('processRenderPdf renders + stores the PDF and returns the document id', async () => {
    renderInvoicePdfMock.mockResolvedValue({ documentId: 'doc-1', sha256: 'a'.repeat(64) });
    const result = await processRenderPdf({ type: 'render-pdf', invoiceId: INV_ID });
    expect(renderInvoicePdfMock).toHaveBeenCalledWith(INV_ID);
    expect(result).toEqual({ invoiceId: INV_ID, documentId: 'doc-1' });
  });

  it('processOverdueSweep runs the sweep and returns the count', async () => {
    runOverdueSweepMock.mockResolvedValue(3);
    const result = await processOverdueSweep();
    expect(runOverdueSweepMock).toHaveBeenCalledOnce();
    expect(result).toEqual({ swept: 3 });
  });
});

describe('enqueueInvoicePdfRender (Redis-outage-safe)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enqueues a render-pdf job with a stable jobId', async () => {
    queueAddMock.mockResolvedValue({ id: 'j1' });
    await enqueueInvoicePdfRender(INV_ID);
    expect(queueAddMock).toHaveBeenCalledWith(
      'render-pdf',
      { type: 'render-pdf', invoiceId: INV_ID },
      expect.objectContaining({ jobId: `invoice-render-${INV_ID}` }),
    );
  });

  it('never throws when the queue add fails (e.g. Redis down)', async () => {
    queueAddMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(enqueueInvoicePdfRender(INV_ID)).resolves.toBeUndefined();
  });
});
