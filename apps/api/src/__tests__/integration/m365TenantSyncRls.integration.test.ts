import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  devices,
  m365CaPolicies,
  m365Connections,
  m365IntuneDevices,
  m365LicenseSkus,
  m365PostureRollups,
  m365SecureScoreSnapshots,
  m365SyncState,
  m365Users,
} from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';
import { executeOrgMerge } from '../../services/orgMerge';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const credentialVersion = '0123456789abcdef0123456789abcdef';
const hash = 'a'.repeat(64);

const SYNC_TABLES = [
  'm365_sync_state',
  'm365_users',
  'm365_intune_devices',
  'm365_ca_policies',
  'm365_license_skus',
  'm365_secure_score_snapshots',
  'm365_posture_rollups',
] as const;

/** The five tables org merge empties in its resolve phase (custom disposition). */
const M365_SNAPSHOT_TABLES = [
  'm365_sync_state',
  'm365_users',
  'm365_intune_devices',
  'm365_ca_policies',
  'm365_license_skus',
] as const;

async function seedOrg(label: string, existingPartnerId?: string) {
  const partner = existingPartnerId ? { id: existingPartnerId } : await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `m365-sync-${label}-${randomUUID()}@example.com`,
  });
  const site = await createSite({ orgId: org.id });
  const tenantId = randomUUID();
  const [connection] = await db.insert(m365Connections).values({
    orgId: org.id,
    userId: null,
    tenantId,
    consentAttemptId: randomUUID(),
    clientId: randomUUID(),
    clientSecret: null,
    profile: 'customer-graph-read',
    authMode: 'application-certificate',
    credentialDomain: 'customer-graph-read',
    vaultRef: `akv://vault.example/m365-customer-graph-read-${tenantId}/${credentialVersion}`,
    credentialVersion,
    permissionManifestVersion: 3,
    status: 'active',
  }).returning({ id: m365Connections.id });
  // Admin connection, like agentRunLineageFixtures.insertDevice: the devices
  // partner-export insert trigger takes partner locks that refuse inside this
  // app-role seed transaction. The fixture is not under test here.
  const [device] = await (getTestDb() as typeof db).insert(devices).values({
    orgId: org.id,
    siteId: site!.id,
    agentId: randomUUID(),
    hostname: `m365-sync-${label}-${randomUUID().slice(0, 8)}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'online',
  }).returning({ id: devices.id });
  const context: DbAccessContext = {
    scope: 'organization',
    orgId: org.id,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [],
    userId: user.id,
  };
  return { partner, org, site: site!, user, tenantId, connection: connection!, device: device!, context };
}

async function seedFixture() {
  return withSystemDbAccessContext(async () => ({
    a: await seedOrg('a'),
    b: await seedOrg('b'),
  }));
}

describe('m365 tenant sync — schema invariants (live catalog)', () => {
  runDb('all seven tables have RLS enabled AND forced', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND relname = ANY(${sql.raw(
        `ARRAY[${SYNC_TABLES.map((t) => `'${t}'`).join(',')}]::text[]`,
      )})
      ORDER BY relname
    `)) as unknown as Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(rows).toHaveLength(SYNC_TABLES.length);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} RLS not enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} RLS not forced`).toBe(true);
    }
  });

  runDb('each table carries one FOR ALL org-access policy with USING and WITH CHECK', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT tablename, policyname, cmd, qual, with_check
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = ANY(${sql.raw(
        `ARRAY[${SYNC_TABLES.map((t) => `'${t}'`).join(',')}]::text[]`,
      )})
      ORDER BY tablename
    `)) as unknown as Array<{ tablename: string; policyname: string; cmd: string; qual: string; with_check: string }>;
    expect(rows.map((r) => r.tablename)).toEqual([...SYNC_TABLES].sort());
    for (const row of rows) {
      expect(row.policyname).toBe(`${row.tablename}_org_access`);
      expect(row.cmd).toBe('ALL');
      expect(row.qual).toContain('breeze_has_org_access');
      expect(row.with_check).toContain('breeze_has_org_access');
    }
  });

  runDb('both composite tenant FKs are deferrable, and the device link sets NULL on one column', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT conname, condeferrable, confdeltype,
             (SELECT array_agg(a.attname ORDER BY a.attname)
                FROM unnest(con.confdelsetcols) AS c(attnum)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = c.attnum) AS setcols
      FROM pg_constraint con
      WHERE conname IN ('m365_sync_state_connection_org_fk', 'm365_intune_devices_breeze_device_org_fk')
      ORDER BY conname
    `)) as unknown as Array<{ conname: string; condeferrable: boolean; confdeltype: string; setcols: string[] | null }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.condeferrable, `${row.conname} not deferrable`).toBe(true);
    const device = rows.find((r) => r.conname === 'm365_intune_devices_breeze_device_org_fk')!;
    expect(device.confdeltype).toBe('n');           // SET NULL
    expect(device.setcols).toEqual(['breeze_device_id']); // ...on that column ONLY
    const state = rows.find((r) => r.conname === 'm365_sync_state_connection_org_fk')!;
    expect(state.confdeltype).toBe('c');            // CASCADE
  });

  runDb('m365_connections carries the (id, org_id) unique index the FK targets', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'm365_connections_id_org_uniq'
    `)) as unknown as Array<{ indexdef: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain('UNIQUE');
    expect(rows[0]!.indexdef).toMatch(/\(id, org_id\)/);
  });

  runDb('the ticker and retention partial indexes exist', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('m365_sync_state_due_idx', 'm365_secure_score_snapshots_prunable_idx',
                          'm365_users_stale_since_idx')
      ORDER BY indexname
    `)) as unknown as Array<{ indexname: string; indexdef: string }>;
    expect(rows.map((r) => r.indexname)).toEqual([
      'm365_secure_score_snapshots_prunable_idx',
      'm365_sync_state_due_idx',
      'm365_users_stale_since_idx',
    ]);
    for (const row of rows) expect(row.indexdef).toContain('WHERE');
  });

  runDb('both enums carry the contracted labels in order', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname IN ('m365_sync_domain', 'm365_sync_status')
      GROUP BY t.typname ORDER BY t.typname
    `)) as unknown as Array<{ typname: string; labels: string[] }>;
    expect(rows.find((r) => r.typname === 'm365_sync_domain')!.labels).toEqual([
      'users', 'signin_activity', 'intune_devices', 'ca_policies', 'skus', 'secure_score',
    ]);
    expect(rows.find((r) => r.typname === 'm365_sync_status')!.labels).toEqual([
      'success', 'partial', 'needs_consent', 'throttled', 'error',
    ]);
  });
});

