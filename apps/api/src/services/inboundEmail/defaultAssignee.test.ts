import { beforeEach, describe, expect, it, vi } from 'vitest';

const { assignTicket } = vi.hoisted(() => ({ assignTicket: vi.fn() }));
vi.mock('../ticketService', async () => {
  class TicketServiceError extends Error {
    constructor(message: string, public status: number, public code?: string) { super(message); }
  }
  return { assignTicket, TicketServiceError };
});

import { applyDefaultInboundAssignee } from './defaultAssignee';
import { TicketServiceError } from '../ticketService';

const actor = { kind: 'system' as const };

/**
 * #8883 W5 (spec §5.3, D8): the default inbound assignee is the FALLBACK when
 * no routing rule assigned the ticket. createTicket stamps a rule's assignee
 * on the insert, so the email ticket reaches this step with assignedTo set
 * and the fallback must leave it alone.
 */
describe('applyDefaultInboundAssignee — the fallback after routing', () => {
  beforeEach(() => {
    assignTicket.mockReset().mockResolvedValue({ id: 't-1' });
  });

  it('does nothing when a routing rule already assigned the ticket', async () => {
    expect(await applyDefaultInboundAssignee({ id: 't-1', assignedTo: 'rule-assignee' }, 'fallback-user', actor as never))
      .toEqual({ kind: 'already_assigned' });
    expect(assignTicket).not.toHaveBeenCalled();
  });

  it('assigns the fallback when no rule assigned (no rule, a rule without an assignee, or a skipped assignee)', async () => {
    expect(await applyDefaultInboundAssignee({ id: 't-1', assignedTo: null }, 'fallback-user', actor as never))
      .toEqual({ kind: 'assigned', assigneeId: 'fallback-user' });
    expect(assignTicket).toHaveBeenCalledWith('t-1', 'fallback-user', actor);
  });

  it('is not configured when no fallback is set', async () => {
    expect(await applyDefaultInboundAssignee({ id: 't-1', assignedTo: null }, null, actor as never)).toEqual({ kind: 'not_configured' });
  });

  it('an ineligible fallback is skipped, not thrown', async () => {
    assignTicket.mockRejectedValueOnce(new TicketServiceError('no', 400, 'ASSIGNEE_NOT_ELIGIBLE'));
    const out = await applyDefaultInboundAssignee({ id: 't-1', assignedTo: null }, 'fallback-user', actor as never);
    expect(out.kind).toBe('skipped');
  });
});
