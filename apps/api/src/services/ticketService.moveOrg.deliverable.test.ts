import { describe, expect, it } from 'vitest';
import { DELIVERABLE_TICKET_PINNED_MESSAGE, assertTicketNotPinnedToDeliverable } from './ticketService';

// The guard itself; that moveTicketOrg actually calls it (and that the move
// succeeds once unpinned) is proven on real Postgres in
// __tests__/integration/deliverableSweep.integration.test.ts.
const txWith = (result: unknown[]) => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => result }) }) }) });

describe('move-org deliverable pin (#5573 spec §6)', () => {
  it('throws 409 DELIVERABLE_TICKET_PINNED when an occurrence is linked', async () => {
    await expect(assertTicketNotPinnedToDeliverable(txWith([{ id: 'o1', nameSnapshot: 'Sign-in log review' }]) as never, 't1'))
      .rejects.toMatchObject({ status: 409, code: 'DELIVERABLE_TICKET_PINNED', message: DELIVERABLE_TICKET_PINNED_MESSAGE });
  });

  it('passes when no occurrence is linked', async () => {
    await expect(assertTicketNotPinnedToDeliverable(txWith([]) as never, 't1')).resolves.toBeUndefined();
  });
});
