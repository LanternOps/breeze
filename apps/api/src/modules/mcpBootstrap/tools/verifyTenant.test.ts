import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db', () => ({
  db: { select: vi.fn(), update: vi.fn() },
}));

vi.mock('../../../db/schema', () => ({
  partners: { id: 'partners.id', emailVerifiedAt: 'partners.emailVerifiedAt', paymentMethodAttachedAt: 'partners.paymentMethodAttachedAt' },
  partnerActivations: { partnerId: 'partnerActivations.partnerId', expiresAt: 'partnerActivations.expiresAt', consumedAt: 'partnerActivations.consumedAt', createdAt: 'partnerActivations.createdAt' },
  apiKeys: { id: 'apiKeys.id', orgId: 'apiKeys.orgId', status: 'apiKeys.status', scopeState: 'apiKeys.scopeState' },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  partnerUsers: { partnerId: 'partnerUsers.partnerId', userId: 'partnerUsers.userId' },
}));

vi.mock('../../../services/rate-limit', () => ({
  rateLimiter: vi.fn().mockResolvedValue({ allowed: true, remaining: 60, resetAt: new Date() }),
}));

vi.mock('../../../services/redis', () => ({
  getRedis: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../services/apiKeys', () => ({
  mintApiKey: vi.fn().mockResolvedValue({ id: 'key-1', rawKey: 'brz_abc123' }),
}));

import { verifyTenantTool } from './verifyTenant';
import { db } from '../../../db';
import { mintApiKey } from '../../../services/apiKeys';
import { rateLimiter } from '../../../services/rate-limit';

/**
 * Queue-based select mock: each successive `.limit()` call resolves to the
 * next value popped from `rows`. Each element is an array (the Drizzle result
 * set) — pass `[]` for "no row".
 */
function enqueueSelects(rows: unknown[][]): void {
  const queue = [...rows];
  vi.mocked(db.select).mockImplementation(() => {
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? [])),
    };
    return chain as any;
  });
}

