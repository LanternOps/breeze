/**
 * #6771 — `computeReportHistoryReach`, the discovery half of the report-history
 * capability, against real Postgres.
 *
 * It runs in the auth bootstrap (before the request transaction opens, like
 * `computeAccessibleOrgIds`) and only for the report-history GET routes. It
 * must admit exactly: the caller's OWN partner's orgs in suspended / churned /
 * offboarding / archived, not soft-deleted, for an active user of an active
 * partner with a live membership whose role grants reports:read. A 'selected'
 * user is intersected with the RAW partner_users.org_ids (no Quick Support
 * exception). An org membership takes precedence, with its own role and site
 * restriction, exactly as the live report resolver does.
 */
import './setup';

import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { organizations, organizationUsers, partnerUsers, rolePermissions } from '../../db/schema';
import { computeReportHistoryReach } from '../../services/reportHistoryAccess';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));
const READ = [{ resource: 'reports', action: 'read' }];

type OrgStatus = 'active' | 'trial' | 'suspended' | 'churned' | 'offboarding' | 'archived' | 'purging' | 'merging';

async function orgWithStatus(partnerId: string, status: OrgStatus, extra: { deletedAt?: Date; type?: 'quick_support' } = {}) {
  const org = await createOrganization({ partnerId });
  await getTestDb()
    .update(organizations)
    .set({ status, ...(extra.deletedAt ? { deletedAt: extra.deletedAt } : {}), ...(extra.type ? { type: extra.type } : {}) })
    .where(eq(organizations.id, org.id));
  return org.id;
}

async function partnerUser(partnerId: string, orgAccess: 'all' | 'selected' | 'none', perms = READ) {
  const role = await createRole({ scope: 'partner', partnerId });
  if (perms.length > 0) await grantRolePermissions(role.id, perms);
  const user = await createUser({ partnerId, email: `rh-reach-${randomUUID()}@example.com` });
  await assignUserToPartner(user.id, partnerId, role.id, orgAccess);
  return { userId: user.id, roleId: role.id };
}

let partnerId: string;
let orgs: Record<string, string>;

beforeEach(async () => {
  if (!process.env.DATABASE_URL) return;
  const partner = await createPartner();
  partnerId = partner.id;
  orgs = {
    active: await orgWithStatus(partnerId, 'active'),
    trial: await orgWithStatus(partnerId, 'trial'),
    suspended: await orgWithStatus(partnerId, 'suspended'),
    churned: await orgWithStatus(partnerId, 'churned'),
    offboarding: await orgWithStatus(partnerId, 'offboarding'),
    archived: await orgWithStatus(partnerId, 'archived'),
    purging: await orgWithStatus(partnerId, 'purging'),
    merging: await orgWithStatus(partnerId, 'merging'),
    deletedSuspended: await orgWithStatus(partnerId, 'suspended', { deletedAt: new Date() }),
  };
});

const HISTORY_KEYS = ['suspended', 'churned', 'offboarding', 'archived'];

