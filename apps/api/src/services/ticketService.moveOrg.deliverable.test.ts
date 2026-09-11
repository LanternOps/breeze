import { describe, expect, it } from 'vitest';
import {
  DELIVERABLE_TICKET_PINNED_MESSAGE, assertTicketNotPinnedToDeliverable, assertDeviceTicketsNotPinnedToDeliverable,
} from './ticketService';

// The guards themselves; that moveTicketOrg actually calls the ticket-axis one
// (and that the move succeeds once unpinned) is proven on real Postgres in
// __tests__/integration/deliverableSweep.integration.test.ts.
const txWith = (result: unknown[]) => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => result }) }) }) });
const joinTxWith = (result: unknown[]) => ({
  select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ limit: async () => result }) }) }) }),
});

describe('move-org deliverable pin (#5573 spec §6)', () => {
  it('throws 409 DELIVERABLE_TICKET_PINNED when an occurrence is linked', async () => {
    await expect(assertTicketNotPinnedToDeliverable(txWith([{ id: 'o1', nameSnapshot: 'Sign-in log review' }]) as never, 't1'))
      .rejects.toMatchObject({ status: 409, code: 'DELIVERABLE_TICKET_PINNED', message: DELIVERABLE_TICKET_PINNED_MESSAGE });
  });

  it('passes when no occurrence is linked', async () => {
    await expect(assertTicketNotPinnedToDeliverable(txWith([]) as never, 't1')).resolves.toBeUndefined();
  });

  // The device-move door re-stamps tickets.org_id for every ticket on the
  // device, so it trips the same FK and needs the same refusal.
  it('throws the same 409 when a ticket on the moved DEVICE is pinned', async () => {
    await expect(assertDeviceTicketsNotPinnedToDeliverable(joinTxWith([{ id: 'o1' }]) as never, 'd1'))
      .rejects.toMatchObject({ status: 409, code: 'DELIVERABLE_TICKET_PINNED', message: DELIVERABLE_TICKET_PINNED_MESSAGE });
  });

  it('passes when the device carries no pinned ticket', async () => {
    await expect(assertDeviceTicketsNotPinnedToDeliverable(joinTxWith([]) as never, 'd1')).resolves.toBeUndefined();
  });
});
