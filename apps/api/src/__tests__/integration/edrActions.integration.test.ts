/**
 * EDR W03 (#8167 / epic #8164) — response actions against real Postgres.
 * Migration: 2026-12-27-130000-edr-actions.sql.
 *
 * Covers the in-flight uniqueness index (one queued/submitted row per target +
 * action), migration replay, and (from A13) cross-tenant insert refusal,
 * concurrent dispatch, tombstoned detections, org erasure and export.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  devices,
  edrActions,
  edrConnections,
  edrEndpoints,
  edrTenants,
} from '../../db/schema';
import { pgErrorCode } from '../../routes/edr/access';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MIGRATION = new URL('../../../migrations/2026-12-27-130000-edr-actions.sql', import.meta.url);

type Row = Record<string, unknown>;
const admin = () => getTestDb() as typeof db;

async function seedEdrTenant(label: string) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `edr-actions-${label}-${randomUUID()}@example.com`,
  });
  const [device] = await admin().insert(devices).values({
    orgId: org.id,
    siteId: site!.id,
    agentId: randomUUID(),
    hostname: `edr-act-${label}-${randomUUID().slice(0, 8)}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'online',
  }).returning({ id: devices.id });

  return withSystemDbAccessContext(async () => {
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
    const [endpoint] = await db.insert(edrEndpoints).values({
      connectionId: connection!.id,
      partnerId: partner.id,
      orgId: org.id,
      tenantId: tenant!.id,
      provider: 'bitdefender',
      vendorEndpointId: `ep-${randomUUID().slice(0, 8)}`,
      hostname: 'WS-01',
      breezeDeviceId: device!.id,
    }).returning({ id: edrEndpoints.id });
    return {
      partner, org, site: site!, user, device: device!,
      connection: connection!, tenant: tenant!, endpoint: endpoint!,
    };
  });
}
type Tenant = Awaited<ReturnType<typeof seedEdrTenant>>;

function actionValues(t: Tenant, over: Row = {}) {
  return {
    connectionId: t.connection.id,
    partnerId: t.partner.id,
    orgId: t.org.id,
    tenantId: t.tenant.id,
    endpointId: t.endpoint.id,
    breezeDeviceId: t.device.id,
    provider: 'bitdefender',
    action: 'isolate',
    requestedVia: 'ui',
    requestedBy: t.user.id,
    ...over,
  } as typeof edrActions.$inferInsert;
}

async function insertActionAsSystem(t: Tenant, over: Row = {}) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.insert(edrActions).values(actionValues(t, over)).returning({ id: edrActions.id });
    return row!;
  });
}

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return pgErrorCode(err);
  }
}

describe('edr actions — migration (real PostgreSQL)', () => {
  runDb('migration replays idempotently on the live schema', async () => {
    const migration = readFileSync(MIGRATION, 'utf8');
    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql.raw(migration));
      await tx.execute(sql.raw(migration));
      const cols = Array.from(await tx.execute(sql.raw(`
        SELECT table_name, column_name, is_nullable, column_default
          FROM information_schema.columns
         WHERE (table_name = 'edr_connections' AND column_name = 'actions_enabled')
            OR (table_name = 'edr_tenants' AND column_name IN ('unsupported_actions', 'unsupported_actions_at'))
         ORDER BY table_name, column_name`))) as Row[];
      expect(cols.map((c) => `${c.table_name}.${c.column_name}:${c.is_nullable}`)).toEqual([
        'edr_connections.actions_enabled:NO',
        'edr_tenants.unsupported_actions:NO',
        'edr_tenants.unsupported_actions_at:YES',
      ]);
      const idx = Array.from(await tx.execute(sql.raw(`
        SELECT indexname, indexdef FROM pg_indexes
         WHERE tablename = 'edr_actions' AND indexname LIKE 'edr_actions_inflight_%' ORDER BY indexname`))) as Row[];
      expect(idx.map((i) => i.indexname)).toEqual([
        'edr_actions_inflight_detection_uniq',
        'edr_actions_inflight_endpoint_uniq',
      ]);
      for (const i of idx) expect(String(i.indexdef)).toMatch(/UNIQUE INDEX[\s\S]*WHERE/);
      // Roll back the replay so nothing else observes it (it is a no-op, but keep the test inert).
      tx.rollback();
    }).catch((err) => {
      if (!(err instanceof Error) || !/rollback/i.test(err.message)) throw err;
    });
  });

  runDb('new connections default actions OFF; new tenants carry no denials', async () => {
    const t = await seedEdrTenant('defaults');
    const [row] = Array.from(await admin().execute(sql`
      SELECT c.actions_enabled, t.unsupported_actions, t.unsupported_actions_at
        FROM edr_connections c JOIN edr_tenants t ON t.connection_id = c.id
       WHERE c.id = ${t.connection.id}`)) as Row[];
    expect(row).toMatchObject({ actions_enabled: false, unsupported_actions_at: null });
    expect(row!.unsupported_actions).toEqual([]);
  });

  runDb('a second in-flight row for the same (endpoint, action) is a 23505; a settled first row frees the slot', async () => {
    const t = await seedEdrTenant('inflight');
    const first = await insertActionAsSystem(t, { status: 'queued' });
    expect(await codeOf(insertActionAsSystem(t, { status: 'queued' }))).toBe('23505');
    expect(await codeOf(insertActionAsSystem(t, { status: 'submitted' }))).toBe('23505');
    // A different action on the same endpoint is independent.
    expect(await codeOf(insertActionAsSystem(t, { action: 'scan' }))).toBeNull();

    await withSystemDbAccessContext(() =>
      db.execute(sql`UPDATE edr_actions SET status = 'failed' WHERE id = ${first.id}`));
    expect(await codeOf(insertActionAsSystem(t, { status: 'queued' }))).toBeNull();
    // Settled rows never collide with each other.
    expect(await codeOf(insertActionAsSystem(t, { status: 'succeeded' }))).toBeNull();
    expect(await codeOf(insertActionAsSystem(t, { status: 'succeeded' }))).toBeNull();
  });
});
