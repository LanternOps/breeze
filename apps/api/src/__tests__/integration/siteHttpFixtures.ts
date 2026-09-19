/** Fixed-state HTTP fixtures. No authentication, permission or database mocks. */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { db, withDbAccessContext } from '../../db';
import { devices, organizationUsers } from '../../db/schema';
import { createAccessToken } from '../../services/jwt';
import { createOrganization, createPartner, createRole, createSite, createUser, grantRolePermissions, assignUserToOrganization } from './db-utils';
import { getTestDb, getAppDb } from './setup';
export async function siteFixture() {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const foreignPartner = await createPartner();
    const foreignOrg = await createOrganization({ partnerId: foreignPartner.id });
    const allowedSite = await createSite({ orgId: org.id });
    const hiddenSite = await createSite({ orgId: org.id });
    const foreignSite = await createSite({ orgId: foreignOrg.id });
    const makeDevice = async (orgId: string, siteId: string, hostname: string) => {
        const [row] = await getTestDb().insert(devices).values({
            orgId, siteId, agentId: randomUUID(), hostname, osType: 'linux', osVersion: 'synthetic',
            architecture: 'amd64', agentVersion: 'synthetic', status: 'quarantined',
            quarantinedAt: new Date(), quarantinedReason: 'synthetic fixture',
        }).returning();
        if (!row)
            throw new Error('Missing device fixture');
        return row;
    };
    const allowed = await makeDevice(org.id, allowedSite.id, 'visible-fixture');
    const hidden = await makeDevice(org.id, hiddenSite.id, 'hidden-fixture');
    const foreign = await makeDevice(foreignOrg.id, foreignSite.id, 'foreign-fixture');
    const actor = async (siteIds: string[] | null, grants: Array<{
        resource: string;
        action: string;
    }>, mfa = true) => {
        const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `${randomUUID()}@example.test`, mfaEnabled: true });
        const role = await createRole({ scope: 'organization', orgId: org.id, name: randomUUID() });
        await grantRolePermissions(role.id, grants);
        await assignUserToOrganization(user.id, org.id, role.id);
        await getTestDb().update(organizationUsers).set({ siteIds }).where(and(eq(organizationUsers.userId, user.id), eq(organizationUsers.orgId, org.id)));
        const token = await createAccessToken({ sub: user.id, email: user.email, roleId: role.id,
            orgId: org.id, partnerId: partner.id, scope: 'organization', mfa, aep: user.authEpoch,
            mep: user.mfaEpoch, sid: randomUUID() });
        return { user, token };
    };
    const appRole = await getAppDb().execute(sql `select current_user, rolsuper, rolbypassrls from pg_roles where rolname=current_user`);
    expect(appRole[0]).toMatchObject({ current_user: 'breeze_app', rolsuper: false, rolbypassrls: false });
    const scoped = <T>(fn: () => Promise<T>, foreign = false) => withDbAccessContext({
        scope: 'organization', orgId: foreign ? foreignOrg.id : org.id,
        accessibleOrgIds: [foreign ? foreignOrg.id : org.id], accessiblePartnerIds: [],
        currentPartnerId: foreign ? foreignPartner.id : partner.id,
    }, fn);
    const deviceSnapshot = () => Promise.all([false, true].map(other => scoped(() => db.select().from(devices).orderBy(devices.id), other)));
    return { partner, org, foreignPartner, foreignOrg, allowedSite, hiddenSite, foreignSite, allowed, hidden, foreign, actor, scoped, deviceSnapshot };
}
export function request(app: Hono, token: string | undefined, method: string, path: string, body?: unknown) {
    return app.request(path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
