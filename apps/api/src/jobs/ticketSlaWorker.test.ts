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

import { sweepTicketSlaBreaches, healMissingDeadlines, initializeTicketSlaWorker, shutdownTicketSlaWorker } from './ticketSlaWorker';
import { captureException } from '../services/sentry';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { tickets } from '../db/schema';

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

    // #8973 W3 (spec §4.3 reader 1): the sweep compares now() against the
    // STORED deadline and walks the partial due-at index in deadline order.
    it('sweeps the stored deadlines, ordered by them, with the index predicate', async () => {
      executeMock
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await sweepTicketSlaBreaches();

      const flat = (n: number) => sqlText(executeMock.mock.calls[n]?.[0]).replace(/\s+/g, ' ');
      const responseSql = flat(0);
      expect(responseSql).toContain('response_due_at IS NOT NULL');
      expect(responseSql).toContain('now() >= response_due_at');
      expect(responseSql).toContain('ORDER BY response_due_at ASC');
      expect(responseSql).not.toContain('created_at');
      expect(responseSql).not.toContain('sla_paused_minutes');

      const resolutionSql = flat(1);
      expect(resolutionSql).toContain('resolution_due_at IS NOT NULL');
      expect(resolutionSql).toContain('now() >= resolution_due_at');
      expect(resolutionSql).toContain('ORDER BY resolution_due_at ASC');
      expect(resolutionSql).not.toContain('created_at');
    });

    // #8972 spec §3.6: merged tombstones are excluded from the sweep.
    it('sweep SQL excludes merged tombstones in both passes', async () => {
      executeMock
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await sweepTicketSlaBreaches();

      expect(sqlText(executeMock.mock.calls[0]?.[0])).toContain('merged_into_ticket_id IS NULL');
      expect(sqlText(executeMock.mock.calls[1]?.[0])).toContain('merged_into_ticket_id IS NULL');
    });
  });

  // Gate B12: a pre-W3 API instance still serving during a rolling deploy
  // writes targets without stored deadlines, or folds a pause into
  // sla_paused_minutes only. Each tick heals up to 500 such rows with the
  // wall-clock formula before the stamping passes run.
  describe('healMissingDeadlines (Gate B12)', () => {
    it('fills missing arms and recomputes unfrozen arms of rows whose business minutes lag', async () => {
      executeMock.mockResolvedValueOnce({ rows: [{ id: 't-1' }] });

      expect(await healMissingDeadlines()).toBe(1);

      const healSql = sqlText(executeMock.mock.calls[0]?.[0]).replace(/\s+/g, ' ');
      expect(healSql).toContain('response_due_at IS NULL');
      expect(healSql).toContain('resolution_due_at IS NULL');
      expect(healSql).toContain('sla_paused_business_minutes < COALESCE(sla_paused_minutes, 0)');
      expect(healSql).toContain('GREATEST(t.sla_paused_business_minutes, COALESCE(t.sla_paused_minutes, 0))');
      // Frozen arms are never recomputed by the lag branch.
      expect(healSql).toContain('t.first_response_at IS NULL');
      expect(healSql).toContain('t.resolved_at IS NULL');
      expect(healSql).toContain("interval '1 minute' * 0.8");
      expect(healSql).toContain('LIMIT 500');
      expect(healSql).toContain('FOR UPDATE SKIP LOCKED');
      expect(healSql).toContain('ORDER BY created_at ASC');
    });

    it('heal pass skips merged tombstones (#8972)', async () => {
      executeMock.mockResolvedValueOnce({ rows: [] });
      await healMissingDeadlines();
      expect(sqlText(executeMock.mock.calls[0]?.[0])).toContain('merged_into_ticket_id IS NULL');
    });

    // #8973 W4 hand-off: on a calendar, sla_paused_business_minutes legitimately
    // differs from sla_paused_minutes, so the wall-clock heal must never select
    // a ticket that carries a calendar revision — on ANY of its three branches.
    it('heal leaves a calendar ticket whose business minutes differ from sla_paused_minutes untouched', async () => {
      executeMock.mockResolvedValueOnce({ rows: [] });

      expect(await healMissingDeadlines()).toBe(0);

      const healSql = sqlText(executeMock.mock.calls[0]?.[0]).replace(/\s+/g, ' ');
      const cteWhere = /WITH missing AS \( SELECT id FROM tickets WHERE (.*?) ORDER BY created_at ASC/.exec(healSql)?.[1]?.trim();
      // #8972 ANDs `merged_into_ticket_id IS NULL` (tombstones are never healed)
      // in front of the index predicate; that only narrows it, so the partial
      // index below still applies.
      const MERGED_PREFIX = 'merged_into_ticket_id IS NULL AND ';
      expect(cteWhere?.startsWith(MERGED_PREFIX)).toBe(true);
      const indexWhere = cteWhere?.slice(MERGED_PREFIX.length);
      expect(indexWhere).toBe(
        'sla_calendar_revision_id IS NULL AND ((response_sla_minutes IS NOT NULL AND response_due_at IS NULL) '
          + 'OR (resolution_sla_minutes IS NOT NULL AND resolution_due_at IS NULL) '
          + 'OR sla_paused_business_minutes < COALESCE(sla_paused_minutes, 0))',
      );

      // The partial index tickets_sla_deadlines_missing_idx (2027-01-03-160100)
      // only serves the heal while the Drizzle declaration, the migration and
      // this CTE carry the identical predicate.
      const index = getTableConfig(tickets).indexes.find((i) => i.config.name === 'tickets_sla_deadlines_missing_idx');
      expect(sqlText(index?.config.where).replace(/\s+/g, ' ').trim()).toBe(indexWhere);
      const migration = readFileSync(
        fileURLToPath(new URL('../../migrations/2027-01-03-160100-ticket-sla-calendar-revision.sql', import.meta.url)),
        'utf8',
      );
      const migrationWhere = /CREATE INDEX CONCURRENTLY IF NOT EXISTS tickets_sla_deadlines_missing_idx\s+ON public\.tickets \(created_at\)\s+WHERE ([^;]+);/
        .exec(migration)?.[1]?.replace(/\s+/g, ' ').replace(/\( \(/g, '((').trim();
      expect(migrationWhere).toBe(indexWhere);
    });
  });

  describe('worker handler', () => {
    it('emits one ticket.sla_breached per stamped row, after the system DB context resolved', async () => {
      executeMock
        .mockResolvedValueOnce({ rows: [] }) // heal pass
        .mockResolvedValueOnce({ rows: [breachedRow] }) // response pass
        .mockResolvedValueOnce({ rows: [] }); // resolution pass

      await initializeTicketSlaWorker();
      expect(workerCapture.processor).toBeTypeOf('function');

      const result = await workerCapture.processor!({
        data: { type: 'sla-sweep', queuedAt: new Date().toISOString() },
      });

      expect(result).toEqual({ breached: 1 });
      // Heal and stamping run in two separate system transactions (#8973).
      expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(2);
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

  describe('worker handler — heal isolation (#8973 Gate B12)', () => {
    it('a failing heal is reported and the breach passes still run', async () => {
      executeMock
        .mockRejectedValueOnce(new Error('canceling statement due to lock timeout')) // heal
        .mockResolvedValueOnce({ rows: [breachedRow] }) // response pass
        .mockResolvedValueOnce({ rows: [] }); // resolution pass

      await initializeTicketSlaWorker();
      const result = await workerCapture.processor!({
        data: { type: 'sla-sweep', queuedAt: new Date().toISOString() },
      });

      expect(result).toEqual({ breached: 1 });
      expect(captureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'canceling statement due to lock timeout' }));
      expect(emitTicketEventMock).toHaveBeenCalledTimes(1);
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
