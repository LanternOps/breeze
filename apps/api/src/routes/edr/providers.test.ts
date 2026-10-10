import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authState } = vi.hoisted(() => ({
  authState: {
    scope: 'partner' as 'organization' | 'partner' | 'system',
    partnerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as string | null,
  },
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/edrProviders/registry', () => ({
  listEdrProviders: () => [{
    key: 'bitdefender',
    label: 'Bitdefender GravityZone',
    credentialsSchema: {},
    credentialFields: [{ name: 'apiKey', label: 'API key', secret: true, required: true }],
    baseUrlPolicy: { required: true, pathPrefix: '/api' },
    capabilities: { tenantModel: 'partner' },
    hostAllowlist: ['.gravityzone.bitdefender.com'],
  }],
}));

import { edrProviderCatalogRoutes } from './providers';

describe('GET /providers', () => {
  let app: Hono;
  beforeEach(() => {
    authState.scope = 'partner';
    authState.partnerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth' as never, {
        scope: authState.scope,
        partnerId: authState.partnerId,
        partnerOrgAccess: 'selected',
      } as never);
      return next();
    });
    app.route('/edr', edrProviderCatalogRoutes);
  });

  it('lists the catalog without credential schemas or host allowlists', async () => {
    const res = await app.request('/edr/providers');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([{
      key: 'bitdefender',
      label: 'Bitdefender GravityZone',
      credentialFields: [{ name: 'apiKey', label: 'API key', secret: true, required: true }],
      baseUrlPolicy: { required: true, pathPrefix: '/api' },
      capabilities: { tenantModel: 'partner' },
    }]);
  });

  it('a selected-org partner user can read the catalog', async () => {
    expect((await app.request('/edr/providers')).status).toBe(200);
  });

  it('org-scoped token -> 403', async () => {
    authState.scope = 'organization';
    expect((await app.request('/edr/providers')).status).toBe(403);
  });
});
