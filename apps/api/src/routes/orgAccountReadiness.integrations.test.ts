import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PERMISSIONS } from '../services/permissions';

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((_c: any, next: any) => next()),
  requireScope: vi.fn((...scopes: string[]) => (c: any, next: any) => {
    const auth = c.get('auth');
    if (!scopes.includes(auth?.scope)) return c.json({ error: 'Forbidden' }, 403);
    return next();
  }),
  requirePermission: vi.fn((resource: string, action: string) => (c: any, next: any) => {
    const perms = c.get('permissions');
    const granted = Array.isArray(perms?.permissions) && perms.permissions.some(
      (p: { resource: string; action: string }) =>
        (p.resource === resource || p.resource === '*') && (p.action === action || p.action === '*'),
    );
    if (!granted) return c.json({ error: 'Permission denied' }, 403);
    return next();
  }),
}));

// services/permissions imports ../db; keep the pool out of the unit run.
vi.mock('../db', () => ({ db: { select: vi.fn(), selectDistinct: vi.fn() } }));
vi.mock('../services/serviceManagement', () => ({ getServiceManagementMode: vi.fn() }));
// W01's resolution and base aggregates are not under test here.
vi.mock('../services/orgAccountReadiness', () => ({ resolveAcceptedOrgs: vi.fn(), loadAccountReadiness: vi.fn() }));
// The W03 loaders are mocked at their modules; the extras composer runs for real.
vi.mock('../services/orgAccountReadinessIntegrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/orgAccountReadinessIntegrations')>();
  return { ...actual, loadIntegrationReadiness: vi.fn() };
});
vi.mock('../services/orgAccountReadinessCommercial', () => ({ loadActiveContractCounts: vi.fn(), loadBackupReadiness: vi.fn() }));

import { getServiceManagementMode } from '../services/serviceManagement';
import { loadAccountReadiness, resolveAcceptedOrgs } from '../services/orgAccountReadiness';
import { loadIntegrationReadiness } from '../services/orgAccountReadinessIntegrations';
import { loadActiveContractCounts, loadBackupReadiness } from '../services/orgAccountReadinessCommercial';
import { orgAccountReadinessRoutes } from './orgAccountReadiness';

const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const ORG_A = '11111111-1111-4111-8111-111111111111';

function buildApp(grants: Array<{ resource: string; action: string }>) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
      scope: 'partner',
      partnerId: PARTNER_ID,
      orgId: null,
      accessibleOrgIds: [ORG_A],
      canAccessOrg: () => true,
    } as any);
    c.set('permissions', { permissions: grants, scope: 'partner', partnerId: PARTNER_ID, orgId: null, roleId: 'role-1' } as any);
    await next();
  });
  app.route('/orgs', orgAccountReadinessRoutes);
  return app;
}

const BASE_GRANTS = [PERMISSIONS.ORGS_READ];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getServiceManagementMode).mockResolvedValue('native');
  vi.mocked(resolveAcceptedOrgs).mockResolvedValue([{ id: ORG_A, type: 'customer', status: 'active', billingAddress: true }]);
  vi.mocked(loadAccountReadiness).mockResolvedValue(new Map());
  vi.mocked(loadIntegrationReadiness).mockResolvedValue({
    connectors: [{ system: 'pax8', state: 'connected' }],
    byOrg: new Map([[ORG_A, [{ system: 'pax8', state: 'linked' }]]]),
  });
  vi.mocked(loadActiveContractCounts).mockResolvedValue(new Map([[ORG_A, 2]]));
  vi.mocked(loadBackupReadiness).mockResolvedValue({ applicable: true, configuredOrgIds: new Set() });
});

async function call(grants: Array<{ resource: string; action: string }>) {
  const res = await buildApp(grants).request(`/orgs/account-readiness?orgIds=${ORG_A}`);
  expect(res.status).toBe(200);
  return res.json();
}

describe('GET /orgs/account-readiness — W03 gates', () => {
  it('without connected_apps:read: capabilities.integrations false, no connectors, no integrations, loader never called', async () => {
    const body = await call([...BASE_GRANTS, PERMISSIONS.CONTRACTS_READ, PERMISSIONS.BACKUP_READ]);
    expect(body.capabilities.integrations).toBe(false);
    expect(body).not.toHaveProperty('connectors');
    expect(body.orgs[0]).not.toHaveProperty('integrations');
    expect(loadIntegrationReadiness).not.toHaveBeenCalled();
  });

  it('with connected_apps:read only: sub-grants are false, connectors and integrations present', async () => {
    const body = await call([...BASE_GRANTS, PERMISSIONS.CONNECTED_APPS_READ]);
    expect(body.capabilities.integrations).toBe(true);
    expect(loadIntegrationReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ partnerId: PARTNER_ID, orgIds: [ORG_A], grants: { accounting: false, pax8: false } }),
    );
    expect(body.connectors).toEqual([{ system: 'pax8', state: 'connected' }]);
    expect(body.orgs[0].integrations).toEqual([{ system: 'pax8', state: 'linked' }]);
  });

  it('accounting:read and billing:manage flow through as sub-grants', async () => {
    await call([...BASE_GRANTS, PERMISSIONS.CONNECTED_APPS_READ, PERMISSIONS.ACCOUNTING_READ, PERMISSIONS.BILLING_MANAGE]);
    expect(loadIntegrationReadiness).toHaveBeenCalledWith(expect.objectContaining({ grants: { accounting: true, pax8: true } }));
  });

  it('contracts: needs contracts:read AND native mode', async () => {
    let body = await call([...BASE_GRANTS, PERMISSIONS.CONTRACTS_READ]);
    expect(body.capabilities.contracts).toBe(true);
    expect(body.orgs[0].account.activeContracts).toBe(2);

    vi.mocked(getServiceManagementMode).mockResolvedValue('external');
    body = await call([...BASE_GRANTS, PERMISSIONS.CONTRACTS_READ]);
    expect(body.capabilities.contracts).toBe(false);
    expect(body.orgs[0].account).not.toHaveProperty('activeContracts');

    vi.mocked(getServiceManagementMode).mockResolvedValue('native');
    body = await call(BASE_GRANTS);
    expect(body.capabilities.contracts).toBe(false);
    expect(loadActiveContractCounts).toHaveBeenCalledTimes(1);
  });

  it('backup: needs backup:read; both booleans land on setup', async () => {
    let body = await call([...BASE_GRANTS, PERMISSIONS.BACKUP_READ]);
    expect(body.capabilities.backup).toBe(true);
    expect(body.orgs[0].setup.backupApplicable).toBe(true);
    expect(body.orgs[0].setup.backupConfigured).toBe(false);

    body = await call(BASE_GRANTS);
    expect(body.capabilities.backup).toBe(false);
    expect(body.orgs[0].setup).not.toHaveProperty('backupApplicable');
    expect(loadBackupReadiness).toHaveBeenCalledTimes(1);
  });

  it('with no accepted org the extras are still computed for zero ids (connectors are partner-level)', async () => {
    vi.mocked(resolveAcceptedOrgs).mockResolvedValue([]);
    vi.mocked(loadIntegrationReadiness).mockResolvedValue({ connectors: [{ system: 'huntress', state: 'disabled' }], byOrg: new Map() });
    const body = await call([...BASE_GRANTS, PERMISSIONS.CONNECTED_APPS_READ]);
    expect(body.orgs).toEqual([]);
    expect(body.connectors).toEqual([{ system: 'huntress', state: 'disabled' }]);
    expect(loadIntegrationReadiness).toHaveBeenCalledWith(expect.objectContaining({ orgIds: [] }));
  });
});
