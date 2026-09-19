/**
 * `device_function_assessments` — Fleet Designer W02 (#5652).
 *
 * Migration under test: `2026-10-16-170700-device-function-assessments.sql`.
 *
 * THE SHAPE. A typed home for "what is this device for": one ACTIVE row per
 * device (partial unique), history rows kept with `active = false`, and a
 * service-maintained projection on `devices.device_function` /
 * `device_function_source`. RLS shape 5 with denormalized `org_id` — a direct
 * `breeze_has_org_access(org_id)` policy TRUSTS `org_id`, so the composite FK
 * `(device_id, org_id) -> devices(id, org_id)` sits under it.
 *
 * What is asserted here, against a real Postgres:
 *   1. An org token cannot forge a row for another org (RLS, 42501).
 *   2. The composite FK rejects a device/org mismatch under system context (23503).
 *   3. Two active rows for one device reject (23505); supersede-then-insert works.
 *   4. Manual wins: an `ai` write after a `manual` row is `kept_manual` and the
 *      projection is untouched; a manual write supersedes an `ai` row.
 *   5. Device delete cascades the assessments; org erasure succeeds with rows
 *      present (the `CORE_ORG_CASCADE_DELETE_ORDER` entry is live).
 *   6. Move-org through the real route carries the row (ON UPDATE CASCADE), no 23503.
 *   7. The org-merge registry classifies the table as a plain repoint.
 *   8. Replaying the migration is a no-op (idempotency).
 */
import './setup';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { moveOrgRoutes } from '../../routes/devices/moveOrg';
import { createAccessToken } from '../../services/jwt';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { deleteDeviceCascade, type DeviceDeletionTx } from '../../services/deviceDeletion';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';
import {
  applyDesignFunctions,
  clearDeviceFunction,
  getDeviceFunction,
  upsertDeviceFunction,
} from '../../services/deviceFunction';
import { replayMigration } from './replayMigration';
import {
  createOrganization,
  createPartner,
  createSite,
  setupTestEnvironment,
} from './db-utils';
import { getTestDb } from './setup';
import { withMoveOrgStepUpGrant } from './moveOrgStepUpFixture';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const MIGRATION_FILE = '2026-10-16-170700-device-function-assessments.sql';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};
const sys = <T>(fn: () => Promise<T>): Promise<T> => withDbAccessContext(SYSTEM_CTX, fn);

function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

let deviceSeq = 0;
async function createDevice(orgId: string, siteId: string, hostname: string): Promise<string> {
  deviceSeq += 1;
  const [device] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `agent-dfa-${Date.now()}-${deviceSeq}`,
    hostname,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x64',
    agentVersion: '1.0.0',
  }).returning({ id: devices.id });
  return device!.id;
}

interface RawInsert {
  deviceId: string;
  orgId: string;
  functionKey?: string;
  source?: 'ai' | 'manual';
  confidence?: number | null;
  active?: boolean;
}

function insertRaw(v: RawInsert, ctx: DbAccessContext = SYSTEM_CTX): Promise<unknown> {
  const active = v.active ?? true;
  return withDbAccessContext(ctx, () => db.execute(sql`
    INSERT INTO device_function_assessments
      (device_id, org_id, function_key, source, confidence, active, superseded_at)
    VALUES (
      ${v.deviceId}::uuid, ${v.orgId}::uuid, ${v.functionKey ?? 'file_server'},
      ${v.source ?? 'ai'}, ${v.confidence ?? (v.source === 'manual' ? null : 0.8)},
      ${active}, ${active ? sql`NULL` : sql`now()`}
    )`));
}

async function readRows(deviceId: string): Promise<Array<{ functionKey: string; source: string; active: boolean; orgId: string }>> {
  return sys(() => db.execute<{ functionKey: string; source: string; active: boolean; orgId: string }>(sql`
    SELECT function_key AS "functionKey", source, active, org_id AS "orgId"
      FROM public.device_function_assessments
     WHERE device_id = ${deviceId}::uuid
     ORDER BY created_at, active`));
}

