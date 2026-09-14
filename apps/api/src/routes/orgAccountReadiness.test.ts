import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Real (unmocked) permission catalogue + matcher — pure, DB-free helpers; the
// real constants keep the granted lists honest against the strings the route
// checks (a typo'd literal in the route fails here instead of never matching).
import { PERMISSIONS } from '../services/permissions';
import type { AcceptedOrg, OrgReadinessSignals } from '../services/orgAccountReadiness';

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

// services/permissions imports ../db; keep the pool out of the unit run.
vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('../services/serviceManagement', () => ({
  getServiceManagementMode: vi.fn(),
}));

vi.mock('../services/orgAccountReadiness', () => ({
  resolveAcceptedOrgs: vi.fn(),
  loadAccountReadiness: vi.fn(),
}));

// W03's extras composer runs for real (services/orgAccountReadinessExtras is
// not mocked); a WILDCARD_GRANTS caller now genuinely holds connected_apps:read
// / contracts:read / backup:read, so these loaders get invoked. Defaulted to
// empty so unrelated W01 assertions don't need to know about W03 payloads.
vi.mock('../services/orgAccountReadinessIntegrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/orgAccountReadinessIntegrations')>();
  return { ...actual, loadIntegrationReadiness: vi.fn() };
});
vi.mock('../services/orgAccountReadinessCommercial', () => ({
  loadActiveContractCounts: vi.fn(),
  loadBackupReadiness: vi.fn(),
}));

import { getServiceManagementMode } from '../services/serviceManagement';
import { loadAccountReadiness, resolveAcceptedOrgs } from '../services/orgAccountReadiness';
import { loadIntegrationReadiness } from '../services/orgAccountReadinessIntegrations';
import { loadActiveContractCounts, loadBackupReadiness } from '../services/orgAccountReadinessCommercial';
import { MAX_ACCOUNT_READINESS_ORG_IDS, orgAccountReadinessRoutes, parseOrgIdsParam } from './orgAccountReadiness';

const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '11111111-1111-4111-8111-222222222222';
const WILDCARD_GRANTS = [{ resource: '*', action: '*' }];

/** Deterministic, UUID-shaped ids for the cap tests. */
function uuidAt(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function acceptedOrg(id: string, overrides: Partial<AcceptedOrg> = {}): AcceptedOrg {
  return { id, type: 'customer', status: 'active', billingAddress: true, ...overrides };
}

function fullSignals(overrides: Partial<OrgReadinessSignals> = {}): OrgReadinessSignals {
  return {
    sites: 2,
    devices: 5,
    lastSeenAt: '2026-09-01T00:00:00.000Z',
    policyAssigned: true,
    primaryContact: { name: 'Jane Doe', email: 'jane@x.example', phone: '555-0100', mobile: null },
    billingRoleContact: true,
    pendingInvitations: 1,
    overdueInvoices: 2,
    tickets: { open: 4, awaitingCustomer: 1, slaBreached: 1 },
    ...overrides,
  };
}

function buildApp(opts: {
  scope?: 'system' | 'partner' | 'organization';
  partnerId?: string | null;
  accessibleOrgIds?: string[] | null;
  grants?: Array<{ resource: string; action: string }>;
  /** Mount something under /orgs BEFORE the readiness router (composed-app tests). */
  before?: (app: Hono) => void;
}) {
  const scope = opts.scope ?? 'partner';
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'tech@example.com', name: 'Tech', isPlatformAdmin: scope === 'system' },
      scope,
      partnerId: opts.partnerId === undefined ? (scope === 'system' ? null : PARTNER_ID) : opts.partnerId,
      orgId: null,
      accessibleOrgIds:
        opts.accessibleOrgIds === undefined ? (scope === 'system' ? null : [ORG_A, ORG_B]) : opts.accessibleOrgIds,
      canAccessOrg: () => true,
    } as any);
    c.set('permissions', {
      permissions: opts.grants ?? [],
      scope,
      partnerId: PARTNER_ID,
      orgId: null,
      roleId: 'role-1',
    } as any);
    await next();
  });
  opts.before?.(app);
  app.route('/orgs', orgAccountReadinessRoutes);
  return app;
}

