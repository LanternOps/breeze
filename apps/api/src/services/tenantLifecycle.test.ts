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

const updateLog: { table: unknown; values: Record<string, unknown> }[] = [];
let returningByTable: Map<unknown, unknown[]>;

function setupUpdate() {
  updateLog.length = 0;
  returningByTable = new Map<unknown, unknown[]>([
    [apiKeys, [{ id: 'a1' }]],
    [devices, [{ id: 'd1' }, { id: 'd2' }]],
    [enrollmentKeys, [{ id: 'k1' }]],
  ]);
  vi.mocked(db.update).mockImplementation(
    (table: any) =>
      ({
        set: vi.fn((values: any) => {
          updateLog.push({ table, values });
          return {
            where: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue(returningByTable.get(table) ?? []),
            })),
          };
        }),
      }) as any
  );
}

function queueSelect(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn(() => ({ where: vi.fn().mockResolvedValue(rows) })),
  } as any);
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