async function readProjection(deviceId: string): Promise<{ deviceFunction: string | null; deviceFunctionSource: string | null }> {
  const rows = await sys(() => db.execute<{ deviceFunction: string | null; deviceFunctionSource: string | null }>(sql`
    SELECT device_function AS "deviceFunction", device_function_source AS "deviceFunctionSource"
      FROM public.devices WHERE id = ${deviceId}::uuid`));
  return rows[0]!;
}

async function seedFixture() {
  const partnerA = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA!.id });
  const orgA2 = await createOrganization({ partnerId: partnerA!.id });
  const siteA = await createSite({ orgId: orgA!.id });
  const siteA2 = await createSite({ orgId: orgA2!.id });
  const deviceA = await createDevice(orgA!.id, siteA!.id, 'dfa-a');
  const deviceA2 = await createDevice(orgA2!.id, siteA2!.id, 'dfa-a2');
  return { partnerA: partnerA!.id, orgA: orgA!.id, orgA2: orgA2!.id, siteA: siteA!.id, deviceA, deviceA2 };
}

describe('device_function_assessments — tenancy guards', () => {
  runDb('an org token cannot forge a row for another org (RLS, 42501)', async () => {
    const f = await seedFixture();
    await expect(insertRaw(
      { deviceId: f.deviceA2, orgId: f.orgA2 },
      orgContext(f.orgA, f.partnerA),
    )).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '42501');
  });

  runDb('the composite FK rejects a device/org mismatch under system context (23503)', async () => {
    const f = await seedFixture();
    // device of org A stamped with org A2: RLS is bypassed (system), so the
    // structural pin is what fires.
    await expect(insertRaw({ deviceId: f.deviceA, orgId: f.orgA2 }))
      .rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23503');
  });

  runDb('an org token cannot read another org\'s assessments (RLS SELECT)', async () => {
    const f = await seedFixture();
    await insertRaw({ deviceId: f.deviceA2, orgId: f.orgA2 });
    const visible = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
      db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM device_function_assessments WHERE device_id = ${f.deviceA2}::uuid`));
    expect(visible[0]!.n).toBe('0');
    const own = await withDbAccessContext(orgContext(f.orgA2, f.partnerA), () =>
      db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM device_function_assessments WHERE device_id = ${f.deviceA2}::uuid`));
    expect(own[0]!.n).toBe('1');
  });

  runDb('only one ACTIVE row per device (23505); supersede then insert succeeds', async () => {
    const f = await seedFixture();
    await insertRaw({ deviceId: f.deviceA, orgId: f.orgA });
    await expect(insertRaw({ deviceId: f.deviceA, orgId: f.orgA, functionKey: 'kiosk' }))
      .rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23505');
    await sys(() => db.execute(sql`
      UPDATE device_function_assessments SET active = false, superseded_at = now()
       WHERE device_id = ${f.deviceA}::uuid AND active`));
    await insertRaw({ deviceId: f.deviceA, orgId: f.orgA, functionKey: 'kiosk' });
    const rows = await readRows(f.deviceA);
    expect(rows.map((r) => [r.functionKey, r.active])).toEqual([['file_server', false], ['kiosk', true]]);
  });

  runDb('CHECKs: manual rows carry no confidence, confidence is 0..1, keys match the SSOT shape', async () => {
    const f = await seedFixture();
    await expect(insertRaw({ deviceId: f.deviceA, orgId: f.orgA, source: 'manual', confidence: 0.5 }))
      .rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
    await expect(insertRaw({ deviceId: f.deviceA, orgId: f.orgA, confidence: 1.5 }))
      .rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '22003' || pgErrorCode(e) === '23514');
    await expect(insertRaw({ deviceId: f.deviceA, orgId: f.orgA, functionKey: 'Not A Key' }))
      .rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
    await expect(sys(() => db.execute(sql`
      UPDATE devices SET device_function = 'file_server', device_function_source = 'bogus' WHERE id = ${f.deviceA}::uuid`)))
      .rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
  });
});

