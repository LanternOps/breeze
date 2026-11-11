/**
 * Real-DB proof for #11702: every consumer that decides "does this member hold
 * permission X?" or "who holds X?" reads grants through the role-inheritance
 * resolver (services/roleInheritance.ts, #9600), not `role_permissions` alone.
 *
 * Every positive test gives the member a role with NO grant of its own whose
 * `parent_role_id` role grants the permission, so the permission is held ONLY
 * through inheritance. Every negative test points the role's parent at a
 * granting role owned by ANOTHER partner (written around the API, which would
 * refuse it): the resolver's tenant-confinement must stop the hop, so the
 * member is not admitted / listed.
 *
 * Skipped consumer: routes/accessReviews.ts GET /:id (needs the HTTP stack); its
 * AI-tool twin (aiToolsAccessReviews.ts `get`) is covered here.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

type Published = { type: string; orgId: string; payload: Record<string, unknown> };
const published = vi.hoisted(() => [] as Published[]);
vi.mock('../../services/eventBus', async (orig) => ({
  ...(await orig<typeof import('../../services/eventBus')>()),
  publishEvent: async (type: string, orgId: string, payload: Record<string, unknown>, _s: string, options?: { eventId?: string }) => {
    published.push({ type, orgId, payload });
    return options?.eventId ?? 'evt';
  },
}));

import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  accessReviewItems,
  accessReviews,
  migrationWindows,
  partnerServicePrincipals,
  partnerUsers,
  roles,
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { buildDbAccessContext } from '../../middleware/auth';
import { registerAccessReviewTools } from '../../services/aiToolsAccessReviews';
import type { AiTool } from '../../services/aiTools';
import { rolesGrantingPermission } from '../../services/aiModels/permissionRoles';
import { generateTechnicianTimeBillabilityReport } from '../../services/businessReports/technicianTimeReport';
import { securityRecipients } from '../../services/callerVerification/effects';
import { loadReattachActor } from '../../services/deviceReattach/access';
import { openMigrationWindow, sweepMigrationWindows } from '../../services/migrationWindows';
import { loadBaselineAuthoritySubject } from '../../services/networkBaselineAuthority';
import { computeReportHistoryReach } from '../../services/reportHistoryAccess';
import { resolveLegacyPrincipalExecuteAuthorityInCurrentSystemContext } from '../../services/sensitiveDataPolicyAuthority';
import {
  resolveLivePartnerReportAuthority,
  resolveLiveReportAuthority,
  resolveLiveReportTypePermissions,
  resolveRequestReportAuthorityMap,
} from '../../services/siteScope';
import { resolvePartnerUsersWithPermission, resolveUsersWithPermissionForOrg } from '../../services/usersWithPermission';
import { computeLiveHumanTerm } from '../../services/wisp/grantAuthority';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

type Axis = 'org' | 'partner';
interface Tenant {
  partnerId: string;
  orgId: string;
  suffix: string;
}

const perm = (key: string) => {
  const [resource, action] = key.split(':') as [string, string];
  return { resource, action };
};

async function seedTenant(): Promise<Tenant> {
  const suffix = randomUUID().slice(0, 8);
  const partner = await createPartner({ name: `Inh consumers ${suffix}` });
  const org = await createOrganization({ partnerId: partner.id, name: `Inh consumers org ${suffix}` });
  return { partnerId: partner.id, orgId: org.id, suffix };
}

async function mkRole(t: Tenant, axis: Axis, label: string, grants: string[], parentRoleId?: string): Promise<string> {
  const role = await createRole({
    name: `${label} ${t.suffix}`,
    scope: axis === 'org' ? 'organization' : 'partner',
    partnerId: t.partnerId,
    orgId: axis === 'org' ? t.orgId : undefined,
  });
  if (grants.length > 0) await grantRolePermissions(role!.id, grants.map(perm));
  if (parentRoleId) await getTestDb().update(roles).set({ parentRoleId }).where(eq(roles.id, role!.id));
  return role!.id;
}

/**
 * A member of `t` on `axis` whose role holds `keys` ONLY through its parent. The
 * parent is owned by `parentTenant` (default: `t` itself - the legitimate case;
 * another tenant - the around-the-API cross-tenant hop).
 */
