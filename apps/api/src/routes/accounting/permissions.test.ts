import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Central route matrix for the dedicated accounting permission family
// (`accounting:read` / `accounting:manage`, SEC-2026-09-05-057 Option A).
//
// Every interactive QuickBooks route is listed exactly once below with the
// accounting capability it requires (or `null` where the route deliberately
// keeps only its pre-existing route-specific permission — customer import and
// the two invoice-push routes). The parameterized cases prove, for every
// route: denial for a caller holding no accounting grant, correct separation
// of read-only vs manage-only, that full-partner authority is still required
// regardless of grant, that MFA remains cumulative on mutations, and that
// every denial lands BEFORE any provider/db/queue/audit/cookie side effect.

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const ENTITY_ID = '33333333-3333-4333-8333-333333333333';

const { authState, effects, AccountingError } = vi.hoisted(() => {
  class AccountingError extends Error {
    constructor(
      public readonly code: string,
      public readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    authState: {
      scope: 'partner' as 'partner' | 'system' | 'organization',
      partnerId: '11111111-1111-4111-8111-111111111111' as string | null,
      partnerOrgAccess: 'all' as 'all' | 'selected' | 'none' | null,
      mfa: true,
      permissions: new Set<string>(),
    },
    effects: {
      buildAuthUrl: vi.fn(() => 'https://provider.example.test/oauth'),
      getConnection: vi.fn(),
      deleteConnection: vi.fn(),
      refreshRealmSettings: vi.fn(),
      listCustomers: vi.fn(),
      importCustomers: vi.fn(),
      listMappings: vi.fn(),
      listIncomeAccounts: vi.fn(),
      saveMapping: vi.fn(),
      syncMapping: vi.fn(),
      resolveConnection: vi.fn(),
      listRemoteCustomers: vi.fn(),
      pushInvoice: vi.fn(),
      enqueueInvoice: vi.fn(),
      enqueueReconcile: vi.fn(),
      dbSelect: vi.fn(),
      dbUpdateReturning: vi.fn(),
      audit: vi.fn(),
    },
    AccountingError,
  };
});

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', {
      scope: authState.scope,
      partnerId: authState.partnerId,
      partnerOrgAccess: authState.partnerOrgAccess,
      orgId: authState.scope === 'organization' ? ENTITY_ID : null,
      user: { id: ENTITY_ID },
      token: { mfa: authState.mfa },
    });
    return next();
  },
  requireScope: (...scopes: string[]) => async (c: any, next: any) => (
    scopes.includes(c.get('auth').scope)
      ? next()
      : c.json({ error: 'Insufficient permissions' }, 403)
  ),
  requireMfa: () => async (c: any, next: any) => (
    authState.mfa ? next() : c.json({ error: 'MFA required' }, 403)
  ),
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => (
    authState.permissions.has(`${resource}:${action}`)
      ? next()
      : c.json({ error: 'Insufficient permissions' }, 403)
  ),
  withAuthDbAccessContext: async (_auth: unknown, fn: () => unknown) => fn(),
}));

vi.mock('../../db', () => ({
  db: {
    select: effects.dbSelect,
    update: vi.fn(() => ({
      set: () => ({ where: () => ({ returning: effects.dbUpdateReturning }) }),
    })),
  },
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T>(fn: () => T) => fn(),
}));

vi.mock('../../services/accounting/accountingConnectionService', () => ({
  getConnection: effects.getConnection,
  deleteConnection: effects.deleteConnection,
  refreshRealmSettings: effects.refreshRealmSettings,
  upsertConnection: vi.fn(),
  resetConnectionForRealmChange: vi.fn(),
  updateHomeCurrency: vi.fn(),
  updateMultiCurrencyEnabled: vi.fn(),
  isHomeCurrencyCasAbort: () => false,
  AccountingConnectionError: AccountingError,
}));

vi.mock('../../services/accounting/quickbooksCustomerImport', () => ({
  listQuickbooksCustomersAnnotated: effects.listCustomers,
  importQuickbooksCustomers: effects.importCustomers,
  QbImportError: AccountingError,
}));

vi.mock('../../services/accounting/accountingMappingService', () => ({
  listMappingProposals: effects.listMappings,
  listRemoteIncomeAccountsForPartner: effects.listIncomeAccounts,
  saveMappingDecision: effects.saveMapping,
  syncMappedEntity: effects.syncMapping,
  resolveConnectionAndToken: effects.resolveConnection,
  AccountingMappingError: AccountingError,
}));