describe('verify_tenant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: true, remaining: 60, resetAt: new Date() });
    vi.mocked(mintApiKey).mockResolvedValue({ id: 'key-1', rawKey: 'brz_abc123' });
  });

  it('throws UNKNOWN_TENANT when partner row missing', async () => {
    enqueueSelects([[]]);
    await expect(
      verifyTenantTool.handler({ tenant_id: '00000000-0000-0000-0000-000000000000' }, {} as any),
    ).rejects.toMatchObject({ code: 'UNKNOWN_TENANT' });
  });

  it('throws RATE_LIMITED when polling budget exceeded', async () => {
    vi.mocked(rateLimiter).mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date() });
    await expect(
      verifyTenantTool.handler({ tenant_id: '00000000-0000-0000-0000-000000000000' }, {} as any),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('returns pending_email when activation exists, not consumed, not expired', async () => {
    enqueueSelects([
      [{ id: 'p1', emailVerifiedAt: null, paymentMethodAttachedAt: null }], // partner
      [{ expiresAt: new Date(Date.now() + 60_000), consumedAt: null }],     // activation
    ]);
    const r = await verifyTenantTool.handler({ tenant_id: 'p1' }, {} as any);
    expect(r).toEqual({ status: 'pending_email' });
  });

  it('returns pending_email (no activation row)', async () => {
    enqueueSelects([
      [{ id: 'p1', emailVerifiedAt: null, paymentMethodAttachedAt: null }],
      [],
    ]);
    const r = await verifyTenantTool.handler({ tenant_id: 'p1' }, {} as any);
    expect(r).toEqual({ status: 'pending_email' });
  });

  it('returns expired with remediation when activation lapsed', async () => {
    enqueueSelects([
      [{ id: 'p1', emailVerifiedAt: null, paymentMethodAttachedAt: null }],
      [{ expiresAt: new Date(Date.now() - 10_000), consumedAt: null }],
    ]);
    const r = await verifyTenantTool.handler({ tenant_id: 'p1' }, {} as any);
    expect(r).toMatchObject({ status: 'expired', remediation: expect.stringContaining('create_tenant') });
  });

  it('mints a readonly key on first pending_payment poll', async () => {
    enqueueSelects([
      [{ id: 'p1', emailVerifiedAt: new Date(), paymentMethodAttachedAt: null }], // partner (verified)
      [{ id: 'org-1' }],                                                            // organizations → default org
      [],                                                                          // existingKey by default org → none
      [{ userId: 'user-1' }],                                                       // partnerUsers → admin user
    ]);
    const r = await verifyTenantTool.handler({ tenant_id: 'p1' }, {} as any);
    expect(r).toEqual({
      status: 'pending_payment',
      api_key: 'brz_abc123',
      scope: 'readonly',
      next_steps: expect.stringContaining('attach_payment_method'),
    });
    expect(mintApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        partnerId: 'p1',
        defaultOrgId: 'org-1',
        createdByUserId: 'user-1',
        scopeState: 'readonly',
        source: 'mcp_provisioning',
      }),
    );
  });

  it('returns pending_payment with null api_key when key already exists', async () => {
    enqueueSelects([
      [{ id: 'p1', emailVerifiedAt: new Date(), paymentMethodAttachedAt: null }],
      [{ id: 'org-1' }],                          // organizations → default org
      [{ id: 'key-1', scopeState: 'readonly' }], // existingKey (byOrg) found
    ]);
    const r = await verifyTenantTool.handler({ tenant_id: 'p1' }, {} as any);
    expect(r).toEqual({
      status: 'pending_payment',
      api_key: null,
      scope: 'readonly',
      next_steps: expect.stringContaining('attach_payment_method'),
    });
    expect(mintApiKey).not.toHaveBeenCalled();
  });

  it('upgrades readonly → full in place on active transition', async () => {
    enqueueSelects([
      [{ id: 'p1', emailVerifiedAt: new Date(), paymentMethodAttachedAt: new Date() }],
      [{ id: 'org-1' }],                          // organizations → default org
      [{ id: 'key-1', scopeState: 'readonly' }], // byOrg existing key
    ]);
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    const r = await verifyTenantTool.handler({ tenant_id: 'p1' }, {} as any);
    expect(r).toEqual({
      status: 'active',
      api_key: null,
      scope: 'full',
      next_steps: expect.stringContaining('connector'),
    });
    expect(db.update).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith({ scopeState: 'full' });
    expect(mintApiKey).not.toHaveBeenCalled();
  });

  it('returns active/full without update when key is already full', async () => {
    enqueueSelects([
      [{ id: 'p1', emailVerifiedAt: new Date(), paymentMethodAttachedAt: new Date() }],
      [{ id: 'org-1' }],                    // organizations → default org
      [{ id: 'key-1', scopeState: 'full' }], // byOrg existing key
    ]);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as any);

    const r = await verifyTenantTool.handler({ tenant_id: 'p1' }, {} as any);
    expect(r).toEqual({
      status: 'active',
      api_key: null,
      scope: 'full',
      next_steps: expect.stringContaining('connector'),
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('mints a full-scope key when active and no existing key', async () => {
    enqueueSelects([
      [{ id: 'p1', emailVerifiedAt: new Date(), paymentMethodAttachedAt: new Date() }],
      [{ id: 'org-1' }],          // organizations → default org
      [],                          // byOrg → none
      [{ userId: 'user-1' }],     // partnerUsers → admin user
    ]);
    const r = await verifyTenantTool.handler({ tenant_id: 'p1' }, {} as any);
    expect(r).toEqual({
      status: 'active',
      api_key: 'brz_abc123',
      scope: 'full',
      next_steps: expect.stringContaining('connector'),
    });
    expect(mintApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ scopeState: 'full' }),
    );
  });
});
