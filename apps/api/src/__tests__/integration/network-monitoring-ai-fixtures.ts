/**
 * Shared fixture for the W09 (#6779) SNMP / network-monitoring tool integration suites
 * (aiToolsSnmpWritesScope / aiToolsNetworkMonitoringScope).
 *
 * Tenants: partner P with org A (sites A1, A2) and org B (site B1); a second, unrelated
 * partner Q with its own org C. Real roles and memberships, so `executeTool`'s permission
 * check resolves a genuine grant:
 *   restricted   org-axis user of A, allowed site A1 only
 *   orgAll       org-axis user of A, no site restriction
 *   otherOrg     org-axis user of B
 *   partnerAdmin partner-axis user of P (orgAccess 'all')
 *   partnerSel   partner-axis user of P (orgAccess 'selected', org A only)
 *   otherPartner partner-axis user of Q (orgAccess 'all')
 * One discovered asset per site (A1, A2, B1), each with an IP.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { DbAccessContext } from '../../db';
import { discoveredAssets } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import {
  assignUserToOrganization, assignUserToPartner, createOrganization, createPartner, createRole, createSite, createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

export type Who = 'restricted' | 'orgAll' | 'otherOrg' | 'partnerAdmin' | 'partnerSel' | 'otherPartner';

const GRANTS = [
  { resource: 'devices', action: 'read' }, { resource: 'devices', action: 'write' },
  { resource: 'organizations', action: 'read' }, { resource: 'organizations', action: 'write' },
  { resource: 'billing', action: 'manage' },
];

export interface NetworkMonitoringFixture {
  partnerId: string; otherPartnerId: string;
  orgA: string; orgB: string; orgC: string;
  siteA1: string; siteA2: string; siteB1: string; siteC1: string;
  assetA1: string; assetA2: string; assetB1: string;
  users: Record<Who, string>;
  auth: Record<Who, AuthContext>;
}

const TOKEN = { mfa: true, aep: 1, mep: 1 } as unknown as AuthContext['token'];

function orgAuth(userId: string, partnerId: string, orgId: string, allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: TOKEN,
    partnerId, orgId, scope: 'organization', accessibleOrgIds: [orgId],
    orgCondition: (col: PgColumn) => eq(col, orgId),
    canAccessOrg: (id: string) => id === orgId,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'network-monitoring-scope' },
  } as unknown as AuthContext;
}

function partnerAuth(userId: string, partnerId: string, orgIds: string[], access: 'all' | 'selected'): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'pa@example.com', name: 'PA', isPlatformAdmin: false },
    token: TOKEN,
    partnerId, orgId: null, scope: 'partner', accessibleOrgIds: orgIds, partnerOrgAccess: access,
    orgCondition: (col: PgColumn) => inArray(col, orgIds),
    canAccessOrg: (id: string) => orgIds.includes(id),
    canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: 'network-monitoring-scope' },
  } as unknown as AuthContext;
}

export async function seedNetworkMonitoringFixture(): Promise<NetworkMonitoringFixture> {
  const p = await createPartner();
  const q = await createPartner();
  const a = await createOrganization({ partnerId: p.id });
  const b = await createOrganization({ partnerId: p.id });
  const c = await createOrganization({ partnerId: q.id });
  const a1 = await createSite({ orgId: a.id, name: 'Net A1' });
  const a2 = await createSite({ orgId: a.id, name: 'Net A2' });
  const b1 = await createSite({ orgId: b.id, name: 'Net B1' });
  const c1 = await createSite({ orgId: c.id, name: 'Net C1' });

  const mk = (tag: string, partnerId: string, orgId: string | null) =>
    createUser({ partnerId, orgId, email: `net-${tag}-${randomUUID()}@example.com` });
  const uA = await mk('a', p.id, a.id);
  const uA2 = await mk('a2', p.id, a.id);
  const uB = await mk('b', p.id, b.id);
  const uP = await mk('p', p.id, null);
  const uS = await mk('s', p.id, null);
  const uQ = await mk('q', q.id, null);

  const roleA = await createRole({ scope: 'organization', orgId: a.id, partnerId: p.id });
  const roleB = await createRole({ scope: 'organization', orgId: b.id, partnerId: p.id });
  const roleP = await createRole({ scope: 'partner', partnerId: p.id });
  const roleQ = await createRole({ scope: 'partner', partnerId: q.id });
  for (const role of [roleA, roleB, roleP, roleQ]) await grantRolePermissions(role.id, GRANTS);
  await assignUserToOrganization(uA.id, a.id, roleA.id);
  await assignUserToOrganization(uA2.id, a.id, roleA.id);
  await assignUserToOrganization(uB.id, b.id, roleB.id);
  await assignUserToPartner(uP.id, p.id, roleP.id, 'all');
  await assignUserToPartner(uS.id, p.id, roleP.id, 'selected');
  await assignUserToPartner(uQ.id, q.id, roleQ.id, 'all');

  const asset = async (orgId: string, siteId: string, ip: string) => {
    const [row] = await getTestDb().insert(discoveredAssets).values({
      orgId, siteId, ipAddress: ip, hostname: `asset-${ip}`, assetType: 'switch', approvalStatus: 'approved',
    }).returning({ id: discoveredAssets.id });
    return row!.id;
  };
  const assetA1 = await asset(a.id, a1.id, '192.0.2.10');
  const assetA2 = await asset(a.id, a2.id, '192.0.2.20');
  const assetB1 = await asset(b.id, b1.id, '198.51.100.10');

  const users: Record<Who, string> = {
    restricted: uA.id, orgAll: uA2.id, otherOrg: uB.id, partnerAdmin: uP.id, partnerSel: uS.id, otherPartner: uQ.id,
  };
  return {
    partnerId: p.id, otherPartnerId: q.id, orgA: a.id, orgB: b.id, orgC: c.id,
    siteA1: a1.id, siteA2: a2.id, siteB1: b1.id, siteC1: c1.id,
    assetA1, assetA2, assetB1,
    users,
    auth: {
      restricted: orgAuth(uA.id, p.id, a.id, [a1.id]),
      orgAll: orgAuth(uA2.id, p.id, a.id),
      otherOrg: orgAuth(uB.id, p.id, b.id),
      partnerAdmin: partnerAuth(uP.id, p.id, [a.id, b.id], 'all'),
      partnerSel: partnerAuth(uS.id, p.id, [a.id], 'selected'),
      otherPartner: partnerAuth(uQ.id, q.id, [c.id], 'all'),
    },
  };
}

export function contextFor(f: NetworkMonitoringFixture, who: Who): DbAccessContext {
  if (who === 'partnerAdmin' || who === 'partnerSel') {
    const orgs = who === 'partnerAdmin' ? [f.orgA, f.orgB] : [f.orgA];
    return { scope: 'partner', orgId: null, accessibleOrgIds: orgs, accessiblePartnerIds: [f.partnerId], userId: f.users[who], currentPartnerId: f.partnerId };
  }
  if (who === 'otherPartner') {
    return { scope: 'partner', orgId: null, accessibleOrgIds: [f.orgC], accessiblePartnerIds: [f.otherPartnerId], userId: f.users[who], currentPartnerId: f.otherPartnerId };
  }
  const orgId = who === 'otherOrg' ? f.orgB : f.orgA;
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: f.users[who], currentPartnerId: f.partnerId };
}