async function seedInheritingMember(
  t: Tenant,
  axis: Axis,
  keys: string[],
  parentTenant: Tenant = t,
): Promise<{ userId: string; childRoleId: string; parentRoleId: string; childName: string }> {
  const parentRoleId = await mkRole(parentTenant, axis, 'Granting parent', keys);
  const childRoleId = await mkRole(t, axis, 'Inheriting child', [], parentRoleId);
  const user = await createUser({
    partnerId: t.partnerId,
    orgId: axis === 'org' ? t.orgId : null,
    email: `inh-cons-${randomUUID()}@example.test`,
  });
  if (axis === 'org') await assignUserToOrganization(user.id, t.orgId, childRoleId);
  else await assignUserToPartner(user.id, t.partnerId, childRoleId, 'all');
  return { userId: user.id, childRoleId, parentRoleId, childName: `Inheriting child ${t.suffix}` };
}

/** A partner member of `t` whose role carries `keys` DIRECTLY (a control / the authority user). */
async function seedDirectPartnerMember(t: Tenant, keys: string[]): Promise<string> {
  const roleId = await mkRole(t, 'partner', 'Direct partner', keys);
  const user = await createUser({ partnerId: t.partnerId, orgId: null, email: `inh-direct-${randomUUID()}@example.test` });
  await assignUserToPartner(user.id, t.partnerId, roleId, 'all');
  return user.id;
}

