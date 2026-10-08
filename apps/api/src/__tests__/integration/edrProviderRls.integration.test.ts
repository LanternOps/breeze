/**
 * EDR provider framework W01a (#8164 / #8165) — tenancy proof against real
 * Postgres. Migration: 2026-12-16-100000-edr-provider-framework.sql.
 *
 * Covers: RLS shape per table, CHECK constraints vs the @breeze/shared tuples,
 * the composite-FK tenant chain (cross-partner / cross-org forges), the
 * column-list ON DELETE SET NULL edges (#4100), deferrability (org-merge
 * contract), device delete / org move / org erasure / org merge with linked EDR
 * rows present, and the D13 tombstone corrections (plan index correction 1).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  EDR_ACTIONS,
  EDR_ACTION_REQUESTED_VIA,
  EDR_ACTION_STATUSES,
  EDR_CONNECTION_STATUSES,
  EDR_DETECTION_STATUSES,
  EDR_DEVICE_MATCH_SOURCES,
  EDR_ENDPOINT_HEALTH,
  EDR_ENDPOINT_TYPES,
  EDR_ISOLATION_STATES,
  EDR_MAPPING_SOURCES,
  EDR_OS_PLATFORMS,
  EDR_SEVERITIES,
  EDR_SYNC_STATUSES,
  EDR_VENDOR_KINDS,
} from '@breeze/shared';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  devices,
  edrActions,
  edrConnections,
  edrDetections,
  edrEndpoints,
  edrTenants,
} from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';
import { executeOrgMerge } from '../../services/orgMerge';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { deleteDeviceCascade, type DeviceDeletionTx } from '../../services/deviceDeletion';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const EDR_TABLES = ['edr_connections', 'edr_tenants', 'edr_endpoints', 'edr_detections', 'edr_actions'] as const;
const PARTNER_TABLES = ['edr_connections', 'edr_tenants'] as const;
const ORG_TABLES = ['edr_endpoints', 'edr_detections', 'edr_actions'] as const;
const ORG_ID_TABLES = ['edr_tenants', 'edr_endpoints', 'edr_detections', 'edr_actions'] as const;

type Row = Record<string, unknown>;
const admin = () => getTestDb() as typeof db;
async function adminRows<T = Row>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await admin().execute(query)) as unknown as T[];
}

/** A partner with one org, one site, one device, one connection, one MAPPED vendor tenant. */
async function seedEdrTenant(label: string, existingPartnerId?: string) {
  const partner = existingPartnerId ? { id: existingPartnerId } : await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `edr-provider-${label}-${randomUUID()}@example.com`,
  });
  // Admin handle for `devices`: its partner-export insert trigger takes partner
  // locks that refuse inside an app-role seed transaction (backupProviderRls precedent).
  const [device] = await admin().insert(devices).values({
    orgId: org.id,
    siteId: site!.id,
    agentId: randomUUID(),
    hostname: `edr-${label}-${randomUUID().slice(0, 8)}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'online',
  }).returning({ id: devices.id, hostname: devices.hostname });

  const [connection] = await db.insert(edrConnections).values({
    partnerId: partner.id,
    provider: 'bitdefender',
    name: `GravityZone ${label} ${randomUUID().slice(0, 6)}`,
    credentialsEncrypted: 'enc:test',
    vendorRootId: 'root-1',
    vendorRootType: 'partner',
  }).returning({ id: edrConnections.id });

  const [tenant] = await db.insert(edrTenants).values({
    connectionId: connection!.id,
    partnerId: partner.id,
    vendorTenantId: `company-${label}-${randomUUID().slice(0, 6)}`,
    vendorTenantName: `Company ${label}`,
    vendorTenantType: 'company',
    orgId: org.id,
    mappingSource: 'manual',
  }).returning({ id: edrTenants.id });

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

  return {
    partner, org, site: site!, user, device: device!, connection: connection!, tenant: tenant!,
    orgContext, partnerContext,
  };
}
type Tenant = Awaited<ReturnType<typeof seedEdrTenant>>;

async function seedFixture() {
  return withSystemDbAccessContext(async () => ({ a: await seedEdrTenant('a'), b: await seedEdrTenant('b') }));
}

async function insertEndpoint(t: Tenant, over: Row = {}) {
  const [row] = await db.insert(edrEndpoints).values({
    connectionId: t.connection.id,
    partnerId: t.partner.id,
    orgId: t.org.id,
    tenantId: t.tenant.id,
    provider: 'bitdefender',
    vendorEndpointId: `ep-${randomUUID().slice(0, 8)}`,
    hostname: 'WS-01',
    ...over,
  } as typeof edrEndpoints.$inferInsert).returning({ id: edrEndpoints.id });
  return row!;
}

async function insertDetection(t: Tenant, over: Row = {}) {
  const [row] = await db.insert(edrDetections).values({
    connectionId: t.connection.id,
    partnerId: t.partner.id,
    orgId: t.org.id,
    tenantId: t.tenant.id,
    provider: 'bitdefender',
    vendorDetectionId: `det-${randomUUID().slice(0, 8)}`,
    vendorKind: 'incident',
    severity: 'high',
    status: 'open',
    ...over,
  } as typeof edrDetections.$inferInsert).returning({ id: edrDetections.id });
  return row!;
}

async function insertAction(t: Tenant, over: Row = {}) {
  const [row] = await db.insert(edrActions).values({
    connectionId: t.connection.id,
    partnerId: t.partner.id,
    orgId: t.org.id,
    tenantId: t.tenant.id,
    provider: 'bitdefender',
    action: 'isolate',
    requestedVia: 'ui',
    requestedBy: t.user.id,
    ...over,
  } as typeof edrActions.$inferInsert).returning({ id: edrActions.id });
  return row!;
}

/** Extract the quoted literals of a CHECK definition, sorted. */
function checkLiterals(def: string): string[] {
  return [...def.matchAll(/'([^']*)'/g)].map((m) => m[1]!).sort();
}

// ---------------------------------------------------------------------------

describe('edr provider — schema invariants (live catalog)', () => {
  runDb('all five tables have RLS enabled AND forced', async () => {
    const rows = await adminRows<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(sql`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND relname = ANY(${sql.raw(
        `ARRAY[${EDR_TABLES.map((t) => `'${t}'`).join(',')}]::text[]`,
      )})
      ORDER BY relname
    `);
    expect(rows.map((r) => r.relname).sort()).toEqual([...EDR_TABLES].sort());
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} RLS not enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} RLS not forced`).toBe(true);
    }
  });

  runDb('partner tables carry four per-command partner policies; tenants WITH CHECK re-checks the connection', async () => {
    const rows = await adminRows<{ tablename: string; cmd: string; qual: string | null; with_check: string | null }>(sql`
      SELECT tablename, cmd, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('edr_connections', 'edr_tenants')
      ORDER BY tablename, cmd
    `);
    for (const table of PARTNER_TABLES) {
      const forTable = rows.filter((r) => r.tablename === table);
      expect(forTable.map((r) => r.cmd).sort(), table).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      for (const policy of forTable) {
        expect(`${policy.qual ?? ''}${policy.with_check ?? ''}`).toContain('breeze_has_partner_access');
        // No org-access branch: an org token must read nothing here.
        expect(`${policy.qual ?? ''}${policy.with_check ?? ''}`).not.toContain('breeze_has_org_access');
      }
    }
    const tenantWrites = rows.filter(
      (r) => r.tablename === 'edr_tenants' && (r.cmd === 'INSERT' || r.cmd === 'UPDATE'),
    );
    expect(tenantWrites).toHaveLength(2);
    for (const policy of tenantWrites) expect(policy.with_check ?? '').toContain('edr_connections');
  });

  runDb('org tables carry one FOR ALL breeze_has_org_access(org_id) policy and no partner branch', async () => {
    const rows = await adminRows<{ tablename: string; policyname: string; cmd: string; qual: string; with_check: string }>(sql`
      SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('edr_endpoints', 'edr_detections', 'edr_actions')
      ORDER BY tablename
    `);
    expect(rows.map((r) => r.tablename).sort()).toEqual([...ORG_TABLES].sort());
    for (const row of rows) {
      expect(row.policyname).toBe(`${row.tablename}_org_access`);
      expect(row.cmd).toBe('ALL');
      expect(row.qual).toContain('breeze_has_org_access');
      expect(row.with_check).toContain('breeze_has_org_access');
      // partner_id is denormalization, NEVER a second read branch.
      expect(row.qual).not.toContain('breeze_has_partner_access');
    }
  });

  runDb('CHECK constraints accept exactly the @breeze/shared tuples', async () => {
    const expected: Record<string, readonly string[]> = {
      edr_connections_status_chk: EDR_CONNECTION_STATUSES,
      edr_tenants_mapping_source_chk: EDR_MAPPING_SOURCES,
      edr_endpoints_os_platform_chk: EDR_OS_PLATFORMS,
      edr_endpoints_endpoint_type_chk: EDR_ENDPOINT_TYPES,
      edr_endpoints_health_chk: EDR_ENDPOINT_HEALTH,
      edr_endpoints_isolation_state_chk: EDR_ISOLATION_STATES,
      edr_endpoints_match_source_chk: EDR_DEVICE_MATCH_SOURCES,
      edr_detections_severity_chk: EDR_SEVERITIES,
      edr_detections_notified_severity_chk: EDR_SEVERITIES,
      edr_detections_status_chk: EDR_DETECTION_STATUSES,
      edr_detections_vendor_kind_chk: EDR_VENDOR_KINDS,
      edr_actions_action_chk: EDR_ACTIONS,
      edr_actions_status_chk: EDR_ACTION_STATUSES,
      edr_actions_requested_via_chk: EDR_ACTION_REQUESTED_VIA,
    };
    // The two sync-status CHECKs list the same tuple once per stream.
    const perStream: Record<string, readonly string[]> = {
      edr_connections_sync_status_chk: EDR_SYNC_STATUSES,
      edr_tenants_sync_status_chk: EDR_SYNC_STATUSES,
    };
    const names = [...Object.keys(expected), ...Object.keys(perStream)];
    const rows = await adminRows<{ conname: string; def: string }>(sql`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE contype = 'c' AND conname = ANY(${sql.raw(`ARRAY[${names.map((n) => `'${n}'`).join(',')}]::text[]`)})
    `);
    expect(rows.map((r) => r.conname).sort()).toEqual([...names].sort());
    for (const row of rows) {
      if (expected[row.conname]) {
        expect(checkLiterals(row.def), row.conname).toEqual([...expected[row.conname]!].sort());
      } else {
        const tuple = perStream[row.conname]!;
        expect(checkLiterals(row.def), row.conname).toEqual([...tuple, ...tuple].sort());
      }
    }
  });

  runDb('a value outside the tuple is refused with 23514', async () => {
    const fx = await seedFixture();
    await expect(withSystemDbAccessContext(() => insertDetection(fx.a, { severity: 'bogus' })))
      .rejects.toMatchObject({ cause: { code: '23514', constraint_name: 'edr_detections_severity_chk' } });
    await expect(withSystemDbAccessContext(() => insertAction(fx.a, { action: 'format_disk' })))
      .rejects.toMatchObject({ cause: { code: '23514', constraint_name: 'edr_actions_action_chk' } });
    await expect(withSystemDbAccessContext(() => insertEndpoint(fx.a, { health: 'bogus' })))
      .rejects.toMatchObject({ cause: { code: '23514', constraint_name: 'edr_endpoints_health_chk' } });
    await expect(withSystemDbAccessContext(() =>
      db.update(edrTenants).set({ mappingSource: 'auto_name' as never })
        .where(sql`${edrTenants.id} = ${fx.a.tenant.id}::uuid`)))
      .rejects.toMatchObject({ cause: { code: '23514', constraint_name: 'edr_tenants_mapping_source_chk' } });
  });

  runDb('link FKs and the tenant/endpoint/detection SET NULL edges null ONE column (confdelsetcols pinned)', async () => {
    const expected: Record<string, string> = {
      edr_endpoints_breeze_device_org_fk: 'breeze_device_id',
      edr_detections_breeze_device_org_fk: 'breeze_device_id',
      edr_actions_breeze_device_org_fk: 'breeze_device_id',
      edr_detections_tenant_connection_fk: 'tenant_id',
      edr_detections_tenant_org_fk: 'tenant_id',
      edr_detections_endpoint_org_fk: 'endpoint_id',
      edr_actions_tenant_connection_fk: 'tenant_id',
      edr_actions_tenant_org_fk: 'tenant_id',
      edr_actions_endpoint_org_fk: 'endpoint_id',
      edr_actions_detection_org_fk: 'detection_id',
    };
    const rows = await adminRows<{ conname: string; confdeltype: string; setcols: string[] | null }>(sql`
      SELECT conname, confdeltype,
             (SELECT array_agg(a.attname ORDER BY a.attname)
                FROM unnest(con.confdelsetcols) AS c(attnum)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = c.attnum) AS setcols
      FROM pg_constraint con
      WHERE conname = ANY(${sql.raw(`ARRAY[${Object.keys(expected).map((n) => `'${n}'`).join(',')}]::text[]`)})
    `);
    expect(rows.map((r) => r.conname).sort()).toEqual(Object.keys(expected).sort());
    for (const row of rows) {
      expect(row.confdeltype, `${row.conname} is not ON DELETE SET NULL`).toBe('n');
      expect(row.setcols, `${row.conname} must null only ${expected[row.conname]}`).toEqual([expected[row.conname]]);
    }
  });

  runDb('every composite FK onto an org_id column is DEFERRABLE INITIALLY IMMEDIATE', async () => {
    // Any FK from an edr_* table whose REFERENCED columns include an org_id
    // (or organizations(id, partner_id)) must be deferrable for the org-merge
    // contract, and not INITIALLY DEFERRED (that would hide forges until COMMIT).
    const rows = await adminRows<{ conname: string; condeferrable: boolean; condeferred: boolean; refcols: string[] }>(sql`
      SELECT con.conname, con.condeferrable, con.condeferred,
             (SELECT array_agg(a.attname::text ORDER BY a.attname)
                FROM unnest(con.confkey) AS k(attnum)
                JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS refcols
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE con.contype = 'f' AND rel.relname LIKE 'edr\\_%' AND array_length(con.conkey, 1) > 1
    `);
    const ontoOrg = rows.filter((r) =>
      r.refcols.includes('org_id') || r.conname.endsWith('_org_partner_fk'));
    const names = ontoOrg.map((r) => r.conname).sort();
    // Pin the set so a dropped constraint is noticed, not silently skipped.
    expect(names).toEqual([
      'edr_actions_breeze_device_org_fk',
      'edr_actions_detection_org_fk',
      'edr_actions_endpoint_org_fk',
      'edr_actions_org_partner_fk',
      'edr_actions_tenant_org_fk',
      'edr_detections_breeze_device_org_fk',
      'edr_detections_endpoint_org_fk',
      'edr_detections_org_partner_fk',
      'edr_detections_tenant_org_fk',
      'edr_endpoints_breeze_device_org_fk',
      'edr_endpoints_org_partner_fk',
      'edr_endpoints_tenant_org_fk',
      'edr_tenants_org_partner_fk',
    ]);
    for (const row of ontoOrg) {
      expect(row.condeferrable, `${row.conname} not deferrable`).toBe(true);
      expect(row.condeferred, `${row.conname} is INITIALLY DEFERRED`).toBe(false);
    }
  });

  runDb('the live detection identity index is partial on detached_at IS NULL and the FK targets exist', async () => {
    const rows = await adminRows<{ indexname: string; indexdef: string }>(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN (
        'edr_detections_live_vendor_uniq',
        'edr_endpoints_connection_breeze_device_uniq',
        'edr_connections_id_partner_uniq',
        'edr_tenants_id_connection_uniq',
        'edr_tenants_id_org_uniq',
        'edr_endpoints_id_org_uniq',
        'edr_detections_id_org_uniq'
      ) ORDER BY indexname
    `);
    expect(rows).toHaveLength(7);
    const live = rows.find((r) => r.indexname === 'edr_detections_live_vendor_uniq')!;
    expect(live.indexdef).toContain('UNIQUE');
    expect(live.indexdef).toMatch(/\(connection_id, vendor_kind, vendor_detection_id\) WHERE \(detached_at IS NULL\)/);
    const perConnection = rows.find((r) => r.indexname === 'edr_endpoints_connection_breeze_device_uniq')!;
    expect(perConnection.indexdef).toMatch(/\(connection_id, breeze_device_id\) WHERE/);
  });
});

describe('edr provider — cross-tenant isolation as breeze_app', () => {
  runDb('runs code-under-test as breeze_app without BYPASSRLS', async () => {
    const fx = await seedFixture();
    const rows = await withDbAccessContext(fx.a.partnerContext, () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
    expect((rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0])
      .toEqual({ who: 'breeze_app', rolbypassrls: false });
  });

  runDb('cross-partner forge of an edr_connections row -> 42501', async () => {
    const fx = await seedFixture();
    await expect(withDbAccessContext(fx.a.partnerContext, () =>
      db.insert(edrConnections).values({
        partnerId: fx.b.partner.id, provider: 'bitdefender', name: 'forged', credentialsEncrypted: 'enc:x',
      }))).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('edr_tenants row claiming partner B with a connection of partner A -> 42501 (policy re-check)', async () => {
    const fx = await seedFixture();
    // Partner B's own context passes breeze_has_partner_access(partner_id = B);
    // only the WITH CHECK re-check of the parent connection's partner refuses it.
    await expect(withDbAccessContext(fx.b.partnerContext, () =>
      db.insert(edrTenants).values({
        connectionId: fx.a.connection.id, partnerId: fx.b.partner.id,
        vendorTenantId: 'forged', vendorTenantName: 'forged',
      }))).rejects.toMatchObject({ cause: { code: '42501' } });
    // And from partner A's context claiming partner B outright.
    await expect(withDbAccessContext(fx.a.partnerContext, () =>
      db.insert(edrTenants).values({
        connectionId: fx.b.connection.id, partnerId: fx.b.partner.id,
        vendorTenantId: 'forged-2', vendorTenantName: 'forged',
      }))).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('a partner cannot re-point its own tenant onto another partner via UPDATE -> 42501', async () => {
    const fx = await seedFixture();
    await expect(withDbAccessContext(fx.a.partnerContext, () =>
      db.update(edrTenants).set({ partnerId: fx.b.partner.id })
        .where(sql`${edrTenants.id} = ${fx.a.tenant.id}::uuid`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('edr_tenants mapped to an org of another partner -> 23503', async () => {
    const fx = await seedFixture();
    await expect(withSystemDbAccessContext(() =>
      db.insert(edrTenants).values({
        connectionId: fx.a.connection.id, partnerId: fx.a.partner.id,
        vendorTenantId: 'cross', vendorTenantName: 'cross',
        orgId: fx.b.org.id, mappingSource: 'manual',
      }))).rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'edr_tenants_org_partner_fk' } });
  });

  runDb('a tombstoned detection/action (tenant_id NULL) claiming an org of another partner -> 23503', async () => {
    const fx = await seedFixture();
    const tombstone = { tenantId: null, detachedAt: new Date(), orgId: fx.b.org.id };
    await expect(withSystemDbAccessContext(() => insertDetection(fx.a, tombstone)))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'edr_detections_org_partner_fk' } });
    await expect(withSystemDbAccessContext(() => insertAction(fx.a, tombstone)))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'edr_actions_org_partner_fk' } });
  });

  runDb('a child row naming another partner than its connection -> 23503', async () => {
    const fx = await seedFixture();
    await expect(withSystemDbAccessContext(() =>
      insertEndpoint(fx.a, { partnerId: fx.b.partner.id, orgId: fx.b.org.id, tenantId: fx.b.tenant.id })))
      .rejects.toMatchObject({ cause: { code: '23503' } });
  });

  runDb('org token reads zero edr_connections / edr_tenants rows', async () => {
    const fx = await seedFixture();
    const conns = await withDbAccessContext(fx.a.orgContext, () =>
      db.select({ id: edrConnections.id }).from(edrConnections));
    expect(conns).toEqual([]);
    const tenants = await withDbAccessContext(fx.a.orgContext, () =>
      db.select({ id: edrTenants.id }).from(edrTenants));
    expect(tenants).toEqual([]);
    // Positive control: the partner token does see its own rows.
    const own = await withDbAccessContext(fx.a.partnerContext, () =>
      db.select({ id: edrTenants.id }).from(edrTenants)
        .where(sql`${edrTenants.id} = ${fx.a.tenant.id}::uuid`));
    expect(own).toHaveLength(1);
  });

  runDb('a partner token cannot read another partner\'s connection or tenant', async () => {
    const fx = await seedFixture();
    const conns = await withDbAccessContext(fx.a.partnerContext, () =>
      db.select({ id: edrConnections.id }).from(edrConnections)
        .where(sql`${edrConnections.id} = ${fx.b.connection.id}::uuid`));
    expect(conns).toEqual([]);
    const tenants = await withDbAccessContext(fx.a.partnerContext, () =>
      db.select({ id: edrTenants.id }).from(edrTenants)
        .where(sql`${edrTenants.id} = ${fx.b.tenant.id}::uuid`));
    expect(tenants).toEqual([]);
  });

  runDb('org token of org A reads none of org B\'s endpoints, detections, actions — and its own', async () => {
    const fx = await seedFixture();
    for (const t of [fx.a, fx.b]) {
      await withSystemDbAccessContext(async () => {
        const ep = await insertEndpoint(t);
        const det = await insertDetection(t, { endpointId: ep.id });
        await insertAction(t, { endpointId: ep.id, detectionId: det.id });
      });
    }
    const read = (ctx: DbAccessContext) => withDbAccessContext(ctx, async () => ({
      endpoints: await db.select({ orgId: edrEndpoints.orgId }).from(edrEndpoints),
      detections: await db.select({ orgId: edrDetections.orgId }).from(edrDetections),
      actions: await db.select({ orgId: edrActions.orgId }).from(edrActions),
    }));
    const seen = await read(fx.a.orgContext);
    for (const [table, rows] of Object.entries(seen)) {
      expect(rows, `${table}: org A token saw nothing of its own`).toHaveLength(1);
      expect(rows.every((r) => r.orgId === fx.a.org.id), `${table}: org A token saw org B rows`).toBe(true);
    }
  });

  runDb('an org token cannot write a row into another org -> 42501', async () => {
    const fx = await seedFixture();
    await expect(withDbAccessContext(fx.a.orgContext, () => insertEndpoint(fx.b)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(withDbAccessContext(fx.a.orgContext, () => insertDetection(fx.b)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(withDbAccessContext(fx.a.orgContext, () => insertAction(fx.b)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('edr_endpoints row whose tenant is mapped to another org -> 23503', async () => {
    // Same partner, two orgs: org coherence alone would accept it; the
    // (tenant_id, org_id) composite FK does not.
    const fx = await withSystemDbAccessContext(async () => {
      const a = await seedEdrTenant('same-partner-a');
      const other = await createOrganization({ partnerId: a.partner.id });
      return { a, other };
    });
    await expect(withSystemDbAccessContext(() => insertEndpoint(fx.a, { orgId: fx.other.id })))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'edr_endpoints_tenant_org_fk' } });
    await expect(withSystemDbAccessContext(() => insertDetection(fx.a, { orgId: fx.other.id })))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'edr_detections_tenant_org_fk' } });
  });

  runDb('a child row mixing a tenant of one connection with another connection -> 23503', async () => {
    // Two connections of ONE partner, both tenants mapped to the SAME org:
    // org coherence holds, only (tenant_id, connection_id) refuses the mix.
    const fx = await withSystemDbAccessContext(async () => {
      const a = await seedEdrTenant('two-conn');
      const [conn2] = await db.insert(edrConnections).values({
        partnerId: a.partner.id, provider: 'sophos', name: `Sophos ${randomUUID().slice(0, 6)}`,
        credentialsEncrypted: 'enc:test',
      }).returning({ id: edrConnections.id });
      return { a, conn2: conn2! };
    });
    await expect(withSystemDbAccessContext(() => insertEndpoint(fx.a, { connectionId: fx.conn2.id })))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'edr_endpoints_tenant_connection_fk' } });
  });

  runDb('link to a device of another org -> 23503 on all three link tables', async () => {
    const fx = await seedFixture();
    await expect(withSystemDbAccessContext(() => insertEndpoint(fx.a, { breezeDeviceId: fx.b.device.id })))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'edr_endpoints_breeze_device_org_fk' } });
    await expect(withSystemDbAccessContext(() => insertDetection(fx.a, { breezeDeviceId: fx.b.device.id })))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'edr_detections_breeze_device_org_fk' } });
    await expect(withSystemDbAccessContext(() => insertAction(fx.a, { breezeDeviceId: fx.b.device.id })))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'edr_actions_breeze_device_org_fk' } });
  });

  runDb('a device may be linked once per CONNECTION (23505), but by two connections', async () => {
    const fx = await withSystemDbAccessContext(async () => {
      const a = await seedEdrTenant('dup-link');
      const [conn2] = await db.insert(edrConnections).values({
        partnerId: a.partner.id, provider: 'sophos', name: `Sophos ${randomUUID().slice(0, 6)}`,
        credentialsEncrypted: 'enc:test',
      }).returning({ id: edrConnections.id });
      const [tenant2] = await db.insert(edrTenants).values({
        connectionId: conn2!.id, partnerId: a.partner.id, vendorTenantId: 'sophos-t',
        vendorTenantName: 'Sophos T', orgId: a.org.id, mappingSource: 'manual',
      }).returning({ id: edrTenants.id });
      return { a, conn2: conn2!, tenant2: tenant2! };
    });
    await withSystemDbAccessContext(() => insertEndpoint(fx.a, { breezeDeviceId: fx.a.device.id }));
    await expect(withSystemDbAccessContext(() => insertEndpoint(fx.a, { breezeDeviceId: fx.a.device.id })))
      .rejects.toMatchObject({ cause: { code: '23505', constraint_name: 'edr_endpoints_connection_breeze_device_uniq' } });
    // A second protection product on the same device is legitimate (spec §4.2).
    await withSystemDbAccessContext(() => insertEndpoint(fx.a, {
      connectionId: fx.conn2.id, tenantId: fx.tenant2.id, provider: 'sophos', breezeDeviceId: fx.a.device.id,
    }));
  });
});

describe('edr provider — lifecycle against real Postgres', () => {
  /** One endpoint + detection + action, all linked to the tenant's device. */
  async function seedLinkedRows(t: Tenant) {
    return withSystemDbAccessContext(async () => {
      const endpoint = await insertEndpoint(t, { breezeDeviceId: t.device.id, deviceMatchSource: 'auto_hostname' });
      const detection = await insertDetection(t, { endpointId: endpoint.id, breezeDeviceId: t.device.id });
      const action = await insertAction(t, {
        endpointId: endpoint.id, detectionId: detection.id, breezeDeviceId: t.device.id,
      });
      return { endpoint, detection, action };
    });
  }

  runDb('deleting a device clears ONLY breeze_device_id on all three tables', async () => {
    const fx = await seedFixture();
    const rows = await seedLinkedRows(fx.a);
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM devices WHERE id = ${fx.a.device.id}::uuid`));
    for (const [table, id] of [
      ['edr_endpoints', rows.endpoint.id],
      ['edr_detections', rows.detection.id],
      ['edr_actions', rows.action.id],
    ] as const) {
      const [after] = await adminRows<{ org_id: string; breeze_device_id: string | null; tenant_id: string | null }>(sql`
        SELECT org_id, breeze_device_id, tenant_id FROM ${sql.identifier(table)} WHERE id = ${id}::uuid
      `);
      expect(after, `${table}: the SET NULL removed the row`).toBeDefined();
      expect(after!.breeze_device_id, table).toBeNull();
      expect(after!.org_id, `${table}: org_id was nulled with the link`).toBe(fx.a.org.id);
      expect(after!.tenant_id, `${table}: tenant link lost`).toBe(fx.a.tenant.id);
    }
  });

  runDb('deleteDeviceCascade snapshots the device site onto its detections before the link is cleared (D14)', async () => {
    const fx = await seedFixture();
    const rows = await seedLinkedRows(fx.a);
    await withSystemDbAccessContext(() => db.transaction(async (tx) => {
      await deleteDeviceCascade(tx as unknown as DeviceDeletionTx, fx.a.device.id);
    }));
    const [det] = await adminRows<{ breeze_device_id: string | null; last_site_id: string | null; device_detached_at: Date | null }>(sql`
      SELECT breeze_device_id, last_site_id, device_detached_at FROM edr_detections WHERE id = ${rows.detection.id}::uuid
    `);
    expect(det!.breeze_device_id).toBeNull();
    expect(det!.last_site_id).toBe(fx.a.site.id);
    expect(det!.device_detached_at).not.toBeNull();
    const [ep] = await adminRows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM edr_endpoints WHERE id = ${rows.endpoint.id}::uuid AND breeze_device_id IS NULL
    `);
    expect(ep!.n, 'the endpoint row did not survive the device delete detached').toBe(1);
  });

  runDb('a device org flip fails on each EDR link FK unless detached first, and the detach keeps the rows', async () => {
    // Proves the premise behind the moveDeviceOrgInTransaction detach: the FKs
    // are checked at the END of the org flip, and nothing but an explicit
    // detach before it clears them. The mocked route test pins the ORDER.
    const fx = await withSystemDbAccessContext(async () => {
      const a = await seedEdrTenant('move-src');
      const target = await createOrganization({ partnerId: a.partner.id });
      const targetSite = await createSite({ orgId: target.id });
      return { a, target, targetSite: targetSite! };
    });
    const rows = await seedLinkedRows(fx.a);
    const flip = (tx: typeof db) => tx.execute(sql`
      UPDATE devices SET org_id = ${fx.target.id}::uuid, site_id = ${fx.targetSite.id}::uuid
      WHERE id = ${fx.a.device.id}::uuid`);
    const detach = {
      edr_endpoints: (tx: typeof db) => tx.execute(sql`UPDATE edr_endpoints
        SET breeze_device_id = NULL, device_match_source = NULL
        WHERE breeze_device_id = ${fx.a.device.id}::uuid AND org_id = ${fx.a.org.id}::uuid`),
      edr_detections: (tx: typeof db) => tx.execute(sql`UPDATE edr_detections
        SET breeze_device_id = NULL, device_detached_at = now(),
            last_site_id = (SELECT site_id FROM devices WHERE id = ${fx.a.device.id}::uuid)
        WHERE breeze_device_id = ${fx.a.device.id}::uuid AND org_id = ${fx.a.org.id}::uuid`),
      edr_actions: (tx: typeof db) => tx.execute(sql`UPDATE edr_actions
        SET breeze_device_id = NULL
        WHERE breeze_device_id = ${fx.a.device.id}::uuid AND org_id = ${fx.a.org.id}::uuid`),
    };

    // Negative controls: leave exactly one table linked -> its FK refuses the flip.
    for (const linked of Object.keys(detach) as Array<keyof typeof detach>) {
      await expect(admin().transaction(async (tx) => {
        for (const [table, run] of Object.entries(detach)) {
          if (table !== linked) await run(tx as unknown as typeof db);
        }
        await flip(tx as unknown as typeof db);
      })).rejects.toMatchObject({ cause: { code: '23503', constraint_name: `${linked}_breeze_device_org_fk` } });
    }

    await admin().transaction(async (tx) => {
      for (const run of Object.values(detach)) await run(tx as unknown as typeof db);
      await flip(tx as unknown as typeof db);
    });
    const [ep] = await adminRows<Row>(sql`
      SELECT org_id, breeze_device_id, device_match_source FROM edr_endpoints WHERE id = ${rows.endpoint.id}::uuid`);
    expect(ep).toEqual({ org_id: fx.a.org.id, breeze_device_id: null, device_match_source: null });
    const [det] = await adminRows<Row>(sql`
      SELECT org_id, breeze_device_id, last_site_id FROM edr_detections WHERE id = ${rows.detection.id}::uuid`);
    // Not re-homed, and the SOURCE site is what was snapshotted (D14).
    expect(det).toEqual({ org_id: fx.a.org.id, breeze_device_id: null, last_site_id: fx.a.site.id });
  });

  runDb('deleting a connection cascades tenants, endpoints, detections and actions', async () => {
    const fx = await seedFixture();
    await seedLinkedRows(fx.a);
    await withSystemDbAccessContext(() =>
      db.execute(sql`DELETE FROM edr_connections WHERE id = ${fx.a.connection.id}::uuid`));
    for (const table of ORG_ID_TABLES) {
      const [count] = await adminRows<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE connection_id = ${fx.a.connection.id}::uuid`);
      expect(count!.n, `${table} survived the connection delete`).toBe(0);
    }
  });

  runDb('cascadeDeleteOrg erases endpoints, detections, actions and tenant rows of the org only', async () => {
    const fx = await seedFixture();
    await seedLinkedRows(fx.a);
    await seedLinkedRows(fx.b);

    await cascadeDeleteOrg(fx.a.org.id, fx.a.user.id, fx.a.user.email);

    for (const table of ORG_ID_TABLES) {
      const [gone] = await adminRows<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${fx.a.org.id}::uuid`);
      expect(gone!.n, `${table} left rows under the erased org`).toBe(0);
      const [kept] = await adminRows<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${fx.b.org.id}::uuid`);
      expect(kept!.n, `${table} lost the OTHER org's rows`).toBe(1);
    }
    // The partner-axis connection belongs to the MSP, not the customer.
    const [connection] = await adminRows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM edr_connections WHERE id = ${fx.a.connection.id}::uuid`);
    expect(connection!.n).toBe(1);
  });

  runDb('executeOrgMerge repoints all four org tables (merge contract)', async () => {
    const prior = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
    try {
      const fx = await withSystemDbAccessContext(async () => {
        const loser = await seedEdrTenant('merge-loser');
        const survivor = await createOrganization({ partnerId: loser.partner.id });
        const actor = await createUser({
          partnerId: loser.partner.id,
          email: `edr-provider-merge-${randomUUID()}@example.com`,
        });
        return { loser, survivor, actor };
      });
      const rows = await seedLinkedRows(fx.loser);
      // A D13 tombstone travels too.
      await withSystemDbAccessContext(() => insertDetection(fx.loser, { tenantId: null, detachedAt: new Date() }));

      const result = await executeOrgMerge({
        loserOrgId: fx.loser.org.id,
        survivorOrgId: fx.survivor.id,
        partnerId: fx.loser.partner.id,
        performedBy: fx.actor.id,
        performedByEmail: fx.actor.email,
      });
      expect(result.tables.edr_tenants).toEqual({ moved: 1, dropped: 0 });
      expect(result.tables.edr_endpoints).toEqual({ moved: 1, dropped: 0 });
      expect(result.tables.edr_detections).toEqual({ moved: 2, dropped: 0 });
      expect(result.tables.edr_actions).toEqual({ moved: 1, dropped: 0 });

      const [moved] = await adminRows<{ org_id: string; breeze_device_id: string | null; tenant_id: string }>(sql`
        SELECT org_id, breeze_device_id, tenant_id FROM edr_detections WHERE id = ${rows.detection.id}::uuid`);
      expect(moved!.org_id).toBe(fx.survivor.id);
      // The device and tenant moved too, so the composite FKs still hold.
      expect(moved!.breeze_device_id).toBe(fx.loser.device.id);
      expect(moved!.tenant_id).toBe(fx.loser.tenant.id);
    } finally {
      if (prior === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
      else process.env.ORG_MERGE_FENCE_DRAIN_MS = prior;
    }
  });
});

describe('edr provider — D13 tombstones (plan index correction 1)', () => {
  runDb('a tombstone may not keep its tenant (23514)', async () => {
    const fx = await seedFixture();
    await expect(withSystemDbAccessContext(() => insertDetection(fx.a, { detachedAt: new Date() })))
      .rejects.toMatchObject({ cause: { code: '23514', constraint_name: 'edr_detections_tombstone_tenant_chk' } });
    await expect(withSystemDbAccessContext(() => insertAction(fx.a, { detachedAt: new Date() })))
      .rejects.toMatchObject({ cause: { code: '23514', constraint_name: 'edr_actions_tombstone_tenant_chk' } });
  });

  runDb('detached detection does not hold the live unique key (correction 1b)', async () => {
    const fx = await seedFixture();
    const vendorDetectionId = `det-${randomUUID()}`;
    const d1 = await withSystemDbAccessContext(() => insertDetection(fx.a, { vendorDetectionId }));
    // A second LIVE row with the same identity is refused.
    await expect(withSystemDbAccessContext(() => insertDetection(fx.a, { vendorDetectionId })))
      .rejects.toMatchObject({ cause: { code: '23505', constraint_name: 'edr_detections_live_vendor_uniq' } });
    // Tombstone D1, then the same identity can live again.
    await withSystemDbAccessContext(() => db.update(edrDetections)
      .set({ detachedAt: new Date(), tenantId: null })
      .where(sql`${edrDetections.id} = ${d1.id}::uuid`));
    await withSystemDbAccessContext(() => insertDetection(fx.a, { vendorDetectionId }));
    await expect(withSystemDbAccessContext(() => insertDetection(fx.a, { vendorDetectionId })))
      .rejects.toMatchObject({ cause: { code: '23505', constraint_name: 'edr_detections_live_vendor_uniq' } });
  });

  runDb('a remap is blocked while live children point at the tenant, and succeeds once they are tombstoned (correction 1a)', async () => {
    const fx = await withSystemDbAccessContext(async () => {
      const a = await seedEdrTenant('remap');
      const target = await createOrganization({ partnerId: a.partner.id });
      return { a, target };
    });
    const vendorDetectionId = `det-${randomUUID()}`;
    const detection = await withSystemDbAccessContext(() => insertDetection(fx.a, { vendorDetectionId }));
    const action = await withSystemDbAccessContext(() => insertAction(fx.a, { detectionId: detection.id }));
    const remap = () => withSystemDbAccessContext(() => db.update(edrTenants)
      .set({ orgId: fx.target.id })
      .where(sql`${edrTenants.id} = ${fx.a.tenant.id}::uuid`));

    // Negative control: a live child still names (tenant_id, old_org).
    await expect(remap()).rejects.toMatchObject({ cause: { code: '23503' } });

    // W01b's remap: tombstone the old org's history, then move the mapping.
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`UPDATE edr_detections SET detached_at = now(), tenant_id = NULL
        WHERE tenant_id = ${fx.a.tenant.id}::uuid`);
      await db.execute(sql`UPDATE edr_actions SET detached_at = now(), tenant_id = NULL
        WHERE tenant_id = ${fx.a.tenant.id}::uuid`);
    });
    await remap();

    // The re-synced vendor detection lands as a NEW row under the new org; the
    // tombstone stays under the old org.
    const fresh = await withSystemDbAccessContext(() => db.insert(edrDetections).values({
      connectionId: fx.a.connection.id, partnerId: fx.a.partner.id, orgId: fx.target.id,
      tenantId: fx.a.tenant.id, provider: 'bitdefender', vendorDetectionId, vendorKind: 'incident',
    }).returning({ id: edrDetections.id }));
    expect(fresh[0]!.id).not.toBe(detection.id);
    const rows = await adminRows<{ id: string; org_id: string; detached: boolean }>(sql`
      SELECT id, org_id, detached_at IS NOT NULL AS detached FROM edr_detections
      WHERE vendor_detection_id = ${vendorDetectionId} ORDER BY detached DESC`);
    expect(rows).toEqual([
      { id: detection.id, org_id: fx.a.org.id, detached: true },
      { id: fresh[0]!.id, org_id: fx.target.id, detached: false },
    ]);
    const [act] = await adminRows<Row>(sql`
      SELECT org_id, tenant_id, detection_id FROM edr_actions WHERE id = ${action.id}::uuid`);
    expect(act).toEqual({ org_id: fx.a.org.id, tenant_id: null, detection_id: detection.id });
  });
});
