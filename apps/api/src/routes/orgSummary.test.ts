import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { orgSummaryRoutes } from './orgSummary';

// Real (unmocked) permission catalogue + matcher — these are pure, DB-free
// helpers, and using the real PERMISSIONS constants keeps the test's granted
// lists honest against whatever resource/action strings the route actually
// checks (a typo'd literal in the route would fail these tests instead of
// silently never matching).
import { PERMISSIONS } from '../services/permissions';

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((_c: any, next: any) => next()),
  requireScope: vi.fn((...scopes: string[]) => (c: any, next: any) => {
    const auth = c.get('auth');
    if (!scopes.includes(auth?.scope)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  }),
  requirePermission: vi.fn((resource: string, action: string) => (c: any, next: any) => {
    const perms = c.get('permissions');
    const granted = Array.isArray(perms?.permissions) && perms.permissions.some(
      (p: { resource: string; action: string }) =>
        (p.resource === resource || p.resource === '*') && (p.action === action || p.action === '*'),
    );
    if (!granted) {
      return c.json({ error: 'Permission denied' }, 403);
    }
    return next();
  }),
}));

vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

import { db } from '../db';
import {
  organizations,
  devices,
  alerts,
  tickets,
  contracts,
  invoices,
  sites,
  contacts,
  portalUsers,
  auditLogs,
} from '../db/schema';

const ORG_ID = '11111111-1111-1111-1111-111111111111';

/** Wraps `rows` so it behaves both as an awaited select-chain result (`baseRows`)
 * and one with a trailing `.limit()` call (`limitedRows`). The organizations
 * existence check and the primary-contact lookup both call `.limit(1)` —
 * `limitedRows` defaults to `baseRows` for every caller that doesn't need to
 * tell the two apart. */
function queryResult<T>(baseRows: T[], limitedRows: T[] = baseRows) {
  const promise = Promise.resolve(baseRows) as Promise<T[]> & { limit: (n: number) => Promise<T[]> };
  promise.limit = () => Promise.resolve(limitedRows);
  return promise;
}

/** Either a plain row array (used for both the awaited result and any
 * trailing `.limit()` on that table's queries), or — for a table queried
 * BOTH ways with different expected rows (`contacts`: a plain `count(*)` and
 * a separate `.limit(1)` primary-contact lookup) — a `{ base, limited }` pair
 * that lets a test express the two independently. */
type RowsSpec<T> = T[] | { base: T[]; limited: T[] };

/** Table-keyed row stubs. `db.select` is mocked to look up the table passed
 * to `.from()` rather than pinning exact call order/count — the route issues
 * a different number of queries depending on which permission sections are
 * granted, so a positional mock would be brittle to read and to extend. */
function setupDb(rowsByTable: Map<unknown, RowsSpec<unknown>>) {
  vi.mocked(db.select).mockImplementation(
    () =>
      ({
        from: (table: unknown) => ({
          where: () => {
            const spec = rowsByTable.get(table);
            if (spec && !Array.isArray(spec)) {
              return queryResult(spec.base, spec.limited);
            }
            return queryResult((spec as unknown[] | undefined) ?? []);
          },
        }),
      }) as any,
  );
}

function buildApp(opts: {
  scope?: 'system' | 'partner' | 'organization';
  canAccessOrg?: (orgId: string) => boolean;
  grants?: Array<{ resource: string; action: string }>;
}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'tech@example.com', name: 'Tech' },
      scope: opts.scope ?? 'partner',
      partnerId: 'partner-1',
      orgId: null,
      canAccessOrg: opts.canAccessOrg ?? (() => true),
    } as any);
    c.set('permissions', {
      permissions: opts.grants ?? [],
      scope: opts.scope ?? 'partner',
      partnerId: 'partner-1',
      orgId: null,
      roleId: 'role-1',
    } as any);
    await next();
  });
  app.route('/orgs', orgSummaryRoutes);
  return app;
}

const WILDCARD_GRANTS = [{ resource: '*', action: '*' }];

