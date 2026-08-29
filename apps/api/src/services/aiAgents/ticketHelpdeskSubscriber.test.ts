/**
 * ticketHelpdeskSubscriber (#3828 wave-6-3 task 3).
 *
 * Mocked-DB unit tests for the durable `ai-agent-ticket-helpdesk` event
 * subscriber. `createAndEnqueueAgentRun` (runService.ts) is mocked — its own
 * admission behaviour (dedupe, forced shadow, kill switch, circuit breaker)
 * is covered in runService.test.ts; these tests pin only what THIS module
 * is responsible for: extracting the trigger from the event, running the
 * origin-based loop guard, and calling admission with the right shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  getCurrentDbAccessContext: vi.fn(() => undefined),
}));

vi.mock('../../db/schema', () => ({
  ticketComments: {
    id: 'id',
    ticketId: 'ticket_id',
    originPrincipalKind: 'origin_principal_kind',
    agentRunId: 'agent_run_id',
  },
}));

const createAndEnqueueAgentRun = vi.hoisted(() => vi.fn());
vi.mock('./runService', () => ({ createAndEnqueueAgentRun }));

import { db, withSystemDbAccessContext } from '../../db';
import type { BreezeEvent } from '../eventBus';
import { handleTicketCreatedEvent } from './ticketHelpdeskSubscriber';

const ORG_ID = '00000000-0000-4000-8000-0000000000c1';
const TICKET_ID = '00000000-0000-4000-8000-0000000000c2';

function ticketCreatedEvent(over: Partial<BreezeEvent> = {}): BreezeEvent {
  return {
    id: 'evt-1',
    type: 'ticket.created',
    orgId: ORG_ID,
    source: 'ticket-outbox-publisher',
    priority: 'normal',
    payload: { ticketId: TICKET_ID },
    metadata: { timestamp: '2026-08-28T00:00:00.000Z' },
    ...over,
  } as BreezeEvent;
}

// Captures the most recent `.where()` mock so a test can pull its call
// argument and compile it to real SQL (see the `loop guard WHERE clause`
// test below) — asserting on the predicate that DEFINES the guard, not just
// on which rows the (entirely mocked) query happens to resolve to.
let lastWhereMock: ReturnType<typeof vi.fn> | undefined;

/** db.select().from().where().limit() -> rows (the origin-guard probe). */
function mockOriginProbe(rows: unknown[]) {
  const whereMock = vi.fn().mockReturnValue({
    limit: vi.fn().mockResolvedValue(rows),
  });
  lastWhereMock = whereMock;
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: whereMock,
    }),
  } as never);
}

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  createAndEnqueueAgentRun.mockReset().mockResolvedValue({
    created: true,
    run: { id: 'run-1' },
  });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('handleTicketCreatedEvent', () => {
  it('admits a helpdesk run when the ticket has no agent-originated activity', async () => {
    mockOriginProbe([]);

    await handleTicketCreatedEvent(ticketCreatedEvent());

    expect(createAndEnqueueAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        kind: 'helpdesk',
        triggerKind: 'ticket',
        deviceId: null,
        ticketId: TICKET_ID,
        dedupeKey: `ticket-created:${TICKET_ID}`,
      }),
    );
  });

  it('runs the origin-guard probe and the admission call under a system DB context', async () => {
    mockOriginProbe([]);
    await handleTicketCreatedEvent(ticketCreatedEvent());
    expect(withSystemDbAccessContext).toHaveBeenCalled();
  });

  it('loop guard: skips admission when a prior comment on the ticket is agent-originated', async () => {
    mockOriginProbe([{ id: 'comment-1' }]);

    await handleTicketCreatedEvent(ticketCreatedEvent());

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  // Compiles the actual `.where()` argument to real parameterized SQL via
  // `PgDialect().sqlToQuery(...)` and asserts on both `.sql` and `.params` —
  // a bare `toContain(...)` substring check (or asserting only on the rows
  // the mock resolves to) passes identically whether the code wrote
  // `and()`/`or()` correctly, swapped them, or dropped the ticket-id scope
  // entirely, so structure is what's under test, not just presence. The
  // mocked schema's columns (see the `vi.mock('../../db/schema', ...)`
  // above) are plain strings rather than real Drizzle Column instances,
  // which is exactly what compiles them to bound parameters below instead of
  // quoted identifiers.
  it('loop guard WHERE clause: scopes to the ticket AND requires the origin OR (non-human origin OR a set agent_run_id)', async () => {
    mockOriginProbe([]);

    await handleTicketCreatedEvent(ticketCreatedEvent());

    const whereArg = lastWhereMock!.mock.calls[0]?.[0];
    const { sql: sqlText, params } = new PgDialect().sqlToQuery(whereArg as never);

    // `($1 = $2 and ($3 <> $4 or $5 is not null))` — the ticket-id scope
    // ANDed with an OR of the two origin arms, i.e. deleting either the
    // ticket-id scope, the AND, or either OR arm changes this string.
    expect(sqlText).toBe('($1 = $2 and ($3 <> $4 or $5 is not null))');
    expect(params).toEqual(['ticket_id', TICKET_ID, 'origin_principal_kind', 'user', 'agent_run_id']);
  });

  it('a duplicate delivery of the same ticket.created event calls admission twice with the same dedupe key (admission itself collapses it)', async () => {
    mockOriginProbe([]);
    mockOriginProbe([]);
    createAndEnqueueAgentRun
      .mockResolvedValueOnce({ created: true, run: { id: 'run-1' } })
      .mockResolvedValueOnce({ created: false, skipped: 'duplicate' });

    const event = ticketCreatedEvent();
    await handleTicketCreatedEvent(event);
    await handleTicketCreatedEvent(event);

    expect(createAndEnqueueAgentRun).toHaveBeenCalledTimes(2);
    expect(createAndEnqueueAgentRun.mock.calls[0]![0]).toMatchObject({
      dedupeKey: `ticket-created:${TICKET_ID}`,
    });
    expect(createAndEnqueueAgentRun.mock.calls[1]![0]).toMatchObject({
      dedupeKey: `ticket-created:${TICKET_ID}`,
    });
    // Must not throw on the duplicate-skip result.
  });

  it('does not throw and does not admit when the event payload has no ticketId', async () => {
    await expect(
      handleTicketCreatedEvent(ticketCreatedEvent({ payload: {} })),
    ).resolves.toBeUndefined();
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rethrows when the origin-guard probe itself fails (queue-mode retry contract)', async () => {
    vi.mocked(db.select).mockImplementationOnce(() => {
      throw new Error('boom');
    });

    await expect(handleTicketCreatedEvent(ticketCreatedEvent())).rejects.toThrow('boom');
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  // #1105 pool-hold seam contract: `withSystemDbAccessContext` opens a real
  // Postgres transaction (`db/index.ts`'s `withDbAccessContext` wraps `fn` in
  // `baseDb.transaction(...)`). `createAndEnqueueAgentRun` manages its own DB
  // access internally and deliberately calls `publishEvent` + the BullMQ
  // enqueuer OUTSIDE its own system context (runService.ts step 10) to avoid
  // holding a pooled connection across a Redis round-trip. Wrapping the WHOLE
  // handler body — including this call — in a system context here would
  // silently defeat that: `runService.ts`'s `inSystemDbContext` skips
  // re-entry when the ambient scope is already 'system', so step 10 would run
  // INSIDE the still-open transaction this handler opened. Only the
  // origin-guard probe may run under a system context; the admission call
  // must run with no system context active at all.
  it('calls createAndEnqueueAgentRun OUTSIDE any withSystemDbAccessContext scope (pool-hold seam contract, #1105)', async () => {
    mockOriginProbe([]);
    let systemContextDepth = 0;
    vi.mocked(withSystemDbAccessContext).mockImplementation(async (fn: () => Promise<unknown>) => {
      systemContextDepth += 1;
      try {
        return await fn();
      } finally {
        systemContextDepth -= 1;
      }
    });
    let depthDuringAdmission: number | null = null;
    createAndEnqueueAgentRun.mockImplementation(async () => {
      depthDuringAdmission = systemContextDepth;
      return { created: true, run: { id: 'run-1' } };
    });

    await handleTicketCreatedEvent(ticketCreatedEvent());

    expect(depthDuringAdmission).toBe(0);
  });
});
