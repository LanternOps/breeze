import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  executeMock,
  withSystemDbAccessContextMock,
  emitTicketEventMock,
  publishMock,
  queueAddMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  workerCapture,
  callOrder,
  expireMock,
} = vi.hoisted(() => ({
  expireMock: vi.fn(),
  executeMock: vi.fn(),
  withSystemDbAccessContextMock: vi.fn(),
  emitTicketEventMock: vi.fn(),
  publishMock: vi.fn(),
  queueAddMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  workerCapture: { processor: null as null | ((job: { data: unknown }) => Promise<unknown>) },
  callOrder: [] as string[],
}));

vi.mock('bullmq', () => ({
  // Regular functions (not arrows) so `new Worker(...)` / `new Queue(...)` work.
  Worker: vi.fn(function (_name: string, processor: (job: { data: unknown }) => Promise<unknown>) {
    workerCapture.processor = processor;
    return { on: vi.fn(), close: vi.fn() };
  }),
  Queue: vi.fn(function () {
    return {
      add: queueAddMock,
      getRepeatableJobs: getRepeatableJobsMock,
      removeRepeatableByKey: removeRepeatableByKeyMock,
      close: vi.fn(),
    };
  }),
  Job: class {},
}));

vi.mock('../db', () => ({
  db: { execute: executeMock },
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../services/ticketEvents', () => ({
  emitTicketEvent: emitTicketEventMock,
  TICKET_EVENTS_QUEUE: 'ticket-events',
}));

vi.mock('../services/eventBus', () => ({
  getEventBus: vi.fn(() => ({ publish: publishMock })),
}));

vi.mock('../services/ticketApproval/decisions', () => ({
  expireDueApprovalRequests: expireMock,
}));

import { sweepTicketSlaBreaches, initializeTicketSlaWorker, shutdownTicketSlaWorker } from './ticketSlaWorker';

/**
 * Flattens a drizzle sql`` object to its static SQL text (StringChunks and
 * nested sql.raw chunks only — bound params contribute nothing). Same
 * introspection approach as auditRetention.test.ts.
 */
function sqlText(q: unknown): string {
  if (q == null) return '';
  if (typeof q === 'string') return q;
  const obj = q as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(obj.queryChunks)) {
    return obj.queryChunks.map(sqlText).join(' ');
  }
  if (Array.isArray(obj.value)) {
    return (obj.value as string[]).join('');
  }
  return '';
}

const breachedRow = {
  id: 't-1',
  org_id: 'o-1',
  partner_id: 'p-1',
  internal_number: 'T-2026-0001',
  subject: 'Printer down',
  assigned_to: 'u-9',
};

