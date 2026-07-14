import './setup';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { m365Connections } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const tenantA = '11111111-1111-1111-1111-111111111111';
const tenantB = '22222222-2222-2222-2222-222222222222';

async function seedFixture() {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const userA = await createUser({
      partnerId: partnerA.id,
      orgId: orgA.id,
      email: `m365-rls-a-${Date.now()}@example.com`,
    });
    const userB = await createUser({
      partnerId: partnerB.id,
      orgId: orgB.id,
      email: `m365-rls-b-${Date.now()}@example.com`,
    });

    const [orgBConnection] = await db.insert(m365Connections).values({
      orgId: orgB.id,
      userId: null,
      tenantId: tenantB,
      clientId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      clientSecret: null,
      profile: 'customer-graph-read',
      authMode: 'application-certificate',
      credentialDomain: 'customer-graph-read',
      vaultRef: 'akv://vault.example/m365-customer-graph-read-b/1',
      credentialVersion: '1',
      permissionManifestVersion: 1,
      status: 'active',
    }).returning({ id: m365Connections.id });
    if (!orgBConnection) throw new Error('failed to seed foreign connection');

    const orgAContext: DbAccessContext = {
      scope: 'organization',
      orgId: orgA.id,
      accessibleOrgIds: [orgA.id],
      accessiblePartnerIds: [partnerA.id],
      userId: userA.id,
    };

    return { partnerA, orgA, orgB, userA, userB, orgBConnection, orgAContext };
  });
}

describe('m365_connections dual-axis RLS', () => {
  runDb('runs code-under-test as breeze_app without BYPASSRLS', async () => {
    const fx = await seedFixture();
    const rows = await withDbAccessContext(fx.orgAContext, () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
    const row = (rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0];
    expect(row).toEqual({ who: 'breeze_app', rolbypassrls: false });
  });

  runDb('hides another organization connection and blocks a forged insert', async () => {
    const fx = await seedFixture();
    const hidden = await withDbAccessContext(fx.orgAContext, () =>
      db.select({ id: m365Connections.id }).from(m365Connections)
        .where(eq(m365Connections.id, fx.orgBConnection.id)));
    expect(hidden).toEqual([]);

    await expect(withDbAccessContext(fx.orgAContext, () => db.insert(m365Connections).values({
      orgId: fx.orgB.id,
      userId: null,
      tenantId: tenantB,
      clientId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      clientSecret: null,
      profile: 'customer-graph-actions',
      authMode: 'application-certificate',
      credentialDomain: 'customer-graph-actions',
      vaultRef: 'akv://vault.example/m365-customer-graph-actions-forged/1',
      credentialVersion: '1',
      permissionManifestVersion: 1,
      status: 'active',
    }))).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('allows the current user to own communications but blocks another user', async () => {
    const fx = await seedFixture();
    const [own] = await withDbAccessContext(fx.orgAContext, () => db.insert(m365Connections).values({
      orgId: null,
      userId: fx.userA.id,
      tenantId: tenantA,
      clientId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      clientSecret: null,
      profile: 'communications-delegated',
      authMode: 'delegated',
      credentialDomain: 'communications-delegated',
      vaultRef: 'akv://vault.example/m365-communications-user-a/1',
      credentialVersion: '1',
      permissionManifestVersion: 1,
      status: 'active',
    }).returning({ id: m365Connections.id, userId: m365Connections.userId }));
    expect(own?.userId).toBe(fx.userA.id);

    await expect(withDbAccessContext(fx.orgAContext, () => db.insert(m365Connections).values({
      orgId: null,
      userId: fx.userB.id,
      tenantId: tenantB,
      clientId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      clientSecret: null,
      profile: 'communications-delegated',
      authMode: 'delegated',
      credentialDomain: 'communications-delegated',
      vaultRef: 'akv://vault.example/m365-communications-user-b-forged/1',
      credentialVersion: '1',
      permissionManifestVersion: 1,
      status: 'active',
    }))).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
