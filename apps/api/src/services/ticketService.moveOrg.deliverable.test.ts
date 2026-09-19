import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  DELIVERABLE_TICKET_PINNED_MESSAGE, assertTicketNotPinnedToDeliverable, assertDeviceTicketsNotPinnedToDeliverable,
} from './ticketService';

// The guards themselves; that moveTicketOrg actually calls the ticket-axis one
// (and that the move succeeds once unpinned) is proven on real Postgres in
// __tests__/integration/deliverableSweep.integration.test.ts.
const txWith = (result: unknown[], where = vi.fn()) => ({
  select: () => ({ from: () => ({ where: (condition: unknown) => {
    where(condition);
    return { limit: async () => result };
  } }) }),
});
const joinTxWith = (result: unknown[], where = vi.fn()) => ({
  select: () => ({ from: () => ({ innerJoin: () => ({ where: (condition: unknown) => {
    where(condition);
    return { limit: async () => result };
  } }) }) }),
});
const SOURCE_ORG = '11111111-1111-4111-8111-111111111111';

describe('move-org deliverable pin (#5573 spec §6)', () => {
  it.each([
    ['ticket', assertTicketNotPinnedToDeliverable, txWith, 'ticket_id'],
    ['device', assertDeviceTicketsNotPinnedToDeliverable, joinTxWith, 'device_id'],
  ] as const)('scopes the %s pin lookup to the source organization', async (_axis, guard, makeTx, idColumn) => {
    const where = vi.fn();
    const resourceId = '22222222-2222-4222-8222-222222222222';
    await guard(makeTx([], where) as never, resourceId, SOURCE_ORG);
    const query = new PgDialect().sqlToQuery(where.mock.calls[0]![0]);
    expect(query.sql).toContain('"service_deliverable_occurrences"."org_id" =');
    expect(query.sql).toContain(`"${idColumn}" =`);
    expect(query.params).toContain(SOURCE_ORG);
    expect(query.params).toContain(resourceId);
  });

  it('throws 409 DELIVERABLE_TICKET_PINNED when an occurrence is linked', async () => {
    await expect(assertTicketNotPinnedToDeliverable(txWith([{ id: 'o1', nameSnapshot: 'Sign-in log review' }]) as never, 't1', SOURCE_ORG))
      .rejects.toMatchObject({ status: 409, code: 'DELIVERABLE_TICKET_PINNED', message: DELIVERABLE_TICKET_PINNED_MESSAGE });
  });

  it('passes when no occurrence is linked', async () => {
    await expect(assertTicketNotPinnedToDeliverable(txWith([]) as never, 't1', SOURCE_ORG)).resolves.toBeUndefined();
  });

  // The device-move door re-stamps tickets.org_id for every ticket on the
  // device, so it trips the same FK and needs the same refusal.
  it('throws the same 409 when a ticket on the moved DEVICE is pinned', async () => {
    await expect(assertDeviceTicketsNotPinnedToDeliverable(joinTxWith([{ id: 'o1' }]) as never, 'd1', SOURCE_ORG))
      .rejects.toMatchObject({ status: 409, code: 'DELIVERABLE_TICKET_PINNED', message: DELIVERABLE_TICKET_PINNED_MESSAGE });
  });

  it('passes when the device carries no pinned ticket', async () => {
    await expect(assertDeviceTicketsNotPinnedToDeliverable(joinTxWith([]) as never, 'd1', SOURCE_ORG)).resolves.toBeUndefined();
  });
});
