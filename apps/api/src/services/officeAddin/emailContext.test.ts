import { beforeEach, describe, expect, it, vi } from 'vitest';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// Every query in emailContext.ts ends the chain in `.limit(n)` (possibly
// preceded by `.innerJoin()`), so a single generic chain shape covers all of
// them. Responses are keyed by a `__table` marker on the mocked schema
// objects and consumed in FIFO order per table (supports a table being
// queried more than once, e.g. `organizations`).
type Responses = Record<string, unknown[][]>;

let capturedWhereArgs: { table: string; args: unknown[] }[] = [];

function primeDb(responses: Responses) {
  const counters: Record<string, number> = {};
  const chain = (table: { __table: string }): any => ({
    innerJoin: () => chain(table),
    where: (...args: unknown[]) => {
      capturedWhereArgs.push({ table: table.__table, args });
      return {
        limit: () => {
          const key = table.__table;
          const idx = counters[key] ?? 0;
          counters[key] = idx + 1;
          return Promise.resolve(responses[key]?.[idx] ?? []);
        },
      };
    },
  });
  vi.mocked(mockDb.select).mockImplementation(
    ((_cols?: unknown) => ({ from: (table: { __table: string }) => chain(table) })) as never
  );
}

const { mockDb, mocks } = vi.hoisted(() => ({
  mockDb: { select: vi.fn() },
  mocks: {
    findTicketInPartner: vi.fn(async (): Promise<unknown> => null),
    listOrgTicketsForAddin: vi.fn(async () => ({ openTickets: [], recentTickets: [] })),
    getConfig: vi.fn(() => ({ TICKETS_INBOUND_DOMAIN: null as string | null })),
  },
}));

vi.mock('../../db', () => ({ db: mockDb }));

vi.mock('../../db/schema', () => ({
  organizations: { __table: 'organizations', id: 'organizations.id', name: 'organizations.name', partnerId: 'organizations.partner_id' },
  sites: { __table: 'sites', orgId: 'sites.org_id' },
  devices: { __table: 'devices', orgId: 'devices.org_id' },
  tickets: {
    __table: 'tickets',
    orgId: 'tickets.org_id',
    partnerId: 'tickets.partner_id',
    status: 'tickets.status',
    deletedAt: 'tickets.deleted_at',
  },
  contacts: { __table: 'contacts', id: 'contacts.id', name: 'contacts.name', email: 'contacts.email', orgId: 'contacts.org_id' },
  customerEmailDomains: {
    __table: 'customerEmailDomains',
    partnerId: 'customer_email_domains.partner_id',
    domain: 'customer_email_domains.domain',
    isActive: 'customer_email_domains.is_active',
    orgId: 'customer_email_domains.org_id',
  },
  partnerInboundDomains: { __table: 'partnerInboundDomains', partnerId: 'partner_inbound_domains.partner_id' },
  ticketMailboxConnections: {
    __table: 'ticketMailboxConnections',
    partnerId: 'ticket_mailbox_connections.partner_id',
    status: 'ticket_mailbox_connections.status',
    id: 'ticket_mailbox_connections.id',
  },
}));

vi.mock('../../db/schema/portal', () => ({
  portalUsers: { __table: 'portalUsers', id: 'portal_users.id', name: 'portal_users.name', email: 'portal_users.email', orgId: 'portal_users.org_id' },
}));

vi.mock('../../config/validate', () => ({ getConfig: mocks.getConfig }));

vi.mock('../inboundEmail/threadMatcher', () => ({
  findTicketInPartner: mocks.findTicketInPartner,
}));

vi.mock('../ticketService', () => ({
  listOrgTicketsForAddin: mocks.listOrgTicketsForAddin,
}));

import { buildEmailContext, type EmailContextInput } from './emailContext';
import type { OfficeAddinTechAuth } from '../../middleware/officeAddinTechAuth';

function makeTech(overrides: Partial<OfficeAddinTechAuth> = {}): OfficeAddinTechAuth {
  const accessibleOrgIds = overrides.accessibleOrgIds ?? null;
  return {
    userId: 'user-1',
    partnerId: PARTNER_ID,
    bindingId: 'binding-1',
    token: 'tok',
    user: { email: 'tech@partner.example', name: 'Tech' },
    accessibleOrgIds,
    partnerOrgAccess: accessibleOrgIds === null ? 'all' : 'selected',
    permissions: {} as any,
    canAccessOrg: (orgId: string) => accessibleOrgIds === null || accessibleOrgIds.includes(orgId),
    canAccessSite: () => true,
    ...overrides,
  };
}