// ---------------------------------------------------------------------------
// siteScope.ts
// ---------------------------------------------------------------------------
describe('#11702 siteScope.ts reads inherited grants', () => {
  runDb('resolveLiveReportAuthority admits an org member holding reports:read only via the parent', async () => {
    const t = await seedTenant();
    const m = await seedInheritingMember(t, 'org', ['reports:read']);
    const result = await resolveLiveReportAuthority(m.userId, t.orgId, 'read');
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  runDb('resolveLiveReportAuthority refuses a role whose parent is another partner\'s granting role', async () => {
    const t = await seedTenant();
    const other = await seedTenant();
    const m = await seedInheritingMember(t, 'org', ['reports:read'], other);
    const result = await resolveLiveReportAuthority(m.userId, t.orgId, 'read');
    expect(result).toMatchObject({ ok: false, reason: 'permission_removed' });
  });

  runDb('resolveLivePartnerReportAuthority admits a partner member holding reports:read only via the parent', async () => {
    const t = await seedTenant();
    const m = await seedInheritingMember(t, 'partner', ['reports:read']);
    const result = await resolveLivePartnerReportAuthority(m.userId, t.partnerId, 'read');
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  runDb('resolveLivePartnerReportAuthority refuses a cross-partner parent', async () => {
    const t = await seedTenant();
    const other = await seedTenant();
    const m = await seedInheritingMember(t, 'partner', ['reports:read'], other);
    const result = await resolveLivePartnerReportAuthority(m.userId, t.partnerId, 'read');
    expect(result.ok).toBe(false);
  });

  runDb('resolveLiveReportTypePermissions admits an org member holding the required permission only via the parent', async () => {
    const t = await seedTenant();
    const key = `inh-${t.suffix}:read`;
    const m = await seedInheritingMember(t, 'org', [key]);
    await expect(resolveLiveReportTypePermissions(m.userId, { orgId: t.orgId }, [perm(key)])).resolves.toBe(true);
  });

  runDb('resolveLiveReportTypePermissions refuses a cross-partner parent', async () => {
    const t = await seedTenant();
    const other = await seedTenant();
    const key = `inh-${t.suffix}:read`;
    const m = await seedInheritingMember(t, 'org', [key], other);
    await expect(resolveLiveReportTypePermissions(m.userId, { orgId: t.orgId }, [perm(key)])).resolves.toBe(false);
  });

  const fakePartnerAuth = (t: Tenant, userId: string) => ({
    scope: 'partner',
    partnerId: t.partnerId,
    orgId: null,
    user: { id: userId, isPlatformAdmin: false },
    accessibleOrgIds: [t.orgId],
    canAccessOrg: (id: string) => id === t.orgId,
  }) as unknown as AuthContext;

  runDb('resolveRequestReportAuthorityMap (batch) admits a partner member holding reports:read only via the parent', async () => {
    const t = await seedTenant();
    const m = await seedInheritingMember(t, 'partner', ['reports:read']);
    const map = await resolveRequestReportAuthorityMap(fakePartnerAuth(t, m.userId), [t.orgId], 'read');
    expect(map.get(t.orgId)?.ok, JSON.stringify([...map])).toBe(true);
  });

  runDb('resolveRequestReportAuthorityMap (batch) refuses a cross-partner parent', async () => {
    const t = await seedTenant();
    const other = await seedTenant();
    const m = await seedInheritingMember(t, 'partner', ['reports:read'], other);
    const map = await resolveRequestReportAuthorityMap(fakePartnerAuth(t, m.userId), [t.orgId], 'read');
    expect(map.get(t.orgId)?.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reportHistoryAccess.ts
// ---------------------------------------------------------------------------
describe('#11702 reportHistoryAccess.computeReportHistoryReach reads inherited grants', () => {
  async function suspend(t: Tenant) {
    await getTestDb().execute(sql`UPDATE organizations SET status = 'suspended' WHERE id = ${t.orgId}`);
  }

  runDb('a partner role holding reports:read only via the parent reaches the suspended org', async () => {
    const t = await seedTenant();
    await suspend(t);
    const m = await seedInheritingMember(t, 'partner', ['reports:read']);
    const reach = await computeReportHistoryReach({ partnerId: t.partnerId, userId: m.userId });
    expect(reach.orgIds).toContain(t.orgId);
  });

  runDb('an org role holding reports:read only via the parent reaches the suspended org', async () => {
    const t = await seedTenant();
    await suspend(t);
    const plainPartnerRole = await mkRole(t, 'partner', 'Plain partner', []);
    const m = await seedInheritingMember(t, 'org', ['reports:read']);
    await assignUserToPartner(m.userId, t.partnerId, plainPartnerRole, 'all');
    const reach = await computeReportHistoryReach({ partnerId: t.partnerId, userId: m.userId });
    expect(reach.orgIds).toContain(t.orgId);
  });

  runDb('a cross-partner parent reaches nothing', async () => {
    const t = await seedTenant();
    const other = await seedTenant();
    await suspend(t);
    const m = await seedInheritingMember(t, 'partner', ['reports:read'], other);
    const reach = await computeReportHistoryReach({ partnerId: t.partnerId, userId: m.userId });
    expect(reach.orgIds).not.toContain(t.orgId);
  });
});

// ---------------------------------------------------------------------------
// sensitiveDataPolicyAuthority.ts
// ---------------------------------------------------------------------------
describe('#11702 sensitiveDataPolicyAuthority reads inherited grants (devices:execute)', () => {
  const resolve = (owner: { orgId: string | null; partnerId: string | null }, userId: string) =>
    withSystemDbAccessContext(() => resolveLegacyPrincipalExecuteAuthorityInCurrentSystemContext(owner, userId));

  runDb('an org member holding devices:execute only via the parent keeps execute authority', async () => {
    const t = await seedTenant();
    const m = await seedInheritingMember(t, 'org', ['devices:execute']);
    expect(await resolve({ orgId: t.orgId, partnerId: null }, m.userId)).not.toBeNull();
  });

  runDb('a partner member holding devices:execute only via the parent keeps partner-wide authority', async () => {
    const t = await seedTenant();
    const m = await seedInheritingMember(t, 'partner', ['devices:execute']);
    expect(await resolve({ orgId: null, partnerId: t.partnerId }, m.userId)).not.toBeNull();
  });

  runDb('a cross-partner parent does not confer authority', async () => {
    const t = await seedTenant();
    const other = await seedTenant();
    const m = await seedInheritingMember(t, 'org', ['devices:execute'], other);
    expect(await resolve({ orgId: t.orgId, partnerId: null }, m.userId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// networkBaselineAuthority.ts
// ---------------------------------------------------------------------------
describe('#11702 networkBaselineAuthority.loadBaselineAuthoritySubject reads inherited grants (devices:write)', () => {
  const load = (userId: string, orgId: string) => withSystemDbAccessContext(() => loadBaselineAuthoritySubject(userId, orgId));

  runDb('an org member holding the permission only via the parent hasRequiredPermission', async () => {
    const t = await seedTenant();
    const m = await seedInheritingMember(t, 'org', ['devices:write']);
    expect((await load(m.userId, t.orgId))?.membership?.hasRequiredPermission).toBe(true);
  });

  runDb('a partner member holding the permission only via the parent hasRequiredPermission', async () => {
    const t = await seedTenant();
    const m = await seedInheritingMember(t, 'partner', ['devices:write']);
    expect((await load(m.userId, t.orgId))?.membership?.hasRequiredPermission).toBe(true);
  });

  runDb('a cross-partner parent does not satisfy the permission', async () => {
    const t = await seedTenant();
    const other = await seedTenant();
    const m = await seedInheritingMember(t, 'org', ['devices:write'], other);
    expect((await load(m.userId, t.orgId))?.membership?.hasRequiredPermission).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deviceReattach/access.ts
// ---------------------------------------------------------------------------
describe('#11702 deviceReattach loadReattachActor reads inherited grants', () => {
  const load = (userId: string, partnerId: string) => withSystemDbAccessContext(() => loadReattachActor(db, userId, partnerId));
  const has = (grants: ReadonlyArray<{ resource: string; action: string }> | undefined, key: string) =>
    (grants ?? []).some((g) => `${g.resource}:${g.action}` === key);

  runDb('membership.grants includes the grants inherited from the parent', async () => {
    const t = await seedTenant();
    const m = await seedInheritingMember(t, 'partner', ['devices:write', 'devices:delete']);
    const actor = await load(m.userId, t.partnerId);
    expect(has(actor?.membership?.grants, 'devices:write')).toBe(true);
    expect(has(actor?.membership?.grants, 'devices:delete')).toBe(true);
  });

  runDb('a cross-partner parent contributes no grants', async () => {
    const t = await seedTenant();
    const other = await seedTenant();
    const m = await seedInheritingMember(t, 'partner', ['devices:write', 'devices:delete'], other);
    const actor = await load(m.userId, t.partnerId);
    expect(actor?.membership).not.toBeNull();
    expect(has(actor?.membership?.grants, 'devices:write')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// wisp/grantAuthority.ts
// ---------------------------------------------------------------------------
describe('#11702 wisp computeLiveHumanTerm reads inherited grants on the org axis', () => {
  async function seedGrantor(t: Tenant, parentTenant: Tenant) {
    const keys = ['ai_sessions:use', 'devices:read'];
    // The partner role holds ai_sessions:use directly; the org-axis role is the inheriting one.
    const partnerRoleId = await mkRole(t, 'partner', 'Grantor partner', ['ai_sessions:use']);
    const parentRoleId = await mkRole(parentTenant, 'org', 'Granting org parent', keys);
    const childRoleId = await mkRole(t, 'org', 'Inheriting org child', [], parentRoleId);
    const user = await createUser({ partnerId: t.partnerId, orgId: null, email: `inh-wisp-${randomUUID()}@example.test` });
    await assignUserToPartner(user.id, t.partnerId, partnerRoleId, 'all');
    await assignUserToOrganization(user.id, t.orgId, childRoleId);
    return user.id;
  }

  runDb('an org role holding ai_sessions:use only via the parent keeps the org and exposes the inherited keys', async () => {
    const t = await seedTenant();
    const userId = await seedGrantor(t, t);
    const term = await computeLiveHumanTerm(userId, t.partnerId);
    expect(term.ok, JSON.stringify(term)).toBe(true);
    if (!term.ok) return;
    const membership = term.orgMemberships.find((m) => m.orgId === t.orgId);
    expect(membership?.permissionKeys).toEqual(expect.arrayContaining(['ai_sessions:use', 'devices:read']));
  });

  runDb('a cross-partner parent leaves the org out of the term', async () => {
    const t = await seedTenant();
    const other = await seedTenant();
    const userId = await seedGrantor(t, other);
    const term = await computeLiveHumanTerm(userId, t.partnerId);
    expect(term).toMatchObject({ ok: false, reason: 'grantor_access_lost' });
  });
});

// ---------------------------------------------------------------------------
// Reverse lookups
// ---------------------------------------------------------------------------
describe('#11702 usersWithPermission reverse lookups', () => {
  runDb('lists an org member and a partner member holding the permission only via the parent', async () => {
    const t = await seedTenant();
    const key = `inh-${t.suffix}:read`;
    const orgMember = await seedInheritingMember(t, 'org', [key]);
    const partnerMember = await seedInheritingMember(t, 'partner', [key]);
    const forOrg = await resolveUsersWithPermissionForOrg(t.orgId, perm(key));
    expect(forOrg).toEqual(expect.arrayContaining([orgMember.userId, partnerMember.userId]));
    const forPartner = await resolvePartnerUsersWithPermission(t.partnerId, perm(key));
    expect(forPartner).toContain(partnerMember.userId);
    expect(forPartner).not.toContain(orgMember.userId);
  });

  runDb('does not list members whose role inherits from another partner\'s granting role', async () => {
    const t = await seedTenant();
    const other = await seedTenant();
    const key = `inh-${t.suffix}:read`;
    const orgMember = await seedInheritingMember(t, 'org', [key], other);
    const partnerMember = await seedInheritingMember(t, 'partner', [key], other);
    const forOrg = await resolveUsersWithPermissionForOrg(t.orgId, perm(key));
    expect(forOrg).not.toContain(orgMember.userId);
    expect(forOrg).not.toContain(partnerMember.userId);
    expect(await resolvePartnerUsersWithPermission(t.partnerId, perm(key))).not.toContain(partnerMember.userId);
  });
});

describe('#11702 callerVerification securityRecipients', () => {
  const recipients = (orgId: string) =>
    withSystemDbAccessContext(() => securityRecipients(orgId)).then((rows) => rows.map((r) => r.id));

  runDb('lists an org member and a partner member holding alerts:read only via the parent', async () => {
    const t = await seedTenant();
    const orgMember = await seedInheritingMember(t, 'org', ['alerts:read']);
    const partnerMember = await seedInheritingMember(t, 'partner', ['alerts:read']);
    expect(await recipients(t.orgId)).toEqual(expect.arrayContaining([orgMember.userId, partnerMember.userId]));
  });

  runDb('does not list members whose role inherits from another partner\'s granting role', async () => {
    const t = await seedTenant();
    const other = await seedTenant();
    const orgMember = await seedInheritingMember(t, 'org', ['alerts:read'], other);
    const partnerMember = await seedInheritingMember(t, 'partner', ['alerts:read'], other);
    const ids = await recipients(t.orgId);
    expect(ids).not.toContain(orgMember.userId);
    expect(ids).not.toContain(partnerMember.userId);
  });
});

describe('#11702 aiModels rolesGrantingPermission', () => {
  runDb('names the inheriting role (org and partner roles)', async () => {
    const t = await seedTenant();
    const key = `inh-${t.suffix}:read`;
    const orgM = await seedInheritingMember(t, 'org', [key]);
    const names = await rolesGrantingPermission({ partnerId: t.partnerId, orgId: t.orgId, permission: key });
    expect(names).toContain(orgM.childName);
  });

  runDb('does not name a role whose parent is another partner\'s granting role', async () => {
    const t = await seedTenant();
    const other = await seedTenant();
    const key = `inh-${t.suffix}:read`;
    const m = await seedInheritingMember(t, 'org', [key], other);
    const names = await rolesGrantingPermission({ partnerId: t.partnerId, orgId: t.orgId, permission: key });
    expect(names).not.toContain(m.childName);
  });
});

describe('#11702 technician_time_billability partner roster', () => {
  const run = async (t: Tenant, adminId: string) => {
    const auth = await resolveLivePartnerReportAuthority(adminId, t.partnerId, 'read');
    if (!auth.ok) throw new Error(`partner authority refused: ${auth.reason}`);
    const result = await generateTechnicianTimeBillabilityReport(
      { kind: 'partner', partnerId: t.partnerId, orgIds: [t.orgId] },
      { period: { kind: 'custom', start: '2026-08-01', end: '2026-08-31' } },
      auth.authority,
    );
    return (result.summary as { groups: Array<{ groupKey: string }> }).groups.map((g) => g.groupKey);
  };

  runDb('a partner technician holding time_entries:read only via the parent is on the technician axis', async () => {
    const t = await seedTenant();
    const admin = await seedDirectPartnerMember(t, ['reports:read']);
    const m = await seedInheritingMember(t, 'partner', ['time_entries:read']);
    expect(await run(t, admin)).toContain(m.userId);
  });

  runDb('a cross-partner parent keeps the member off the technician axis', async () => {
    const t = await seedTenant();
    const other = await seedTenant();
    const admin = await seedDirectPartnerMember(t, ['reports:read']);
    const m = await seedInheritingMember(t, 'partner', ['time_entries:read'], other);
    expect(await run(t, admin)).not.toContain(m.userId);
  });
});

// ---------------------------------------------------------------------------
// migrationWindows.ts sweep
// ---------------------------------------------------------------------------
describe('#11702 migrationWindows sweep keeps an opener holding the opener permissions only via inheritance', () => {
  const DAY = 86_400_000;
  const OPEN_KEYS = ['organizations:write', 'tickets:write'];

  /** An open window whose owner opened it with DIRECT grants; the caller then swaps the owner's role. */
  async function openWindow(t: Tenant) {
    const ownerRoleId = await mkRole(t, 'partner', 'Window owner', OPEN_KEYS);
    const owner = await createUser({ partnerId: t.partnerId, orgId: null, email: `inh-mw-${randomUUID()}@example.test` });
    await assignUserToPartner(owner.id, t.partnerId, ownerRoleId, 'all');
    const [principal] = await getTestDb().insert(partnerServicePrincipals).values({
      partnerId: t.partnerId, name: `Import ${t.suffix}`, scopes: ['tickets:read', 'tickets:write'],
      createdBy: owner.id, updatedBy: owner.id,
    }).returning();
    const [epochs] = (await getTestDb().execute(
      sql`SELECT auth_epoch, mfa_epoch FROM users WHERE id = ${owner.id}`,
    )) as unknown as Array<{ auth_epoch: number; mfa_epoch: number }>;
    const view = await withDbAccessContext(
      { scope: 'partner', orgId: null, accessibleOrgIds: [t.orgId], accessiblePartnerIds: [t.partnerId], currentPartnerId: t.partnerId, userId: owner.id },
      () => openMigrationWindow({
        partnerId: t.partnerId,
        principalId: principal!.id,
        orgIds: [t.orgId],
        endsAt: new Date(Date.now() + 2 * DAY),
        sourceLabel: 'zammad',
        opener: { userId: owner.id, authEpoch: epochs!.auth_epoch, mfaEpoch: epochs!.mfa_epoch },
        stepUp: null,
      }),
    );
    return { ownerId: owner.id, ownerRoleId, windowId: view.id };
  }

  const statusOf = async (id: string) =>
    (await getTestDb().select().from(migrationWindows).where(eq(migrationWindows.id, id)))[0]!;

  const swapOwnerRole = (ownerId: string, partnerId: string, roleId: string) =>
    getTestDb().update(partnerUsers).set({ roleId })
      .where(and(eq(partnerUsers.userId, ownerId), eq(partnerUsers.partnerId, partnerId)));

  runDb('does not close the window when the opener\'s role holds the permissions only via the parent', async () => {
    const t = await seedTenant();
    const w = await openWindow(t);
    const child = await mkRole(t, 'partner', 'Inheriting owner', [], w.ownerRoleId);
    await swapOwnerRole(w.ownerId, t.partnerId, child);
    await sweepMigrationWindows(new Date());
    expect(await statusOf(w.windowId)).toMatchObject({ status: 'open' });
  });

  runDb('closes the window (opener_inactive) when the parent belongs to another partner', async () => {
    const t = await seedTenant();
    const other = await seedTenant();
    const w = await openWindow(t);
    const foreignParent = await mkRole(other, 'partner', 'Foreign opener perms', OPEN_KEYS);
    const child = await mkRole(t, 'partner', 'Cross-tenant owner', [], foreignParent);
    await swapOwnerRole(w.ownerId, t.partnerId, child);
    await sweepMigrationWindows(new Date());
    expect(await statusOf(w.windowId)).toMatchObject({ status: 'closed', closedReason: 'opener_inactive' });
  });
});

// ---------------------------------------------------------------------------
// aiToolsAccessReviews.ts (manage_access_reviews get)
// ---------------------------------------------------------------------------
describe('#11702 manage_access_reviews get lists inherited permissions', () => {
  const tools = new Map<string, AiTool>();
  registerAccessReviewTools(tools);

  function orgAuth(t: Tenant, userId: string): AuthContext {
    return {
      principal: { kind: 'user_session' },
      user: { id: userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
      token: { mfa: true } as AuthContext['token'],
      partnerId: t.partnerId, orgId: t.orgId, scope: 'organization', accessibleOrgIds: [t.orgId],
      orgCondition: (col: any) => eq(col, t.orgId),
      canAccessOrg: (id: string) => id === t.orgId,
      canAccessSite: () => true,
      aiOrigin: { kind: 'ai_assistant', sessionId: 'inh-consumers' },
    } as unknown as AuthContext;
  }

  async function permissionsListed(t: Tenant, m: { userId: string; childRoleId: string }): Promise<string[]> {
    const viewer = await createUser({ partnerId: t.partnerId, orgId: t.orgId, email: `inh-ar-${randomUUID()}@example.test` });
    const viewerRole = await mkRole(t, 'org', 'Viewer', []);
    await assignUserToOrganization(viewer.id, t.orgId, viewerRole);
    const [review] = await getTestDb().insert(accessReviews).values({
      orgId: t.orgId, name: `Review ${t.suffix}`, reviewerId: viewer.id,
    }).returning({ id: accessReviews.id });
    await getTestDb().insert(accessReviewItems).values({ reviewId: review!.id, userId: m.userId, roleId: m.childRoleId });
    const auth = orgAuth(t, viewer.id);
    const ctx = buildDbAccessContext({ scope: 'organization', orgId: t.orgId, accessibleOrgIds: [t.orgId], partnerId: t.partnerId, userId: viewer.id });
    const raw = await withDbAccessContext(ctx, () =>
      tools.get('manage_access_reviews')!.handler({ action: 'get', reviewId: review!.id }, auth));
    const body = JSON.parse(raw) as { roles?: Record<string, { permissions: string[] }>; error?: string };
    expect(body.error, raw).toBeUndefined();
    return body.roles?.[m.childRoleId]?.permissions ?? [];
  }

  runDb('the inheriting role\'s permission list includes the parent\'s permission', async () => {
    const t = await seedTenant();
    const key = `inh-${t.suffix}:read`;
    const m = await seedInheritingMember(t, 'org', [key]);
    expect(await permissionsListed(t, m)).toContain(key);
  });

  runDb('a cross-partner parent contributes no permissions to the list', async () => {
    const t = await seedTenant();
    const other = await seedTenant();
    const key = `inh-${t.suffix}:read`;
    const m = await seedInheritingMember(t, 'org', [key], other);
    expect(await permissionsListed(t, m)).not.toContain(key);
  });
});
