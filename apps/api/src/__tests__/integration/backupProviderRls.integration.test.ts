import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { EXTERNAL_BACKUP_STATUSES } from '@breeze/shared';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  backupProviderConnections,
  backupProviderCustomers,
  backupProviderDeviceHistory,
  backupProviderDevices,
  devices,
} from '../../db/schema';
import { createIntegrationTestClient, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';
import { executeOrgMerge } from '../../services/orgMerge';
import { cascadeDeleteOrg } from '../../services/tenantCascade';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const PROVIDER_TABLES = [
  'backup_provider_connections',
  'backup_provider_customers',
  'backup_provider_devices',
  'backup_provider_device_history',
] as const;

/** A partner with one org, one site, one device, one connection, one mapped customer. */
async function seedTenant(label: string, existingPartnerId?: string) {
  const partner = existingPartnerId ? { id: existingPartnerId } : await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `backup-provider-${label}-${randomUUID()}@example.com`,
  });
  // Admin handle for `devices`: its partner-export insert trigger takes partner
  // locks that refuse inside an app-role seed transaction (same reason as
  // m365TenantSyncRls's seedOrg).
  const [device] = await (getTestDb() as typeof db).insert(devices).values({
    orgId: org.id,
    siteId: site!.id,
    agentId: randomUUID(),
    hostname: `bp-${label}-${randomUUID().slice(0, 8)}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'online',
  }).returning({ id: devices.id, hostname: devices.hostname });

  const [connection] = await db.insert(backupProviderConnections).values({
    partnerId: partner.id,
    provider: 'cove',
    name: `Cove ${label}`,
    credentialsEncrypted: 'enc:test',
    vendorRootId: '1000',
    vendorRootName: 'RootPartner',
  }).returning({ id: backupProviderConnections.id });

  const [customer] = await db.insert(backupProviderCustomers).values({
    connectionId: connection!.id,
    partnerId: partner.id,
    vendorCustomerId: `vendor-${label}`,
    vendorCustomerName: `Customer ${label}`,
    orgId: org.id,
    mappingSource: 'manual',
  }).returning({ id: backupProviderCustomers.id });

  const orgContext: DbAccessContext = {
    scope: 'organization',
    orgId: org.id,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [],
    userId: user.id,
  };
  const partnerContext: DbAccessContext = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [partner.id],
    userId: user.id,
  };

  return { partner, org, site: site!, user, device: device!, connection: connection!, customer: customer!, orgContext, partnerContext };
}

async function seedFixture() {
  return withSystemDbAccessContext(async () => ({ a: await seedTenant('a'), b: await seedTenant('b') }));
}

async function insertProviderDevice(
  tenant: Awaited<ReturnType<typeof seedTenant>>,
  over: Record<string, unknown> = {},
) {
  const [row] = await db.insert(backupProviderDevices).values({
    connectionId: tenant.connection.id,
    partnerId: tenant.partner.id,
    orgId: tenant.org.id,
    customerId: tenant.customer.id,
    provider: 'cove',
    vendorDeviceId: `vd-${randomUUID().slice(0, 8)}`,
    vendorDeviceName: 'SRV-FS01',
    ...over,
  }).returning({ id: backupProviderDevices.id });
  return row!;
}

// ---------------------------------------------------------------------------

describe('backup provider — schema invariants (live catalog)', () => {
  runDb('all four tables have RLS enabled AND forced', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND relname = ANY(${sql.raw(
        `ARRAY[${PROVIDER_TABLES.map((t) => `'${t}'`).join(',')}]::text[]`,
      )})
      ORDER BY relname
    `)) as unknown as Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(rows).toHaveLength(PROVIDER_TABLES.length);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} RLS not enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} RLS not forced`).toBe(true);
    }
  });

  runDb('the partner-axis tables carry four breeze_has_partner_access policies each', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT tablename, cmd, qual, with_check FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('backup_provider_connections', 'backup_provider_customers')
      ORDER BY tablename, cmd
    `)) as unknown as Array<{ tablename: string; cmd: string; qual: string | null; with_check: string | null }>;
    for (const table of ['backup_provider_connections', 'backup_provider_customers']) {
      const forTable = rows.filter((r) => r.tablename === table);
      expect(forTable.map((r) => r.cmd).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      for (const policy of forTable) {
        expect(`${policy.qual ?? ''}${policy.with_check ?? ''}`).toContain('breeze_has_partner_access');
      }
    }
    // The customers INSERT/UPDATE WITH CHECK additionally re-checks the parent
    // connection's partner_id, so a row whose connection belongs to another
    // partner is refused by the POLICY as well as by the composite FK.
    const customerWrites = rows.filter(
      (r) => r.tablename === 'backup_provider_customers' && (r.cmd === 'INSERT' || r.cmd === 'UPDATE'),
    );
    expect(customerWrites).toHaveLength(2);
    for (const policy of customerWrites) {
      expect(policy.with_check ?? '').toContain('backup_provider_connections');
    }
  });

  runDb('the org-axis tables carry one FOR ALL breeze_has_org_access policy each', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('backup_provider_devices', 'backup_provider_device_history')
      ORDER BY tablename
    `)) as unknown as Array<{ tablename: string; policyname: string; cmd: string; qual: string; with_check: string }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.policyname).toBe(`${row.tablename}_org_access`);
      expect(row.cmd).toBe('ALL');
      expect(row.qual).toContain('breeze_has_org_access');
      expect(row.with_check).toContain('breeze_has_org_access');
      // partner_id on backup_provider_devices is denormalization, NEVER a
      // second read branch — a partner-access leg here would let a
      // restricted-org partner user read every org's rows.
      expect(row.qual).not.toContain('breeze_has_partner_access');
    }
  });

  runDb('every composite FK referencing an org_id column is deferrable, and the device link sets ONE column', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT conname, condeferrable, confdeltype,
             (SELECT array_agg(a.attname ORDER BY a.attname)
                FROM unnest(con.confdelsetcols) AS c(attnum)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = c.attnum) AS setcols
      FROM pg_constraint con
      WHERE conname IN (
        'backup_provider_customers_org_partner_fk',
        'backup_provider_devices_customer_org_fk',
        'backup_provider_devices_breeze_device_org_fk',
        'backup_provider_device_history_device_org_fk'
      )
      ORDER BY conname
    `)) as unknown as Array<{ conname: string; condeferrable: boolean; confdeltype: string; setcols: string[] | null }>;
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.condeferrable, `${row.conname} not deferrable`).toBe(true);
    const link = rows.find((r) => r.conname === 'backup_provider_devices_breeze_device_org_fk')!;
    expect(link.confdeltype).toBe('n');                 // SET NULL
    expect(link.setcols).toEqual(['breeze_device_id']); // ...on that column ONLY
  });

  runDb('the external_backup_status enum matches EXTERNAL_BACKUP_STATUSES exactly, in order', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'external_backup_status' ORDER BY e.enumsortorder
    `)) as unknown as Array<{ enumlabel: string }>;
    expect(rows.map((r) => r.enumlabel)).toEqual([...EXTERNAL_BACKUP_STATUSES]);
  });

  runDb('the one-provider-row-per-device index is partial and the FK targets exist', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN (
        'backup_provider_devices_breeze_device_uniq',
        'backup_provider_customers_id_org_uniq',
        'backup_provider_devices_id_org_uniq',
        'backup_provider_connections_id_partner_uniq'
      ) ORDER BY indexname
    `)) as unknown as Array<{ indexname: string; indexdef: string }>;
    expect(rows).toHaveLength(4);
    const partial = rows.find((r) => r.indexname === 'backup_provider_devices_breeze_device_uniq')!;
    expect(partial.indexdef).toContain('UNIQUE');
    expect(partial.indexdef).toContain('WHERE');
  });
});

