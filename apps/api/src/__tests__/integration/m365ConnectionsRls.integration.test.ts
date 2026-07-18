import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { m365Connections } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const tenantA = '11111111-1111-1111-1111-111111111111';
const tenantB = '22222222-2222-2222-2222-222222222222';
const tenantC = '33333333-3333-3333-3333-333333333333';
const credentialVersion = '0123456789abcdef0123456789abcdef';
const attemptA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const attemptB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function seedFixture() {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const orgA2 = await createOrganization({ partnerId: partnerA.id });
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
    const userA2 = await createUser({
      partnerId: partnerA.id,
      orgId: orgA2.id,
      email: `m365-rls-a2-${Date.now()}@example.com`,
    });
    const userAPeer = await createUser({
      partnerId: partnerA.id,
      orgId: orgA.id,
      email: `m365-rls-a-peer-${Date.now()}@example.com`,
    });

    const [orgBConnection] = await db.insert(m365Connections).values({
      orgId: orgB.id,
      userId: null,
      tenantId: tenantB,
      consentAttemptId: attemptB,
      clientId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      clientSecret: null,
      profile: 'customer-graph-read',
      authMode: 'application-certificate',
      credentialDomain: 'customer-graph-read',
      vaultRef: `akv://vault.example/m365-customer-graph-read-22222222-2222-2222-2222-222222222222/${credentialVersion}`,
      credentialVersion,
      permissionManifestVersion: 1,
      status: 'active',
    }).returning({ id: m365Connections.id });
    if (!orgBConnection) throw new Error('failed to seed foreign connection');

    const [samePartnerUserConnection] = await db.insert(m365Connections).values({
      orgId: null,
      userId: userA2.id,
      tenantId: tenantC,
      clientId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      clientSecret: null,
      profile: 'communications-delegated',
      authMode: 'delegated',
      credentialDomain: 'communications-delegated',
      vaultRef: `akv://vault.example/m365-communications-delegated-33333333-3333-3333-3333-333333333333/${credentialVersion}`,
      credentialVersion,
      permissionManifestVersion: 1,
      status: 'active',
    }).returning({ id: m365Connections.id });
    if (!samePartnerUserConnection) throw new Error('failed to seed same-partner user connection');

    const [sameOrgUserConnection] = await db.insert(m365Connections).values({
      orgId: null,
      userId: userAPeer.id,
      tenantId: tenantC,
      clientId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      clientSecret: null,
      profile: 'communications-delegated',
      authMode: 'delegated',
      credentialDomain: 'communications-delegated',
      vaultRef: `akv://vault.example/m365-communications-delegated-77777777-7777-7777-7777-777777777777/${credentialVersion}`,
      credentialVersion,
      permissionManifestVersion: 1,
      status: 'active',
    }).returning({ id: m365Connections.id });
    if (!sameOrgUserConnection) throw new Error('failed to seed same-org user connection');

    const orgAContext: DbAccessContext = {
      scope: 'organization',
      orgId: orgA.id,
      accessibleOrgIds: [orgA.id],
      accessiblePartnerIds: [],
      userId: userA.id,
    };

    const selectedOrgPartnerContext: DbAccessContext = {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [orgA.id],
      accessiblePartnerIds: [partnerA.id],
      userId: userA.id,
    };

    return {
      partnerA,
      orgA,
      orgB,
      userA,
      userB,
      orgBConnection,
      samePartnerUserConnection,
      sameOrgUserConnection,
      orgAContext,
      selectedOrgPartnerContext,
    };
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
      consentAttemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      clientId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      clientSecret: null,
      profile: 'customer-graph-actions',
      authMode: 'application-certificate',
      credentialDomain: 'customer-graph-actions',
      vaultRef: `akv://vault.example/m365-customer-graph-actions-44444444-4444-4444-4444-444444444444/${credentialVersion}`,
      credentialVersion,
      permissionManifestVersion: 1,
      status: 'active',
    }))).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('does not expose another user communications connection through partner access', async () => {
    const fx = await seedFixture();
    const hidden = await withDbAccessContext(fx.selectedOrgPartnerContext, () =>
      db.select({ id: m365Connections.id }).from(m365Connections)
        .where(eq(m365Connections.id, fx.samePartnerUserConnection.id)));

    expect(hidden).toEqual([]);
  });

  runDb('does not expose a same-organization peer communications connection', async () => {
    const fx = await seedFixture();
    const hidden = await withDbAccessContext(fx.orgAContext, () =>
      db.select({ id: m365Connections.id }).from(m365Connections)
        .where(eq(m365Connections.id, fx.sameOrgUserConnection.id)));

    expect(hidden).toEqual([]);
  });

  runDb('allows owner CRUD but blocks reassignment to another user', async () => {
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
      vaultRef: `akv://vault.example/m365-communications-delegated-55555555-5555-5555-5555-555555555555/${credentialVersion}`,
      credentialVersion,
      permissionManifestVersion: 1,
      status: 'active',
    }).returning({ id: m365Connections.id, userId: m365Connections.userId }));
    expect(own?.userId).toBe(fx.userA.id);

    const selected = await withDbAccessContext(fx.orgAContext, () =>
      db.select({ id: m365Connections.id }).from(m365Connections)
        .where(eq(m365Connections.id, own!.id)));
    expect(selected).toEqual([{ id: own!.id }]);

    const updated = await withDbAccessContext(fx.orgAContext, () =>
      db.update(m365Connections)
        .set({ status: 'degraded' })
        .where(eq(m365Connections.id, own!.id))
        .returning({ status: m365Connections.status }));
    expect(updated).toEqual([{ status: 'degraded' }]);

    await expect(withDbAccessContext(fx.orgAContext, () =>
      db.update(m365Connections)
        .set({ userId: fx.userB.id })
        .where(eq(m365Connections.id, own!.id))
        .returning({ id: m365Connections.id })))
      .rejects.toMatchObject({ cause: { code: '42501' } });

    const removed = await withDbAccessContext(fx.orgAContext, () =>
      db.delete(m365Connections)
        .where(eq(m365Connections.id, own!.id))
        .returning({ id: m365Connections.id }));
    expect(removed).toEqual([{ id: own!.id }]);

    await expect(withDbAccessContext(fx.orgAContext, () => db.insert(m365Connections).values({
      orgId: null,
      userId: fx.userB.id,
      tenantId: tenantB,
      clientId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      clientSecret: null,
      profile: 'communications-delegated',
      authMode: 'delegated',
      credentialDomain: 'communications-delegated',
      vaultRef: `akv://vault.example/m365-communications-delegated-66666666-6666-6666-6666-666666666666/${credentialVersion}`,
      credentialVersion,
      permissionManifestVersion: 1,
      status: 'active',
    }))).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('preserves a legacy encrypted secret and metadata when reapplied twice', async () => {
    const fx = await seedFixture();
    const encryptedSecret = 'enc:v1:AAECAwQFBgcICQ==:legacy-ciphertext';
    const [legacy] = await withSystemDbAccessContext(() => db.insert(m365Connections).values({
      orgId: fx.orgA.id,
      userId: null,
      tenantId: tenantA,
      clientId: '11111111-1111-4111-8111-111111111111',
      clientSecret: encryptedSecret,
      profile: 'legacy-direct',
      authMode: 'client-secret-legacy',
      credentialDomain: 'legacy-direct',
      permissionManifestVersion: 0,
      observedGrants: [],
      displayName: 'Legacy exact metadata',
      status: 'active',
    }).returning());

    const migrationSql = readFileSync(join(
      __dirname,
      '../../../migrations/2026-07-14-m365-customer-graph-read-consent.sql',
    ), 'utf8');
    await getTestDb().execute(sql.raw(migrationSql));
    await getTestDb().execute(sql.raw(migrationSql));

    const [after] = await withSystemDbAccessContext(() => db.select()
      .from(m365Connections)
      .where(eq(m365Connections.id, legacy!.id)));
    expect(after).toEqual(legacy);
    expect(after?.clientSecret).toBe(encryptedSecret);
  });

  runDb('allows legacy plus graph-read for one org and enforces verified tenant/profile ownership', async () => {
    const fx = await seedFixture();
    await withSystemDbAccessContext(() => db.insert(m365Connections).values({
      orgId: fx.orgA.id,
      userId: null,
      tenantId: tenantA,
      clientId: '11111111-1111-4111-8111-111111111111',
      clientSecret: 'legacy-encrypted-secret',
      profile: 'legacy-direct',
      authMode: 'client-secret-legacy',
      credentialDomain: 'legacy-direct',
      permissionManifestVersion: 0,
      observedGrants: [],
      status: 'active',
    }));

    await withSystemDbAccessContext(() => db.insert(m365Connections).values({
      orgId: fx.orgA.id,
      userId: null,
      tenantId: tenantA,
      consentAttemptId: attemptA,
      clientId: '22222222-2222-4222-8222-222222222222',
      clientSecret: null,
      profile: 'customer-graph-read',
      authMode: 'application-certificate',
      credentialDomain: 'customer-graph-read',
      vaultRef: `akv://vault.example/graph-read/${credentialVersion}`,
      credentialVersion,
      permissionManifestVersion: 2,
      observedGrants: [],
      status: 'active',
    }));

    await expect(withSystemDbAccessContext(() => db.insert(m365Connections).values({
      orgId: fx.orgB.id,
      userId: null,
      tenantId: tenantA,
      consentAttemptId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      clientId: '33333333-3333-4333-8333-333333333333',
      clientSecret: null,
      profile: 'customer-graph-read',
      authMode: 'application-certificate',
      credentialDomain: 'customer-graph-read',
      vaultRef: `akv://vault.example/graph-read-foreign/${credentialVersion}`,
      credentialVersion,
      permissionManifestVersion: 2,
      observedGrants: [],
      status: 'active',
    }))).rejects.toMatchObject({ cause: { code: '23505' } });

    await expect(withSystemDbAccessContext(() => db.insert(m365Connections).values({
      orgId: fx.orgB.id,
      userId: null,
      tenantId: tenantA,
      consentAttemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      clientId: '44444444-4444-4444-8444-444444444444',
      clientSecret: null,
      profile: 'customer-graph-actions',
      authMode: 'application-certificate',
      credentialDomain: 'customer-graph-actions',
      vaultRef: `akv://vault.example/graph-actions/${credentialVersion}`,
      credentialVersion,
      permissionManifestVersion: 1,
      observedGrants: [],
      status: 'active',
    }))).resolves.toBeDefined();
  });

  runDb('accepts a pending null tenant and rejects uppercase non-legacy tenant GUIDs', async () => {
    const fx = await seedFixture();
    await expect(withSystemDbAccessContext(() => db.insert(m365Connections).values({
      orgId: fx.orgA.id,
      userId: null,
      tenantId: null,
      consentAttemptId: attemptA,
      clientId: '55555555-5555-4555-8555-555555555555',
      clientSecret: null,
      profile: 'customer-graph-read',
      authMode: 'application-certificate',
      credentialDomain: 'customer-graph-read',
      vaultRef: `akv://vault.example/pending/${credentialVersion}`,
      credentialVersion,
      permissionManifestVersion: 2,
      observedGrants: [],
      status: 'pending-consent',
    }))).resolves.toBeDefined();

    await expect(withSystemDbAccessContext(() => db.insert(m365Connections).values({
      orgId: fx.orgB.id,
      userId: null,
      tenantId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      consentAttemptId: attemptB,
      clientId: '66666666-6666-4666-8666-666666666666',
      clientSecret: null,
      profile: 'customer-graph-actions',
      authMode: 'application-certificate',
      credentialDomain: 'customer-graph-actions',
      vaultRef: `akv://vault.example/uppercase/${credentialVersion}`,
      credentialVersion,
      permissionManifestVersion: 1,
      observedGrants: [],
      status: 'active',
    }))).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  runDb('accepts sorted canonical observed grants and rejects unsorted or duplicate ID keys', async () => {
    const fx = await seedFixture();
    const base = {
      orgId: fx.orgA.id,
      userId: null,
      tenantId: tenantA,
      clientId: '77777777-7777-4777-8777-777777777777',
      clientSecret: null,
      profile: 'customer-graph-actions' as const,
      authMode: 'application-certificate' as const,
      credentialDomain: 'customer-graph-actions' as const,
      vaultRef: `akv://vault.example/grants/${credentialVersion}`,
      credentialVersion,
      permissionManifestVersion: 1,
      status: 'active' as const,
    };
    const first = {
      resourceApplicationId: '00000003-0000-0000-c000-000000000000',
      appRoleId: '11111111-1111-4111-8111-111111111111',
      value: null,
    };
    const second = {
      resourceApplicationId: '00000003-0000-0000-c000-000000000000',
      appRoleId: '22222222-2222-4222-8222-222222222222',
      value: 'Example.Read.All',
    };

    const [valid] = await withSystemDbAccessContext(() => db.insert(m365Connections)
      .values({ ...base, observedGrants: [first, second] })
      .returning({ id: m365Connections.id }));
    await withSystemDbAccessContext(() => db.delete(m365Connections)
      .where(eq(m365Connections.id, valid!.id)));

    await expect(withSystemDbAccessContext(() => db.insert(m365Connections)
      .values({ ...base, observedGrants: [second, first] })))
      .rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(withSystemDbAccessContext(() => db.insert(m365Connections)
      .values({ ...base, observedGrants: [first, { ...first, value: 'Duplicate name' }] })))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  });

  runDb('preflight rejects invalid existing graph-read rows without rewriting them', async () => {
    const fx = await seedFixture();
    const migrationSql = readFileSync(join(
      __dirname,
      '../../../migrations/2026-07-14-m365-customer-graph-read-consent.sql',
    ), 'utf8');
    const adminDb = getTestDb();
    let invalidId: string | undefined;
    try {
      await adminDb.execute(sql.raw(`
        ALTER TABLE m365_connections
          DROP CONSTRAINT IF EXISTS m365_connections_graph_read_consent_check;
        ALTER TABLE m365_connections
          DROP CONSTRAINT IF EXISTS m365_connections_profile_binding_check;
      `));
      const [invalid] = await withSystemDbAccessContext(() => db.insert(m365Connections).values({
        orgId: fx.orgA.id,
        userId: null,
        tenantId: tenantA,
        consentAttemptId: null,
        clientId: '88888888-8888-4888-8888-888888888888',
        clientSecret: null,
        profile: 'customer-graph-read',
        authMode: 'application-certificate',
        credentialDomain: 'customer-graph-read',
        vaultRef: `akv://vault.example/preflight/${credentialVersion}`,
        credentialVersion,
        permissionManifestVersion: 2,
        observedGrants: [],
        displayName: 'must remain untouched',
        status: 'pending-consent',
      }).returning({ id: m365Connections.id }));
      invalidId = invalid!.id;

      await expect(adminDb.execute(sql.raw(migrationSql)))
        .rejects.toMatchObject({ cause: { code: 'P0001' } });
      const [unchanged] = await withSystemDbAccessContext(() => db.select({
        consentAttemptId: m365Connections.consentAttemptId,
        displayName: m365Connections.displayName,
      }).from(m365Connections).where(eq(m365Connections.id, invalidId!)));
      expect(unchanged).toEqual({ consentAttemptId: null, displayName: 'must remain untouched' });
    } finally {
      if (invalidId) {
        await withSystemDbAccessContext(() => db.delete(m365Connections)
          .where(eq(m365Connections.id, invalidId!)));
      }
      await adminDb.execute(sql.raw(migrationSql));
    }
  });
});
