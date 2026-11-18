/**
 * Real-PostgreSQL contract for device_oem_update_status (#11068, W03 of
 * #11065): shape-1 RLS, the deferrable composite (device_id, org_id) FK, one
 * row per device, and the device org move and org merge paths.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { devices, deviceOemUpdateStatus } from '../../db/schema';
import { executeOrgMerge } from '../../services/orgMerge';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

async function seedDevice(orgId: string, label: string): Promise<string> {
  const site = await createSite({ orgId });
  const [device] = await getTestDb().insert(devices).values({
    orgId,
    siteId: site.id,
    agentId: `oem-${label}-${randomUUID()}`,
    hostname: `oem-${label}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'amd64',
    agentVersion: '0.127.0',
    status: 'online',
  }).returning({ id: devices.id });
  return device!.id;
}

async function seedFixture() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const orgB = await createOrganization({ partnerId: partnerB.id });
  return {
    partnerA,
    orgA,
    orgB,
    deviceA: await seedDevice(orgA.id, 'a'),
    deviceB: await seedDevice(orgB.id, 'b'),
  };
}

async function insertStatusAs(contextOrgId: string, row: { orgId: string; deviceId: string }): Promise<string> {
  const inserted = await withDbAccessContext(orgContext(contextOrgId), () => db.execute(sql`
    INSERT INTO device_oem_update_status (org_id, device_id, applicability, lane)
    VALUES (${row.orgId}::uuid, ${row.deviceId}::uuid, 'applicable', 'dell')
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return inserted[0]!.id;
}

async function causeOf(work: () => Promise<unknown>): Promise<{ code?: string } | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return (error as { cause?: { code?: string } }).cause ?? (error as { code?: string });
  }
}

describe('device_oem_update_status tenancy contract', () => {
  afterEach(() => vi.unstubAllEnvs());

  runDb('runs as a non-bypass app role against forced four-command direct-org RLS', async () => {
    // Without this, every RLS assertion below could pass vacuously on a
    // superuser / BYPASSRLS connection.
    const role = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT current_user AS who, rolsuper, rolbypassrls
      FROM pg_roles WHERE rolname = current_user
    `)) as unknown as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
    expect(role[0]).toMatchObject({ who: 'breeze_app', rolsuper: false, rolbypassrls: false });

    const tables = await getTestDb().execute(sql`
      SELECT c.relrowsecurity AS rls_on, c.relforcerowsecurity AS rls_forced,
             ARRAY_AGG(DISTINCT p.cmd ORDER BY p.cmd) AS commands
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_policies p ON p.schemaname = n.nspname AND p.tablename = c.relname
      WHERE n.nspname = 'public' AND c.relname = 'device_oem_update_status'
      GROUP BY c.relrowsecurity, c.relforcerowsecurity
    `) as unknown as Array<{ rls_on: boolean; rls_forced: boolean; commands: string[] }>;
    expect(tables).toEqual([{
      rls_on: true,
      rls_forced: true,
      commands: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
    }]);
  });

  runDb('declares the composite device FK DEFERRABLE INITIALLY IMMEDIATE with ON UPDATE/DELETE CASCADE', async () => {
    const rows = await getTestDb().execute(sql`
      SELECT condeferrable, condeferred, confupdtype, confdeltype
      FROM pg_constraint
      WHERE conname = 'device_oem_update_status_device_org_fk'
    `) as unknown as Array<{ condeferrable: boolean; condeferred: boolean; confupdtype: string; confdeltype: string }>;
    expect(rows).toEqual([{ condeferrable: true, condeferred: false, confupdtype: 'c', confdeltype: 'c' }]);
  });

  runDb('accepts an own-org insert (positive control for the rejections below)', async () => {
    const { orgA, deviceA } = await seedFixture();
    const id = await insertStatusAs(orgA.id, { orgId: orgA.id, deviceId: deviceA });
    const visible = await withDbAccessContext(orgContext(orgA.id), () => db.execute(sql`
      SELECT id, takeover_state, attempts FROM device_oem_update_status WHERE id = ${id}::uuid
    `));
    expect(visible).toEqual([{ id, takeover_state: 'none', attempts: 0 }]);
  });

  runDb('rejects a cross-org insert as breeze_app with 42501', async () => {
    const { orgA, orgB, deviceB } = await seedFixture();
    const forged = await causeOf(() => insertStatusAs(orgA.id, { orgId: orgB.id, deviceId: deviceB }));
    expect(forged?.code).toBe('42501');
  });

  runDb('rejects a composite-FK tenant mismatch with 23503', async () => {
    const { orgA, deviceB } = await seedFixture();
    const mismatch = await causeOf(() => insertStatusAs(orgA.id, { orgId: orgA.id, deviceId: deviceB }));
    expect(mismatch?.code).toBe('23503');
  });

  runDb("hides another org's row from SELECT, UPDATE and DELETE", async () => {
    const { orgA, orgB, deviceB } = await seedFixture();
    const foreignId = await insertStatusAs(orgB.id, { orgId: orgB.id, deviceId: deviceB });

    const seen = await withDbAccessContext(orgContext(orgA.id), () => db.execute(sql`
      SELECT id FROM device_oem_update_status WHERE id = ${foreignId}::uuid
    `));
    expect(seen).toHaveLength(0);

    const updated = await withDbAccessContext(orgContext(orgA.id), () => db.execute(sql`
      UPDATE device_oem_update_status SET attempts = 9 WHERE id = ${foreignId}::uuid RETURNING id
    `));
    expect(updated).toHaveLength(0);

    const deleted = await withDbAccessContext(orgContext(orgA.id), () => db.execute(sql`
      DELETE FROM device_oem_update_status WHERE id = ${foreignId}::uuid RETURNING id
    `));
    expect(deleted).toHaveLength(0);

    const still = await getTestDb().execute(sql`
      SELECT attempts FROM device_oem_update_status WHERE id = ${foreignId}::uuid
    `);
    expect(still).toEqual([{ attempts: 0 }]);
  });

  runDb('allows one row per device', async () => {
    const { orgA, deviceA } = await seedFixture();
    await insertStatusAs(orgA.id, { orgId: orgA.id, deviceId: deviceA });
    const dup = await causeOf(() => insertStatusAs(orgA.id, { orgId: orgA.id, deviceId: deviceA }));
    expect(dup?.code).toBe('23505');
  });

  runDb('refuses values outside the lane, applicability, outcome and takeover sets', async () => {
    const { orgA, deviceA } = await seedFixture();
    const id = await insertStatusAs(orgA.id, { orgId: orgA.id, deviceId: deviceA });
    for (const assign of [
      sql`lane = 'acme'`,
      sql`applicability = 'maybe'`,
      sql`last_outcome = 'great'`,
      sql`takeover_state = 'mine'`,
    ]) {
      const bad = await causeOf(() => withDbAccessContext(orgContext(orgA.id), () => db.execute(sql`
        UPDATE device_oem_update_status SET ${assign} WHERE id = ${id}::uuid
      `)));
      expect(bad?.code).toBe('23514');
    }
  });

  runDb('a device org move restamps the row through the FK', async () => {
    const { orgA, deviceA, partnerA } = await seedFixture();
    const orgTarget = await createOrganization({ partnerId: partnerA.id });
    const siteTarget = await createSite({ orgId: orgTarget.id });
    const id = await insertStatusAs(orgA.id, { orgId: orgA.id, deviceId: deviceA });

    await getTestDb().update(devices).set({ orgId: orgTarget.id, siteId: siteTarget.id }).where(eq(devices.id, deviceA));

    const [row] = await getTestDb().select({ orgId: deviceOemUpdateStatus.orgId })
      .from(deviceOemUpdateStatus).where(eq(deviceOemUpdateStatus.id, id));
    expect(row?.orgId).toBe(orgTarget.id);
  });

  runDb('an org merge succeeds with constraints deferred and repoints the row', async () => {
    const { orgA, deviceA, partnerA } = await seedFixture();
    const survivor = await createOrganization({ partnerId: partnerA.id });
    const actor = await createUser({ partnerId: partnerA.id, orgId: survivor.id });
    const id = await insertStatusAs(orgA.id, { orgId: orgA.id, deviceId: deviceA });

    vi.stubEnv('ORG_MERGE_FENCE_DRAIN_MS', '0');
    await executeOrgMerge({
      loserOrgId: orgA.id,
      survivorOrgId: survivor.id,
      partnerId: partnerA.id,
      performedBy: actor!.id,
      performedByEmail: actor!.email,
    });

    const [row] = await getTestDb().select({ orgId: deviceOemUpdateStatus.orgId })
      .from(deviceOemUpdateStatus).where(eq(deviceOemUpdateStatus.id, id));
    expect(row?.orgId).toBe(survivor.id);
  });
});
