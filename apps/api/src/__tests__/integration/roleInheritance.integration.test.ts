/**
 * Real-DB proof for #9600: a custom role's "Inherit From" parent grants the
 * parent's permissions at RUNTIME (getUserPermissions), not only in the role
 * editor and the assignment ceilings.
 *
 * Covers: the child gains exactly the parent's grants (plus its own); a
 * cycle written around the API terminates and grants only the cycle's own
 * roles; a parent owned by another tenant is never inherited; editing the
 * parent propagates to the child's members, both through the resolver and
 * through the permissions_epoch triggers that revoke live sessions.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  organizationUsers,
  organizations,
  partnerUsers,
  partners,
  permissions,
  rolePermissions,
  roles,
  users,
} from '../../db/schema';
import { clearPermissionCache, getUserPermissions } from '../../services/permissions';
import { MAX_ROLE_INHERITANCE_DEPTH } from '../../services/roleInheritance';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Tenant {
  partnerId: string;
  orgId: string;
  suffix: string;
}

async function seedTenant(): Promise<Tenant> {
  const tdb = getTestDb();
  const suffix = randomUUID().slice(0, 8);
  const [partner] = await tdb
    .insert(partners)
    .values({ name: `Inherit ${suffix}`, slug: `inherit-${suffix}`, type: 'msp', plan: 'pro', status: 'active' })
    .returning({ id: partners.id });
  const [org] = await tdb
    .insert(organizations)
    .values({ currencyCode: 'USD', partnerId: partner!.id, name: `Inherit org ${suffix}`, slug: `inherit-org-${suffix}`, status: 'active' })
    .returning({ id: organizations.id });
  return { partnerId: partner!.id, orgId: org!.id, suffix };
}

async function seedPartnerRole(tenant: Tenant, name: string, grants: string[], parentRoleId: string | null = null): Promise<string> {
  const tdb = getTestDb();
  const [role] = await tdb
    .insert(roles)
    .values({ partnerId: tenant.partnerId, scope: 'partner', name: `${name} ${tenant.suffix}`, parentRoleId })
    .returning({ id: roles.id });
  await grant(role!.id, grants);
  return role!.id;
}

async function seedOrgRole(tenant: Tenant, name: string, grants: string[], parentRoleId: string | null = null): Promise<string> {
  const tdb = getTestDb();
  const [role] = await tdb
    .insert(roles)
    .values({ orgId: tenant.orgId, scope: 'organization', name: `${name} ${tenant.suffix}`, parentRoleId })
    .returning({ id: roles.id });
  await grant(role!.id, grants);
  return role!.id;
}

/** grants are `resource:action`; each resource is made unique per call site by the caller. */
async function grant(roleId: string, grants: string[]): Promise<void> {
  const tdb = getTestDb();
  for (const key of grants) {
    const [resource, action] = key.split(':');
    const [perm] = await tdb.insert(permissions).values({ resource: resource!, action: action! }).returning({ id: permissions.id });
    await tdb.insert(rolePermissions).values({ roleId, permissionId: perm!.id });
  }
}

async function seedPartnerMember(tenant: Tenant, roleId: string): Promise<string> {
  const tdb = getTestDb();
  const [user] = await tdb
    .insert(users)
    .values({ partnerId: tenant.partnerId, orgId: tenant.orgId, email: `inh-${randomUUID()}@example.test`, name: 'Inherit member', status: 'active' })
    .returning({ id: users.id });
  await tdb.insert(partnerUsers).values({ partnerId: tenant.partnerId, userId: user!.id, roleId, orgAccess: 'all' });
  return user!.id;
}

async function seedOrgMember(tenant: Tenant, roleId: string): Promise<string> {
  const tdb = getTestDb();
  const [user] = await tdb
    .insert(users)
    .values({ partnerId: tenant.partnerId, orgId: tenant.orgId, email: `inh-${randomUUID()}@example.test`, name: 'Inherit org member', status: 'active' })
    .returning({ id: users.id });
  await tdb.insert(organizationUsers).values({ orgId: tenant.orgId, userId: user!.id, roleId });
  return user!.id;
}