describe('m365 tenant sync — cross-tenant isolation as breeze_app', () => {
  runDb('runs code-under-test as breeze_app without BYPASSRLS', async () => {
    const fx = await seedFixture();
    const rows = await withDbAccessContext(fx.a.context, () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
    expect((rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0])
      .toEqual({ who: 'breeze_app', rolbypassrls: false });
  });

  runDb('refuses a forged insert into every sync table with 42501', async () => {
    const fx = await seedFixture();
    const forge = async (label: string, run: () => Promise<unknown>) => {
      await expect(withDbAccessContext(fx.a.context, run), `${label} accepted a cross-tenant insert`)
        .rejects.toMatchObject({ cause: { code: '42501' } });
    };

    await forge('m365_sync_state', () => db.insert(m365SyncState).values({
      orgId: fx.b.org.id, connectionId: fx.b.connection.id, domain: 'users', intervalSeconds: 21600,
    }));
    await forge('m365_users', () => db.insert(m365Users).values({
      orgId: fx.b.org.id, graphId: randomUUID(), coreHash: hash,
    }));
    await forge('m365_intune_devices', () => db.insert(m365IntuneDevices).values({
      orgId: fx.b.org.id, graphId: randomUUID(), coreHash: hash,
    }));
    await forge('m365_ca_policies', () => db.insert(m365CaPolicies).values({
      orgId: fx.b.org.id, graphId: randomUUID(), coreHash: hash, definitionHash: hash,
    }));
    await forge('m365_license_skus', () => db.insert(m365LicenseSkus).values({
      orgId: fx.b.org.id, graphId: randomUUID(), coreHash: hash,
    }));
    await forge('m365_secure_score_snapshots', () => db.insert(m365SecureScoreSnapshots).values({
      orgId: fx.b.org.id, tenantId: fx.b.tenantId, scoreDate: '2026-09-01',
    }));
    await forge('m365_posture_rollups', () => db.insert(m365PostureRollups).values({
      orgId: fx.b.org.id, tenantId: fx.b.tenantId, rollupDate: '2026-09-01',
    }));
  });

  runDb('hides another org rows from a SELECT', async () => {
    const fx = await seedFixture();
    await withSystemDbAccessContext(() => db.insert(m365Users).values({
      orgId: fx.b.org.id, graphId: randomUUID(), coreHash: hash, userPrincipalName: 'b@example.test',
    }));
    const visible = await withDbAccessContext(fx.a.context, () =>
      db.select({ id: m365Users.id }).from(m365Users)
        .where(sql`${m365Users.orgId} = ${fx.b.org.id}::uuid`));
    expect(visible).toEqual([]);
  });

  runDb('refuses a (breeze_device_id, org_id) pair that crosses orgs with 23503', async () => {
    const fx = await seedFixture();
    await expect(withSystemDbAccessContext(() => db.insert(m365IntuneDevices).values({
      orgId: fx.a.org.id,
      graphId: randomUUID(),
      coreHash: hash,
      // org A's row pointing at org B's device — representable only if the
      // composite FK is missing.
      breezeDeviceId: fx.b.device.id,
    }))).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  runDb('refuses a (connection_id, org_id) pair that crosses orgs with 23503', async () => {
    const fx = await seedFixture();
    await expect(withSystemDbAccessContext(() => db.insert(m365SyncState).values({
      orgId: fx.a.org.id, connectionId: fx.b.connection.id, domain: 'skus', intervalSeconds: 86400,
    }))).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  runDb('deleting a device clears only breeze_device_id, keeping the snapshot row', async () => {
    const fx = await seedFixture();
    const graphId = randomUUID();
    await withSystemDbAccessContext(() => db.insert(m365IntuneDevices).values({
      orgId: fx.a.org.id, graphId, coreHash: hash,
      deviceName: 'linked', breezeDeviceId: fx.a.device.id,
    }));
    await withSystemDbAccessContext(() =>
      db.execute(sql`DELETE FROM devices WHERE id = ${fx.a.device.id}::uuid`));
    const [row] = await withSystemDbAccessContext(() =>
      db.select({
        orgId: m365IntuneDevices.orgId,
        deviceName: m365IntuneDevices.deviceName,
        breezeDeviceId: m365IntuneDevices.breezeDeviceId,
      }).from(m365IntuneDevices).where(sql`${m365IntuneDevices.graphId} = ${graphId}`)) as Array<{
        orgId: string; deviceName: string | null; breezeDeviceId: string | null }>;
    expect(row, 'the ON DELETE SET NULL nulled the whole row instead of the link column').toBeDefined();
    expect(row!.breezeDeviceId).toBeNull();
    expect(row!.orgId).toBe(fx.a.org.id);
    expect(row!.deviceName).toBe('linked');
  });

  runDb('deleting the connection cascades its sync state away', async () => {
    const fx = await seedFixture();
    await withSystemDbAccessContext(() => db.insert(m365SyncState).values({
      orgId: fx.a.org.id, connectionId: fx.a.connection.id, domain: 'ca_policies', intervalSeconds: 86400,
    }));
    await withSystemDbAccessContext(() =>
      db.execute(sql`DELETE FROM m365_connections WHERE id = ${fx.a.connection.id}::uuid`));
    const remaining = await withSystemDbAccessContext(() =>
      db.select({ id: m365SyncState.id }).from(m365SyncState)
        .where(sql`${m365SyncState.connectionId} = ${fx.a.connection.id}::uuid`));
    expect(remaining).toEqual([]);
  });
});

describe('m365 tenant sync — org lifecycle against real Postgres', () => {
  // Proves the PREMISE behind the moveOrg.ts detach (spec §3.4): the device
  // link FK is checked at the end of the device org flip, and nothing but an
  // explicit detach before the flip clears it. The mocked route test pins the
  // statement order; only a live database can show that order is load-bearing.
  runDb('a device org flip with a live Intune link fails on the link FK unless it is detached first', async () => {
    const fx = await withSystemDbAccessContext(async () => {
      const a = await seedOrg('move-src');
      const target = await createOrganization({ partnerId: a.partner.id });
      const targetSite = await createSite({ orgId: target.id });
      return { a, target, targetSite: targetSite! };
    });
    const graphId = randomUUID();
    await withSystemDbAccessContext(() => db.insert(m365IntuneDevices).values({
      orgId: fx.a.org.id, graphId, coreHash: hash, deviceName: 'linked', breezeDeviceId: fx.a.device.id,
    }));

    const admin = getTestDb() as typeof db;
    const flip = (tx: typeof db) => tx.execute(sql`
      UPDATE devices SET org_id = ${fx.target.id}::uuid, site_id = ${fx.targetSite.id}::uuid
      WHERE id = ${fx.a.device.id}::uuid`);

    // Negative control: no detach -> the composite FK refuses the flip.
    await expect(admin.transaction(async (tx) => { await flip(tx as unknown as typeof db); }))
      .rejects.toMatchObject({
        cause: { code: '23503', constraint_name: 'm365_intune_devices_breeze_device_org_fk' },
      });

    // The route's statement, then the flip: succeeds, and the SOURCE org's
    // snapshot row survives with only its link cleared.
    await admin.transaction(async (tx) => {
      await tx.execute(sql`UPDATE m365_intune_devices SET breeze_device_id = NULL
        WHERE breeze_device_id = ${fx.a.device.id}::uuid AND org_id = ${fx.a.org.id}::uuid`);
      await flip(tx as unknown as typeof db);
    });
    const rows = (await admin.execute(sql`
      SELECT org_id, breeze_device_id FROM m365_intune_devices WHERE graph_id = ${graphId}
    `)) as unknown as Array<{ org_id: string; breeze_device_id: string | null }>;
    expect(rows).toEqual([{ org_id: fx.a.org.id, breeze_device_id: null }]);
  });

  runDb('an org merge deletes the loser snapshots, keeps survivor history on a date collision, and commits', async () => {
    const prior = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
    try {
      const fx = await withSystemDbAccessContext(async () => {
        const loser = await seedOrg('merge-loser');
        const survivor = await createOrganization({ partnerId: loser.partner.id });
        const actor = await createUser({
          partnerId: loser.partner.id,
          email: `m365-sync-merge-${randomUUID()}@example.com`,
        });
        return { loser, survivor, actor };
      });
      const L = fx.loser.org.id;
      const S = fx.survivor.id;
      await withSystemDbAccessContext(async () => {
        // Both composite-FK tables populated, so a move-phase disposition would
        // violate the deferred FK at COMMIT when m365_connections and devices
        // repoint out from under them.
        await db.insert(m365SyncState).values({
          orgId: L, connectionId: fx.loser.connection.id, domain: 'users', intervalSeconds: 21600,
        });
        await db.insert(m365IntuneDevices).values({
          orgId: L, graphId: randomUUID(), coreHash: hash, breezeDeviceId: fx.loser.device.id,
        });
        await db.insert(m365Users).values({ orgId: L, graphId: randomUUID(), coreHash: hash });
        await db.insert(m365CaPolicies).values({
          orgId: L, graphId: randomUUID(), coreHash: hash, definitionHash: hash,
        });
        await db.insert(m365LicenseSkus).values({ orgId: L, graphId: randomUUID(), coreHash: hash });
        await db.insert(m365SecureScoreSnapshots).values([
          { orgId: L, tenantId: fx.loser.tenantId, scoreDate: '2026-09-01', currentScore: '10.00' },
          { orgId: L, tenantId: fx.loser.tenantId, scoreDate: '2026-09-02', currentScore: '11.00' },
          { orgId: S, tenantId: fx.loser.tenantId, scoreDate: '2026-09-01', currentScore: '99.00' },
        ]);
      });

      const result = await executeOrgMerge({
        loserOrgId: L, survivorOrgId: S, partnerId: fx.loser.partner.id,
        performedBy: fx.actor.id, performedByEmail: fx.actor.email,
      });
      for (const table of M365_SNAPSHOT_TABLES) {
        expect(result.tables[table], `${table} merge outcome`).toEqual({ moved: 0, dropped: 1 });
      }
      expect(result.tables.m365_secure_score_snapshots).toEqual({ moved: 1, dropped: 1 });

      const admin = getTestDb() as typeof db;
      for (const table of M365_SNAPSHOT_TABLES) {
        const [row] = (await admin.execute(sql`
          SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id IN (${L}::uuid, ${S}::uuid)
        `)) as unknown as Array<{ n: number }>;
        expect(row!.n, `${table} rows survived the merge`).toBe(0);
      }
      const scores = (await admin.execute(sql`
        SELECT org_id, score_date::text AS score_date, current_score::text AS current_score
        FROM m365_secure_score_snapshots WHERE org_id IN (${L}::uuid, ${S}::uuid) ORDER BY score_date
      `)) as unknown as Array<{ org_id: string; score_date: string; current_score: string }>;
      expect(scores).toEqual([
        { org_id: S, score_date: '2026-09-01', current_score: '99.00' }, // survivor wins the collision
        { org_id: S, score_date: '2026-09-02', current_score: '11.00' }, // loser-only date moves
      ]);
    } finally {
      if (prior === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
      else process.env.ORG_MERGE_FENCE_DRAIN_MS = prior;
    }
  });
});
