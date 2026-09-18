import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const state = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('../../db', () => ({
  db: { select: state.select },
  runOutsideDbContext: <T,>(fn: () => T): T => fn(),
  withDbAccessContext: <T,>(_context: unknown, fn: () => T): T => fn(),
  withSystemDbAccessContext: <T,>(fn: () => T): T => fn(),
}));
vi.mock('../../services/portal/securityReadModel', () => ({
  securityScoreTile: vi.fn(), devicesProtectedTile: vi.fn(),
}));
vi.mock('../../services/portal/patchReadModel', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../services/portal/patchReadModel')>(),
  patchesAppliedTile: vi.fn(),
}));
vi.mock('../../services/portal/backupReadModel', () => ({ backupTile: vi.fn() }));
vi.mock('../../services/portal/actionItemsReadModel', () => ({ actionItemsTile: vi.fn() }));
vi.mock('../../services/portal/serviceReadModel', () => ({ serviceTile: vi.fn() }));

import { tickets } from '../../db/schema';
import { portalDashboardRoutes } from './dashboard';
import { portalTicketOwnership } from './ticketOwnership';

const ORG = '11111111-1111-4111-8111-111111111111';
const LOGIN = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const compile = (where: SQL) => new PgDialect().sqlToQuery(where);

beforeEach(() => vi.resetAllMocks());

it.each([
  { name: 'portal login', contactId: null, submittedBy: LOGIN, requesterContactId: null, expected: 1 },
  { name: 'linked contact', contactId: CONTACT, submittedBy: null, requesterContactId: CONTACT, expected: 1 },
  { name: 'login with no requests', contactId: null, submittedBy: OTHER, requesterContactId: null, expected: 0 },
])('counts only open requests owned by the $name', async ({ contactId, submittedBy, requesterContactId, expected }) => {
  const user = { id: LOGIN, orgId: ORG, contactId };
  const fixture = [
    { orgId: ORG, submittedBy, requesterContactId, status: 'open', deletedAt: null },
    { orgId: ORG, submittedBy: OTHER, requesterContactId: null, status: 'open', deletedAt: null },
    { orgId: OTHER, submittedBy: LOGIN, requesterContactId: CONTACT, status: 'open', deletedAt: null },
    { orgId: ORG, submittedBy: LOGIN, requesterContactId: CONTACT, status: 'closed', deletedAt: null },
    { orgId: ORG, submittedBy: LOGIN, requesterContactId: CONTACT, status: 'open', deletedAt: new Date() },
  ];
  let openWhere: SQL | undefined;
  state.select.mockImplementation((fields: Record<string, unknown>) => ({
    from: () => ({
      where: (where: SQL) => {
        if (!('openTickets' in fields)) return Promise.resolve([]);
        openWhere = where;
        const query = compile(where);
        // Interpret bound equality values so the real route -> dashboard ->
        // support query determines which fixture rows are visible.
        const bound = (column: string) => {
          const match = query.sql.match(new RegExp(`"tickets"\\."${column}" = \\$(\\d+)`));
          return match ? query.params[Number(match[1]) - 1] : undefined;
        };
        const login = bound('submitted_by');
        const contact = bound('requester_contact_id');
        return Promise.resolve([{ openTickets: fixture.filter((row) =>
          row.orgId === bound('org_id') && row.deletedAt === null &&
          ['new', 'open', 'pending', 'on_hold'].includes(row.status) &&
          (login === undefined && contact === undefined ||
            row.submittedBy === login || row.requesterContactId === contact),
        ).length }]);
      },
    }),
  }));
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: { ...user, email: 'customer@example.com', name: 'Customer', receiveNotifications: true, status: 'active' },
      token: 'token', authMethod: 'bearer', timezone: 'UTC',
    });
    await next();
  });
  app.route('/portal', portalDashboardRoutes);

  const response = await app.request('/portal/dashboard');

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ support: { openTickets: expected } });
  expect(compile(openWhere!)).toEqual(compile(and(
    eq(tickets.orgId, ORG),
    isNull(tickets.deletedAt),
    inArray(tickets.status, ['new', 'open', 'pending', 'on_hold']),
    portalTicketOwnership(user),
  )!));
});
