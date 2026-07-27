import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
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
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

type EpochMap = Map<string, number>;

interface Fixture {
  partnerId: string;
  orgId: string;
  userIds: string[];
  orgRoleId: string;
  otherOrgRoleId: string;
  partnerRoleId: string;
  otherPartnerRoleId: string;
  permissionIds: string[];
}

async function seedFixture(): Promise<Fixture> {
  const tdb = getTestDb();
  const suffix = randomUUID();
  const [partner] = await tdb
    .insert(partners)
    .values({
      name: `Permission epoch ${suffix}`,
      slug: `permission-epoch-${suffix}`,
      type: 'msp',
      plan: 'pro',
      status: 'active',
    })
    .returning({ id: partners.id });
  const [org] = await tdb
    .insert(organizations)
    .values({
      partnerId: partner!.id,
      name: `Permission epoch org ${suffix}`,
      slug: `permission-epoch-org-${suffix}`,
      status: 'active',
    })
    .returning({ id: organizations.id });
  const createdUsers = await tdb
    .insert(users)
    .values(
      Array.from({ length: 5 }, (_, index) => ({
        partnerId: partner!.id,
        orgId: org!.id,
        email: `permission-epoch-${index}-${suffix}@example.test`,
        name: `Permission epoch ${index}`,
        status: 'active' as const,
      })),
    )
    .returning({ id: users.id });
  const createdRoles = await tdb
    .insert(roles)
    .values([
      { orgId: org!.id, scope: 'organization', name: `Org shared ${suffix}` },
      { orgId: org!.id, scope: 'organization', name: `Org other ${suffix}` },
      { partnerId: partner!.id, scope: 'partner', name: `Partner shared ${suffix}` },
      { partnerId: partner!.id, scope: 'partner', name: `Partner other ${suffix}` },
    ])
    .returning({ id: roles.id });
  const createdPermissions = await tdb
    .insert(permissions)
    .values([
      { resource: `epoch-a-${suffix}`, action: 'read' },
      { resource: `epoch-b-${suffix}`, action: 'read' },
    ])
    .returning({ id: permissions.id });

  return {
    partnerId: partner!.id,
    orgId: org!.id,
    userIds: createdUsers.map((user) => user.id),
    orgRoleId: createdRoles[0]!.id,
    otherOrgRoleId: createdRoles[1]!.id,
    partnerRoleId: createdRoles[2]!.id,
    otherPartnerRoleId: createdRoles[3]!.id,
    permissionIds: createdPermissions.map((permission) => permission.id),
  };
}

async function epochs(userIds: string[]): Promise<EpochMap> {
  const rows = await getTestDb()
    .select({ id: users.id, permissionsEpoch: users.permissionsEpoch })
    .from(users)
    .where(inArray(users.id, userIds));
  return new Map(rows.map((row) => [row.id, row.permissionsEpoch]));
}

async function expectEpochDelta(
  userIds: string[],
  before: EpochMap,
  expected: Record<string, number>,
): Promise<void> {
  const after = await epochs(userIds);
  for (const userId of userIds) {
    expect(after.get(userId), `permissions_epoch delta for ${userId}`).toBe(
      (before.get(userId) ?? 0) + (expected[userId] ?? 0),
    );
  }
}

