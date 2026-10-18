import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';

vi.mock('../db', () => {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => [{ status: 'active' }]),
    set: vi.fn(() => chain),
  };
  return {
    db: { select: vi.fn(() => chain), update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })) },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => unknown) => fn()),
  };
});

vi.mock('../services/redis', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, remaining: 10, resetAt: new Date(Date.now() + 60_000) })),
}));
vi.mock('../services/clientIp', () => ({ getTrustedClientIpOrUndefined: vi.fn(() => undefined) }));
vi.mock('../services/permissions', () => ({
  getUserPermissions: vi.fn(async () => ({ scope: 'partner', partnerId: 'partner-1', orgAccess: 'all', permissions: [] })),
  runWithUncachedPermissionsFor: vi.fn((_id: string, fn: () => unknown) => fn()),
}));
vi.mock('../services/apiKeyScopes', () => ({ validateApiKeyScopeDelegation: vi.fn(() => ({ ok: true })) }));
vi.mock('../services/tenantStatus', () => ({
  TenantInactiveError: class TenantInactiveError extends Error {},
  assertActiveTenantContext: vi.fn(async () => undefined),
}));
vi.mock('./apiKeyAuth', () => ({ enforcePreLookupProbeRateLimit: vi.fn(async () => undefined) }));
vi.mock('./bearerTokenAuth', () => ({
  resolvePartnerAccess: vi.fn(async () => ({ isMember: true, orgIds: ['org-1'] })),
}));
vi.mock('../services/partnerServicePrincipalCredential', () => ({
  hashPartnerApiKey: vi.fn(() => 'hash'),
  isPartnerServicePrincipalKeyFormat: vi.fn(() => true),
  loadPartnerServicePrincipalCredential: vi.fn(async () => ({
    credential: {
      keyId: 'psp-key-1',
      partnerId: 'partner-1',
      partnerServicePrincipalId: 'psp-1',
      name: 'Partner SP',
      scopes: ['ai:read'],
      rateLimit: 100,
    },
    ownerUserId: 'owner-1',
    keyIssuedBy: 'owner-1',
  })),
}));

import { partnerServicePrincipalMcpAuthMiddleware } from './partnerServicePrincipalMcpAuth';

function createContext(): Context {
  const store = new Map<string, unknown>();
  return {
    req: { header: (name: string) => (name.toLowerCase() === 'x-api-key' ? 'brz_sp_test' : undefined) },
    header: vi.fn(),
    set: (key: string, value: unknown) => store.set(key, value),
    get: (key: string) => store.get(key),
  } as unknown as Context;
}

describe('partnerServicePrincipalMcpAuthMiddleware', () => {
  beforeEach(() => vi.clearAllMocks());

  it('partner service principal keys are unrestricted', async () => {
    const c = createContext();
    const next = vi.fn(async () => undefined);
    await partnerServicePrincipalMcpAuthMiddleware(c, next);
    expect(next).toHaveBeenCalledOnce();
    const ctx = c.get('apiKey') as Record<string, unknown>;
    expect(ctx).toMatchObject({ partnerServicePrincipalId: 'psp-1', scopes: ['ai:read'] });
    // Present and explicitly null — never undefined, which would fail closed to core-only.
    expect('mcpDomains' in ctx).toBe(true);
    expect(ctx.mcpDomains).toBeNull();
  });
});
