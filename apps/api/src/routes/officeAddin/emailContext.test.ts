import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type AuthState = { accessibleOrgIds: string[] | null };

const { authRef, mockDb } = vi.hoisted(() => ({
  authRef: { current: { accessibleOrgIds: null as string[] | null } as AuthState },
  mockDb: { select: vi.fn() },
}));

// Middleware is exercised elsewhere (officeAddinTechAuth's own tests); here it
// is stubbed to publish `officeAddinAuth` from the test-controlled ref,
// matching bindingsAdmin.test.ts's authRef pattern. `canAccessOrg` is the
// REAL narrowing closure under test — everything downstream (buildEmailContext,
// searchOrgsForAddin) runs unmocked against a mocked db.
vi.mock('../../middleware/officeAddinTechAuth', () => ({
  officeAddinTechAuthMiddleware: vi.fn(async (c: any, next: any) => {
    const accessibleOrgIds = authRef.current.accessibleOrgIds;
    c.set('officeAddinAuth', {
      userId: 'user-1',
      partnerId: PARTNER_ID,
      bindingId: 'binding-1',
      token: 'tok',
      user: { email: 'tech@partner.example', name: 'Tech' },
      accessibleOrgIds,
      partnerOrgAccess: accessibleOrgIds === null ? 'all' : 'selected',
      permissions: {},
      canAccessOrg: (orgId: string) => accessibleOrgIds === null || accessibleOrgIds.includes(orgId),
      canAccessSite: () => true,
    });
    return next();
  }),
  requireAddinCapability: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../db', () => ({ db: mockDb }));

vi.mock('../../db/schema', () => ({
  organizations: { __table: 'organizations', id: 'organizations.id', name: 'organizations.name', partnerId: 'organizations.partner_id' },
  sites: { __table: 'sites', orgId: 'sites.org_id' },
  devices: { __table: 'devices', orgId: 'devices.org_id' },
  tickets: { __table: 'tickets', orgId: 'tickets.org_id', partnerId: 'tickets.partner_id', status: 'tickets.status', deletedAt: 'tickets.deleted_at' },
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

vi.mock('../../config/validate', () => ({ getConfig: vi.fn(() => ({ TICKETS_INBOUND_DOMAIN: null })) }));

vi.mock('../../services/inboundEmail/threadMatcher', () => ({
  findTicketInPartner: vi.fn(async () => null),
}));

vi.mock('../../services/ticketService', () => ({
  listOrgTicketsForAddin: vi.fn(async () => ({ openTickets: [], recentTickets: [] })),
}));

import { officeAddinEmailContextRoutes } from './emailContext';

type Responses = Record<string, unknown[][]>;

let capturedWhereArgs: unknown[] = [];

function primeDb(responses: Responses) {
  const counters: Record<string, number> = {};
  const chain = (table: { __table: string }): any => ({
    innerJoin: () => chain(table),
    where: (...args: unknown[]) => {
      capturedWhereArgs.push(...args);
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

function makeApp() {
  const app = new Hono();
  app.route('/', officeAddinEmailContextRoutes);
  return app;
}

const baseBody = {
  from: { email: 'customer@acme.com', name: 'Customer' },
  subject: 'Help please',
  itemGeneration: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  authRef.current = { accessibleOrgIds: null };
  capturedWhereArgs = [];
});

describe('POST /email-context', () => {
  it('returns the domain-resolved org for an all-org technician', async () => {
    authRef.current = { accessibleOrgIds: null };
    primeDb({
      portalUsers: [[]],
      contacts: [[]],
      customerEmailDomains: [[{ orgId: ORG_A }]],
      organizations: [[{ id: ORG_A, name: 'Acme' }]],
      sites: [[{ count: 0 }]],
      devices: [[{ count: 0 }]],
      tickets: [[{ count: 0 }]],
    });

    const res = await makeApp().request('/email-context', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.org).toEqual({ id: ORG_A, name: 'Acme' });
    expect(body.itemGeneration).toBe(1);
  });

  it('a selected-org technician never sees another org resolved via domain mapping', async () => {
    authRef.current = { accessibleOrgIds: [ORG_B] }; // does NOT include ORG_A
    primeDb({
      portalUsers: [[]],
      contacts: [[]],
      customerEmailDomains: [[{ orgId: ORG_A }]],
    });

    const res = await makeApp().request('/email-context', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.org).toBeNull();
    expect(body.orgSummary).toBeNull();
    expect(body.openTickets).toEqual([]);
    expect(body.recentTickets).toEqual([]);
  });

  it('a selected-org technician never sees an address-matched contact from an inaccessible org', async () => {
    authRef.current = { accessibleOrgIds: [ORG_B] };
    primeDb({
      portalUsers: [[{ id: 'pu-1', name: 'Alice', email: 'customer@acme.com', orgId: ORG_A }]],
      contacts: [[]],
    });

    const res = await makeApp().request('/email-context', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contacts).toEqual([]);
    expect(body.org).toBeNull();
  });

  it('400s on an invalid body (missing subject)', async () => {
    const res = await makeApp().request('/email-context', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: { email: 'a@b.com' }, itemGeneration: 1 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /orgs/search', () => {
  it('returns matching orgs for an all-org technician', async () => {
    authRef.current = { accessibleOrgIds: null };
    primeDb({ organizations: [[{ id: ORG_A, name: 'Acme Corp' }]] });

    const res = await makeApp().request('/orgs/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'acme' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orgs).toEqual([{ id: ORG_A, name: 'Acme Corp' }]);
  });

  it('a selected-org technician only sees granted orgs (asserts the inArray narrowing predicate is attached)', async () => {
    authRef.current = { accessibleOrgIds: [ORG_B] };
    primeDb({ organizations: [[{ id: ORG_B, name: 'Beta Corp' }]] });

    const res = await makeApp().request('/orgs/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'corp' }),
    });
    expect(res.status).toBe(200);

    // The mocked db returns canned rows regardless of the WHERE clause, so the
    // narrowing itself is verified by inspecting the actual condition object
    // built by searchOrgsForAddin (real drizzle-orm `inArray`/`eq`/`ilike`,
    // unmocked in this file) — it must reference the technician's granted org
    // and must NOT be an unrestricted (all-org) query.
    const serialized = JSON.stringify(capturedWhereArgs);
    expect(serialized).toContain(ORG_B);
  });

  it('does not narrow by org for an all-org (partnerOrgAccess=all) technician', async () => {
    authRef.current = { accessibleOrgIds: null };
    primeDb({ organizations: [[{ id: ORG_A, name: 'Acme Corp' }]] });

    await makeApp().request('/orgs/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'acme' }),
    });

    // No org-id predicate at all should be present — only the partner + name-ilike conditions.
    const serialized = JSON.stringify(capturedWhereArgs);
    expect(serialized).not.toContain(ORG_A);
    expect(serialized).not.toContain(ORG_B);
  });

  it('400s on an empty query', async () => {
    const res = await makeApp().request('/orgs/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '' }),
    });
    expect(res.status).toBe(400);
  });
});