function path(orgIds: string[], extra: Record<string, string> = {}): string {
  const query = [`orgIds=${orgIds.join(',')}`, ...Object.entries(extra).map(([k, v]) => `${k}=${v}`)];
  return `/orgs/account-readiness?${query.join('&')}`;
}

describe('parseOrgIdsParam', () => {
  it('rejects a missing or blank value', () => {
    expect(parseOrgIdsParam(undefined)).toEqual({ ok: false, error: 'orgIds is required' });
    expect(parseOrgIdsParam('  ')).toEqual({ ok: false, error: 'orgIds is required' });
    expect(parseOrgIdsParam(',,')).toEqual({ ok: false, error: 'orgIds is required' });
  });

  it('rejects any non-UUID entry', () => {
    expect(parseOrgIdsParam(`${ORG_A},not-a-uuid`)).toEqual({ ok: false, error: 'orgIds must be comma-separated UUIDs' });
  });

  it('caps at 200 entries as sent (before de-duplication)', () => {
    const ids = Array.from({ length: MAX_ACCOUNT_READINESS_ORG_IDS + 1 }, (_, i) => uuidAt(i));
    expect(parseOrgIdsParam(ids.join(','))).toEqual({ ok: false, error: 'orgIds accepts at most 200 ids' });
    expect(parseOrgIdsParam(ids.slice(0, MAX_ACCOUNT_READINESS_ORG_IDS).join(',')).ok).toBe(true);
  });

  it('trims, lower-cases and de-duplicates while keeping first-seen order', () => {
    expect(parseOrgIdsParam(` ${ORG_B.toUpperCase()}, ${ORG_A} ,${ORG_B}`)).toEqual({ ok: true, orgIds: [ORG_B, ORG_A] });
  });
});

