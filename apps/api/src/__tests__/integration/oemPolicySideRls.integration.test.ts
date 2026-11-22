/**
 * Real-PostgreSQL contract for device_oem_policy_side (#11242): shape-1 RLS,
 * the deferrable composite (device_id, org_id) FK, one row per device (the PK
 * is device_id), the CHECK sets, partner-scope visibility, device delete, and
 * the device org move and org merge paths.
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
import { devices, deviceOemPolicySide } from '../../db/schema';
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

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
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

async function insertSideAs(contextOrgId: string, row: { orgId: string; deviceId: string }): Promise<string> {
  const inserted = await withDbAccessContext(orgContext(contextOrgId), () => db.execute(sql`
    INSERT INTO device_oem_policy_side (org_id, device_id, gates_fingerprint)
    VALUES (${row.orgId}::uuid, ${row.deviceId}::uuid, 'fp')
    RETURNING device_id
  `)) as unknown as Array<{ device_id: string }>;
  return inserted[0]!.device_id;
}

async function causeOf(work: () => Promise<unknown>): Promise<{ code?: string } | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return (error as { cause?: { code?: string } }).cause ?? (error as { code?: string });
  }
}

describe('device_oem_policy_side tenancy contract', () => {
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
      WHERE n.nspname = 'public' AND c.relname = 'device_oem_policy_side'
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
      WHERE conname = 'device_oem_policy_side_device_org_fk'
    `) as unknown as Array<{ condeferrable: boolean; condeferred: boolean; confupdtype: string; confdeltype: string }>;
    expect(rows).toEqual([{ condeferrable: true, condeferred: false, confupdtype: 'c', confdeltype: 'c' }]);
  });

  runDb('accepts an own-org insert (positive control for the rejections below)', async () => {
    const { orgA, deviceA } = await seedFixture();
    const id = await insertSideAs(orgA.id, { orgId: orgA.id, deviceId: deviceA });
    expect(id).toBe(deviceA);
    const visible = await withDbAccessContext(orgContext(orgA.id), () => db.execute(sql`
      SELECT device_id, gates_fingerprint, link_enabled FROM device_oem_policy_side WHERE device_id = ${id}::uuid
    `));
    expect(visible).toEqual([{ device_id: deviceA, gates_fingerprint: 'fp', link_enabled: false }]);
  });

  runDb('rejects a cross-org insert as breeze_app with 42501', async () => {
    const { orgA, orgB, deviceB } = await seedFixture();
    const forged = await causeOf(() => insertSideAs(orgA.id, { orgId: orgB.id, deviceId: deviceB }));
    expect(forged?.code).toBe('42501');
  });

  runDb('rejects a composite-FK tenant mismatch with 23503', async () => {
    const { orgA, deviceB } = await seedFixture();
    const mismatch = await causeOf(() => insertSideAs(orgA.id, { orgId: orgA.id, deviceId: deviceB }));
    expect(mismatch?.code).toBe('23503');
  });

  runDb("hides another org's row from SELECT, UPDATE and DELETE", async () => {
    const { orgA, orgB, deviceB } = await seedFixture();
    const foreignId = await insertSideAs(orgB.id, { orgId: orgB.id, deviceId: deviceB });

    const seen = await withDbAccessContext(orgContext(orgA.id), () => db.execute(sql`
      SELECT device_id FROM device_oem_policy_side WHERE device_id = ${foreignId}::uuid
    `));
    expect(seen).toHaveLength(0);

    const updated = await withDbAccessContext(orgContext(orgA.id), () => db.execute(sql`
      UPDATE device_oem_policy_side SET link_enabled = true WHERE device_id = ${foreignId}::uuid RETURNING device_id
    `));
    expect(updated).toHaveLength(0);

    const deleted = await withDbAccessContext(orgContext(orgA.id), () => db.execute(sql`
      DELETE FROM device_oem_policy_side WHERE device_id = ${foreignId}::uuid RETURNING device_id
    `));
    expect(deleted).toHaveLength(0);

    const still = await getTestDb().execute(sql`
      SELECT link_enabled FROM device_oem_policy_side WHERE device_id = ${foreignId}::uuid
    `);
    expect(still).toEqual([{ link_enabled: false }]);
  });

  runDb("a partner-scope caller sees its orgs' rows and not another partner's", async () => {
    const { partnerA, orgA, orgB, deviceA, deviceB } = await seedFixture();
    await insertSideAs(orgA.id, { orgId: orgA.id, deviceId: deviceA });
    await insertSideAs(orgB.id, { orgId: orgB.id, deviceId: deviceB });

    const seen = await withDbAccessContext(partnerContext(partnerA.id, [orgA.id]), () => db.execute(sql`
      SELECT device_id FROM device_oem_policy_side
      WHERE device_id IN (${deviceA}::uuid, ${deviceB}::uuid)
    `)) as unknown as Array<{ device_id: string }>;
    expect(seen.map((r) => r.device_id)).toEqual([deviceA]);
  });

  runDb('allows one row per device', async () => {
    const { orgA, deviceA } = await seedFixture();
    await insertSideAs(orgA.id, { orgId: orgA.id, deviceId: deviceA });
    const dup = await causeOf(() => insertSideAs(orgA.id, { orgId: orgA.id, deviceId: deviceA }));
    expect(dup?.code).toBe('23505');
  });

  runDb('refuses values outside the lane and reboot-mode sets', async () => {
    const { orgA, deviceA } = await seedFixture();
    const id = await insertSideAs(orgA.id, { orgId: orgA.id, deviceId: deviceA });
    for (const assign of [
      sql`offered_lane = 'acme'`,
      sql`reboot_mode = 'sometimes'`,
    ]) {
      const bad = await causeOf(() => withDbAccessContext(orgContext(orgA.id), () => db.execute(sql`
        UPDATE device_oem_policy_side SET ${assign} WHERE device_id = ${id}::uuid
      `)));
      expect(bad?.code).toBe('23514');
    }
  });

  runDb('deleting the device removes its row', async () => {
    const { orgA, deviceA } = await seedFixture();
    await insertSideAs(orgA.id, { orgId: orgA.id, deviceId: deviceA });

    await getTestDb().delete(devices).where(eq(devices.id, deviceA));

    const rows = await getTestDb().select({ deviceId: deviceOemPolicySide.deviceId })
      .from(deviceOemPolicySide).where(eq(deviceOemPolicySide.deviceId, deviceA));
    expect(rows).toHaveLength(0);
  });

  runDb('a device org move restamps the row through the FK', async () => {
    const { orgA, deviceA, partnerA } = await seedFixture();
    const orgTarget = await createOrganization({ partnerId: partnerA.id });
    const siteTarget = await createSite({ orgId: orgTarget.id });
    const id = await insertSideAs(orgA.id, { orgId: orgA.id, deviceId: deviceA });

    await getTestDb().update(devices).set({ orgId: orgTarget.id, siteId: siteTarget.id }).where(eq(devices.id, deviceA));

    const [row] = await getTestDb().select({ orgId: deviceOemPolicySide.orgId })
      .from(deviceOemPolicySide).where(eq(deviceOemPolicySide.deviceId, id));
    expect(row?.orgId).toBe(orgTarget.id);
  });

  runDb('an org merge succeeds with constraints deferred and repoints the row', async () => {
    const { orgA, deviceA, partnerA } = await seedFixture();
    const survivor = await createOrganization({ partnerId: partnerA.id });
    const actor = await createUser({ partnerId: partnerA.id, orgId: survivor.id });
    const id = await insertSideAs(orgA.id, { orgId: orgA.id, deviceId: deviceA });

    vi.stubEnv('ORG_MERGE_FENCE_DRAIN_MS', '0');
    await executeOrgMerge({
      loserOrgId: orgA.id,
      survivorOrgId: survivor.id,
      partnerId: partnerA.id,
      performedBy: actor!.id,
      performedByEmail: actor!.email,
    });

    const [row] = await getTestDb().select({ orgId: deviceOemPolicySide.orgId })
      .from(deviceOemPolicySide).where(eq(deviceOemPolicySide.deviceId, id));
    expect(row?.orgId).toBe(survivor.id);
  });
});