const baseInput: EmailContextInput = {
  from: { email: 'customer@acme.com', name: 'Customer' },
  sender: null,
  internetMessageId: null,
  references: null,
  inReplyTo: null,
  subject: 'Help please',
  conversationId: null,
  itemGeneration: 7,
};

describe('buildEmailContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfig.mockReturnValue({ TICKETS_INBOUND_DOMAIN: null });
    mocks.listOrgTicketsForAddin.mockResolvedValue({ openTickets: [], recentTickets: [] });
    capturedWhereArgs = [];
  });

  it('resolves org via a single portal_users address match; sender is ignored', async () => {
    primeDb({
      organizations: [[{ id: ORG_A, name: 'Acme' }]],
      portalUsers: [[{ id: 'pu-1', name: 'Alice', email: 'customer@acme.com', orgId: ORG_A }]],
      contacts: [[]],
      sites: [[{ count: 2 }]],
      devices: [[{ count: 5 }]],
      tickets: [[{ count: 1 }]],
    });

    const result = await buildEmailContext(
      { ...baseInput, sender: { email: 'someone-else@partner.example', name: 'Send-on-behalf' } },
      makeTech()
    );

    expect(result.org).toEqual({ id: ORG_A, name: 'Acme' });
    expect(result.contacts).toEqual([
      { kind: 'portal_user', id: 'pu-1', name: 'Alice', email: 'customer@acme.com', orgId: ORG_A, provenance: 'address_match' },
    ]);
    expect(result.itemGeneration).toBe(7);
    expect(result.orgSummary).toEqual({ name: 'Acme', siteCount: 2, deviceCount: 5, openTicketCount: 1 });
  });

  it('matches a mixed-case stored portal_users email against the lowercased sender address', async () => {
    primeDb({
      organizations: [[{ id: ORG_A, name: 'Acme' }]],
      // Stored with mixed case (no DB-level normalization on portal_users.email) —
      // the query must still match via lower(email), same as the contacts path.
      portalUsers: [[{ id: 'pu-1', name: 'Alice', email: 'Customer@Acme.com', orgId: ORG_A }]],
      contacts: [[]],
      sites: [[{ count: 0 }]],
      devices: [[{ count: 0 }]],
      tickets: [[{ count: 0 }]],
    });

    const result = await buildEmailContext(baseInput, makeTech());

    expect(result.org).toEqual({ id: ORG_A, name: 'Acme' });
    expect(result.contacts).toEqual([
      { kind: 'portal_user', id: 'pu-1', name: 'Alice', email: 'Customer@Acme.com', orgId: ORG_A, provenance: 'address_match' },
    ]);

    // The mocked db returns canned rows regardless of the WHERE predicate, so
    // assert the real (unmocked drizzle-orm) predicate actually normalizes
    // case on both sides — `lower(portal_users.email) = <lowercased sender>` —
    // rather than a case-sensitive `eq()` that would silently miss a
    // mixed-case stored row against a real database.
    const portalUsersWhere = capturedWhereArgs.find((c) => c.table === 'portalUsers');
    const serialized = JSON.stringify(portalUsersWhere?.args);
    expect(serialized).toContain('lower(');
  });

  it('portal_users address match wins over a domain mapping', async () => {
    primeDb({
      organizations: [[{ id: ORG_A, name: 'Acme' }]],
      portalUsers: [[{ id: 'pu-1', name: 'Alice', email: 'customer@acme.com', orgId: ORG_A }]],
      contacts: [[]],
      sites: [[{ count: 0 }]],
      devices: [[{ count: 0 }]],
      tickets: [[{ count: 0 }]],
      // Domain table should never even be queried once an address match resolves.
      customerEmailDomains: [[{ orgId: ORG_B }]],
    });

    const result = await buildEmailContext(baseInput, makeTech());
    expect(result.org?.id).toBe(ORG_A);
  });

  it('resolves org via exact customer_email_domains match; subdomain does not match', async () => {
    primeDb({
      organizations: [[{ id: ORG_A, name: 'Acme' }]],
      portalUsers: [[]],
      contacts: [[]],
      customerEmailDomains: [[{ orgId: ORG_A }]],
      sites: [[{ count: 0 }]],
      devices: [[{ count: 0 }]],
      tickets: [[{ count: 0 }]],
    });

    const result = await buildEmailContext(baseInput, makeTech());
    expect(result.org?.id).toBe(ORG_A);
  });

  it('does not widen a subdomain sender into a base-domain mapping', async () => {
    primeDb({
      portalUsers: [[]],
      contacts: [[]],
      // A real `customer_email_domains` row only maps 'acme.com'; the exact-domain
      // WHERE clause means a `mail.acme.com` sender's query returns no rows.
      customerEmailDomains: [[]],
    });

    const result = await buildEmailContext(
      { ...baseInput, from: { email: 'bob@mail.acme.com' } },
      makeTech()
    );
    expect(result.org).toBeNull();
  });

  it('skips domain resolution for a freemail sender', async () => {
    primeDb({
      portalUsers: [[]],
      contacts: [[]],
      customerEmailDomains: [[{ orgId: ORG_A }]], // must never be consumed
    });

    const result = await buildEmailContext(
      { ...baseInput, from: { email: 'person@gmail.com' } },
      makeTech()
    );

    expect(result.org).toBeNull();
    expect(result.orgSummary).toBeNull();
  });

  it('drops a domain-resolved org outside tech.accessibleOrgIds (app-layer narrowing)', async () => {
    primeDb({
      portalUsers: [[]],
      contacts: [[]],
      customerEmailDomains: [[{ orgId: ORG_B }]],
    });

    const result = await buildEmailContext(baseInput, makeTech({ accessibleOrgIds: [ORG_A] }));
    expect(result.org).toBeNull();
  });

  it('returns multiple candidates (never auto-picked) when the address matches contacts in two orgs', async () => {
    primeDb({
      portalUsers: [[{ id: 'pu-1', name: 'Alice', email: 'customer@acme.com', orgId: ORG_A }]],
      contacts: [[{ id: 'c-1', name: 'Alice (other org)', email: 'customer@acme.com', orgId: ORG_B }]],
    });

    const result = await buildEmailContext(baseInput, makeTech());

    expect(result.org).toBeNull();
    expect(result.contacts).toHaveLength(2);
    expect(result.contacts.map((c) => c.orgId).sort()).toEqual([ORG_A, ORG_B].sort());
  });

  it('surfaces threadMatchedTicket from findTicketInPartner, dropped when not accessible', async () => {
    primeDb({ portalUsers: [[]], contacts: [[]] });
    mocks.findTicketInPartner.mockResolvedValueOnce({
      id: 't-1',
      partnerId: PARTNER_ID,
      orgId: ORG_B,
      status: 'open',
      emailThreadKey: 'key',
      internalNumber: 'T-2026-0001',
    });

    const denied = await buildEmailContext(baseInput, makeTech({ accessibleOrgIds: [ORG_A] }));
    expect(denied.threadMatchedTicket).toBeNull();

    primeDb({ portalUsers: [[]], contacts: [[]] });
    mocks.findTicketInPartner.mockResolvedValueOnce({
      id: 't-1',
      partnerId: PARTNER_ID,
      orgId: ORG_A,
      status: 'open',
      emailThreadKey: 'key',
      internalNumber: 'T-2026-0001',
    });
    const allowed = await buildEmailContext(baseInput, makeTech({ accessibleOrgIds: [ORG_A] }));
    expect(allowed.threadMatchedTicket?.id).toBe('t-1');
  });

  it('returns threadMatchedTicket null with no identifiers and no subject token match', async () => {
    primeDb({ portalUsers: [[]], contacts: [[]] });
    mocks.findTicketInPartner.mockResolvedValueOnce(null);

    const result = await buildEmailContext(
      { ...baseInput, internetMessageId: null, references: null, inReplyTo: null, subject: 'no ticket ref here' },
      makeTech()
    );
    expect(result.threadMatchedTicket).toBeNull();
  });

  it('inboundPathConfigured is true when the partner has a connected ticket mailbox', async () => {
    primeDb({
      portalUsers: [[]],
      contacts: [[]],
      ticketMailboxConnections: [[{ id: 'conn-1' }]],
      partnerInboundDomains: [[]],
    });
    const result = await buildEmailContext(baseInput, makeTech());
    expect(result.inboundPathConfigured).toBe(true);
  });

  it('inboundPathConfigured is true when the partner has a Mailgun inbound address configured', async () => {
    primeDb({
      portalUsers: [[]],
      contacts: [[]],
      ticketMailboxConnections: [[]],
      partnerInboundDomains: [[{ partnerId: PARTNER_ID }]],
    });
    const result = await buildEmailContext(baseInput, makeTech());
    expect(result.inboundPathConfigured).toBe(true);
  });

  it('inboundPathConfigured is false when neither path is configured', async () => {
    primeDb({
      portalUsers: [[]],
      contacts: [[]],
      ticketMailboxConnections: [[]],
      partnerInboundDomains: [[]],
    });
    mocks.getConfig.mockReturnValue({ TICKETS_INBOUND_DOMAIN: null });
    const result = await buildEmailContext(baseInput, makeTech());
    expect(result.inboundPathConfigured).toBe(false);
  });
});