vi.mock('../../services/accounting/accountingInvoicePush', () => ({
  pushInvoiceToAccounting: effects.pushInvoice,
  AccountingInvoicePushError: AccountingError,
}));

vi.mock('../../services/accounting/providerRegistry', () => ({
  getAccountingProvider: () => ({
    buildAuthUrl: effects.buildAuthUrl,
    listRemoteCustomers: effects.listRemoteCustomers,
    listRemoteItems: vi.fn(),
  }),
}));

vi.mock('../../jobs/accountingSyncWorker', () => ({
  enqueueAccountingInvoicePush: effects.enqueueInvoice,
}));
vi.mock('../../jobs/accountingReconcileWorker', () => ({
  enqueueAccountingReconcile: effects.enqueueReconcile,
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: effects.audit }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../../config/env', () => ({
  QBO_CLIENT_ID: 'client-id',
  QBO_CLIENT_SECRET: 'client-secret',
  QBO_REDIRECT_URI: 'https://api.example.test/accounting/quickbooks/callback',
  QBO_ENVIRONMENT: 'production',
}));

import { accountingRoutes } from './index';

type AccountingCapability = 'accounting:read' | 'accounting:manage' | null;

type RouteCase = {
  name: string;
  method?: string;
  path: string;
  body?: unknown;
  effect: keyof typeof effects;
  /** The accounting capability this route requires, or null if it keeps only
   *  its pre-existing route-specific permissions (import / invoice push). */
  requires: AccountingCapability;
  /** True when the route also carries requireMfa(). */
  mfa: boolean;
};

const routes: RouteCase[] = [
  // --- reads -------------------------------------------------------------
  { name: 'status', path: '/quickbooks', effect: 'getConnection', requires: 'accounting:read', mfa: false },
  { name: 'customers', path: '/quickbooks/customers', effect: 'listCustomers', requires: 'accounting:read', mfa: false },
  { name: 'mapping proposals', path: '/quickbooks/mappings?entityType=org', effect: 'listMappings', requires: 'accounting:read', mfa: false },
  { name: 'income accounts', path: '/quickbooks/income-accounts', effect: 'listIncomeAccounts', requires: 'accounting:read', mfa: false },
  { name: 'remote candidates', path: '/quickbooks/remote-candidates?entityType=org', effect: 'resolveConnection', requires: 'accounting:read', mfa: false },
  // --- realm lifecycle / settings / synchronization ----------------------
  { name: 'connect', path: '/quickbooks/connect', effect: 'buildAuthUrl', requires: 'accounting:manage', mfa: true },
  { name: 'disconnect', method: 'POST', path: '/quickbooks/disconnect', effect: 'deleteConnection', requires: 'accounting:manage', mfa: true },
  {
    name: 'settings update', method: 'PATCH', path: '/quickbooks/settings',
    body: { defaultIncomeAccountRef: '79' }, effect: 'dbUpdateReturning',
    requires: 'accounting:manage', mfa: true,
  },
  { name: 'settings refresh', method: 'POST', path: '/quickbooks/settings/refresh', effect: 'refreshRealmSettings', requires: 'accounting:manage', mfa: true },
  { name: 'reconcile', method: 'POST', path: '/quickbooks/reconcile', effect: 'enqueueReconcile', requires: 'accounting:manage', mfa: true },
  {
    name: 'mapping decision', method: 'PUT', path: '/quickbooks/mappings',
    body: { breezeEntityType: 'org', breezeEntityId: ENTITY_ID, decision: 'unlinked' }, effect: 'saveMapping',
    requires: 'accounting:manage', mfa: true,
  },
  {
    name: 'mapping sync', method: 'POST', path: '/quickbooks/mappings/sync',
    body: { breezeEntityType: 'org', breezeEntityId: ENTITY_ID }, effect: 'syncMapping',
    requires: 'accounting:manage', mfa: true,
  },
  // --- routes that keep only their pre-existing route-specific permission --
  {
    name: 'customer import', method: 'POST', path: '/quickbooks/customers/import',
    body: { customerIds: ['remote-1'] }, effect: 'importCustomers', requires: null, mfa: true,
  },
  { name: 'invoice push', method: 'POST', path: `/quickbooks/invoices/${ENTITY_ID}/push`, effect: 'pushInvoice', requires: null, mfa: true },
  {
    name: 'bulk invoice push', method: 'POST', path: '/quickbooks/invoices/push-bulk',
    body: { invoiceIds: [ENTITY_ID] }, effect: 'enqueueInvoice', requires: null, mfa: true,
  },
];