describe('GET /orgs/organizations/:id/summary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('404s when :id is not UUID-shaped', async () => {
    const app = buildApp({ grants: WILDCARD_GRANTS });
    const res = await app.request('/orgs/organizations/not-a-uuid/summary');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Organization not found' });
  });

  it('404s when a partner token cannot access the org', async () => {
    const app = buildApp({ grants: WILDCARD_GRANTS, canAccessOrg: () => false });
    const res = await app.request(`/orgs/organizations/${ORG_ID}/summary`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Organization not found' });
    // Never reaches the DB — canAccessOrg is checked before any lookup.
    expect(db.select).not.toHaveBeenCalled();
  });

  it('404s when the organization does not exist', async () => {
    setupDb(new Map([[organizations, []]]));
    const app = buildApp({ grants: WILDCARD_GRANTS });
    const res = await app.request(`/orgs/organizations/${ORG_ID}/summary`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Organization not found' });
  });

  it('returns every section for a wildcard-permission partner', async () => {
    setupDb(
      new Map<unknown, unknown[]>([
        [organizations, [{ id: ORG_ID, currencyCode: 'USD' }]],
        [devices, [{ total: '5', online: '3', offline: '2' }]],
        [alerts, [{ open: '2', critical: '1', high: '1' }]],
        [tickets, [{ open: '4', awaitingCustomer: '1' }]],
        [contracts, [{ active: '1', nextRenewalAt: '2026-12-01' }]],
        [invoices, [{ outstanding: '150.00', nextDueAt: '2026-10-01', overdueCount: '1' }]],
        [sites, [{ count: '2' }]],
        [
          contacts,
          [{ count: '3', id: 'contact-1', name: 'Jane Doe', email: 'jane@x.example', phone: '555-0100' }],
        ],
        [portalUsers, [{ count: '2' }]],
        [auditLogs, [{ lastActivityAt: '2026-09-01T00:00:00.000Z' }]],
      ]),
    );
    const app = buildApp({ grants: WILDCARD_GRANTS });
    const res = await app.request(`/orgs/organizations/${ORG_ID}/summary`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orgId).toBe(ORG_ID);
    expect(body.devices).toEqual({ total: 5, online: 3, offline: 2 });
    expect(body.alerts).toEqual({ open: 2, critical: 1, high: 1 });
    expect(body.tickets).toEqual({ open: 4, awaitingCustomer: 1 });
    expect(body.contracts).toEqual({ active: 1, nextRenewalAt: new Date('2026-12-01').toISOString() });
    expect(body.invoices).toEqual({
      outstanding: '150.00',
      currencyCode: 'USD',
      nextDueAt: new Date('2026-10-01').toISOString(),
      overdueCount: 1,
    });
    expect(body.sites).toEqual({ count: 2 });
    expect(body.contacts).toEqual({
      count: 3,
      primary: { id: 'contact-1', name: 'Jane Doe', email: 'jane@x.example', phone: '555-0100' },
    });
    expect(body.portalUsers).toEqual({ count: 2 });
    expect(body.lastActivityAt).toBe(new Date('2026-09-01T00:00:00.000Z').toISOString());
  });

  it('omits tickets and invoices when those permissions are missing, but keeps sites', async () => {
    setupDb(
      new Map<unknown, RowsSpec<unknown>>([
        [organizations, [{ id: ORG_ID, currencyCode: 'USD' }]],
        [devices, [{ total: '1', online: '1', offline: '0' }]],
        [alerts, [{ open: '0', critical: '0', high: '0' }]],
        [contracts, [{ active: '0', nextRenewalAt: null }]],
        [sites, [{ count: '1' }]],
        // Discriminated: the plain count(*) sees a row, the `.limit(1)`
        // primary-contact lookup sees none — an org with zero contacts has no
        // primary either. Before this stub distinguished the two queries,
        // both saw `[{ count: '0' }]`, so the route built a garbage
        // `primary: { id: undefined, name: '', ... }` object that nothing
        // here checked for.
        [contacts, { base: [{ count: '0' }], limited: [] }],
        [portalUsers, [{ count: '0' }]],
        [auditLogs, [{ lastActivityAt: null }]],
      ]),
    );
    const app = buildApp({
      grants: [
        PERMISSIONS.DEVICES_READ,
        PERMISSIONS.ALERTS_READ,
        PERMISSIONS.CONTRACTS_READ,
        PERMISSIONS.USERS_READ,
        PERMISSIONS.ORGS_READ,
      ],
    });
    const res = await app.request(`/orgs/organizations/${ORG_ID}/summary`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty('tickets');
    expect(body).not.toHaveProperty('invoices');
    expect(body).not.toHaveProperty('lastActivityAt');
    expect(body.sites).toEqual({ count: 1 });
    expect(body.devices).toEqual({ total: 1, online: 1, offline: 0 });
    expect(body.contacts).toEqual({ count: 0, primary: null });
  });

  it('grants tickets/invoices independently of devices/alerts/contracts (disjoint grant set)', async () => {
    setupDb(
      new Map<unknown, RowsSpec<unknown>>([
        [organizations, [{ id: ORG_ID, currencyCode: 'USD' }]],
        [tickets, [{ open: '2', awaitingCustomer: '1' }]],
        [invoices, [{ outstanding: '50.00', nextDueAt: '2026-10-01', overdueCount: '0' }]],
        [sites, [{ count: '1' }]],
        [contacts, { base: [{ count: '0' }], limited: [] }],
      ]),
    );
    const app = buildApp({
      grants: [PERMISSIONS.ORGS_READ, PERMISSIONS.TICKETS_READ, PERMISSIONS.INVOICES_READ],
    });
    const res = await app.request(`/orgs/organizations/${ORG_ID}/summary`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tickets).toEqual({ open: 2, awaitingCustomer: 1 });
    expect(body.invoices).toEqual({
      outstanding: '50.00',
      currencyCode: 'USD',
      nextDueAt: new Date('2026-10-01').toISOString(),
      overdueCount: 0,
    });
    expect(body.sites).toEqual({ count: 1 });
    expect(body.contacts).toEqual({ count: 0, primary: null });
    expect(body).not.toHaveProperty('devices');
    expect(body).not.toHaveProperty('alerts');
    expect(body).not.toHaveProperty('contracts');
    expect(body).not.toHaveProperty('portalUsers');
    expect(body).not.toHaveProperty('lastActivityAt');
  });

  it('several contacts, none primary: count is real, primary is null', async () => {
    setupDb(
      new Map<unknown, RowsSpec<unknown>>([
        [organizations, [{ id: ORG_ID, currencyCode: 'USD' }]],
        [sites, [{ count: '1' }]],
        [contacts, { base: [{ count: '3' }], limited: [] }],
      ]),
    );
    const app = buildApp({ grants: [PERMISSIONS.ORGS_READ] });
    const res = await app.request(`/orgs/organizations/${ORG_ID}/summary`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contacts).toEqual({ count: 3, primary: null });
  });

  it('includes lastActivityAt only when the caller holds audit:read', async () => {
    setupDb(
      new Map<unknown, RowsSpec<unknown>>([
        [organizations, [{ id: ORG_ID, currencyCode: 'USD' }]],
        [sites, [{ count: '0' }]],
        [contacts, { base: [{ count: '0' }], limited: [] }],
        [auditLogs, [{ lastActivityAt: '2026-09-01T00:00:00.000Z' }]],
      ]),
    );

    const appWithAudit = buildApp({ grants: [PERMISSIONS.ORGS_READ, PERMISSIONS.AUDIT_READ] });
    const resWithAudit = await appWithAudit.request(`/orgs/organizations/${ORG_ID}/summary`);
    expect(resWithAudit.status).toBe(200);
    const bodyWithAudit = await resWithAudit.json();
    expect(bodyWithAudit.lastActivityAt).toBe(new Date('2026-09-01T00:00:00.000Z').toISOString());

    const appWithoutAudit = buildApp({ grants: [PERMISSIONS.ORGS_READ] });
    const resWithoutAudit = await appWithoutAudit.request(`/orgs/organizations/${ORG_ID}/summary`);
    expect(resWithoutAudit.status).toBe(200);
    const bodyWithoutAudit = await resWithoutAudit.json();
    expect(bodyWithoutAudit).not.toHaveProperty('lastActivityAt');
  });

  it('200s for a system-scoped token even when canAccessOrg would be false', async () => {
    setupDb(
      new Map<unknown, RowsSpec<unknown>>([
        [organizations, [{ id: ORG_ID, currencyCode: 'USD' }]],
        [sites, [{ count: '0' }]],
        [contacts, { base: [{ count: '0' }], limited: [] }],
      ]),
    );
    const app = buildApp({ scope: 'system', grants: WILDCARD_GRANTS, canAccessOrg: () => false });
    const res = await app.request(`/orgs/organizations/${ORG_ID}/summary`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orgId).toBe(ORG_ID);
  });

  it('403s an organization-scoped token before any org lookup', async () => {
    const app = buildApp({ scope: 'organization', grants: WILDCARD_GRANTS });
    const res = await app.request(`/orgs/organizations/${ORG_ID}/summary`);
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });
});