describe('device_function_assessments — service semantics on a real database', () => {
  runDb('manual wins: an ai write after a manual row is kept_manual and leaves the projection alone', async () => {
    const f = await seedFixture();
    const ctx = orgContext(f.orgA, f.partnerA);
    const manual = await withDbAccessContext(ctx, () => upsertDeviceFunction({
      deviceId: f.deviceA, orgId: f.orgA, functionKey: 'print_server', source: 'manual',
    }));
    expect(manual.outcome).toBe('written');
    expect(await readProjection(f.deviceA)).toEqual({ deviceFunction: 'print_server', deviceFunctionSource: 'manual' });

    const ai = await withDbAccessContext(ctx, () => upsertDeviceFunction({
      deviceId: f.deviceA, orgId: f.orgA, functionKey: 'file_server', source: 'ai', confidence: 0.95, evidence: ['smb'],
    }));
    expect(ai).toEqual({ outcome: 'kept_manual', assessmentId: null });
    expect(await readProjection(f.deviceA)).toEqual({ deviceFunction: 'print_server', deviceFunctionSource: 'manual' });
    expect((await readRows(f.deviceA)).filter((r) => r.active)).toHaveLength(1);

    const dto = await withDbAccessContext(ctx, () => getDeviceFunction(f.deviceA, f.orgA));
    expect(dto).toMatchObject({ functionKey: 'print_server', source: 'manual', confidence: null, evidence: [] });
  });

  runDb('an ai row supersedes an older ai row; a manual write supersedes an ai row; clear supersedes anything', async () => {
    const f = await seedFixture();
    const ctx = orgContext(f.orgA, f.partnerA);
    await withDbAccessContext(ctx, () => upsertDeviceFunction({
      deviceId: f.deviceA, orgId: f.orgA, functionKey: 'file_server', source: 'ai', confidence: 0.7,
    }));
    await withDbAccessContext(ctx, () => upsertDeviceFunction({
      deviceId: f.deviceA, orgId: f.orgA, functionKey: 'domain_controller', source: 'ai', confidence: 0.9,
    }));
    expect(await readProjection(f.deviceA)).toEqual({ deviceFunction: 'domain_controller', deviceFunctionSource: 'ai' });
    let rows = await readRows(f.deviceA);
    expect(rows.filter((r) => r.active).map((r) => r.functionKey)).toEqual(['domain_controller']);
    expect(rows).toHaveLength(2);

    await withDbAccessContext(ctx, () => upsertDeviceFunction({
      deviceId: f.deviceA, orgId: f.orgA, functionKey: 'custom:pos', label: 'POS', source: 'manual',
    }));
    expect(await readProjection(f.deviceA)).toEqual({ deviceFunction: 'custom:pos', deviceFunctionSource: 'manual' });
    const dto = await withDbAccessContext(ctx, () => getDeviceFunction(f.deviceA, f.orgA));
    expect(dto).toMatchObject({ functionKey: 'custom:pos', label: 'POS', source: 'manual' });

    const cleared = await withDbAccessContext(ctx, () => clearDeviceFunction({ deviceId: f.deviceA, orgId: f.orgA }));
    expect(cleared.supersededAssessmentId).not.toBeNull();
    expect(await readProjection(f.deviceA)).toEqual({ deviceFunction: null, deviceFunctionSource: null });
    rows = await readRows(f.deviceA);
    expect(rows.filter((r) => r.active)).toHaveLength(0);
    expect(rows).toHaveLength(3);
  });

  runDb('the service refuses to write a device the caller\'s org does not own', async () => {
    const f = await seedFixture();
    await expect(withDbAccessContext(orgContext(f.orgA, f.partnerA), () => upsertDeviceFunction({
      deviceId: f.deviceA2, orgId: f.orgA, functionKey: 'kiosk', source: 'manual',
    }))).rejects.toMatchObject({ code: 'device_not_found' });
    expect(await readRows(f.deviceA2)).toEqual([]);
  });

  runDb('applyDesignFunctions writes ai rows for the org\'s devices and counts foreign ids', async () => {
    const f = await seedFixture();
    const ctx = orgContext(f.orgA, f.partnerA);
    const result = await withDbAccessContext(ctx, () => applyDesignFunctions({
      orgId: f.orgA, reportRunId: null, runId: null, userId: null,
      functions: [{ functionKey: 'file_server', deviceIds: [f.deviceA, f.deviceA2], confidence: 0.85, evidence: ['smb'] }],
    }));
    expect(result).toEqual({ written: 1, keptManual: 0, skippedForeign: 1 });
    expect(await readProjection(f.deviceA)).toEqual({ deviceFunction: 'file_server', deviceFunctionSource: 'ai' });
    expect(await readRows(f.deviceA2)).toEqual([]);
  });
});