const gatedRoutes = routes.filter((route) => route.requires !== null);
const readRoutes = routes.filter((route) => route.requires === 'accounting:read');
const manageRoutes = routes.filter((route) => route.requires === 'accounting:manage');
const ungatedRoutes = routes.filter((route) => route.requires === null);

// Permissions every route already required before this change. Held throughout
// so the only variable under test is the accounting capability.
const PRE_EXISTING_GRANTS = [
  'organizations:write', 'sites:write', 'invoices:write', 'catalog:write',
];

const effectMocks = Object.values(effects);

function app() {
  const result = new Hono();
  result.route('/accounting', accountingRoutes);
  return result;
}

async function request(route: RouteCase) {
  return app().request(`/accounting${route.path}`, {
    method: route.method,
    headers: route.body ? { 'Content-Type': 'application/json' } : undefined,
    body: route.body ? JSON.stringify(route.body) : undefined,
  });
}

function grant(...capabilities: string[]) {
  authState.permissions = new Set([...PRE_EXISTING_GRANTS, ...capabilities]);
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.scope = 'partner';
  authState.partnerId = PARTNER_ID;
  authState.partnerOrgAccess = 'all';
  authState.mfa = true;
  grant();
  effects.getConnection.mockResolvedValue({ id: 'connection-1', partnerId: PARTNER_ID, pullPayments: true });
  effects.deleteConnection.mockResolvedValue({ id: 'connection-1' });
  effects.refreshRealmSettings.mockResolvedValue({ homeCurrency: 'USD', multiCurrencyEnabled: false });
  effects.listCustomers.mockResolvedValue([]);
  effects.importCustomers.mockResolvedValue({ imported: [], skipped: [], errors: [] });
  effects.listMappings.mockResolvedValue([]);
  effects.listIncomeAccounts.mockResolvedValue([]);
  const mapping = {
    id: 'mapping-1', breezeEntityType: 'org', breezeEntityId: ENTITY_ID,
    remoteEntityType: 'Customer', remoteEntityId: null, linkStatus: 'unlinked',
    syncStatus: 'pending', lastSyncedAt: null, lastError: null,
  };
  effects.saveMapping.mockResolvedValue(mapping);
  effects.syncMapping.mockResolvedValue(mapping);
  effects.resolveConnection.mockResolvedValue({ liveConn: {} });
  effects.listRemoteCustomers.mockResolvedValue([]);
  effects.pushInvoice.mockResolvedValue({
    mappingId: 'mapping-1', remoteEntityId: 'remote-1', docNumber: '1',
    syncStatus: 'synced', taxVarianceCents: 0,
  });
  effects.enqueueInvoice.mockResolvedValue(true);
  effects.enqueueReconcile.mockResolvedValue(true);
  effects.dbSelect.mockReturnValue({
    from: () => ({ where: () => Promise.resolve([{ id: ENTITY_ID }]) }),
  });
  effects.dbUpdateReturning.mockResolvedValue([{
    status: 'connected', environment: 'production', pushMode: 'auto',
    defaultIncomeAccountRef: '79', defaultTaxCodeRef: null, lastError: null, pullPayments: true,
  }]);
});

