import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const mocks = vi.hoisted(() => ({ rows: vi.fn(), lock: vi.fn(), where: vi.fn(), links: vi.fn() }));
vi.mock('../../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: (predicate: unknown) => {
      mocks.where(predicate);
      const query = { limit: mocks.rows, for: (mode: string) => { mocks.lock(mode); return query; } };
      return query;
    } }) })
  }
}));
vi.mock('../ticketEmailLinks', () => ({ findTicketIdsByMessageIds: mocks.links }));

import { findClosedTicketInPartner, findTicketInPartner, type MatchedTicket, type SenderResolver } from './threadMatcher';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const ticket: MatchedTicket = {
  id: '33333333-3333-4333-8333-333333333333', partnerId: PARTNER, orgId: ORG,
  status: 'open', emailThreadKey: '<anchor@example.com>', internalNumber: 'T-2026-0001',
  submittedBy: 'requester', requesterContactId: 'contact', submitterEmail: 'requester@example.com'
};
const sender = (id: string, orgId = ORG): SenderResolver => ({
  portalUser: vi.fn(async () => ({ id, orgId, contactId: null, name: null })),
  domainOrg: vi.fn(async () => null)
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows.mockResolvedValue([ticket]);
  mocks.links.mockResolvedValue([]);
});

describe.each([
  ['live', findTicketInPartner], ['closed', findClosedTicketInPartner]
] as const)('%s header thread matching', (_name, match) => {
  it.each([
    { inReplyTo: '<anchor@example.com>' },
    { references: ['<anchor@example.com>'] }
  ])('rejects another requester using header %j', async (headers) => {
    expect(await match({ ...headers, from: 'other@example.com' }, PARTNER, sender('other'))).toBeNull();
  });

  it('locks the matched ticket before checking requester identity', async () => {
    const resolver = sender('requester');
    vi.mocked(resolver.portalUser).mockImplementation(async () => {
      expect(mocks.lock).toHaveBeenCalledWith('update');
      return { id: 'requester', orgId: ORG, contactId: null, name: null };
    });
    expect(await match({ inReplyTo: '<anchor@example.com>', from: 'requester@example.com' }, PARTNER, resolver)).toEqual(ticket);
    expect(resolver.portalUser).toHaveBeenCalledOnce();
  });

  it('rejects a historical requester whose ticket moved to another org', async () => {
    expect(await match({ inReplyTo: '<anchor@example.com>', from: ticket.submitterEmail }, PARTNER,
      sender('requester', '44444444-4444-4444-8444-444444444444'))).toBeNull();
  });

  it('accepts an email-only requester only with its current org domain binding', async () => {
    const resolver: SenderResolver = {
      portalUser: vi.fn(async () => null), domainOrg: vi.fn(async () => ({ orgId: ORG, autoCreateContact: false }))
    };
    expect(await match({ inReplyTo: '<anchor@example.com>', from: ' REQUESTER@EXAMPLE.COM ' }, PARTNER, resolver)).toEqual(ticket);
    expect(resolver.domainOrg).toHaveBeenCalledOnce();
  });

  it('also binds matches supplied by ticket email links', async () => {
    mocks.links.mockResolvedValue([ticket.id]);
    expect(await match({ references: ['<linked@example.com>'], from: 'other@example.com' }, PARTNER, sender('other'))).toBeNull();
    expect(mocks.links).toHaveBeenCalledWith(PARTNER, ['<linked@example.com>']);
  });

  it('keeps authenticated technician matching partner-scoped without locks', async () => {
    expect(await match({ inReplyTo: '<anchor@example.com>' }, PARTNER)).toEqual(ticket);
    expect(mocks.lock).not.toHaveBeenCalled();
    const compiled = new PgDialect().sqlToQuery(mocks.where.mock.calls[0]![0]);
    expect(compiled.sql).toContain('"tickets"."partner_id" =');
    expect(compiled.sql).toContain('"tickets"."deleted_at" is null');
    expect(compiled.params).toContain(PARTNER);
  });
});
