import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn(), update: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  apiKeys: { id: 'apiKeys.id', orgId: 'apiKeys.orgId', status: 'apiKeys.status', updatedAt: 'apiKeys.updatedAt' },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    agentTokenSuspendedAt: 'devices.agentTokenSuspendedAt',
    agentTokenSuspendedReason: 'devices.agentTokenSuspendedReason',
  },
  enrollmentKeys: { id: 'enrollmentKeys.id', orgId: 'enrollmentKeys.orgId', expiresAt: 'enrollmentKeys.expiresAt' },
  organizationUsers: { userId: 'organizationUsers.userId', orgId: 'organizationUsers.orgId' },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  partnerUsers: { userId: 'partnerUsers.userId', partnerId: 'partnerUsers.partnerId' },
}));

vi.mock('../oauth/grantRevocation', () => ({
  revokeAllOrgOauthArtifacts: vi.fn(async () => ({ grantsRevoked: 0, refreshTokensRevoked: 0 })),
  revokeAllPartnerOauthArtifacts: vi.fn(async () => ({ grantsRevoked: 0, refreshTokensRevoked: 0 })),
}));

vi.mock('./permissions', () => ({ clearPermissionCache: vi.fn(async () => undefined) }));
vi.mock('./tokenRevocation', () => ({ revokeAllUserTokens: vi.fn(async () => undefined) }));
vi.mock('./tenantStatus', () => ({ invalidateAgentTenantCache: vi.fn(async () => undefined) }));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args) => ({ and: args })),
  eq: vi.fn((l, r) => ({ eq: [l, r] })),
  inArray: vi.fn((c, vals) => ({ inArray: [c, vals] })),
  isNull: vi.fn((c) => ({ isNull: c })),
  gt: vi.fn((l, r) => ({ gt: [l, r] })),
  or: vi.fn((...args) => ({ or: args })),
  sql: vi.fn(),
}));

import { db } from '../db';
import { apiKeys, devices, enrollmentKeys } from '../db/schema';
import { invalidateAgentTenantCache } from './tenantStatus';
import {
  revokeOrganizationTenantAccess,
  revokePartnerTenantAccess,
  restoreOrganizationTenantAccess,
  restorePartnerTenantAccess,
} from './tenantLifecycle';

const updateLog: { table: unknown; values: Record<string, unknown>; where: unknown }[] = [];
let returningByTable: Map<unknown, unknown[]>;

function setupUpdate() {
  updateLog.length = 0;
  returningByTable = new Map<unknown, unknown[]>([
    [apiKeys, [{ id: 'a1' }]],
    [devices, [{ id: 'd1' }, { id: 'd2' }]],
    [enrollmentKeys, [{ id: 'k1' }]],
  ]);
  // Capture BOTH .set(values) and .where(predicate): the WHERE clause carries
  // the load-bearing security filters (restore reason-tag isolation, sever
  // idempotency) — tests must be able to assert on them, or a regression that
  // drops a predicate would pass silently.
  vi.mocked(db.update).mockImplementation(
    (table: any) =>
      ({
        set: vi.fn((values: any) => ({
          where: vi.fn((where: any) => {
            updateLog.push({ table, values, where });
            return {
              returning: vi.fn().mockResolvedValue(returningByTable.get(table) ?? []),
            };
          }),
        })),
      }) as any
  );
}

function queueSelect(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn(() => ({ where: vi.fn().mockResolvedValue(rows) })),
  } as any);
}

// The drizzle-orm mock renders predicates as plain objects:
//   and(...a) -> {and:a}, eq(l,r) -> {eq:[l,r]}, isNull(c) -> {isNull:c},
//   inArray(c,v) -> {inArray:[c,v]}, gt(l,r) -> {gt:[l,r]}, or(...a) -> {or:a}.
// Flatten an `and(...)` predicate's clauses so a specific one can be asserted.
function andClauses(where: any): any[] {
  return Array.isArray(where?.and) ? where.and : [where];
}