describe('accounting permission family — route matrix', () => {
  it('covers every interactive accounting route exactly once', () => {
    expect(new Set(routes.map((route) => route.name)).size).toBe(routes.length);
    expect(routes).toHaveLength(15);
    expect(readRoutes).toHaveLength(5);
    expect(manageRoutes).toHaveLength(7);
    expect(ungatedRoutes).toHaveLength(3);
  });

  it.each(gatedRoutes)(
    'denies a full-partner caller with no accounting grant before the $name sink',
    async (route) => {
      const response = await request(route);
      expect(response.status, route.name).toBe(403);
      expect(response.headers.get('set-cookie'), route.name).toBeNull();
      for (const effect of effectMocks) expect(effect, route.name).not.toHaveBeenCalled();
    },
  );

  it.each(readRoutes)('allows accounting:read through to $name', async (route) => {
    grant('accounting:read');
    const response = await request(route);
    expect(response.status).not.toBe(403);
    expect(effects[route.effect]).toHaveBeenCalled();
  });

  it.each(manageRoutes)('denies accounting:read-only before the $name sink', async (route) => {
    grant('accounting:read');
    const response = await request(route);
    expect(response.status, route.name).toBe(403);
    for (const effect of effectMocks) expect(effect, route.name).not.toHaveBeenCalled();
  });

  it.each(manageRoutes)('allows accounting:manage through to $name', async (route) => {
    grant('accounting:manage');
    const response = await request(route);
    expect(response.status).not.toBe(403);
    expect(effects[route.effect]).toHaveBeenCalled();
  });

  it.each(readRoutes)('denies accounting:manage-only before the read-gated $name sink', async (route) => {
    grant('accounting:manage');
    const response = await request(route);
    expect(response.status, route.name).toBe(403);
    for (const effect of effectMocks) expect(effect, route.name).not.toHaveBeenCalled();
  });

  it.each(routes)('allows a caller holding both capabilities through to $name', async (route) => {
    grant('accounting:read', 'accounting:manage');
    const response = await request(route);
    expect(response.status, route.name).not.toBe(403);
    expect(effects[route.effect], route.name).toHaveBeenCalled();
  });

  it.each(ungatedRoutes)(
    'leaves $name on its pre-existing route-specific permission only',
    async (route) => {
      const response = await request(route);
      expect(response.status, route.name).not.toBe(403);
      expect(effects[route.effect], route.name).toHaveBeenCalled();
    },
  );
});

describe('accounting permission family — cumulative with existing gates', () => {
  const partnerAccessCases = (['selected', 'none', null] as const).flatMap((partnerOrgAccess) =>
    routes.map((route) => ({ partnerOrgAccess, route })),
  );

  it.each(partnerAccessCases)(
    'denies partnerOrgAccess=$partnerOrgAccess for $route.name even with both accounting grants',
    async ({ partnerOrgAccess, route }) => {
      grant('accounting:read', 'accounting:manage');
      authState.partnerOrgAccess = partnerOrgAccess;
      const response = await request(route);
      expect(response.status, route.name).toBe(403);
      expect(response.headers.get('set-cookie'), route.name).toBeNull();
      for (const effect of effectMocks) expect(effect, route.name).not.toHaveBeenCalled();
    },
  );

  it.each(routes.filter((route) => route.mfa))(
    'still requires MFA on $name with both accounting grants held',
    async (route) => {
      grant('accounting:read', 'accounting:manage');
      authState.mfa = false;
      const response = await request(route);
      expect(response.status, route.name).toBe(403);
      expect(await response.json(), route.name).toEqual({ error: 'MFA required' });
      for (const effect of effectMocks) expect(effect, route.name).not.toHaveBeenCalled();
    },
  );

  it('still requires invoices:write on invoice push when both accounting grants are held', async () => {
    grant('accounting:read', 'accounting:manage');
    authState.permissions.delete('invoices:write');
    const response = await request(routes.find((route) => route.name === 'invoice push')!);
    expect(response.status).toBe(403);
    expect(effects.pushInvoice).not.toHaveBeenCalled();
  });

  it('still requires organizations:write + sites:write on customer import', async () => {
    grant('accounting:read', 'accounting:manage');
    authState.permissions.delete('sites:write');
    const response = await request(routes.find((route) => route.name === 'customer import')!);
    expect(response.status).toBe(403);
    expect(effects.importCustomers).not.toHaveBeenCalled();
  });

  it.each(gatedRoutes)(
    'exempts system scope from the accounting permission gate on $name',
    async (route) => {
      // System-scope tokens carry no partner/org membership, so requirePermission
      // can resolve no role for them — the same partnerScopedPermission exemption
      // the pre-existing import/invoice guards already rely on.
      authState.scope = 'system';
      authState.partnerId = null;
      authState.partnerOrgAccess = null;
      const separator = route.path.includes('?') ? '&' : '?';
      const response = await app().request(
        `/accounting${route.path}${separator}partnerId=${PARTNER_ID}`,
        {
          method: route.method,
          headers: route.body ? { 'Content-Type': 'application/json' } : undefined,
          body: route.body ? JSON.stringify(route.body) : undefined,
        },
      );
      expect(response.status, route.name).not.toBe(403);
      expect(effects[route.effect], route.name).toHaveBeenCalled();
    },
  );

  it('denies a missing accounting grant before provider and body validation', async () => {
    const response = await app().request('/accounting/not-a-provider/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(403);
    for (const effect of effectMocks) expect(effect).not.toHaveBeenCalled();
  });
});
