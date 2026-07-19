import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capturing DB mock: every db.update() call records its set()/where() arguments
// in order, and each .returning() consumes the next configured result from
// `dbState.returningQueue` (default: claim WON → [{ id: 'q-1' }]). Chains that
// end at .where() without .returning() (the un-stamp and the email-outcome
// persist) resolve as plain promises. and/eq are mocked to inspectable shapes
// so tests can assert the exact predicates, not just "an update happened".
const {
  addMock, removeMock, sendQuoteMock, captureExceptionMock,
  withSystemDbAccessContextMock, updateMock, selectMock, updateCalls, dbState,
} = vi.hoisted(() => {
  const updateCalls: Array<{ set: unknown; where: unknown }> = [];
  const dbState = {
    /** Rows resolved by db.select().from().where() */
    selectRows: [] as unknown[],
    /** One entry consumed per .returning() call, in order. Empty → claim won. */
    returningQueue: [] as unknown[][],
  };
  const updateMock = vi.fn(() => {
    const record: { set: unknown; where: unknown } = { set: undefined, where: undefined };
    updateCalls.push(record);
    return {
      set: (setArg: unknown) => {
        record.set = setArg;
        return {
          where: (whereArg: unknown) => {
            record.where = whereArg;
            const promise = Promise.resolve([]) as unknown as Promise<unknown[]> & { returning: (cols: unknown) => Promise<unknown[]> };
            promise.returning = () => Promise.resolve(
              dbState.returningQueue.length > 0 ? (dbState.returningQueue.shift() as unknown[]) : [{ id: 'q-1' }],
            );
            return promise;
          },
        };
      },
    };
  });
  const selectMock = vi.fn(() => ({
    from: vi.fn(() => ({ where: vi.fn(async () => dbState.selectRows) })),
  }));
  return {
    addMock: vi.fn(),
    removeMock: vi.fn(),
    sendQuoteMock: vi.fn(),
    captureExceptionMock: vi.fn(),
    withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    updateMock, selectMock, updateCalls, dbState,
  };
});

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
vi.mock('../services/sentry', () => ({ captureException: captureExceptionMock }));
vi.mock('../db', () => ({
  db: { update: updateMock, select: selectMock },
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));
vi.mock('../services/quoteLifecycle', () => ({ sendQuote: sendQuoteMock }));
vi.mock('../db/schema/quotes', () => ({
  quotes: { id: 'id', status: 'status', sendScheduledAt: 'sendScheduledAt', sendJobId: 'sendJobId', sendEmailReason: 'sendEmailReason' },
}));
// Inspectable predicate shapes so where() payloads can be asserted exactly.
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
  and: (...args: unknown[]) => ({ and: args }),
  isNull: (col: unknown) => ({ isNull: col }),
}));
// Same constructor shape as the real class (services/quoteTypes.ts) — the
// module under test both constructs and callers instanceof-check it.
vi.mock('../services/quoteTypes', () => ({
  QuoteServiceError: class QuoteServiceError extends Error {
    constructor(
      message: string,
      public status: number = 400,
      public code?: string,
    ) {
      super(message);
      this.name = 'QuoteServiceError';
    }
  },
}));

import { scheduleQuoteSend, cancelQuoteSend, processQuoteSendJob } from './quoteSendQueue';
import { QuoteServiceError, type QuoteActor } from '../services/quoteTypes';

const actor: QuoteActor = { userId: 'u-1', partnerId: 'p-1', accessibleOrgIds: ['org-1'] } as QuoteActor;
const eqm = (col: string, val: unknown) => ({ col, val });
const andm = (...args: unknown[]) => ({ and: args });
const JOB_ID_RE = /^quote-send-q-1-[0-9a-f-]+$/;