describe('tenantLifecycle — agent fleet severance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupUpdate();
  });

  it('revokeOrganizationTenantAccess suspends agent tokens (reason-tagged) and invalidates enrollment keys', async () => {
    queueSelect([{ userId: 'u1' }]); // organizationUsers

    const result = await revokeOrganizationTenantAccess('org-1');

    const tables = updateLog.map((u) => u.table);
    expect(tables).toContain(devices);
    expect(tables).toContain(enrollmentKeys);

    const deviceUpdate = updateLog.find((u) => u.table === devices)!;
    expect(deviceUpdate.values.agentTokenSuspendedAt).toBeInstanceOf(Date);
    expect(deviceUpdate.values.agentTokenSuspendedReason).toBe('tenant_suspended');
    // C2: idempotency predicate — sever must only touch not-already-suspended
    // devices so it never clobbers a cross-tenant-probe suspension's reason.
    expect(andClauses(deviceUpdate.where)).toContainEqual({ isNull: 'devices.agentTokenSuspendedAt' });

    const keyUpdate = updateLog.find((u) => u.table === enrollmentKeys)!;
    expect(keyUpdate.values.expiresAt).toBeInstanceOf(Date);

    expect(invalidateAgentTenantCache).toHaveBeenCalledWith(['org-1']);
    expect(result.agentTokensSuspended).toBe(2);
    expect(result.enrollmentKeysInvalidated).toBe(1);
  });

  it('revokePartnerTenantAccess severs agents across every org under the partner', async () => {
    queueSelect([{ id: 'org-1' }, { id: 'org-2' }]); // organizations under partner
    queueSelect([{ userId: 'pu1' }]); // partnerUsers
    queueSelect([{ userId: 'ou1' }]); // org memberships

    const result = await revokePartnerTenantAccess('partner-1');

    const tables = updateLog.map((u) => u.table);
    expect(tables).toContain(devices);
    expect(tables).toContain(enrollmentKeys);
    expect(result.agentTokensSuspended).toBe(2);
    expect(result.enrollmentKeysInvalidated).toBe(1);
  });

  it('revokePartnerTenantAccess with no orgs does not touch devices or enrollment keys', async () => {
    queueSelect([]); // no organizations under the partner
    queueSelect([{ userId: 'pu1' }]); // partnerUsers

    const result = await revokePartnerTenantAccess('partner-1');

    const tables = updateLog.map((u) => u.table);
    expect(tables).not.toContain(devices);
    expect(tables).not.toContain(enrollmentKeys);
    expect(result.agentTokensSuspended).toBe(0);
    expect(result.enrollmentKeysInvalidated).toBe(0);
  });

  it('restoreOrganizationTenantAccess clears ONLY tenant-suspended tokens', async () => {
    returningByTable.set(devices, [{ id: 'd1' }]);

    const result = await restoreOrganizationTenantAccess('org-1');

    const deviceUpdate = updateLog.find((u) => u.table === devices)!;
    expect(deviceUpdate.values.agentTokenSuspendedAt).toBeNull();
    expect(deviceUpdate.values.agentTokenSuspendedReason).toBeNull();
    // C1: reason-tag isolation — restore must filter on reason='tenant_suspended'
    // so a 'cross-tenant-probe' suspension is never lifted by reactivation.
    // Without this assertion the test would pass even if the filter were dropped.
    expect(andClauses(deviceUpdate.where)).toContainEqual({
      eq: ['devices.agentTokenSuspendedReason', 'tenant_suspended'],
    });
    // Must NOT un-expire enrollment keys.
    expect(updateLog.some((u) => u.table === enrollmentKeys)).toBe(false);
    expect(result.agentTokensRestored).toBe(1);
  });

  it('restorePartnerTenantAccess clears tenant-suspended tokens across partner orgs', async () => {
    queueSelect([{ id: 'org-1' }, { id: 'org-2' }]);
    returningByTable.set(devices, [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }]);

    const result = await restorePartnerTenantAccess('partner-1');

    expect(updateLog.some((u) => u.table === devices)).toBe(true);
    expect(result.agentTokensRestored).toBe(3);
  });
});
