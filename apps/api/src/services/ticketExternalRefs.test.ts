import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  values: vi.fn(),
  insertReturning: vi.fn(),
  selectResult: vi.fn(),
  deleteWhere: vi.fn(),
}));
vi.mock('../db', () => ({
  db: {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({
      insert: vi.fn(() => ({
        values: vi.fn((v: unknown) => {
          mocks.values(v);
          return { onConflictDoUpdate: vi.fn(() => ({ returning: vi.fn(() => mocks.insertReturning()) })) };
        }),
      })),
    })),
    select: vi.fn(() => {
      const b: any = {
        from: vi.fn(() => b), innerJoin: vi.fn(() => b), where: vi.fn(() => b),
        limit: vi.fn(() => mocks.selectResult()),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(mocks.selectResult()).then(res, rej),
      };
      return b;
    }),
    delete: vi.fn(() => ({ where: vi.fn((w: unknown) => { mocks.deleteWhere(w); return Promise.resolve(); }) })),
  },
}));

import {
  TicketExternalRefConflictError,
  clearTicketExternalRef,
  findTicketIdByExternalRef,
  ticketExternalRefsFor,
  upsertTicketExternalRef,
} from './ticketExternalRefs';

const TICKET_ORG = '44444444-4444-4444-8444-444444444444';
const input = {
  principalId: '11111111-1111-4111-8111-111111111111',
  partnerId: '22222222-2222-4222-8222-222222222222',
  ticketId: '33333333-3333-4333-8333-333333333333',
  externalId: 'PSA-42',
  externalUrl: 'https://psa.example/42',
};

describe('ticketExternalRefs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Every upsert first reads the ticket's org; tests that exercise the
    // conflict lookup queue their holder rows after this one.
    mocks.selectResult.mockResolvedValueOnce([{ orgId: TICKET_ORG }]);
  });

  it('upserts (principal, ticket) → external id with the org read from the TICKET, never from the caller', async () => {
    mocks.insertReturning.mockResolvedValueOnce([{ ticketId: input.ticketId, externalId: 'PSA-42', externalUrl: input.externalUrl }]);
    const ref = await upsertTicketExternalRef({ ...input, orgId: 'caller-supplied-org' } as typeof input);
    expect(ref).toEqual({ ticketId: input.ticketId, externalId: 'PSA-42', externalUrl: input.externalUrl });
    expect(mocks.values).toHaveBeenCalledWith({
      ticketId: input.ticketId, orgId: TICKET_ORG, partnerId: input.partnerId,
      partnerServicePrincipalId: input.principalId, externalId: 'PSA-42', externalUrl: input.externalUrl,
    });
  });

  it('refuses to write a ref for a ticket this context cannot see (callers authorize first)', async () => {
    mocks.selectResult.mockReset();
    mocks.selectResult.mockResolvedValueOnce([]);
    await expect(upsertTicketExternalRef(input)).rejects.toThrow(/not visible to this context/);
    expect(mocks.values).not.toHaveBeenCalled();
  });

  it('maps a 23505 on the (principal, external_id) index to 409 EXTERNAL_ID_CONFLICT naming the holder', async () => {
    mocks.insertReturning.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505', constraint_name: 'ticket_external_refs_principal_external_uq' }));
    mocks.selectResult.mockResolvedValueOnce([{ ticketId: 'other-ticket', deletedAt: new Date() }]);
    const err = await upsertTicketExternalRef(input).catch((e) => e);
    expect(err).toBeInstanceOf(TicketExternalRefConflictError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('EXTERNAL_ID_CONFLICT');
    expect(err.details).toEqual({ externalTicketId: 'PSA-42', existingTicketId: 'other-ticket', existingDeleted: true });
  });

  it('a conflict whose holder RLS hides reports null ids; the same ticket re-asserting its own id is a no-op', async () => {
    mocks.insertReturning.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505', constraint_name: 'ticket_external_refs_principal_external_uq' }));
    mocks.selectResult.mockResolvedValueOnce([]);
    const hidden = await upsertTicketExternalRef(input).catch((e) => e);
    expect(hidden.details).toEqual({ externalTicketId: 'PSA-42', existingTicketId: null, existingDeleted: null });

    mocks.insertReturning.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505', constraint_name: 'ticket_external_refs_principal_external_uq' }));
    mocks.selectResult.mockResolvedValueOnce([{ orgId: TICKET_ORG }]); // the second upsert's ticket read
    mocks.selectResult.mockResolvedValueOnce([{ ticketId: input.ticketId, deletedAt: null }]);
    await expect(upsertTicketExternalRef(input)).resolves.toEqual({ ticketId: input.ticketId, externalId: 'PSA-42', externalUrl: input.externalUrl });
  });

  it('a 23505 from any other index is rethrown untouched', async () => {
    const boom = Object.assign(new Error('dup'), { code: '23505', constraint_name: 'something_else' });
    mocks.insertReturning.mockRejectedValueOnce(boom);
    await expect(upsertTicketExternalRef(input)).rejects.toBe(boom);
  });

  it('lookups are scoped by principal', async () => {
    mocks.selectResult.mockReset();
    mocks.selectResult.mockResolvedValueOnce([{ ticketId: input.ticketId }]);
    expect(await findTicketIdByExternalRef(input.principalId, 'PSA-42')).toBe(input.ticketId);
    mocks.selectResult.mockResolvedValueOnce([]);
    expect(await findTicketIdByExternalRef(input.principalId, 'PSA-nope')).toBeNull();
    mocks.selectResult.mockResolvedValueOnce([{ ticketId: input.ticketId, externalId: 'PSA-42', externalUrl: null }]);
    const map = await ticketExternalRefsFor(input.principalId, [input.ticketId]);
    expect(map.get(input.ticketId)).toEqual({ ticketId: input.ticketId, externalId: 'PSA-42', externalUrl: null });
    expect((await ticketExternalRefsFor(input.principalId, [])).size).toBe(0);
    await clearTicketExternalRef(input.principalId, input.ticketId);
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(1);
  });
});
