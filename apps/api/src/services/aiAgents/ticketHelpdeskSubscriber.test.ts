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

/** db.select().from().where().limit() -> rows (the origin-guard probe). */
function mockOriginProbe(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
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
});
