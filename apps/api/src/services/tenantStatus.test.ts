import { describe, expect, it, vi, beforeEach } from 'vitest';

const { redisGet, redisSet, redisDel } = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: vi.fn() },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
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
import { isAgentTenantActive, invalidateAgentTenantCache } from './tenantStatus';

function queueSelect(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(rows) })) })),
  } as any);
}

const ACTIVE_ORG = { orgId: 'org-1', orgStatus: 'active', orgDeletedAt: null, partnerId: 'partner-1' };
const ACTIVE_PARTNER = { id: 'partner-1', status: 'active', deletedAt: null };

describe('isAgentTenantActive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedis).mockReturnValue({ get: redisGet, set: redisSet, del: redisDel } as any);
    redisGet.mockResolvedValue(null);
    redisSet.mockResolvedValue('OK');
    redisDel.mockResolvedValue(1);
  });

  it('returns true and short-circuits the DB on a cache hit', async () => {
    redisGet.mockResolvedValueOnce('1');

    expect(await isAgentTenantActive('org-1')).toBe(true);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('checks the DB and caches the positive result on a cache miss', async () => {
    queueSelect([ACTIVE_ORG]);
    queueSelect([ACTIVE_PARTNER]);

    expect(await isAgentTenantActive('org-1')).toBe(true);
    expect(db.select).toHaveBeenCalledTimes(2);
    expect(redisSet).toHaveBeenCalledWith('agent_tenant_ok:org-1', '1', 'EX', 60);
  });

  it('returns false and does NOT cache when the org is suspended', async () => {
    queueSelect([{ ...ACTIVE_ORG, orgStatus: 'suspended' }]);

    expect(await isAgentTenantActive('org-1')).toBe(false);
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('returns false when the org is soft-deleted (filtered out by the query)', async () => {
    queueSelect([]);

    expect(await isAgentTenantActive('org-1')).toBe(false);
  });

  it('returns false when the partner is not active', async () => {
    queueSelect([ACTIVE_ORG]);
    queueSelect([{ ...ACTIVE_PARTNER, status: 'churned' }]);

    expect(await isAgentTenantActive('org-1')).toBe(false);
  });

  it('falls through to the authoritative DB check when Redis is unavailable', async () => {
    vi.mocked(getRedis).mockReturnValue(null);
    queueSelect([ACTIVE_ORG]);
    queueSelect([ACTIVE_PARTNER]);

    expect(await isAgentTenantActive('org-1')).toBe(true);
  });

  it('fails to the DB check (never fail-open) when the cache read throws', async () => {
    redisGet.mockRejectedValueOnce(new Error('redis down'));
    queueSelect([ACTIVE_ORG]);
    queueSelect([ACTIVE_PARTNER]);

    expect(await isAgentTenantActive('org-1')).toBe(true);
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
