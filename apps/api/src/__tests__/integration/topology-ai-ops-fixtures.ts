/**
 * Shared fixture for the W08 (#6778) topology-tool integration suites
 * (aiToolsTopologyWritesScope / aiToolsTopologyApplyDiagnosticScope).
 *
 * Tenants: one partner P with org A (sites A1, A2) and org B (site B1). Real roles
 * and memberships, so the tools' `getUserPermissions` resolves a genuine grant:
 *   restricted   org-axis user of A, allowed site A1 only
 *   orgAll       org-axis user of A, no site restriction
 *   otherOrg     org-axis user of B
 *   partnerAdmin partner-axis user (orgAccess 'all')
 * Org A has topology materialization on and both sites imported (ready for writes).
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { organizations } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { importLegacyTopologySite } from '../../services/topology/legacyImport';
import {
  assignUserToOrganization, assignUserToPartner, createOrganization, createPartner, createRole, createSite, createUser,
  grantRolePermissions,
} from './db-utils';
import { orgContext } from './topology-fixtures';
import { getTestDb } from './setup';

export type Who = 'restricted' | 'orgAll' | 'otherOrg' | 'partnerAdmin';

const GRANTS = ['topology', 'devices'].flatMap((resource) => ['read', 'write', 'execute'].map((action) => ({ resource, action })));

export interface TopologyOpsFixture {
  partnerId: string;
  orgA: string; orgB: string;
  siteA1: string; siteA2: string; siteB1: string;
  userA: string; userB: string; userP: string;
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
    aiOrigin: { kind: 'ai_assistant', sessionId: 'topology-ops-scope' },
  } as unknown as AuthContext;
}

function partnerAuth(userId: string, partnerId: string, orgIds: string[]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'pa@example.com', name: 'PA', isPlatformAdmin: false },
    token: TOKEN,
    partnerId, orgId: null, scope: 'partner', accessibleOrgIds: orgIds, partnerOrgAccess: 'all',
    orgCondition: (col: PgColumn) => inArray(col, orgIds),
    canAccessOrg: (id: string) => orgIds.includes(id),
    canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: 'topology-ops-scope' },
  } as unknown as AuthContext;
}

export async function seedTopologyOpsFixture(): Promise<TopologyOpsFixture> {
  const p = await createPartner();
  const a = await createOrganization({ partnerId: p.id });
  const b = await createOrganization({ partnerId: p.id });
  const a1 = await createSite({ orgId: a.id, name: 'Ops A1' });
  const a2 = await createSite({ orgId: a.id, name: 'Ops A2' });
  const b1 = await createSite({ orgId: b.id, name: 'Ops B1' });

  const userA = await createUser({ partnerId: p.id, orgId: a.id, email: `ops-a-${randomUUID()}@example.com` });
  const userB = await createUser({ partnerId: p.id, orgId: b.id, email: `ops-b-${randomUUID()}@example.com` });
  const userP = await createUser({ partnerId: p.id, orgId: null, email: `ops-p-${randomUUID()}@example.com` });
  const roleA = await createRole({ scope: 'organization', orgId: a.id, partnerId: p.id });
  const roleB = await createRole({ scope: 'organization', orgId: b.id, partnerId: p.id });
  const roleP = await createRole({ scope: 'partner', partnerId: p.id });
  for (const role of [roleA, roleB, roleP]) await grantRolePermissions(role.id, GRANTS);
  await assignUserToOrganization(userA.id, a.id, roleA.id);
  await assignUserToOrganization(userB.id, b.id, roleB.id);
  await assignUserToPartner(userP.id, p.id, roleP.id, 'all');

  await getTestDb().update(organizations)
    .set({ settings: { topologyFeatureFlags: { materialization: true, diagnostics: true } } })
    .where(inArray(organizations.id, [a.id, b.id]));
  for (const [orgId, siteId] of [[a.id, a1.id], [a.id, a2.id], [b.id, b1.id]] as const) {
    await withDbAccessContext(orgContext(orgId), () => importLegacyTopologySite({ orgId, siteId }));
  }

  return {
    partnerId: p.id, orgA: a.id, orgB: b.id, siteA1: a1.id, siteA2: a2.id, siteB1: b1.id,
    userA: userA.id, userB: userB.id, userP: userP.id,
    auth: {
      restricted: orgAuth(userA.id, p.id, a.id, [a1.id]),
      orgAll: orgAuth(userA.id, p.id, a.id),
      otherOrg: orgAuth(userB.id, p.id, b.id),
      partnerAdmin: partnerAuth(userP.id, p.id, [a.id, b.id]),
    },
  };
}

export function contextFor(f: TopologyOpsFixture, who: Who): DbAccessContext {
  if (who === 'partnerAdmin') {
    return { scope: 'partner', orgId: null, accessibleOrgIds: [f.orgA, f.orgB], accessiblePartnerIds: [f.partnerId], userId: f.userP, currentPartnerId: f.partnerId };
  }
  const orgId = who === 'otherOrg' ? f.orgB : f.orgA;
  const userId = who === 'otherOrg' ? f.userB : f.userA;
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId, currentPartnerId: f.partnerId };
}
