import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock, removeMock, updateWhereMock, selectRows, sendQuoteMock } = vi.hoisted(() => ({
  addMock: vi.fn(),
  removeMock: vi.fn().mockResolvedValue(1),
  updateWhereMock: vi.fn().mockResolvedValue(undefined),
  selectRows: { rows: [] as unknown[] },
  sendQuoteMock: vi.fn().mockResolvedValue({}),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = addMock;
    remove = removeMock;
  },
  Worker: class {
    on = vi.fn();
    close = vi.fn();
  },
}));
vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../db', () => ({
  db: {
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: updateWhereMock })) })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => selectRows.rows) })) })),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../services/quoteLifecycle', () => ({ sendQuote: sendQuoteMock }));
vi.mock('../db/schema/quotes', () => ({
  quotes: { id: 'id', sendScheduledAt: 'sendScheduledAt', sendJobId: 'sendJobId', sendEmailReason: 'sendEmailReason', status: 'status' },
}));
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));

import { scheduleQuoteSend, cancelQuoteSend, processQuoteSendJob } from './quoteSendQueue';
import type { QuoteActor } from '../services/quoteTypes';

const actor: QuoteActor = { userId: 'u-1', partnerId: 'p-1', accessibleOrgIds: ['org-1'] } as QuoteActor;

describe('quoteSendQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removeMock.mockResolvedValue(1);
    selectRows.rows = [];
  });

  it('schedules a colon-free per-quote job with the requested delay and single attempt', async () => {
    const { sendScheduledAt } = await scheduleQuoteSend('q-1', actor, { to: ['a@b.co'] }, 30_000);
    // Replaces any prior schedule before enqueueing the new one.
    expect(removeMock).toHaveBeenCalledWith('quote-send-q-1');
    expect(addMock).toHaveBeenCalledWith(
      'quote-send',
      { quoteId: 'q-1', actor, emailOpts: { to: ['a@b.co'] } },
      expect.objectContaining({ jobId: 'quote-send-q-1', delay: 30_000, attempts: 1 }),
    );
    // jobId must not contain colons (BullMQ treats them as key separators).
    expect((addMock.mock.calls[0]?.[2] as { jobId: string }).jobId).not.toContain(':');
    expect(sendScheduledAt.getTime()).toBeGreaterThan(Date.now() + 25_000);
    // Row stamped for the UI/cancel bookkeeping.
    expect(updateWhereMock).toHaveBeenCalled();
  });

  it('cancel removes the pending job and clears the bookkeeping', async () => {
    await expect(cancelQuoteSend('q-1')).resolves.toBe(true);
    expect(removeMock).toHaveBeenCalledWith('quote-send-q-1');
    expect(updateWhereMock).toHaveBeenCalled();
  });

  it('cancel after the window reports false but still clears stale bookkeeping', async () => {
    removeMock.mockResolvedValue(0);
    await expect(cancelQuoteSend('q-1')).resolves.toBe(false);
    expect(updateWhereMock).toHaveBeenCalled();
  });

  it('the job fires the real sendQuote with the ORIGINAL actor when still scheduled', async () => {
    selectRows.rows = [{ sendJobId: 'quote-send-q-1', status: 'draft' }];
    await processQuoteSendJob({ quoteId: 'q-1', actor, emailOpts: { to: ['a@b.co'] } });
    expect(sendQuoteMock).toHaveBeenCalledWith('q-1', actor, { to: ['a@b.co'] });
    // Bookkeeping cleared after firing.
    expect(updateWhereMock).toHaveBeenCalled();
  });

  it('the job SKIPS when the schedule was canceled (sendJobId cleared) or the quote is no longer a draft', async () => {
    selectRows.rows = [{ sendJobId: null, status: 'draft' }];
    await processQuoteSendJob({ quoteId: 'q-1', actor, emailOpts: {} });
    expect(sendQuoteMock).not.toHaveBeenCalled();

    selectRows.rows = [{ sendJobId: 'quote-send-q-1', status: 'sent' }];
    await processQuoteSendJob({ quoteId: 'q-1', actor, emailOpts: {} });
    expect(sendQuoteMock).not.toHaveBeenCalled();
  });

  it('a fire-time sendQuote failure still clears the schedule (quote stays a plain draft)', async () => {
    selectRows.rows = [{ sendJobId: 'quote-send-q-1', status: 'draft' }];
    sendQuoteMock.mockRejectedValueOnce(new Error('CONTRACT_VARIABLES_UNRESOLVED'));
    await expect(processQuoteSendJob({ quoteId: 'q-1', actor, emailOpts: {} })).rejects.toThrow();
    expect(updateWhereMock).toHaveBeenCalled();
  });
});