describe('computeReportHistoryReach (#6771)', () => {
  runDb('all-access: exactly the four out-of-service statuses, never active/trial/purging/merging/deleted', async () => {
    const { userId } = await partnerUser(partnerId, 'all');
    const foreign = await createPartner();
    const foreignSuspended = await orgWithStatus(foreign.id, 'suspended');

    const reach = await computeReportHistoryReach({ partnerId, userId });

    expect([...reach.orgIds].sort()).toEqual(HISTORY_KEYS.map((k) => orgs[k]).sort());
    expect(reach.orgIds).not.toContain(foreignSuspended);
    for (const key of HISTORY_KEYS) {
      expect(reach.scopes.get(orgs[key]!)).toEqual({ version: 1, kind: 'unrestricted', orgId: orgs[key] });
    }
  });

  runDb('selected: intersected with the raw org list, and no Quick Support exception', async () => {
    const quickSupport = await orgWithStatus(partnerId, 'suspended', { type: 'quick_support' });
    const { userId } = await partnerUser(partnerId, 'selected');
    await getTestDb()
      .update(partnerUsers)
      .set({ orgIds: [orgs.suspended!, orgs.active!] })
      .where(eq(partnerUsers.userId, userId));

    const reach = await computeReportHistoryReach({ partnerId, userId });

    expect([...reach.orgIds]).toEqual([orgs.suspended]);
    expect(reach.orgIds).not.toContain(quickSupport);
  });

  runDb('selected with an empty list, and none-access, reach nothing', async () => {
    const selected = await partnerUser(partnerId, 'selected');
    const none = await partnerUser(partnerId, 'none');
    expect((await computeReportHistoryReach({ partnerId, userId: selected.userId })).orgIds).toEqual([]);
    expect((await computeReportHistoryReach({ partnerId, userId: none.userId })).orgIds).toEqual([]);
  });

  runDb('an inactive user reaches nothing', async () => {
    const role = await createRole({ scope: 'partner', partnerId });
    await grantRolePermissions(role.id, READ);
    const user = await createUser({ partnerId, status: 'disabled', email: `rh-reach-${randomUUID()}@example.com` });
    await assignUserToPartner(user.id, partnerId, role.id, 'all');
    expect((await computeReportHistoryReach({ partnerId, userId: user.id })).orgIds).toEqual([]);
  });

  runDb('an inactive or deleted partner reaches nothing', async () => {
    for (const status of ['suspended', 'churned'] as const) {
      const partner = await createPartner({ status });
      await orgWithStatus(partner.id, 'suspended');
      const { userId } = await partnerUser(partner.id, 'all');
      expect((await computeReportHistoryReach({ partnerId: partner.id, userId })).orgIds).toEqual([]);
    }
    const deleted = await createPartner({ deletedAt: new Date() });
    await orgWithStatus(deleted.id, 'suspended');
    const { userId } = await partnerUser(deleted.id, 'all');
    expect((await computeReportHistoryReach({ partnerId: deleted.id, userId })).orgIds).toEqual([]);
  });

  runDb('a user of ANOTHER partner (token partner mismatch) reaches nothing', async () => {
    const other = await createPartner();
    const { userId } = await partnerUser(other.id, 'all');
    expect((await computeReportHistoryReach({ partnerId, userId })).orgIds).toEqual([]);
  });

  runDb('membership removal and role-permission removal take effect on the next request', async () => {
    const { userId, roleId } = await partnerUser(partnerId, 'all');
    expect((await computeReportHistoryReach({ partnerId, userId })).orgIds).toHaveLength(4);

    await getTestDb().delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    expect((await computeReportHistoryReach({ partnerId, userId })).orgIds).toEqual([]);

    await grantRolePermissions(roleId, READ);
    expect((await computeReportHistoryReach({ partnerId, userId })).orgIds).toHaveLength(4);

    await getTestDb().delete(partnerUsers).where(eq(partnerUsers.userId, userId));
    expect((await computeReportHistoryReach({ partnerId, userId })).orgIds).toEqual([]);
  });

  runDb('a wildcard role (*:*) grants reports:read', async () => {
    const { userId } = await partnerUser(partnerId, 'all', [{ resource: '*', action: '*' }]);
    expect((await computeReportHistoryReach({ partnerId, userId })).orgIds).toHaveLength(4);
  });

  runDb('a role without reports:read (only reports:write) reaches nothing', async () => {
    const { userId } = await partnerUser(partnerId, 'all', [{ resource: 'reports', action: 'write' }]);
    expect((await computeReportHistoryReach({ partnerId, userId })).orgIds).toEqual([]);
  });

  runDb('an org membership takes precedence: its site restriction is carried, its role must grant reports:read', async () => {
    const { userId } = await partnerUser(partnerId, 'all');
    const site = await createSite({ orgId: orgs.suspended! });

    const orgRole = await createRole({ scope: 'organization', orgId: orgs.suspended!, partnerId });
    await grantRolePermissions(orgRole.id, READ);
    await assignUserToOrganization(userId, orgs.suspended!, orgRole.id);
    await getTestDb()
      .update(organizationUsers)
      .set({ siteIds: [site.id] })
      .where(and(eq(organizationUsers.userId, userId), eq(organizationUsers.orgId, orgs.suspended!)));

    const restricted = await computeReportHistoryReach({ partnerId, userId });
    expect(restricted.scopes.get(orgs.suspended!)).toEqual({
      version: 1, kind: 'restricted', orgId: orgs.suspended, siteIds: [site.id],
    });

    // An org role WITHOUT reports:read excludes that org even though the
    // partner role grants it (org membership wins).
    const churnedRole = await createRole({ scope: 'organization', orgId: orgs.churned!, partnerId });
    await grantRolePermissions(churnedRole.id, [{ resource: 'devices', action: 'read' }]);
    await assignUserToOrganization(userId, orgs.churned!, churnedRole.id);

    const reach = await computeReportHistoryReach({ partnerId, userId });
    expect(reach.orgIds).not.toContain(orgs.churned);
    expect(reach.orgIds).toContain(orgs.offboarding);

    // An empty site list is an empty scope: excluded.
    await getTestDb()
      .update(organizationUsers)
      .set({ siteIds: [] })
      .where(and(eq(organizationUsers.userId, userId), eq(organizationUsers.orgId, orgs.suspended!)));
    expect((await computeReportHistoryReach({ partnerId, userId })).orgIds).not.toContain(orgs.suspended);
  });
});
