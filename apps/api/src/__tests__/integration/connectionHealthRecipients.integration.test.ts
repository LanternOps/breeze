/**
 * Connection health recipient resolution against real Postgres + RLS
 * (spec 2026-10-15 §4). Pins the authorization filter: partner, granting role
 * (wildcard-aware), active status, org access; never org-scope members.
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { resolvePartnerUsersWithPermission } from '../../services/usersWithPermission';
import { resolveIncidentRecipients } from '../../services/connectionHealth/recipients';

const MANAGE = { resource: 'connected_apps', action: 'manage' };
const asSystem = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

let P: string;
let orgA: string;
const ids: Record<string, string> = {};

async function member(
  key: string,
  partnerId: string,
  roleId: string,
  orgAccess: 'all' | 'selected' | 'none',
  status: 'active' | 'invited' | 'disabled' = 'active',
) {
  const u = await createUser({ partnerId, status });
  const pu = await assignUserToPartner(u.id, partnerId, roleId, orgAccess);
  if (orgAccess === 'selected') {
    const { partnerUsers } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const { db } = await import('../../db');
    await asSystem(() => db.update(partnerUsers).set({ orgIds: [orgA] }).where(eq(partnerUsers.id, pu.id)));
  }
  ids[key] = u.id;
  return u.id;
}

describe('connection health recipients (real DB)', () => {
  beforeEach(async () => {
    P = (await createPartner()).id;
    const Q = (await createPartner()).id;
    orgA = (await createOrg(P)).id;

    const grant = await createRole({ scope: 'partner', partnerId: P, name: 'grant' });
    await grantRolePermissions(grant.id, [MANAGE]);
    const none = await createRole({ scope: 'partner', partnerId: P, name: 'nogrant' });
    await grantRolePermissions(none.id, [{ resource: 'devices', action: 'read' }]);
    const wild = await createRole({ scope: 'partner', partnerId: P, name: 'wild' });
    await grantRolePermissions(wild.id, [{ resource: '*', action: '*' }]);
    const qGrant = await createRole({ scope: 'partner', partnerId: Q, name: 'qgrant' });
    await grantRolePermissions(qGrant.id, [MANAGE]);
    const orgRole = await createRole({ scope: 'organization', orgId: orgA, name: 'orggrant' });
    await grantRolePermissions(orgRole.id, [MANAGE]);

    await member('allGrant', P, grant.id, 'all');
    await member('allWild', P, wild.id, 'all');
    await member('allNoGrant', P, none.id, 'all');
    await member('allDisabled', P, grant.id, 'all', 'disabled');
    await member('allInvited', P, grant.id, 'all', 'invited');
    await member('accessNone', P, grant.id, 'none');
    await member('selectedA', P, grant.id, 'selected');
    await member('otherPartner', Q, qGrant.id, 'all');
    const om = await createUser({ partnerId: P, orgId: orgA, status: 'active' });
    await assignUserToOrganization(om.id, orgA, orgRole.id);
    ids.orgMember = om.id;
  });

  it('partner-wide: exactly active orgAccess=all holders of granting or wildcard roles', async () => {
    const out = await asSystem(() => resolvePartnerUsersWithPermission(P, MANAGE));
    expect(out.sort()).toEqual([ids.allGrant, ids.allWild].sort());
  });

  it('org-scoped: also the selected[orgA] user; still excludes none/other partner/disabled/invited/org member', async () => {
    const out = await asSystem(() => resolvePartnerUsersWithPermission(P, MANAGE, { orgId: orgA }));
    expect(out.sort()).toEqual([ids.allGrant, ids.allWild, ids.selectedA].sort());
  });

  it('resolveIncidentRecipients: owner separate and excluded from admins; works in system scope', async () => {
    const r = await asSystem(() =>
      resolveIncidentRecipients({ partnerId: P, orgId: null, ownerUserId: ids.allGrant!, repairPermission: 'connected_apps:manage' }),
    );
    expect(r.owner).toBe(ids.allGrant);
    expect(r.admins).toEqual([ids.allWild]);
  });

  it('resolveIncidentRecipients: disabled owner is dropped', async () => {
    const r = await asSystem(() =>
      resolveIncidentRecipients({ partnerId: P, orgId: null, ownerUserId: ids.allDisabled!, repairPermission: 'connected_apps:manage' }),
    );
    expect(r.owner).toBeNull();
    expect(r.admins.sort()).toEqual([ids.allGrant, ids.allWild].sort());
  });
});

async function createOrg(partnerId: string) {
  return createOrganization({ partnerId });
}