describe('permission epoch database triggers', () => {
  runDb('covers organization membership insert, user/role/site updates, and delete', async () => {
    const tdb = getTestDb();
    const fixture = await seedFixture();
    const [firstUser, secondUser] = fixture.userIds;

    let before = await epochs(fixture.userIds);
    const [membership] = await tdb
      .insert(organizationUsers)
      .values({
        orgId: fixture.orgId,
        userId: firstUser!,
        roleId: fixture.orgRoleId,
        siteIds: null,
      })
      .returning({ id: organizationUsers.id });
    await expectEpochDelta(fixture.userIds, before, { [firstUser!]: 1 });

    before = await epochs(fixture.userIds);
    await tdb
      .update(organizationUsers)
      .set({ roleId: fixture.otherOrgRoleId })
      .where(eq(organizationUsers.id, membership!.id));
    await expectEpochDelta(fixture.userIds, before, { [firstUser!]: 1 });

    before = await epochs(fixture.userIds);
    await tdb
      .update(organizationUsers)
      .set({ siteIds: [] })
      .where(eq(organizationUsers.id, membership!.id));
    await expectEpochDelta(fixture.userIds, before, { [firstUser!]: 1 });

    before = await epochs(fixture.userIds);
    await tdb
      .update(organizationUsers)
      .set({ userId: secondUser! })
      .where(eq(organizationUsers.id, membership!.id));
    await expectEpochDelta(fixture.userIds, before, {
      [firstUser!]: 1,
      [secondUser!]: 1,
    });

    before = await epochs(fixture.userIds);
    await tdb.delete(organizationUsers).where(eq(organizationUsers.id, membership!.id));
    await expectEpochDelta(fixture.userIds, before, { [secondUser!]: 1 });
  });

  runDb('covers partner membership insert, user/role/access/org-list updates, and delete', async () => {
    const tdb = getTestDb();
    const fixture = await seedFixture();
    const [firstUser, secondUser] = fixture.userIds;

    let before = await epochs(fixture.userIds);
    const [membership] = await tdb
      .insert(partnerUsers)
      .values({
        partnerId: fixture.partnerId,
        userId: firstUser!,
        roleId: fixture.partnerRoleId,
        orgAccess: 'none',
        orgIds: null,
      })
      .returning({ id: partnerUsers.id });
    await expectEpochDelta(fixture.userIds, before, { [firstUser!]: 1 });

    before = await epochs(fixture.userIds);
    await tdb
      .update(partnerUsers)
      .set({ userId: secondUser! })
      .where(eq(partnerUsers.id, membership!.id));
    await expectEpochDelta(fixture.userIds, before, {
      [firstUser!]: 1,
      [secondUser!]: 1,
    });

    for (const update of [
      { roleId: fixture.otherPartnerRoleId },
      { orgAccess: 'selected' as const },
      { orgIds: [fixture.orgId] },
    ]) {
      before = await epochs(fixture.userIds);
      await tdb.update(partnerUsers).set(update).where(eq(partnerUsers.id, membership!.id));
      await expectEpochDelta(fixture.userIds, before, { [secondUser!]: 1 });
    }

    before = await epochs(fixture.userIds);
    await tdb.delete(partnerUsers).where(eq(partnerUsers.id, membership!.id));
    await expectEpochDelta(fixture.userIds, before, { [secondUser!]: 1 });
  });

  runDb('fans role-permission and role-definition changes to every assigned user only', async () => {
    const tdb = getTestDb();
    const fixture = await seedFixture();
    const [sharedA, sharedB, elsewhere] = fixture.userIds;
    await tdb.insert(organizationUsers).values([
      {
        orgId: fixture.orgId,
        userId: sharedA!,
        roleId: fixture.orgRoleId,
      },
      {
        orgId: fixture.orgId,
        userId: sharedB!,
        roleId: fixture.orgRoleId,
      },
      {
        orgId: fixture.orgId,
        userId: elsewhere!,
        roleId: fixture.otherOrgRoleId,
      },
    ]);

    let before = await epochs(fixture.userIds);
    await tdb.insert(rolePermissions).values({
      roleId: fixture.orgRoleId,
      permissionId: fixture.permissionIds[0]!,
    });
    await expectEpochDelta(fixture.userIds, before, {
      [sharedA!]: 1,
      [sharedB!]: 1,
    });

    before = await epochs(fixture.userIds);
    await tdb
      .update(rolePermissions)
      .set({ roleId: fixture.otherOrgRoleId })
      .where(eq(rolePermissions.permissionId, fixture.permissionIds[0]!));
    await expectEpochDelta(fixture.userIds, before, {
      [sharedA!]: 1,
      [sharedB!]: 1,
      [elsewhere!]: 1,
    });

    before = await epochs(fixture.userIds);
    await tdb
      .delete(rolePermissions)
      .where(eq(rolePermissions.permissionId, fixture.permissionIds[0]!));
    await expectEpochDelta(fixture.userIds, before, { [elsewhere!]: 1 });

    before = await epochs(fixture.userIds);
    await tdb
      .update(roles)
      .set({ forceMfa: true })
      .where(eq(roles.id, fixture.orgRoleId));
    await expectEpochDelta(fixture.userIds, before, {
      [sharedA!]: 1,
      [sharedB!]: 1,
    });
  });

  runDb('rolls permission epoch bumps back with the authorization mutation', async () => {
    const tdb = getTestDb();
    const fixture = await seedFixture();
    const [assigned, untouched] = fixture.userIds;
    await tdb.insert(organizationUsers).values({
      orgId: fixture.orgId,
      userId: assigned!,
      roleId: fixture.orgRoleId,
    });
    const before = await epochs(fixture.userIds);

    await expect(
      tdb.transaction(async (tx) => {
        await tx
          .update(roles)
          .set({ forceMfa: true })
          .where(eq(roles.id, fixture.orgRoleId));
        const inside = await tx
          .select({ permissionsEpoch: users.permissionsEpoch })
          .from(users)
          .where(eq(users.id, assigned!));
        expect(inside[0]!.permissionsEpoch).toBe((before.get(assigned!) ?? 0) + 1);
        throw new Error('rollback permission epoch test');
      }),
    ).rejects.toThrow('rollback permission epoch test');

    await expectEpochDelta(fixture.userIds, before, {
      [assigned!]: 0,
      [untouched!]: 0,
    });
  });
});
