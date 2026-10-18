/**
 * Real-PostgreSQL contract for device_restore_point_attempts (#4755, W04 of
 * #4751): shape-1 RLS, the deferrable composite (device_id, org_id) FK, the
 * request_id idempotency key, and the device delete / org-move cascades.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { devices } from '../../db/schema';
import {
  deploymentResultRestorePointSql,
  scriptExecutionRestorePointSql,
} from '../../services/restorePointInline';
import { createOrganization, createPartner, createSite } from './db-utils';
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

async function seedFixture() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const orgB = await createOrganization({ partnerId: partnerB.id });
  const siteA = await createSite({ orgId: orgA.id });
  const siteB = await createSite({ orgId: orgB.id });
  const [deviceA, deviceB] = await getTestDb().insert(devices).values([
    {
      orgId: orgA.id,
      siteId: siteA.id,
      agentId: `rp-a-${randomUUID()}`,
      hostname: 'rp-a',
      osType: 'windows',
      osVersion: '11',
      architecture: 'amd64',
      agentVersion: '0.99.0',
      status: 'online',
    },
    {
      orgId: orgB.id,
      siteId: siteB.id,
      agentId: `rp-b-${randomUUID()}`,
      hostname: 'rp-b',
      osType: 'windows',
      osVersion: '11',
      architecture: 'amd64',
      agentVersion: '0.99.0',
      status: 'online',
    },
  ]).returning({ id: devices.id, orgId: devices.orgId });
  return { orgA, orgB, siteA, siteB, deviceA: deviceA!, deviceB: deviceB! };
}

/** Insert one 'requested' attempt as breeze_app under the given org's context. */
async function insertAttemptAs(
  contextOrgId: string,
  row: { orgId: string; deviceId: string; requestId?: string; trigger?: string; status?: string },
): Promise<string> {
  const requestId = row.requestId ?? randomUUID();
  const inserted = await withDbAccessContext(orgContext(contextOrgId), () => db.execute(sql`
    INSERT INTO device_restore_point_attempts (request_id, org_id, device_id, trigger, status)
    VALUES (
      ${requestId}::uuid, ${row.orgId}::uuid, ${row.deviceId}::uuid,
      ${row.trigger ?? 'script'}, ${row.status ?? 'requested'}
    )
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return inserted[0]!.id;
}

async function causeOf(work: () => Promise<unknown>): Promise<{ code?: string; message?: string } | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return (error as { cause?: { code?: string; message?: string } }).cause
      ?? (error as { code?: string; message?: string });
  }
}

describe('device_restore_point_attempts tenancy contract', () => {
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
      WHERE n.nspname = 'public' AND c.relname = 'device_restore_point_attempts'
      GROUP BY c.relrowsecurity, c.relforcerowsecurity
    `) as unknown as Array<{ rls_on: boolean; rls_forced: boolean; commands: string[] }>;
    expect(tables).toHaveLength(1);
    expect(tables[0]).toEqual({
      rls_on: true,
      rls_forced: true,
      commands: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
    });
  });

  runDb('declares the composite device FK DEFERRABLE INITIALLY IMMEDIATE with ON UPDATE/DELETE CASCADE', async () => {
    // Org merge runs SET CONSTRAINTS ALL DEFERRED; a non-deferrable composite
    // FK onto devices(id, org_id) aborts the merge with 23503.
    const rows = await getTestDb().execute(sql`
      SELECT condeferrable, condeferred, confupdtype, confdeltype
      FROM pg_constraint
      WHERE conname = 'device_restore_point_attempts_device_org_fk'
    `) as unknown as Array<{ condeferrable: boolean; condeferred: boolean; confupdtype: string; confdeltype: string }>;
    expect(rows).toEqual([{ condeferrable: true, condeferred: false, confupdtype: 'c', confdeltype: 'c' }]);
  });

  runDb('accepts an own-org insert (positive control for the rejections below)', async () => {
    const { orgA, deviceA } = await seedFixture();
    const id = await insertAttemptAs(orgA.id, { orgId: orgA.id, deviceId: deviceA.id });
    const visible = await withDbAccessContext(orgContext(orgA.id), () => db.execute(sql`
      SELECT id, accepted_existing_point FROM device_restore_point_attempts WHERE id = ${id}::uuid
    `)) as unknown as Array<{ id: string; accepted_existing_point: boolean }>;
    expect(visible).toEqual([{ id, accepted_existing_point: false }]);
  });

  runDb('rejects a cross-tenant forge as breeze_app with 42501', async () => {
    const { orgA, orgB, deviceB } = await seedFixture();
    const forged = await causeOf(() => insertAttemptAs(orgA.id, { orgId: orgB.id, deviceId: deviceB.id }));
    expect(forged?.code).toBe('42501');
  });

  runDb('rejects a composite-FK tenant mismatch with 23503', async () => {
    // RLS passes (org_id is the caller's org); the FK refuses a device that
    // belongs to another org.
    const { orgA, deviceB } = await seedFixture();
    const mismatch = await causeOf(() => insertAttemptAs(orgA.id, { orgId: orgA.id, deviceId: deviceB.id }));
    expect(mismatch?.code).toBe('23503');
  });

  runDb('hides another org\'s rows from SELECT, UPDATE and DELETE', async () => {
    const { orgA, orgB, deviceB } = await seedFixture();
    const foreignId = await insertAttemptAs(orgB.id, { orgId: orgB.id, deviceId: deviceB.id });

    const seen = await withDbAccessContext(orgContext(orgA.id), () => db.execute(sql`
      SELECT id FROM device_restore_point_attempts WHERE id = ${foreignId}::uuid
    `));
    expect(seen).toHaveLength(0);

    const updated = await withDbAccessContext(orgContext(orgA.id), () => db.execute(sql`
      UPDATE device_restore_point_attempts SET status = 'failed'
      WHERE id = ${foreignId}::uuid RETURNING id
    `));
    expect(updated).toHaveLength(0);

    const deleted = await withDbAccessContext(orgContext(orgA.id), () => db.execute(sql`
      DELETE FROM device_restore_point_attempts WHERE id = ${foreignId}::uuid RETURNING id
    `));
    expect(deleted).toHaveLength(0);

    const still = await getTestDb().execute(sql`
      SELECT status FROM device_restore_point_attempts WHERE id = ${foreignId}::uuid
    `) as unknown as Array<{ status: string }>;
    expect(still).toEqual([{ status: 'requested' }]);
  });

  runDb("the inline badge subqueries never surface another org's row through a shared link id (#8584)", async () => {
    // The badge subqueries (services/restorePointInline.ts) filter ONLY on the
    // link id (+ device for software). script_execution_id and
    // software_deployment_id carry no FK, so a row stamped with org B can name
    // an id that belongs to org A; RLS on the ambient request connection is
    // the only thing keeping it out of org A's badge.
    const { orgA, orgB, deviceB } = await seedFixture();
    const executionId = randomUUID();
    const deploymentId = randomUUID();
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO device_restore_point_attempts
        (request_id, org_id, device_id, trigger, status, script_execution_id, software_deployment_id)
      VALUES (${randomUUID()}::uuid, ${orgB.id}::uuid, ${deviceB.id}::uuid, 'script', 'failed',
              ${executionId}::uuid, ${deploymentId}::uuid)
    `));
    const badges = () => db.execute(sql`select
      ${scriptExecutionRestorePointSql(sql`${executionId}::uuid`)} as script,
      ${deploymentResultRestorePointSql(sql`${deploymentId}::uuid`, sql`${deviceB.id}::uuid`)} as software`);

    // Control: the row is there and both subqueries match it without RLS.
    const unscoped = Array.from(await withSystemDbAccessContext(badges) as unknown as Array<{ script: unknown; software: unknown }>)[0]!;
    expect(unscoped.script).toMatchObject({ status: 'failed' });
    expect(unscoped.software).toMatchObject({ status: 'failed' });

    const asOrgA = Array.from(await withDbAccessContext(orgContext(orgA.id), badges) as unknown as Array<{ script: unknown; software: unknown }>)[0]!;
    expect(asOrgA).toEqual({ script: null, software: null });

    const asOrgB = Array.from(await withDbAccessContext(orgContext(orgB.id), badges) as unknown as Array<{ script: unknown; software: unknown }>)[0]!;
    expect(asOrgB.script).toMatchObject({ status: 'failed' });
  });

  runDb('rejects re-tenanting an own row to another org with 42501 (UPDATE WITH CHECK)', async () => {
    // The UPDATE policy's WITH CHECK fires before the (after-trigger) FK, so a
    // missing WITH CHECK would surface here as 23503 instead of 42501.
    const { orgA, orgB, deviceA } = await seedFixture();
    const id = await insertAttemptAs(orgA.id, { orgId: orgA.id, deviceId: deviceA.id });
    const moved = await causeOf(() => withDbAccessContext(orgContext(orgA.id), () => db.execute(sql`
      UPDATE device_restore_point_attempts SET org_id = ${orgB.id}::uuid WHERE id = ${id}::uuid
    `)));
    expect(moved?.code).toBe('42501');
  });

  runDb('enforces one ledger row per request_id with 23505', async () => {
    const { orgA, deviceA } = await seedFixture();
    const requestId = randomUUID();
    await insertAttemptAs(orgA.id, { orgId: orgA.id, deviceId: deviceA.id, requestId });
    const dup = await causeOf(() => insertAttemptAs(orgA.id, { orgId: orgA.id, deviceId: deviceA.id, requestId }));
    expect(dup?.code).toBe('23505');
  });

  runDb('rejects an unknown trigger or status with 23514', async () => {
    const { orgA, deviceA } = await seedFixture();
    const badTrigger = await causeOf(() => insertAttemptAs(orgA.id, {
      orgId: orgA.id, deviceId: deviceA.id, trigger: 'reboot',
    }));
    expect(badTrigger?.code).toBe('23514');
    const badStatus = await causeOf(() => insertAttemptAs(orgA.id, {
      orgId: orgA.id, deviceId: deviceA.id, status: 'recoverable',
    }));
    expect(badStatus?.code).toBe('23514');
  });

  runDb('cascades away when the device is deleted', async () => {
    const { orgA, deviceA } = await seedFixture();
    await insertAttemptAs(orgA.id, { orgId: orgA.id, deviceId: deviceA.id });
    await getTestDb().delete(devices).where(eq(devices.id, deviceA.id));
    const remaining = await getTestDb().execute(sql`
      SELECT id FROM device_restore_point_attempts WHERE device_id = ${deviceA.id}::uuid
    `);
    expect(remaining).toHaveLength(0);
  });

  runDb('follows the device org when the device row changes org', async () => {
    // Why the table is in DEVICE_ORG_FK_CASCADE_TABLES: move-org does not
    // issue an app-role UPDATE against it; the database restamps org_id.
    // NOTE: this asserts the outcome, not the mechanism -- the composite FK's
    // ON UPDATE CASCADE and the breeze_cascade_device_org_id() trigger would
    // both produce it. The FK's cascade action itself is pinned by the
    // confupdtype = 'c' assertion in the FK-declaration case above.
    const { orgA, orgB, siteB, deviceA } = await seedFixture();
    const id = await insertAttemptAs(orgA.id, { orgId: orgA.id, deviceId: deviceA.id });

    await withSystemDbAccessContext(() => db.execute(sql`
      UPDATE devices SET org_id = ${orgB.id}::uuid, site_id = ${siteB.id}::uuid
      WHERE id = ${deviceA.id}::uuid
    `));

    const restamped = await getTestDb().execute(sql`
      SELECT org_id FROM device_restore_point_attempts WHERE id = ${id}::uuid
    `) as unknown as Array<{ org_id: string }>;
    expect(restamped).toEqual([{ org_id: orgB.id }]);

    // ...and the row moved tenants: the old org can no longer see it.
    const oldOrgView = await withDbAccessContext(orgContext(orgA.id), () => db.execute(sql`
      SELECT id FROM device_restore_point_attempts WHERE id = ${id}::uuid
    `));
    expect(oldOrgView).toHaveLength(0);
  });
});
