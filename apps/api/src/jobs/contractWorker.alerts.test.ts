import { beforeEach, describe, expect, it, vi } from 'vitest';

const order: string[] = [];
const { processorRef, alertMock, renewalMock, closeOutMock, captureMock } = vi.hoisted(() => ({
  processorRef: { fn: undefined as undefined | ((job: { name: string }) => Promise<unknown>) },
  alertMock: vi.fn(),
  renewalMock: vi.fn(),
  closeOutMock: vi.fn(),
  captureMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {},
  Job: class {},
  Worker: class {
    constructor(_queue: string, processor: (job: { name: string }) => Promise<unknown>) {
      processorRef.fn = processor;
    }
  },
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: captureMock }));
vi.mock('../services/contractService', () => ({ generateDueInvoice: vi.fn() }));
vi.mock('../services/invoiceService', () => ({ issueInvoice: vi.fn() }));
vi.mock('../services/invoicePdf', () => ({ sendInvoiceEmail: vi.fn() }));
vi.mock('../services/contractRenewal', () => ({ runContractRenewalSweep: renewalMock }));
vi.mock('../services/contractHourBlockClose', () => ({ runHourBlockCloseOutSweep: closeOutMock }));
vi.mock('../services/contractHourBlockAlerts', () => ({ runHourBlockAlertSweep: alertMock }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const mth of ['select', 'from']) chain[mth] = vi.fn(() => chain);
  chain.where = vi.fn(() => { order.push('billing'); return chain; });
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve);
  return {
    db: chain,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import { createContractWorker } from './contractWorker';

describe('contract billing-sweep job ordering (block hours W04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    renewalMock.mockImplementation(async () => { order.push('renewal'); });
    closeOutMock.mockImplementation(async () => { order.push('closeout'); return { contracts: 0, closes: 0, errors: 0 }; });
    alertMock.mockImplementation(async () => { order.push('alerts'); });
    createContractWorker();
  });

  it('runs renewal, billing, the close-out sweep, and only THEN the threshold alerts', async () => {
    await processorRef.fn!({ name: 'billing-sweep' });
    expect(order).toEqual(['renewal', 'billing', 'closeout', 'alerts']);
  });

  it('an alert-sweep failure is reported and never fails the job or the billing result', async () => {
    alertMock.mockRejectedValueOnce(new Error('alerts down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await processorRef.fn!({ name: 'billing-sweep' });
      expect(result).toEqual({ billed: 0, failed: 0 });
      expect(captureMock).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
    }
  });
});
