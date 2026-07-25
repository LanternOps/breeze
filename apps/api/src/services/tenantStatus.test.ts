import { describe, expect, it, vi, beforeEach } from 'vitest';

const { redisGet, redisSet, redisDel } = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: vi.fn() },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  // readAsSystem() consults these: contextless (undefined) → runs the query via
  // withSystemDbAccessContext, matching these tests' agent/contextless call path.
  getCurrentDbAccessContext: vi.fn(() => undefined),
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  organizations: { id: 'id', status: 'status', deletedAt: 'deletedAt', partnerId: 'partnerId' },
  partners: { id: 'id', status: 'status', deletedAt: 'deletedAt' },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args) => ({ and: args })),
  eq: vi.fn((l, r) => ({ eq: [l, r] })),
  isNull: vi.fn((c) => ({ isNull: c })),
}));

vi.mock('./redis', () => ({
  getRedis: vi.fn(() => ({ get: redisGet, set: redisSet, del: redisDel })),
}));

import { db } from '../db';
import { getRedis } from './redis';
import { getAgentTenantState, isAgentTenantActive, invalidateAgentTenantCache } from './tenantStatus';

// getAgentTenantState runs a single org⋈partner join:
// select().from().innerJoin().where().limit()
function queueJoinedSelect(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(rows) })),
      })),
    })),
  } as any);
}

function tenantRow(orgStatus: string, partnerStatus: string, partnerDeletedAt: Date | null = null) {
  return { orgStatus, partnerStatus, partnerDeletedAt };
}

describe('getAgentTenantState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedis).mockReturnValue({ get: redisGet, set: redisSet, del: redisDel } as any);
    redisGet.mockResolvedValue(null);
    redisSet.mockResolvedValue('OK');
    redisDel.mockResolvedValue(1);
  });

  it('returns active and short-circuits the DB on a "1" cache hit', async () => {
    redisGet.mockResolvedValueOnce('1');

    expect(await getAgentTenantState('org-1')).toBe('active');
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns draining and short-circuits the DB on a "drain" cache hit', async () => {
    redisGet.mockResolvedValueOnce('drain');

    expect(await getAgentTenantState('org-1')).toBe('draining');
    expect(db.select).not.toHaveBeenCalled();
  });

  it('resolves active for an active org under an active partner and caches "1"', async () => {
    queueJoinedSelect([tenantRow('active', 'active')]);

    expect(await getAgentTenantState('org-1')).toBe('active');
    expect(redisSet).toHaveBeenCalledWith('agent_tenant_ok:org-1', '1', 'EX', 60);
  });

  it('resolves active for a trial org under an active partner', async () => {
    queueJoinedSelect([tenantRow('trial', 'active')]);

    expect(await getAgentTenantState('org-1')).toBe('active');
  });

  it('resolves draining for an offboarding org under an active partner and caches "drain"', async () => {
    queueJoinedSelect([tenantRow('offboarding', 'active')]);

    expect(await getAgentTenantState('org-1')).toBe('draining');
    expect(redisSet).toHaveBeenCalledWith('agent_tenant_ok:org-1', 'drain', 'EX', 60);
  });

  it('resolves draining for an active org under an offboarding partner', async () => {
    queueJoinedSelect([tenantRow('active', 'offboarding')]);

    expect(await getAgentTenantState('org-1')).toBe('draining');
  });

  it('resolves draining when both org and partner are offboarding', async () => {
    queueJoinedSelect([tenantRow('offboarding', 'offboarding')]);

    expect(await getAgentTenantState('org-1')).toBe('draining');
  });

  it('returns null (no cache write) for a suspended org', async () => {
    queueJoinedSelect([tenantRow('suspended', 'active')]);

    expect(await getAgentTenantState('org-1')).toBeNull();
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('returns null for an offboarding org under a suspended partner (abuse lockout wins)', async () => {
    queueJoinedSelect([tenantRow('offboarding', 'suspended')]);

    expect(await getAgentTenantState('org-1')).toBeNull();
  });

  it('returns null for a churned org under an offboarding partner', async () => {
    queueJoinedSelect([tenantRow('churned', 'offboarding')]);

    expect(await getAgentTenantState('org-1')).toBeNull();
  });

  it('returns null when the org is soft-deleted (filtered out by the query)', async () => {
    queueJoinedSelect([]);

    expect(await getAgentTenantState('org-1')).toBeNull();
  });

  it('returns null when the partner is soft-deleted', async () => {
    queueJoinedSelect([tenantRow('active', 'active', new Date())]);

    expect(await getAgentTenantState('org-1')).toBeNull();
  });

  it('falls through to the authoritative DB check when Redis is unavailable', async () => {
    vi.mocked(getRedis).mockReturnValue(null);
    queueJoinedSelect([tenantRow('active', 'active')]);

    expect(await getAgentTenantState('org-1')).toBe('active');
  });

  it('fails to the DB check (never fail-open) when the cache read throws', async () => {
    redisGet.mockRejectedValueOnce(new Error('redis down'));
    queueJoinedSelect([tenantRow('active', 'active')]);

    expect(await getAgentTenantState('org-1')).toBe('active');
  });
});

describe('isAgentTenantActive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedis).mockReturnValue({ get: redisGet, set: redisSet, del: redisDel } as any);
    redisGet.mockResolvedValue(null);
    redisSet.mockResolvedValue('OK');
    redisDel.mockResolvedValue(1);
  });

  it('returns true for a fully active tenant', async () => {
    queueJoinedSelect([tenantRow('active', 'active')]);

    expect(await isAgentTenantActive('org-1')).toBe(true);
  });

  it('returns true for a draining tenant (mTLS renewal path must stay open mid-drain)', async () => {
    queueJoinedSelect([tenantRow('offboarding', 'active')]);

    expect(await isAgentTenantActive('org-1')).toBe(true);
  });

  it('returns false when the org is suspended', async () => {
    queueJoinedSelect([tenantRow('suspended', 'active')]);

    expect(await isAgentTenantActive('org-1')).toBe(false);
  });

  it('returns false when the partner is churned', async () => {
    queueJoinedSelect([tenantRow('active', 'churned')]);

    expect(await isAgentTenantActive('org-1')).toBe(false);
  });
});

describe('invalidateAgentTenantCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedis).mockReturnValue({ get: redisGet, set: redisSet, del: redisDel } as any);
    redisDel.mockResolvedValue(1);
  });

  it('deletes the cached positive key for each org', async () => {
    await invalidateAgentTenantCache(['org-1', 'org-2']);

    expect(redisDel).toHaveBeenCalledWith('agent_tenant_ok:org-1');
    expect(redisDel).toHaveBeenCalledWith('agent_tenant_ok:org-2');
  });

  it('no-ops on an empty org list', async () => {
    await invalidateAgentTenantCache([]);

    expect(redisDel).not.toHaveBeenCalled();
  });

  it('swallows Redis errors (device-level flag is the real cutoff)', async () => {
    redisDel.mockRejectedValueOnce(new Error('redis down'));

    await expect(invalidateAgentTenantCache(['org-1'])).resolves.toBeUndefined();
  });
});