describe('GET /orgs/account-readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServiceManagementMode).mockResolvedValue('native');
    vi.mocked(resolveAcceptedOrgs).mockResolvedValue([acceptedOrg(ORG_A)]);
    vi.mocked(loadAccountReadiness).mockResolvedValue(new Map([[ORG_A, fullSignals()]]));
    vi.mocked(loadIntegrationReadiness).mockResolvedValue({ connectors: [], byOrg: new Map() });
    vi.mocked(loadActiveContractCounts).mockResolvedValue(new Map());
    vi.mocked(loadBackupReadiness).mockResolvedValue({ applicable: false, configuredOrgIds: new Set() });
  });

  it('400s without orgIds and never touches the services', async () => {
    const app = buildApp({ grants: WILDCARD_GRANTS });
    const res = await app.request('/orgs/account-readiness');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'orgIds is required' });
    expect(getServiceManagementMode).not.toHaveBeenCalled();
    expect(resolveAcceptedOrgs).not.toHaveBeenCalled();
  });

  it('400s on a malformed id', async () => {
    const app = buildApp({ grants: WILDCARD_GRANTS });
    const res = await app.request(path([ORG_A, 'nope']));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'orgIds must be comma-separated UUIDs' });
    expect(resolveAcceptedOrgs).not.toHaveBeenCalled();
  });

  it('400s above the 200-id cap and accepts exactly 200', async () => {
    const app = buildApp({ grants: WILDCARD_GRANTS });
    const ids = Array.from({ length: 201 }, (_, i) => uuidAt(i));
    const over = await app.request(path(ids));
    expect(over.status).toBe(400);
    expect(await over.json()).toEqual({ error: 'orgIds accepts at most 200 ids' });

    const exact = await app.request(path(ids.slice(0, 200)));
    expect(exact.status).toBe(200);
    expect(vi.mocked(resolveAcceptedOrgs).mock.calls[0]?.[0].orgIds).toHaveLength(200);
  });

  it('de-duplicates repeated ids before resolution', async () => {
    const app = buildApp({ grants: WILDCARD_GRANTS });
    const res = await app.request(path([ORG_A, ORG_A, ORG_B, ORG_A]));
    expect(res.status).toBe(200);
    expect(vi.mocked(resolveAcceptedOrgs).mock.calls[0]?.[0].orgIds).toEqual([ORG_A, ORG_B]);
  });

  it('system scope: 400s without partnerId, and on a malformed one', async () => {
    const app = buildApp({ scope: 'system', grants: WILDCARD_GRANTS });
    const missing = await app.request(path([ORG_A]));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'partnerId is required for system scope' });

    const malformed = await app.request(path([ORG_A], { partnerId: 'nope' }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'partnerId must be a UUID' });
    expect(resolveAcceptedOrgs).not.toHaveBeenCalled();
  });

  it('system scope: resolves against the named partner with unrestricted access', async () => {
    const app = buildApp({ scope: 'system', grants: WILDCARD_GRANTS });
    const res = await app.request(path([ORG_A], { partnerId: OTHER_PARTNER_ID }));
    expect(res.status).toBe(200);
    expect(resolveAcceptedOrgs).toHaveBeenCalledWith({ orgIds: [ORG_A], partnerId: OTHER_PARTNER_ID, accessibleOrgIds: null });
    expect(getServiceManagementMode).toHaveBeenCalledWith(OTHER_PARTNER_ID);
    expect((await res.json()).partnerId).toBe(OTHER_PARTNER_ID);
  });

  it("partner scope: ignores a partnerId query and passes the token's partner and accessible list", async () => {
    const app = buildApp({ grants: WILDCARD_GRANTS, accessibleOrgIds: [ORG_A, ORG_B] });
    const res = await app.request(path([ORG_A, ORG_B], { partnerId: OTHER_PARTNER_ID }));
    expect(res.status).toBe(200);
    expect(resolveAcceptedOrgs).toHaveBeenCalledWith({ orgIds: [ORG_A, ORG_B], partnerId: PARTNER_ID, accessibleOrgIds: [ORG_A, ORG_B] });
    expect(getServiceManagementMode).toHaveBeenCalledWith(PARTNER_ID);
    expect((await res.json()).partnerId).toBe(PARTNER_ID);
  });

  it('partner scope: an unresolved accessible list fails closed (empty, not null)', async () => {
    const app = buildApp({ grants: WILDCARD_GRANTS, accessibleOrgIds: null });
    await app.request(path([ORG_A]));
    expect(vi.mocked(resolveAcceptedOrgs).mock.calls[0]?.[0].accessibleOrgIds).toEqual([]);
  });

  it('partner scope: 400s when the token carries no partner', async () => {
    const app = buildApp({ grants: WILDCARD_GRANTS, partnerId: null });
    const res = await app.request(path([ORG_A]));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Partner context required' });
  });

  it('silently omits ids the resolver dropped and loads only the accepted ones', async () => {
    // A sibling org of the same partner that the token cannot access: the
    // resolver (tested on its own SQL) leaves it out; the route must not 403.
    vi.mocked(resolveAcceptedOrgs).mockResolvedValue([acceptedOrg(ORG_A)]);
    const app = buildApp({ grants: WILDCARD_GRANTS });
    const res = await app.request(path([ORG_A, ORG_B]));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orgs.map((org: { orgId: string }) => org.orgId)).toEqual([ORG_A]);
    expect(vi.mocked(loadAccountReadiness).mock.calls[0]?.[0].orgIds).toEqual([ORG_A]);
  });

  it('skips the readiness load when nothing was accepted, but still reports capabilities', async () => {
    vi.mocked(resolveAcceptedOrgs).mockResolvedValue([]);
    const app = buildApp({ grants: WILDCARD_GRANTS });
    const res = await app.request(path([ORG_A]));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orgs).toEqual([]);
    expect(body.capabilities.sites).toBe(true);
    expect(loadAccountReadiness).not.toHaveBeenCalled();
  });

  it('shapes every section for a wildcard caller in native mode', async () => {
    const app = buildApp({ grants: WILDCARD_GRANTS });
    const res = await app.request(path([ORG_A]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      partnerId: PARTNER_ID,
      capabilities: {
        sites: true,
        devices: true,
        policies: true,
        contacts: true,
        portalUsers: true,
        invoices: true,
        tickets: true,
        integrations: true,
        contracts: true,
        backup: true,
      },
      serviceManagementMode: 'native',
      connectors: [],
      orgs: [
        {
          orgId: ORG_A,
          type: 'customer',
          status: 'active',
          setup: {
            sites: 2,
            devices: 5,
            lastSeenAt: '2026-09-01T00:00:00.000Z',
            policyAssigned: true,
            backupApplicable: false,
            backupConfigured: false,
          },
          account: {
            primaryContact: { name: 'Jane Doe', email: 'jane@x.example', phone: '555-0100', mobile: null },
            billingRoleContact: true,
            billingAddress: true,
            pendingInvitations: 1,
            overdueInvoices: 2,
            activeContracts: 0,
          },
          integrations: [],
          tickets: { open: 4, awaitingCustomer: 1, slaBreached: 1 },
        },
      ],
    });
    expect(loadAccountReadiness).toHaveBeenCalledWith({
      orgIds: [ORG_A],
      partnerId: PARTNER_ID,
      sections: { sites: true, devices: true, portalUsers: true, invoices: true, tickets: true },
    });
  });

  it('carries the accepted org type, status and billingAddress through unchanged', async () => {
    vi.mocked(resolveAcceptedOrgs).mockResolvedValue([acceptedOrg(ORG_A, { type: 'internal', status: 'trial', billingAddress: false })]);
    const app = buildApp({ grants: WILDCARD_GRANTS });
    const body = await (await app.request(path([ORG_A]))).json();
    expect(body.orgs[0]).toMatchObject({ type: 'internal', status: 'trial', account: { billingAddress: false } });
  });

  const ALL_FALSE = { sites: false, devices: false, policies: true, contacts: true, portalUsers: false, invoices: false, tickets: false, integrations: false, contracts: false, backup: false };
  const gateCases: Array<{
    name: string;
    grants: Array<{ resource: string; action: string }>;
    mode: 'native' | 'external' | 'off';
    capabilities: Record<string, boolean>;
  }> = [
    { name: 'organizations:read only', grants: [PERMISSIONS.ORGS_READ], mode: 'native', capabilities: ALL_FALSE },
    { name: '+ sites:read', grants: [PERMISSIONS.ORGS_READ, PERMISSIONS.SITES_READ], mode: 'native', capabilities: { ...ALL_FALSE, sites: true } },
    { name: '+ devices:read', grants: [PERMISSIONS.ORGS_READ, PERMISSIONS.DEVICES_READ], mode: 'native', capabilities: { ...ALL_FALSE, devices: true } },
    { name: '+ users:read', grants: [PERMISSIONS.ORGS_READ, PERMISSIONS.USERS_READ], mode: 'native', capabilities: { ...ALL_FALSE, portalUsers: true } },
    { name: '+ invoices:read (native)', grants: [PERMISSIONS.ORGS_READ, PERMISSIONS.INVOICES_READ], mode: 'native', capabilities: { ...ALL_FALSE, invoices: true } },
    { name: '+ tickets:read (native)', grants: [PERMISSIONS.ORGS_READ, PERMISSIONS.TICKETS_READ], mode: 'native', capabilities: { ...ALL_FALSE, tickets: true } },
    { name: '+ invoices:read + tickets:read but external mode', grants: [PERMISSIONS.ORGS_READ, PERMISSIONS.INVOICES_READ, PERMISSIONS.TICKETS_READ], mode: 'external', capabilities: ALL_FALSE },
    { name: 'wildcard but mode off', grants: WILDCARD_GRANTS, mode: 'off', capabilities: { ...ALL_FALSE, sites: true, devices: true, portalUsers: true, integrations: true, backup: true } },
    // accounting:read is a W03 sub-grant (forwarded to the integrations loader) — it does not itself gate `capabilities.integrations`, only connected_apps:read does.
    { name: '+ connected_apps:read + accounting:read (W03 only)', grants: [PERMISSIONS.ORGS_READ, PERMISSIONS.CONNECTED_APPS_READ, PERMISSIONS.ACCOUNTING_READ], mode: 'native', capabilities: { ...ALL_FALSE, integrations: true } },
  ];

  it.each(gateCases)('gates sections by grant and mode: $name', async ({ grants, mode, capabilities }) => {
    vi.mocked(getServiceManagementMode).mockResolvedValue(mode);
    const app = buildApp({ grants });
    const res = await app.request(path([ORG_A]));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.capabilities).toEqual(capabilities);
    expect(body.serviceManagementMode).toBe(mode);
    expect(vi.mocked(loadAccountReadiness).mock.calls[0]?.[0].sections).toEqual({
      sites: capabilities.sites,
      devices: capabilities.devices,
      portalUsers: capabilities.portalUsers,
      invoices: capabilities.invoices,
      tickets: capabilities.tickets,
    });

    const org = body.orgs[0];
    expect(org.setup).toHaveProperty('policyAssigned');
    expect(org.account).toHaveProperty('primaryContact');
    expect(org.account).toHaveProperty('billingRoleContact');
    expect(org.account).toHaveProperty('billingAddress');
    expect('sites' in org.setup).toBe(capabilities.sites);
    expect('devices' in org.setup).toBe(capabilities.devices);
    expect('lastSeenAt' in org.setup).toBe(capabilities.devices);
    expect('pendingInvitations' in org.account).toBe(capabilities.portalUsers);
    expect('overdueInvoices' in org.account).toBe(capabilities.invoices);
    expect('tickets' in org).toBe(capabilities.tickets);
    expect('integrations' in org).toBe(capabilities.integrations);
    expect('connectors' in body).toBe(capabilities.integrations);
    expect('activeContracts' in org.account).toBe(capabilities.contracts);
    expect('backupApplicable' in org.setup).toBe(capabilities.backup);
  });

  it('403s an organization-scoped token before any lookup', async () => {
    const app = buildApp({ scope: 'organization', grants: WILDCARD_GRANTS });
    const res = await app.request(path([ORG_A]));
    expect(res.status).toBe(403);
    expect(getServiceManagementMode).not.toHaveBeenCalled();
  });

  it('403s without organizations:read', async () => {
    const app = buildApp({ grants: [PERMISSIONS.SITES_READ, PERMISSIONS.DEVICES_READ] });
    const res = await app.request(path([ORG_A]));
    expect(res.status).toBe(403);
    expect(resolveAcceptedOrgs).not.toHaveBeenCalled();
  });

  // Spec "Decisions recorded": the path lives at /orgs/account-readiness, not
  // /orgs/organizations/account-readiness, because orgRoutes is mounted first
  // and its `/organizations/:id` captures any literal in that position.
  it('is reachable when a router owning /organizations/:id is mounted first (composed-app path)', async () => {
    const app = buildApp({
      grants: WILDCARD_GRANTS,
      before: (composed) => {
        const standInOrgRoutes = new Hono();
        standInOrgRoutes.get('/', (c) => c.json({ route: 'list' }));
        standInOrgRoutes.get('/organizations/:id', (c) => c.json({ route: 'record', id: c.req.param('id') }));
        composed.route('/orgs', standInOrgRoutes);
      },
    });

    const res = await app.request(path([ORG_A]));
    expect(res.status).toBe(200);
    expect((await res.json()).partnerId).toBe(PARTNER_ID);

    // And the shape the spec ruled out really is captured by the earlier router.
    const shadowed = await app.request(`/orgs/organizations/account-readiness?orgIds=${ORG_A}`);
    expect(await shadowed.json()).toEqual({ route: 'record', id: 'account-readiness' });
  });
});
