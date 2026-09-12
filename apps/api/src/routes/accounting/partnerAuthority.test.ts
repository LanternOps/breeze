import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PARTNER_ID = '22222222-2222-4222-8222-222222222222';
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
      partnerOrgAccess: 'selected' as 'all' | 'selected' | 'none' | null,
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
      token: { mfa: true },
    });
    return next();
  },
  requireScope: (...scopes: string[]) => async (c: any, next: any) => (
    scopes.includes(c.get('auth').scope)
      ? next()
      : c.json({ error: 'Insufficient permissions' }, 403)
  ),
  requireMfa: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next(),
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

type RouteCase = {
  name: string;
  method?: string;
  path: string;
  body?: unknown;
  effect: keyof typeof effects;
};

const routes: RouteCase[] = [
  { name: 'connect', path: '/quickbooks/connect', effect: 'buildAuthUrl' },
  { name: 'disconnect', method: 'POST', path: '/quickbooks/disconnect', effect: 'deleteConnection' },
  { name: 'status', path: '/quickbooks', effect: 'getConnection' },
  { name: 'customers', path: '/quickbooks/customers', effect: 'listCustomers' },
  {
    name: 'customer import', method: 'POST', path: '/quickbooks/customers/import',
    body: { customerIds: ['remote-1'] }, effect: 'importCustomers',
  },
  {
    name: 'settings update', method: 'PATCH', path: '/quickbooks/settings',
    body: { defaultIncomeAccountRef: '79' }, effect: 'dbUpdateReturning',
  },
  { name: 'settings refresh', method: 'POST', path: '/quickbooks/settings/refresh', effect: 'refreshRealmSettings' },
  { name: 'reconcile', method: 'POST', path: '/quickbooks/reconcile', effect: 'enqueueReconcile' },
  { name: 'mapping proposals', path: '/quickbooks/mappings?entityType=org', effect: 'listMappings' },
  { name: 'income accounts', path: '/quickbooks/income-accounts', effect: 'listIncomeAccounts' },
  {
    name: 'mapping decision', method: 'PUT', path: '/quickbooks/mappings',
    body: { breezeEntityType: 'org', breezeEntityId: ENTITY_ID, decision: 'unlinked' }, effect: 'saveMapping',
  },
  {
    name: 'mapping sync', method: 'POST', path: '/quickbooks/mappings/sync',
    body: { breezeEntityType: 'org', breezeEntityId: ENTITY_ID }, effect: 'syncMapping',
  },
  { name: 'invoice push', method: 'POST', path: `/quickbooks/invoices/${ENTITY_ID}/push`, effect: 'pushInvoice' },
  {
    name: 'bulk invoice push', method: 'POST', path: '/quickbooks/invoices/push-bulk',
    body: { invoiceIds: [ENTITY_ID] }, effect: 'enqueueInvoice',
  },
  { name: 'remote candidates', path: '/quickbooks/remote-candidates?entityType=org', effect: 'resolveConnection' },
];

const effectMocks = Object.values(effects);

function app() {
  const result = new Hono();
  result.route('/accounting', accountingRoutes);
  return result;
}

function pathFor(route: RouteCase, explicitPartnerId?: string): string {
  const suffix = explicitPartnerId
    ? `${route.path.includes('?') ? '&' : '?'}partnerId=${explicitPartnerId}`
    : '';
  return `/accounting${route.path}${suffix}`;
}

async function request(route: RouteCase, explicitPartnerId?: string) {
  return app().request(pathFor(route, explicitPartnerId), {
    method: route.method,
    headers: route.body ? { 'Content-Type': 'application/json' } : undefined,
    body: route.body ? JSON.stringify(route.body) : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.scope = 'partner';
  authState.partnerId = PARTNER_ID;
  authState.partnerOrgAccess = 'selected';
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

describe('partner-global accounting route authority', () => {
  const deniedCases = (['selected', 'none', null] as const).flatMap((partnerOrgAccess) =>
    routes.map((route) => ({ partnerOrgAccess, route })),
  );

  it.each(deniedCases)(
    'denies partnerOrgAccess=$partnerOrgAccess before the $route.name sink',
    async ({ partnerOrgAccess, route }) => {
      authState.partnerOrgAccess = partnerOrgAccess;
      const response = await request(route);
      expect(response.status, route.name).toBe(403);
      expect(response.headers.get('set-cookie'), route.name).toBeNull();
      for (const effect of effectMocks) expect(effect, route.name).not.toHaveBeenCalled();
    },
  );

  it.each(routes)('allows full-partner authority through to $name', async (route) => {
    authState.partnerOrgAccess = 'all';
    const response = await request(route);
    expect(response.status).not.toBe(403);
    expect(effects[route.effect]).toHaveBeenCalled();
  });

  it.each(routes)('allows system scope with an explicit partner through to $name', async (route) => {
    authState.scope = 'system';
    authState.partnerId = null;
    authState.partnerOrgAccess = null;
    const response = await request(route, PARTNER_ID);
    expect(response.status).not.toBe(403);
    expect(effects[route.effect]).toHaveBeenCalled();
  });

  it.each(routes)('denies organization scope before the $name sink', async (route) => {
    authState.scope = 'organization';
    authState.partnerId = null;
    authState.partnerOrgAccess = null;
    const response = await request(route);
    expect(response.status).toBe(403);
    expect(effects[route.effect]).not.toHaveBeenCalled();
  });

  it('denies a full-partner caller that requests a different partner before the sink', async () => {
    authState.partnerOrgAccess = 'all';
    const response = await request(routes.find((route) => route.name === 'status')!, OTHER_PARTNER_ID);
    expect(response.status).toBe(403);
    expect(effects.getConnection).not.toHaveBeenCalled();
  });

  it('requires system scope to bind an explicit partner before the sink', async () => {
    authState.scope = 'system';
    authState.partnerId = null;
    authState.partnerOrgAccess = null;
    const response = await request(routes.find((route) => route.name === 'status')!);
    expect(response.status).toBe(400);
    expect(effects.getConnection).not.toHaveBeenCalled();
  });

  it('denies restricted authority before provider and body validation', async () => {
    const response = await app().request('/accounting/not-a-provider/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(403);
    for (const effect of effectMocks) expect(effect).not.toHaveBeenCalled();
  });

  it('keeps the unauthenticated signed callback outside the human-route gate', async () => {
    const response = await app().request('/accounting/quickbooks/callback');
    expect(response.status).toBe(400);
  });
});
