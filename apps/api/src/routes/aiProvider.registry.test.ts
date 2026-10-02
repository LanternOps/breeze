import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mounts the REAL route over the REAL partnerLlmConfig service (the facade);
// only the DB, the platform-model registry reads and the reconcile are mocked.
// aiProvider.test.ts mocks the service wholesale and stays the route-shape suite.

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { user: { id: '11111111-1111-4111-8111-111111111111' }, scope: 'partner', partnerId: '22222222-2222-4222-8222-222222222222', partnerOrgAccess: 'all' });
    await next();
  },
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));
vi.mock('../services/permissions', () => ({ PERMISSIONS: { BILLING_MANAGE: { resource: 'billing', action: 'manage' } } }));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/llmProviderCatalog', () => ({ getListedProviders: vi.fn(async () => []), getListedProviderByEntryId: vi.fn() }));
vi.mock('../services/aiModels/legacyReconcile', () => ({
  lockPartnerRegistryReconcile: vi.fn(async () => undefined),
  reconcilePartnerFromLegacyInTx: vi.fn(async () => ({})),
}));
// C7: the real platformModels reads use .orderBy, which the db chain below lacks.
vi.mock('../services/aiModels/platformModels', () => ({
  listOfferableModelIds: vi.fn(async () => ['claude-sonnet-4-6', 'claude-haiku-4-5']),
  isOfferablePlatformModel: vi.fn(async () => true),
}));
const registryRow = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => (registryRow.value ? [registryRow.value] : [])) })) })) })),
  },
}));

import { aiProviderRoutes } from './aiProvider';
import { db } from '../db';
import { partnerAiConnections } from '../db/schema';

describe('GET /ai/provider served from the registry (#7600 W02)', () => {
  beforeEach(() => { registryRow.value = null; vi.mocked(db.select).mockClear(); });

  it('keeps the exact contract, including a null pin that tracks the deployment default', async () => {
    registryRow.value = { keyLast4: '4242', defaultModel: null, status: 'active', verifiedAt: new Date('2026-11-01T00:00:00Z'), lastError: null, catalogEntryId: null };
    const res = await aiProviderRoutes.request('/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ configured: true, provider: 'anthropic', keyLast4: '4242', defaultModel: null, status: 'active', lastError: null, catalogEntryId: null });
    expect(body.verifiedAt).toBe('2026-11-01T00:00:00.000Z');
    expect(typeof body.effectiveDefaultModel).toBe('string');
    expect(Object.keys(body).sort()).toEqual(['catalog', 'catalogEntryId', 'configured', 'defaultModel', 'effectiveDefaultModel', 'keyLast4', 'lastError', 'provider', 'status', 'supportedModels', 'verifiedAt']);
  });

  it('reads partner_ai_connections, not partner_llm_configs', async () => {
    registryRow.value = { keyLast4: '4242', defaultModel: 'claude-haiku-4-5', status: 'error', verifiedAt: null, lastError: 'auth_rejected', catalogEntryId: null };
    const body = await (await aiProviderRoutes.request('/')).json();
    expect(body).toMatchObject({ defaultModel: 'claude-haiku-4-5', effectiveDefaultModel: 'claude-haiku-4-5', status: 'error', lastError: 'auth_rejected' });
    const from = vi.mocked(db.select).mock.results[0]!.value.from as ReturnType<typeof vi.fn>;
    expect(from).toHaveBeenCalledWith(partnerAiConnections);
  });

  it('reports the platform when the partner has no connection', async () => {
    const body = await (await aiProviderRoutes.request('/')).json();
    expect(body).toMatchObject({ configured: false, status: 'platform', keyLast4: null, defaultModel: null });
  });
});