async function partnerGrants(userId: string, tenant: Tenant): Promise<string[]> {
  const perms = await getUserPermissions(userId, { partnerId: tenant.partnerId }, { bypassCache: true });
  return (perms?.permissions ?? []).map((p) => `${p.resource}:${p.action}`).sort();
}

describe('custom role inheritance at runtime (#9600)', () => {
  beforeEach(async () => {
    await clearPermissionCache();
  });

  runDb('a parent-only child role grants exactly the parent\'s permissions', async () => {
    const t = await seedTenant();
    const parent = await seedPartnerRole(t, 'Parent', [`inh-a-${t.suffix}:read`, `inh-b-${t.suffix}:write`]);
    const child = await seedPartnerRole(t, 'Child', [], parent);
    const member = await seedPartnerMember(t, child);

    expect(await partnerGrants(member, t)).toEqual([`inh-a-${t.suffix}:read`, `inh-b-${t.suffix}:write`].sort());
  });

  runDb('a child grants its own permissions plus every ancestor\'s, and nothing else', async () => {
    const t = await seedTenant();
    const grandparent = await seedPartnerRole(t, 'Grandparent', [`inh-g-${t.suffix}:read`]);
    const parent = await seedPartnerRole(t, 'Parent', [`inh-p-${t.suffix}:read`], grandparent);
    const child = await seedPartnerRole(t, 'Child', [`inh-c-${t.suffix}:read`], parent);
    // A sibling of the parent must not leak in.
    await seedPartnerRole(t, 'Sibling', [`inh-s-${t.suffix}:read`], grandparent);
    const member = await seedPartnerMember(t, child);

    expect(await partnerGrants(member, t)).toEqual(
      [`inh-c-${t.suffix}:read`, `inh-g-${t.suffix}:read`, `inh-p-${t.suffix}:read`].sort(),
    );
  });

  runDb('org-scope roles inherit on the org axis too', async () => {
    const t = await seedTenant();
    const parent = await seedOrgRole(t, 'Org parent', [`inh-o-${t.suffix}:read`]);
    const child = await seedOrgRole(t, 'Org child', [], parent);
    const member = await seedOrgMember(t, child);

    const perms = await getUserPermissions(member, { orgId: t.orgId }, { bypassCache: true });
    expect(perms?.roleId).toBe(child);
    expect(perms?.permissions.map((p) => `${p.resource}:${p.action}`)).toEqual([`inh-o-${t.suffix}:read`]);
  });

  runDb('an inheritance cycle written around the API terminates and grants only the cycle\'s roles', async () => {
    const tdb = getTestDb();
    const t = await seedTenant();
    const a = await seedPartnerRole(t, 'Cycle A', [`inh-ca-${t.suffix}:read`]);
    const b = await seedPartnerRole(t, 'Cycle B', [`inh-cb-${t.suffix}:read`], a);
    await tdb.update(roles).set({ parentRoleId: b }).where(eq(roles.id, a));
    const member = await seedPartnerMember(t, a);

    expect(await partnerGrants(member, t)).toEqual([`inh-ca-${t.suffix}:read`, `inh-cb-${t.suffix}:read`].sort());
  });

  runDb('a parent owned by another partner is never inherited, even when written around the API', async () => {
    const tdb = getTestDb();
    const home = await seedTenant();
    const foreign = await seedTenant();
    const foreignRole = await seedPartnerRole(foreign, 'Foreign admin', [`inh-f-${foreign.suffix}:write`]);
    const child = await seedPartnerRole(home, 'Child', [`inh-h-${home.suffix}:read`]);
    await tdb.update(roles).set({ parentRoleId: foreignRole }).where(eq(roles.id, child));
    const member = await seedPartnerMember(home, child);

    expect(await partnerGrants(member, home)).toEqual([`inh-h-${home.suffix}:read`]);
  });

  runDb('an org role never inherits a partner-scope role, even of its own partner', async () => {
    const tdb = getTestDb();
    const t = await seedTenant();
    const partnerRole = await seedPartnerRole(t, 'Partner role', [`inh-pr-${t.suffix}:write`]);
    const child = await seedOrgRole(t, 'Org child', [`inh-oc-${t.suffix}:read`]);
    await tdb.update(roles).set({ parentRoleId: partnerRole }).where(eq(roles.id, child));
    const member = await seedOrgMember(t, child);

    const perms = await getUserPermissions(member, { orgId: t.orgId }, { bypassCache: true });
    expect(perms?.permissions.map((p) => `${p.resource}:${p.action}`)).toEqual([`inh-oc-${t.suffix}:read`]);
  });

  runDb(`inheritance stops after ${MAX_ROLE_INHERITANCE_DEPTH} ancestors`, async () => {
    const t = await seedTenant();
    // Root first, so the deepest child sits MAX + 1 levels below it.
    let parentId: string | null = null;
    const chain: string[] = [];
    for (let level = 0; level <= MAX_ROLE_INHERITANCE_DEPTH + 1; level++) {
      parentId = await seedPartnerRole(t, `Level ${level}`, [`inh-l${level}-${t.suffix}:read`], parentId);
      chain.push(parentId);
    }
    const member = await seedPartnerMember(t, chain[chain.length - 1]!);
    const grants = await partnerGrants(member, t);

    // The member's own role plus MAX ancestors: the root (level 0) is cut off.
    expect(grants).toHaveLength(MAX_ROLE_INHERITANCE_DEPTH + 1);
    expect(grants).not.toContain(`inh-l0-${t.suffix}:read`);
    expect(grants).toContain(`inh-l1-${t.suffix}:read`);
  });

  runDb('editing the parent propagates to the child\'s members (resolver and permissions_epoch)', async () => {
    const tdb = getTestDb();
    const t = await seedTenant();
    const grandparent = await seedPartnerRole(t, 'Grandparent', [`inh-e0-${t.suffix}:read`]);
    const parent = await seedPartnerRole(t, 'Parent', [], grandparent);
    const child = await seedPartnerRole(t, 'Child', [], parent);
    const other = await seedPartnerRole(t, 'Unrelated', []);
    const childMember = await seedPartnerMember(t, child);
    const parentMember = await seedPartnerMember(t, parent);
    const bystander = await seedPartnerMember(t, other);

    const epochs = async () => new Map(
      (await tdb.select({ id: users.id, epoch: users.permissionsEpoch }).from(users)
        .where(inArray(users.id, [childMember, parentMember, bystander])))
        .map((r) => [r.id, r.epoch]),
    );

    // Grant on the grandparent → both descendants' members are bumped.
    let before = await epochs();
    await grant(grandparent, [`inh-e1-${t.suffix}:write`]);
    let after = await epochs();
    expect(after.get(childMember)).toBe(before.get(childMember)! + 1);
    expect(after.get(parentMember)).toBe(before.get(parentMember)! + 1);
    expect(after.get(bystander)).toBe(before.get(bystander));
    expect(await partnerGrants(childMember, t)).toEqual([`inh-e0-${t.suffix}:read`, `inh-e1-${t.suffix}:write`].sort());

    // Re-pointing the parent's own parent → the child's members are bumped too.
    before = await epochs();
    await tdb.update(roles).set({ parentRoleId: null }).where(eq(roles.id, parent));
    after = await epochs();
    expect(after.get(childMember)).toBe(before.get(childMember)! + 1);
    expect(after.get(parentMember)).toBe(before.get(parentMember)! + 1);
    expect(after.get(bystander)).toBe(before.get(bystander));
    expect(await partnerGrants(childMember, t)).toEqual([]);
  });
});