describe('backup provider — cross-tenant isolation as breeze_app', () => {
  runDb('runs code-under-test as breeze_app without BYPASSRLS', async () => {
    const fx = await seedFixture();
    const rows = await withDbAccessContext(fx.a.partnerContext, () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
    expect((rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0])
      .toEqual({ who: 'breeze_app', rolbypassrls: false });
  });

  runDb('refuses a forged cross-partner connection insert with 42501', async () => {
    const fx = await seedFixture();
    await expect(withDbAccessContext(fx.a.partnerContext, () =>
      db.insert(backupProviderConnections).values({
        partnerId: fx.b.partner.id, provider: 'cove', name: 'forged', credentialsEncrypted: 'enc:x',
      }))).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('refuses a forged cross-partner customer insert with 42501', async () => {
    const fx = await seedFixture();
    await expect(withDbAccessContext(fx.a.partnerContext, () =>
      db.insert(backupProviderCustomers).values({
        connectionId: fx.b.connection.id, partnerId: fx.b.partner.id,
        vendorCustomerId: 'forged', vendorCustomerName: 'forged',
      }))).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('hides another partner connection from a SELECT', async () => {
    const fx = await seedFixture();
    const visible = await withDbAccessContext(fx.a.partnerContext, () =>
      db.select({ id: backupProviderConnections.id }).from(backupProviderConnections)
        .where(sql`${backupProviderConnections.id} = ${fx.b.connection.id}::uuid`));
    expect(visible).toEqual([]);
  });

  runDb('an ORG token cannot read the partner-axis tables at all', async () => {
    // This is what forces `provider` and `portal_show_provider_name` to be
    // DENORMALIZED onto the device rows: the client portal runs under an org
    // token and could otherwise never label a provider row.
    const fx = await seedFixture();
    const conns = await withDbAccessContext(fx.a.orgContext, () =>
      db.select({ id: backupProviderConnections.id }).from(backupProviderConnections));
    expect(conns).toEqual([]);
    const customers = await withDbAccessContext(fx.a.orgContext, () =>
      db.select({ id: backupProviderCustomers.id }).from(backupProviderCustomers));
    expect(customers).toEqual([]);
  });

  runDb('a customer mapped to a FOREIGN-partner org is rejected with 23503', async () => {
    const fx = await seedFixture();
    await expect(withSystemDbAccessContext(() =>
      db.insert(backupProviderCustomers).values({
        connectionId: fx.a.connection.id,
        partnerId: fx.a.partner.id,
        vendorCustomerId: 'cross',
        vendorCustomerName: 'cross',
        // Partner A's connection mapped to partner B's org — representable
        // only if the (org_id, partner_id) composite FK is missing.
        orgId: fx.b.org.id,
        mappingSource: 'manual',
      }))).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  runDb('an org token cannot read ANOTHER org device rows, and its own partner token reads them all', async () => {
    const fx = await seedFixture();
    await withSystemDbAccessContext(() => insertProviderDevice(fx.b));
    const foreign = await withDbAccessContext(fx.a.orgContext, () =>
      db.select({ id: backupProviderDevices.id }).from(backupProviderDevices)
        .where(sql`${backupProviderDevices.orgId} = ${fx.b.org.id}::uuid`));
    expect(foreign).toEqual([]);

    await withSystemDbAccessContext(() => insertProviderDevice(fx.a));
    const own = await withDbAccessContext(fx.a.partnerContext, () =>
      db.select({ id: backupProviderDevices.id }).from(backupProviderDevices));
    expect(own).toHaveLength(1);
  });

  runDb('refuses a device row whose customer belongs to another org with 23503', async () => {
    const fx = await seedFixture();
    await expect(withSystemDbAccessContext(() =>
      db.insert(backupProviderDevices).values({
        connectionId: fx.a.connection.id,
        partnerId: fx.a.partner.id,
        orgId: fx.a.org.id,
        customerId: fx.b.customer.id, // another org's customer
        provider: 'cove',
        vendorDeviceId: 'x',
        vendorDeviceName: 'x',
      }))).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  runDb('refuses linking to a device in ANOTHER org with 23503', async () => {
    const fx = await seedFixture();
    await expect(withSystemDbAccessContext(() =>
      insertProviderDevice(fx.a, { breezeDeviceId: fx.b.device.id })))
      .rejects.toMatchObject({ cause: { code: '23503' } });
  });

  runDb('refuses a SECOND provider row linked to the same Breeze device with 23505', async () => {
    const fx = await seedFixture();
    await withSystemDbAccessContext(() => insertProviderDevice(fx.a, { breezeDeviceId: fx.a.device.id }));
    await expect(withSystemDbAccessContext(() =>
      insertProviderDevice(fx.a, { breezeDeviceId: fx.a.device.id })))
      .rejects.toMatchObject({ cause: { code: '23505' } });
  });

  runDb('refuses a ledger row whose device belongs to another org with 23503', async () => {
    const fx = await seedFixture();
    const row = await withSystemDbAccessContext(() => insertProviderDevice(fx.b));
    await expect(withSystemDbAccessContext(() =>
      db.insert(backupProviderDeviceHistory).values({
        providerDeviceId: row.id, orgId: fx.a.org.id, day: '2026-09-15', status: 'completed',
      }))).rejects.toMatchObject({ cause: { code: '23503' } });
  });
});

describe('backup provider — lifecycle against real Postgres', () => {
  runDb('deleting a device clears ONLY breeze_device_id, keeping the provider row and its org', async () => {
    const fx = await seedFixture();
    const row = await withSystemDbAccessContext(() =>
      insertProviderDevice(fx.a, { breezeDeviceId: fx.a.device.id, deviceMatchSource: 'manual' }));
    await withSystemDbAccessContext(() =>
      db.execute(sql`DELETE FROM devices WHERE id = ${fx.a.device.id}::uuid`));
    const [after] = (await getTestDb().execute(sql`
      SELECT org_id, breeze_device_id, vendor_device_name
      FROM backup_provider_devices WHERE id = ${row.id}::uuid
    `)) as unknown as Array<{ org_id: string; breeze_device_id: string | null; vendor_device_name: string }>;
    expect(after, 'the ON DELETE SET NULL nulled the whole row instead of the link column').toBeDefined();
    expect(after!.breeze_device_id).toBeNull();
    expect(after!.org_id).toBe(fx.a.org.id);
  });

  runDb('deleting a connection cascades customers, devices and the ledger away', async () => {
    const fx = await seedFixture();
    const row = await withSystemDbAccessContext(() => insertProviderDevice(fx.a));
    await withSystemDbAccessContext(() => db.insert(backupProviderDeviceHistory).values({
      providerDeviceId: row.id, orgId: fx.a.org.id, day: '2026-09-15', status: 'completed',
    }));

    await withSystemDbAccessContext(() =>
      db.execute(sql`DELETE FROM backup_provider_connections WHERE id = ${fx.a.connection.id}::uuid`));

    const admin = getTestDb() as typeof db;
    for (const table of ['backup_provider_customers', 'backup_provider_devices', 'backup_provider_device_history']) {
      const [count] = (await admin.execute(sql`
        SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${fx.a.org.id}::uuid
      `)) as unknown as Array<{ n: number }>;
      expect(count!.n, `${table} survived the connection delete`).toBe(0);
    }
  });

  runDb('a device org flip with a live provider link fails on the link FK unless it is detached first', async () => {
    // Proves the PREMISE behind the moveOrg.ts detach (Task 4): the FK is
    // checked at the END of the device org flip, and nothing but an explicit
    // detach before the flip clears it. The mocked route test pins the
    // statement ORDER; only a live database shows that order is load-bearing.
    const fx = await withSystemDbAccessContext(async () => {
      const a = await seedTenant('move-src');
      const target = await createOrganization({ partnerId: a.partner.id });
      const targetSite = await createSite({ orgId: target.id });
      return { a, target, targetSite: targetSite! };
    });
    const row = await withSystemDbAccessContext(() =>
      insertProviderDevice(fx.a, { breezeDeviceId: fx.a.device.id, deviceMatchSource: 'auto_hostname' }));

    const admin = getTestDb() as typeof db;
    const flip = (tx: typeof db) => tx.execute(sql`
      UPDATE devices SET org_id = ${fx.target.id}::uuid, site_id = ${fx.targetSite.id}::uuid
      WHERE id = ${fx.a.device.id}::uuid`);

    // Negative control: no detach -> the composite FK refuses the flip.
    await expect(admin.transaction(async (tx) => { await flip(tx as unknown as typeof db); }))
      .rejects.toMatchObject({
        cause: { code: '23503', constraint_name: 'backup_provider_devices_breeze_device_org_fk' },
      });

    // The route's statement, then the flip: succeeds, and the SOURCE org's
    // provider row survives with only its link and provenance cleared.
    await admin.transaction(async (tx) => {
      await tx.execute(sql`UPDATE backup_provider_devices
        SET breeze_device_id = NULL, device_match_source = NULL
        WHERE breeze_device_id = ${fx.a.device.id}::uuid AND org_id = ${fx.a.org.id}::uuid`);
      await flip(tx as unknown as typeof db);
    });
    const rows = (await admin.execute(sql`
      SELECT org_id, breeze_device_id, device_match_source
      FROM backup_provider_devices WHERE id = ${row.id}::uuid
    `)) as unknown as Array<{ org_id: string; breeze_device_id: string | null; device_match_source: string | null }>;
    // NOT re-homed: the row stays with its customer's org.
    expect(rows).toEqual([{ org_id: fx.a.org.id, breeze_device_id: null, device_match_source: null }]);
  });

  runDb('org erasure removes every provider row for the target org and leaves the other org intact', async () => {
    const fx = await seedFixture();
    const row = await withSystemDbAccessContext(() => insertProviderDevice(fx.a, { breezeDeviceId: fx.a.device.id }));
    await withSystemDbAccessContext(() => db.insert(backupProviderDeviceHistory).values({
      providerDeviceId: row.id, orgId: fx.a.org.id, day: '2026-09-15', status: 'failed',
    }));
    await withSystemDbAccessContext(() => insertProviderDevice(fx.b));

    await cascadeDeleteOrg(fx.a.org.id, fx.a.user.id, fx.a.user.email);

    const admin = getTestDb() as typeof db;
    for (const table of ['backup_provider_customers', 'backup_provider_devices', 'backup_provider_device_history']) {
      const [gone] = (await admin.execute(sql`
        SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${fx.a.org.id}::uuid
      `)) as unknown as Array<{ n: number }>;
      expect(gone!.n, `${table} left rows under the erased org`).toBe(0);
    }
    const [survivor] = (await admin.execute(sql`
      SELECT count(*)::int AS n FROM backup_provider_devices WHERE org_id = ${fx.b.org.id}::uuid
    `)) as unknown as Array<{ n: number }>;
    expect(survivor!.n).toBe(1);
    // The PARTNER-axis connection is untouched by an ORG erasure — it has no
    // org_id and belongs to the MSP, not the customer.
    const [connection] = (await admin.execute(sql`
      SELECT count(*)::int AS n FROM backup_provider_connections WHERE id = ${fx.a.connection.id}::uuid
    `)) as unknown as Array<{ n: number }>;
    expect(connection!.n).toBe(1);
  });

  runDb('an org merge re-points the customer, its devices and its ledger to the survivor', async () => {
    const prior = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
    try {
      const fx = await withSystemDbAccessContext(async () => {
        const loser = await seedTenant('merge-loser');
        const survivor = await createOrganization({ partnerId: loser.partner.id });
        const actor = await createUser({
          partnerId: loser.partner.id,
          email: `backup-provider-merge-${randomUUID()}@example.com`,
        });
        return { loser, survivor, actor };
      });
      const row = await withSystemDbAccessContext(() =>
        insertProviderDevice(fx.loser, { breezeDeviceId: fx.loser.device.id }));
      await withSystemDbAccessContext(() => db.insert(backupProviderDeviceHistory).values({
        providerDeviceId: row.id, orgId: fx.loser.org.id, day: '2026-09-15', status: 'completed',
      }));

      const result = await executeOrgMerge({
        loserOrgId: fx.loser.org.id,
        survivorOrgId: fx.survivor.id,
        partnerId: fx.loser.partner.id,
        performedBy: fx.actor.id,
        performedByEmail: fx.actor.email,
      });
      // Plain repoint, not a resolve-phase delete: the mapping, the link and
      // the 28-day ledger all survive the merge.
      expect(result.tables.backup_provider_customers).toEqual({ moved: 1, dropped: 0 });
      expect(result.tables.backup_provider_devices).toEqual({ moved: 1, dropped: 0 });
      expect(result.tables.backup_provider_device_history).toEqual({ moved: 1, dropped: 0 });

      const admin = getTestDb() as typeof db;
      const [moved] = (await admin.execute(sql`
        SELECT org_id, breeze_device_id FROM backup_provider_devices WHERE id = ${row.id}::uuid
      `)) as unknown as Array<{ org_id: string; breeze_device_id: string | null }>;
      expect(moved!.org_id).toBe(fx.survivor.id);
      // The device repointed too, so the composite link FK still holds.
      expect(moved!.breeze_device_id).toBe(fx.loser.device.id);
    } finally {
      if (prior === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
      else process.env.ORG_MERGE_FENCE_DRAIN_MS = prior;
    }
  });

  runDb('remapCustomer deletes the old org rows and re-homes the mapping atomically', async () => {
    const { remapCustomer } = await import('../../services/backupProviders/mapping');
    const fx = await withSystemDbAccessContext(async () => {
      const tenant = await seedTenant('remap');
      const target = await createOrganization({ partnerId: tenant.partner.id });
      return { tenant, target };
    });
    const row = await withSystemDbAccessContext(() => insertProviderDevice(fx.tenant));
    await withSystemDbAccessContext(() => db.insert(backupProviderDeviceHistory).values({
      providerDeviceId: row.id, orgId: fx.tenant.org.id, day: '2026-09-15', status: 'completed',
    }));

    const result = await withSystemDbAccessContext(() => remapCustomer(
      fx.tenant.customer.id,
      fx.target.id,
      { userId: fx.tenant.user.id, partnerId: fx.tenant.partner.id },
    ));
    expect(result).toMatchObject({ orgId: fx.target.id, mappingSource: 'manual', deletedDevices: 1, deletedHistory: 1 });

    const admin = getTestDb() as typeof db;
    const [devicesLeft] = (await admin.execute(sql`
      SELECT count(*)::int AS n FROM backup_provider_devices WHERE customer_id = ${fx.tenant.customer.id}::uuid
    `)) as unknown as Array<{ n: number }>;
    // Nothing stays visible to the OLD org: the rows are gone, and the next
    // sync re-creates them under the new one.
    expect(devicesLeft!.n).toBe(0);
    const [customer] = (await admin.execute(sql`
      SELECT org_id, mapping_source FROM backup_provider_customers WHERE id = ${fx.tenant.customer.id}::uuid
    `)) as unknown as Array<{ org_id: string; mapping_source: string }>;
    expect(customer).toEqual({ org_id: fx.target.id, mapping_source: 'manual' });
  });

  runDb('un-mapping stamps manual_unmapped so auto-mapping never silently re-maps it', async () => {
    const { remapCustomer } = await import('../../services/backupProviders/mapping');
    const fx = await withSystemDbAccessContext(() => seedTenant('unmap'));
    await withSystemDbAccessContext(() => remapCustomer(
      fx.customer.id, null, { userId: fx.user.id, partnerId: fx.partner.id },
    ));
    const [row] = (await (getTestDb() as typeof db).execute(sql`
      SELECT org_id, mapping_source FROM backup_provider_customers WHERE id = ${fx.customer.id}::uuid
    `)) as unknown as Array<{ org_id: string | null; mapping_source: string }>;
    expect(row).toEqual({ org_id: null, mapping_source: 'manual_unmapped' });
  });

  runDb('remapCustomer refuses a target org under a different partner, writing nothing', async () => {
    const { remapCustomer, RemapCustomerError } = await import('../../services/backupProviders/mapping');
    const fx = await seedFixture();
    await expect(withSystemDbAccessContext(() => remapCustomer(
      fx.a.customer.id, fx.b.org.id, { userId: fx.a.user.id, partnerId: fx.a.partner.id },
    ))).rejects.toBeInstanceOf(RemapCustomerError);
    const [row] = (await (getTestDb() as typeof db).execute(sql`
      SELECT org_id FROM backup_provider_customers WHERE id = ${fx.a.customer.id}::uuid
    `)) as unknown as Array<{ org_id: string }>;
    expect(row!.org_id).toBe(fx.a.org.id);
  });
});

describe('backup provider — HTTP-level FK mapping through the real router', () => {
  runDb('PUT /backup/providers/devices/:id/link answers 422, not 500, for a cross-org device', async () => {
    // A caught 23503 inside the ambient request transaction poisons it, and the
    // mapped 422 is then rethrown as a raw Internal Server Error at COMMIT.
    // Drizzle mocks cannot see that; only a real request can.
    const { Hono } = await import('hono');
    const { backupRoutes } = await import('../../routes/backup');

    const app = new Hono();
    app.route('/api/v1/backup', backupRoutes);
    const client = await createIntegrationTestClient(app, { scope: 'partner' });

    const fixture = await withSystemDbAccessContext(async () => {
      const otherOrg = await createOrganization({ partnerId: client.env.partner.id });
      const otherSite = await createSite({ orgId: otherOrg.id });
      const [otherDevice] = await (getTestDb() as typeof db).insert(devices).values({
        orgId: otherOrg.id,
        siteId: otherSite!.id,
        agentId: randomUUID(),
        hostname: `bp-other-${randomUUID().slice(0, 8)}`,
        osType: 'windows', osVersion: '11', architecture: 'x86_64',
        agentVersion: '0.0.0-test', status: 'online',
      }).returning({ id: devices.id });

      const [connection] = await db.insert(backupProviderConnections).values({
        partnerId: client.env.partner.id, provider: 'cove', name: 'Cove HTTP',
        credentialsEncrypted: 'enc:test',
      }).returning({ id: backupProviderConnections.id });
      const [customer] = await db.insert(backupProviderCustomers).values({
        connectionId: connection!.id, partnerId: client.env.partner.id,
        vendorCustomerId: 'http-1', vendorCustomerName: 'HTTP Customer',
        orgId: client.env.organization.id, mappingSource: 'manual',
      }).returning({ id: backupProviderCustomers.id });
      const [providerRow] = await db.insert(backupProviderDevices).values({
        connectionId: connection!.id, partnerId: client.env.partner.id,
        orgId: client.env.organization.id, customerId: customer!.id,
        provider: 'cove', vendorDeviceId: 'http-vd-1', vendorDeviceName: 'HTTP-SRV',
      }).returning({ id: backupProviderDevices.id });

      return { otherDevice: otherDevice!, providerRow: providerRow! };
    });

    const res = await client.put(
      `/api/v1/backup/providers/devices/${fixture.providerRow.id}/link`,
      { deviceId: fixture.otherDevice.id },
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'DEVICE_ORG_MISMATCH' });
  });
});