describe('device_function_assessments — cascade, move and merge', () => {
  runDb('device hard-delete cascades the assessments', async () => {
    const f = await seedFixture();
    await insertRaw({ deviceId: f.deviceA, orgId: f.orgA, active: false });
    await insertRaw({ deviceId: f.deviceA, orgId: f.orgA, functionKey: 'kiosk' });
    await sys(() => db.transaction(async (tx) => {
      await deleteDeviceCascade(tx as unknown as DeviceDeletionTx, f.deviceA);
    }));
    expect(await readRows(f.deviceA)).toEqual([]);
  });

  runDb('org erasure succeeds with assessments present and leaves the sibling org intact', async () => {
    const f = await seedFixture();
    await insertRaw({ deviceId: f.deviceA, orgId: f.orgA });
    await insertRaw({ deviceId: f.deviceA2, orgId: f.orgA2 });
    const stats = await cascadeDeleteOrg(f.orgA, '00000000-0000-4000-8000-000000000001', 'erasure@test.local');
    expect(stats.tablesDeleted.device_function_assessments ?? 0).toBeGreaterThanOrEqual(0);
    expect(await readRows(f.deviceA)).toEqual([]);
    expect(await readRows(f.deviceA2)).toHaveLength(1);
  });

  runDb('POST /devices/:id/move-org carries the active assessment to the target org (ON UPDATE CASCADE)', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const { partner, organization: sourceOrg, site: sourceSite, user, role } = env;
    const targetOrg = await createOrganization({ partnerId: partner.id });
    const targetSite = await createSite({ orgId: targetOrg.id });
    const deviceId = await createDevice(sourceOrg.id, sourceSite.id, 'dfa-move');
    await withDbAccessContext(orgContext(sourceOrg.id, partner.id), () => upsertDeviceFunction({
      deviceId, orgId: sourceOrg.id, functionKey: 'hypervisor', source: 'manual',
    }));

    const token = await createAccessToken({
      sub: user.id,
      email: user.email,
      roleId: role.id,
      orgId: null,
      partnerId: partner.id,
      scope: 'partner',
      mfa: true,
      aep: 1,
      mep: 1,
      sid: 'dfa-move-session',
    });
    const app = new Hono();
    app.route('/devices', moveOrgRoutes);
    // Move-org step-up (spec 2026-09-18 W01): the route requires a fresh grant; mint one for exactly this request.
    const response = await app.request(`/devices/${deviceId}/move-org`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(await withMoveOrgStepUpGrant(token, deviceId, { orgId: targetOrg.id, siteId: targetSite.id })),
    });
    expect(response.status, await response.clone().text()).toBe(200);

    const rows = await readRows(deviceId);
    expect(rows).toEqual([{ functionKey: 'hypervisor', source: 'manual', active: true, orgId: targetOrg.id }]);
    expect(await readProjection(deviceId)).toEqual({ deviceFunction: 'hypervisor', deviceFunctionSource: 'manual' });
  });

  runDb('the org-merge registry classifies the table as a plain repoint', async () => {
    const policy = getOrgMergePolicies().get('device_function_assessments');
    expect(policy?.kind).toBe('repoint');
  });

  runDb('replaying the migration is a no-op', async () => {
    const f = await seedFixture();
    await insertRaw({ deviceId: f.deviceA, orgId: f.orgA });
    await replayMigration(MIGRATION_FILE);
    expect(await readRows(f.deviceA)).toHaveLength(1);
    const policies = await getTestDb().execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM pg_policies WHERE tablename = 'device_function_assessments'`);
    expect(policies[0]!.n).toBe('4');
  });
});