describe('ticketSlaWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => {
      const result = await fn();
      callOrder.push('db-context-resolved');
      return result;
    });
    emitTicketEventMock.mockImplementation(async () => {
      callOrder.push('emit');
    });
    publishMock.mockResolvedValue('event-id');
    getRepeatableJobsMock.mockResolvedValue([]);
    queueAddMock.mockResolvedValue({});
  });

  describe('sweepTicketSlaBreaches', () => {
    it('runs response and resolution passes and returns rows tagged by target', async () => {
      executeMock
        .mockResolvedValueOnce({ rows: [breachedRow] }) // response pass
        .mockResolvedValueOnce({ rows: [] }); // resolution pass

      const rows = await sweepTicketSlaBreaches();

      expect(executeMock).toHaveBeenCalledTimes(2);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.target).toBe('response');
      expect(rows[0]?.id).toBe('t-1');
    });

    it('sweep SQL excludes paused, already-breached-target, and non-active tickets', async () => {
      executeMock
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await sweepTicketSlaBreaches();

      const responseSql = sqlText(executeMock.mock.calls[0]?.[0]);
      expect(responseSql).toContain("status IN ('new', 'open')");
      expect(responseSql).toContain('sla_paused_at IS NULL');
      expect(responseSql).toContain('first_response_at IS NULL');
      expect(responseSql).toContain('string_to_array');
      expect(responseSql).toContain('NOT (');
      expect(responseSql).toContain('= ANY(string_to_array(COALESCE(sla_breach_reason');
      expect(responseSql).toContain('FOR UPDATE SKIP LOCKED');

      const resolutionSql = sqlText(executeMock.mock.calls[1]?.[0]);
      expect(resolutionSql).toContain('resolved_at IS NULL');
      expect(resolutionSql).toContain("status IN ('new', 'open')");
      expect(resolutionSql).toContain('sla_paused_at IS NULL');
      expect(resolutionSql).toContain('FOR UPDATE SKIP LOCKED');
      // #5573 W02 (spec §4.8): planned work (deliverables, key-date reminders)
      // has a due date, not an SLA — both passes skip non-support tickets.
      expect(responseSql).toContain("work_kind = 'support'");
      expect(resolutionSql).toContain("work_kind = 'support'");
    });
  });

  describe('worker handler', () => {
    it('emits one ticket.sla_breached per stamped row, after the system DB context resolved', async () => {
      executeMock
        .mockResolvedValueOnce({ rows: [breachedRow] }) // response pass
        .mockResolvedValueOnce({ rows: [] }); // resolution pass

      await initializeTicketSlaWorker();
      expect(workerCapture.processor).toBeTypeOf('function');

      const result = await workerCapture.processor!({
        data: { type: 'sla-sweep', queuedAt: new Date().toISOString() },
      });

      expect(result).toEqual({ breached: 1 });
      expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
      expect(emitTicketEventMock).toHaveBeenCalledTimes(1);
      expect(emitTicketEventMock).toHaveBeenCalledWith({
        type: 'ticket.sla_breached',
        ticketId: 't-1',
        orgId: 'o-1',
        partnerId: 'p-1',
        actorUserId: null,
        payload: {
          target: 'response',
          internalNumber: 'T-2026-0001',
          subject: 'Printer down',
          assigneeId: 'u-9',
        },
      });

      // #1105 pool-poison rule: emits happen AFTER withSystemDbAccessContext's
      // callback has fully resolved.
      const contextResolvedIdx = callOrder.indexOf('db-context-resolved');
      const firstEmitIdx = callOrder.indexOf('emit');
      expect(contextResolvedIdx).toBeGreaterThanOrEqual(0);
      expect(firstEmitIdx).toBeGreaterThan(contextResolvedIdx);

      // Routing-rule hook: eventBus publish mirrors the breach.
      expect(publishMock).toHaveBeenCalledWith(
        'ticket.sla_breached',
        'o-1',
        expect.objectContaining({
          ticketId: 't-1',
          internalNumber: 'T-2026-0001',
          subject: 'Printer down',
          target: 'response',
          assigneeId: 'u-9',
        }),
        'ticket-sla-monitor'
      );
    });

    it('emits nothing when the sweep stamps zero rows', async () => {
      executeMock
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await initializeTicketSlaWorker();
      const result = await workerCapture.processor!({
        data: { type: 'sla-sweep', queuedAt: new Date().toISOString() },
      });

      expect(result).toEqual({ breached: 0 });
      expect(emitTicketEventMock).not.toHaveBeenCalled();
      expect(publishMock).not.toHaveBeenCalled();
    });
  });

  describe('ticket-approval-expiry (#4617)', () => {
    const expiredEvent = (requestId: string) => ({
      type: 'ticket.approval_decided', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1', actorUserId: null,
      payload: { requestId, trigger: 'budget', status: 'expired' },
    });

    it('registers a 5-minute repeatable job with a colon-free jobId', async () => {
      await shutdownTicketSlaWorker(); // module state: re-run registration
      await initializeTicketSlaWorker();
      expect(queueAddMock).toHaveBeenCalledWith('ticket-approval-expiry', expect.objectContaining({ type: 'approval-expiry' }),
        expect.objectContaining({ jobId: 'ticket-approval-expiry', repeat: { every: 5 * 60 * 1000 } }));
      const jobId = queueAddMock.mock.calls.find((c) => c[0] === 'ticket-approval-expiry')![2].jobId as string;
      expect(jobId).not.toContain(':');
    });

    it('runs expireDueApprovalRequests (which opens its own system contexts) and emits one approval_decided per expired row afterwards', async () => {
      expireMock.mockImplementation(async () => {
        callOrder.push('expired');
        return { expired: 2, events: [expiredEvent('r-1'), expiredEvent('r-2')] };
      });
      await initializeTicketSlaWorker();
      const result = await workerCapture.processor!({ data: { type: 'approval-expiry', queuedAt: new Date().toISOString() } });
      expect(result).toEqual({ expired: 2 });
      expect(expireMock).toHaveBeenCalledTimes(1);
      expect(expireMock.mock.calls[0]![0]).toBeInstanceOf(Date);
      // Not wrapped in a worker-level system context: each request gets its own transaction.
      expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
      expect(executeMock).not.toHaveBeenCalled();
      expect(emitTicketEventMock).toHaveBeenCalledTimes(2);
      expect(emitTicketEventMock).toHaveBeenNthCalledWith(1, expiredEvent('r-1'));
      expect(callOrder.indexOf('emit')).toBeGreaterThan(callOrder.indexOf('expired'));
    });
  });
});
