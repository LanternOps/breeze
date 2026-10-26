import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit shape of the automatic-reminder sweep (#9075 W4a, OD8 B): select due
// ids, remind each in ITS OWN system transaction through the lifecycle's
// automatic path, mail + audit only AFTER that transaction, and never let one
// request's failure stop the rest. The real-Postgres selector is
// __tests__/integration/agreementRequestAutoReminder.integration.test.ts.

const queued: unknown[][] = [];
function queue(rows: unknown[]) { queued.push(rows); }
const ctx = { depth: 0, opened: 0 };

vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'orderBy', 'innerJoin']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(queued.shift() ?? []).then(resolve, reject);
  return {
    db: chain,
    withSystemDbAccessContext: async (fn: () => unknown) => {
      ctx.depth += 1; ctx.opened += 1;
      try { return await fn(); } finally { ctx.depth -= 1; }
    },
  };
});

vi.mock('bullmq', () => ({ Queue: vi.fn(), Worker: vi.fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

const { auditMock, autoRemindMock } = vi.hoisted(() => ({ auditMock: vi.fn(), autoRemindMock: vi.fn() }));
vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: auditMock,
  requestLikeFromSnapshot: () => ({ req: 'like' }),
}));
vi.mock('../services/agreementRequestLifecycle', () => ({ autoRemindAgreementRequest: autoRemindMock }));

import { sendDueAgreementAutoReminders } from './agreementRequestAutoReminder';
import { captureException } from '../services/sentry';

const NOW = new Date('2027-01-11T12:00:00.000Z');
const ORG = '11111111-1111-4111-8111-111111111111';

function reminded(id: string, deliver: () => Promise<unknown>) {
  return {
    reminded: true as const,
    result: {
      request: { id, orgId: ORG, label: 'BAA', reminderCount: 2 },
      link: 'https://portal.example.test/agreement/x',
      recipients: ['jane@example.com', 'ops@example.com'],
      reissued: false,
      deliverEmail: deliver,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  queued.length = 0;
  ctx.depth = 0;
  ctx.opened = 0;
});

describe('sendDueAgreementAutoReminders', () => {
  it('nothing due → no per-request work', async () => {
    queue([]);
    await expect(sendDueAgreementAutoReminders(NOW)).resolves.toEqual({ selected: 0, reminded: 0, skipped: 0, failed: 0 });
    expect(autoRemindMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('reminds each due request in its own system transaction, then mails + audits OUTSIDE it', async () => {
    queue([{ id: 'r-1' }, { id: 'r-2' }]);
    const depthAtDelivery: number[] = [];
    const deliver = vi.fn(async () => { depthAtDelivery.push(ctx.depth); return { emailed: true }; });
    autoRemindMock
      .mockImplementationOnce(async () => { expect(ctx.depth).toBe(1); return reminded('r-1', deliver); })
      .mockImplementationOnce(async () => ({ reminded: false, reason: 'not_due' }));

    const res = await sendDueAgreementAutoReminders(NOW);

    expect(res).toEqual({ selected: 2, reminded: 1, skipped: 1, failed: 0 });
    expect(autoRemindMock).toHaveBeenNthCalledWith(1, 'r-1', NOW);
    expect(autoRemindMock).toHaveBeenNthCalledWith(2, 'r-2', NOW);
    expect(ctx.opened).toBe(3); // selector + one per candidate
    expect(depthAtDelivery).toEqual([0]); // post-commit, no pooled connection held across SMTP
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![1]).toMatchObject({
      orgId: ORG,
      action: 'billing.agreement.reminded',
      resourceType: 'agreement_request',
      resourceId: 'r-1',
      actorType: 'system',
      actorId: null,
      result: 'success',
      details: { automatic: true, reminderCount: 2, recipientCount: 2, reissued: false, emailed: true },
    });
  });

  it('a failed send is audited with its reason, not retried', async () => {
    queue([{ id: 'r-1' }]);
    autoRemindMock.mockResolvedValueOnce(reminded('r-1', async () => ({ emailed: false, emailReason: 'send_failed' })));
    const res = await sendDueAgreementAutoReminders(NOW);
    expect(res).toEqual({ selected: 1, reminded: 1, skipped: 0, failed: 0 });
    expect(auditMock.mock.calls[0]![1]).toMatchObject({ details: { emailed: false, emailReason: 'send_failed' } });
  });

  it('one request throwing is captured and the rest still run', async () => {
    queue([{ id: 'r-1' }, { id: 'r-2' }]);
    autoRemindMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(reminded('r-2', async () => ({ emailed: true })));
    const res = await sendDueAgreementAutoReminders(NOW);
    expect(res).toEqual({ selected: 2, reminded: 1, skipped: 0, failed: 1 });
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledTimes(1);
  });
});