describe('quoteSendQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addMock.mockResolvedValue(undefined);
    removeMock.mockResolvedValue(1);
    updateCalls.length = 0;
    dbState.selectRows = [];
    dbState.returningQueue.length = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('scheduleQuoteSend', () => {
    it('stamps the row (unique colon-free jobId, scheduled time, cleared failure) BEFORE enqueueing, then enqueues single-attempt with the same jobId', async () => {
      const before = Date.now();
      const { sendScheduledAt } = await scheduleQuoteSend('q-1', actor, { to: ['a@b.co'] }, 30_000);

      // Exact stamp payload: fresh unique jobId, fire time, prior failure cleared.
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.set).toEqual({
        sendScheduledAt: expect.any(Date),
        sendJobId: expect.stringMatching(JOB_ID_RE),
        sendEmailReason: null,
      });
      const stamped = updateCalls[0]!.set as { sendScheduledAt: Date; sendJobId: string };
      expect(stamped.sendJobId).not.toContain(':'); // BullMQ jobIds must be colon-free
      expect(stamped.sendScheduledAt).toBe(sendScheduledAt);
      expect(sendScheduledAt.getTime()).toBeGreaterThanOrEqual(before + 30_000);
      // Stamp is guarded draft-only (closes the race with a direct send).
      expect(updateCalls[0]!.where).toEqual(andm(eqm('id', 'q-1'), eqm('status', 'draft')));

      // The stamp happened BEFORE the enqueue.
      expect(updateMock.mock.invocationCallOrder[0]!).toBeLessThan(addMock.mock.invocationCallOrder[0]!);

      // Enqueue carries the SAME jobId in data and opts; one shot, no retries.
      expect(addMock).toHaveBeenCalledTimes(1);
      const [queueName, data, opts] = addMock.mock.calls[0]! as [string, Record<string, unknown>, Record<string, unknown>];
      expect(queueName).toBe('quote-send');
      expect(data).toEqual({ quoteId: 'q-1', jobId: stamped.sendJobId, actor, emailOpts: { to: ['a@b.co'] } });
      expect(opts).toEqual({
        jobId: stamped.sendJobId,
        delay: 30_000,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      });

      // No prior schedule on the row → nothing to remove.
      expect(removeMock).not.toHaveBeenCalled();
    });

    it('generates a UNIQUE jobId per schedule (not per quote)', async () => {
      await scheduleQuoteSend('q-1', actor, {}, 30_000);
      await scheduleQuoteSend('q-1', actor, {}, 30_000);
      const first = (updateCalls[0]!.set as { sendJobId: string }).sendJobId;
      const second = (updateCalls[1]!.set as { sendJobId: string }).sendJobId;
      expect(first).toMatch(JOB_ID_RE);
      expect(second).toMatch(JOB_ID_RE);
      expect(second).not.toBe(first);
    });

    it('removes the PRIOR job when rescheduling; a remove failure is reported but does not block the new enqueue', async () => {
      dbState.selectRows = [{ sendJobId: 'quote-send-q-1-prior-uuid' }];
      removeMock.mockRejectedValueOnce(new Error('redis hiccup'));

      await scheduleQuoteSend('q-1', actor, {}, 30_000);

      expect(removeMock).toHaveBeenCalledWith('quote-send-q-1-prior-uuid');
      expect(addMock).toHaveBeenCalledTimes(1); // still enqueued
      expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error));
    });

    it('throws QuoteServiceError 409 when the stamp claims 0 rows (no longer a draft) and never enqueues', async () => {
      dbState.returningQueue.push([]); // stamp update returns no rows
      await expect(scheduleQuoteSend('q-1', actor, {}, 30_000)).rejects.toBeInstanceOf(QuoteServiceError);
      dbState.returningQueue.push([]);
      await expect(scheduleQuoteSend('q-1', actor, {}, 30_000)).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
      expect(addMock).not.toHaveBeenCalled();
    });

    it('un-stamps the row (guarded on its own jobId) and rethrows when the enqueue fails', async () => {
      addMock.mockRejectedValueOnce(new Error('redis down'));

      await expect(scheduleQuoteSend('q-1', actor, {}, 30_000)).rejects.toThrow('redis down');

      expect(updateCalls).toHaveLength(2);
      const stampedJobId = (updateCalls[0]!.set as { sendJobId: string }).sendJobId;
      // No prior failure marker on the row → restored to null.
      expect(updateCalls[1]!.set).toEqual({ sendScheduledAt: null, sendJobId: null, sendEmailReason: null });
      // Guarded so it only clears its OWN stamp, never a competing reschedule's.
      expect(updateCalls[1]!.where).toEqual(andm(eqm('id', 'q-1'), eqm('sendJobId', stampedJobId)));
    });

    it("a failed enqueue RESTORES the prior 'schedule_failed' marker the stamp had cleared", async () => {
      dbState.selectRows = [{ sendJobId: null, sendEmailReason: 'schedule_failed' }];
      addMock.mockRejectedValueOnce(new Error('redis down'));

      await expect(scheduleQuoteSend('q-1', actor, {}, 30_000)).rejects.toThrow('redis down');

      // The durable failure banner must survive a retry that failed to enqueue.
      expect(updateCalls[1]!.set).toEqual({
        sendScheduledAt: null, sendJobId: null, sendEmailReason: 'schedule_failed',
      });
    });
  });

  describe('cancelQuoteSend', () => {
    it('claims the schedule (clears both columns, guarded on the row jobId) and removes the job', async () => {
      dbState.selectRows = [{ sendJobId: 'quote-send-q-1-live-uuid', status: 'draft' }];

      await expect(cancelQuoteSend('q-1')).resolves.toBe(true);

      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.set).toEqual({ sendScheduledAt: null, sendJobId: null });
      expect(updateCalls[0]!.where).toEqual(
        andm(eqm('id', 'q-1'), eqm('status', 'draft'), eqm('sendJobId', 'quote-send-q-1-live-uuid')),
      );
      expect(removeMock).toHaveBeenCalledWith('quote-send-q-1-live-uuid');
    });

    it('returns false and does NOT touch Redis when the claim loses (window elapsed / concurrent winner)', async () => {
      dbState.selectRows = [{ sendJobId: 'quote-send-q-1-live-uuid', status: 'draft' }];
      dbState.returningQueue.push([]); // claim update returns no rows

      await expect(cancelQuoteSend('q-1')).resolves.toBe(false);
      expect(removeMock).not.toHaveBeenCalled();
    });

    it('still returns true when the Redis removal fails AFTER a won claim (answer comes from the DB, not Redis)', async () => {
      dbState.selectRows = [{ sendJobId: 'quote-send-q-1-live-uuid', status: 'draft' }];
      removeMock.mockRejectedValueOnce(new Error('redis down'));

      await expect(cancelQuoteSend('q-1')).resolves.toBe(true);
      expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error));
    });

    it('returns false without any update when the row is missing, non-draft, or has no scheduled job', async () => {
      dbState.selectRows = []; // missing
      await expect(cancelQuoteSend('q-1')).resolves.toBe(false);

      dbState.selectRows = [{ sendJobId: 'quote-send-q-1-live-uuid', status: 'sent' }]; // non-draft
      await expect(cancelQuoteSend('q-1')).resolves.toBe(false);

      dbState.selectRows = [{ sendJobId: null, status: 'draft' }]; // nothing scheduled
      await expect(cancelQuoteSend('q-1')).resolves.toBe(false);

      expect(updateMock).not.toHaveBeenCalled();
      expect(removeMock).not.toHaveBeenCalled();
    });
  });

  describe('processQuoteSendJob', () => {
    const jobId = 'quote-send-q-1-fire-uuid';
    const jobData = { quoteId: 'q-1', jobId, actor, emailOpts: { to: ['a@b.co'] } };

    it('claims atomically (clears ONLY sendJobId, guarded draft+jobId) then fires sendQuote with the ORIGINAL actor', async () => {
      sendQuoteMock.mockResolvedValueOnce({ emailed: true });

      await processQuoteSendJob(jobData);

      expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
      // The claim: takes the registration, touches nothing else.
      expect(updateCalls[0]!.set).toEqual({ sendJobId: null });
      expect(updateCalls[0]!.where).toEqual(
        andm(eqm('id', 'q-1'), eqm('status', 'draft'), eqm('sendJobId', jobId)),
      );
      expect(sendQuoteMock).toHaveBeenCalledWith('q-1', actor, { to: ['a@b.co'] });
      // Delivered → no outcome write needed: sendQuote's draft→sent flip
      // already cleared the marker atomically. Only the claim ran.
      expect(updateCalls).toHaveLength(1);
    });

    it('persists the email-failure reason when the send committed but no email went out', async () => {
      sendQuoteMock.mockResolvedValueOnce({ emailed: false, emailReason: 'no_billing_contact' });
      await processQuoteSendJob(jobData);
      expect(updateCalls[1]!.set).toEqual({ sendEmailReason: 'no_billing_contact' });
    });

    it("falls back to 'send_failed' when emailed:false carries no reason", async () => {
      sendQuoteMock.mockResolvedValueOnce({ emailed: false });
      await processQuoteSendJob(jobData);
      expect(updateCalls[1]!.set).toEqual({ sendEmailReason: 'send_failed' });
    });

    it('no-ops entirely when the claim loses — must NOT clear sendScheduledAt (it may belong to a newer schedule)', async () => {
      dbState.returningQueue.push([]); // claim update returns no rows

      await processQuoteSendJob(jobData);

      expect(sendQuoteMock).not.toHaveBeenCalled();
      // Exactly the one claim attempt — no follow-up update may touch the row.
      expect(updateMock).toHaveBeenCalledTimes(1);
      expect(updateCalls[0]!.set).toEqual({ sendJobId: null });
    });

    it('a fire-time sendQuote failure stamps schedule_failed OUTSIDE the rolled-back txn (draft + own-jobId guards) and rethrows', async () => {
      sendQuoteMock.mockRejectedValueOnce(new Error('CONTRACT_VARIABLES_UNRESOLVED'));

      await expect(processQuoteSendJob(jobData)).rejects.toThrow('CONTRACT_VARIABLES_UNRESOLVED');

      expect(updateCalls).toHaveLength(2);
      // The send transaction rolled back (claim included — the row still
      // carries this job's id on a real DB), so the durable marker runs in a
      // SECOND system context and re-clears the whole schedule itself.
      // 'schedule_failed', not 'send_failed': on a draft this means the whole
      // scheduled send failed, not that email transport failed post-commit.
      expect(updateCalls[1]!.set).toEqual({
        sendScheduledAt: null, sendJobId: null, sendEmailReason: 'schedule_failed',
      });
      // Guards: draft-only (a lost race with a direct send must never stamp
      // failure onto a SENT quote) AND own-jobId match (a NEWER schedule
      // stamped after the rollback must not be clobbered — its job is live).
      expect(updateCalls[1]!.where).toEqual(
        andm(eqm('id', 'q-1'), eqm('status', 'draft'), eqm('sendJobId', jobId)),
      );
      // Two separate system contexts: the failed send txn + the marker write.
      expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(2);
    });

    it('falls back to the legacy derivable jobId for pre-deploy payloads without data.jobId', async () => {
      sendQuoteMock.mockResolvedValueOnce({ emailed: true });
      const legacy = { quoteId: 'q-1', actor, emailOpts: {} } as Parameters<typeof processQuoteSendJob>[0];
      await processQuoteSendJob(legacy);
      // The claim must target the id the OLD producer stamped on the row.
      expect(updateCalls[0]!.where).toEqual(
        andm(eqm('id', 'q-1'), eqm('status', 'draft'), eqm('sendJobId', 'quote-send-q-1')),
      );
      expect(sendQuoteMock).toHaveBeenCalled();
    });
  });
});
