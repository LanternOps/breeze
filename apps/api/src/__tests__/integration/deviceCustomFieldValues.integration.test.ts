/**
 * `device_custom_field_values` — #3257 W05 (sub-issue #4773).
 *
 * Migration under test:
 * `2026-10-11-160000-device-custom-field-values.sql`.
 *
 * THE SHAPE. Device custom-field VALUES move out of the `devices.custom_fields`
 * jsonb into a real table. `devices.custom_fields` survives as a
 * TRIGGER-MAINTAINED PROJECTION, so the ~34 JS readers, the MCP resource
 * projection and both partner-export statement triggers keep working unchanged
 * (Open Decision 1 = A, resolved at Gate A — not relitigated here).
 *
 * FOUR LIVE DEFECTS THIS CLOSES, all asserted below:
 *   1. The partner export emits TWO records for ONE datum when an org-owned and
 *      a partner-wide definition share a `field_key` — the identity hash
 *      includes `f.id` (`routes/partnerApi/configuration.ts`). W03 forbids new
 *      collisions; this removes the shape entirely by making the ROW the datum.
 *   2. `devices.custom_fields` is `excludedOpen` in the tenant-export policy, so
 *      every custom-field value was silently DROPPED from the GDPR export.
 *   3. `custom.<key>` filters scanned with `jsonb_extract_path_text`, unindexed.
 *   4. Deleting a definition orphaned every value stored under it, forever.
 *
 * WHY `field_key` IS DENORMALIZED. `services/tenantExport.ts` `readOrgRows` is a
 * bare `SELECT <included columns> FROM <table> WHERE <orgKey> = $1` with NO
 * joins, so a `definition_id`-only row exports as an opaque uuid the data
 * subject cannot read — and a partner-wide definition has `org_id IS NULL`, so
 * it is not in their export at all. The coherence trigger is what keeps the
 * denormalized copy honest.
 *
 * TWO GUARDS SIT UNDER A DIRECT-`org_id` RLS POLICY, because such a policy
 * TRUSTS `org_id`:
 *   * a composite FK `(device_id, org_id) -> devices(id, org_id)`, and
 *   * a coherence trigger for `definition_id` — the definitions table is
 *     DUAL-AXIS (org XOR partner), which no single FK can express.
 *
 * ORDERING NOTE, same as W03's. The coherence guard is a BEFORE ROW trigger, and
 * `ExecInsert` runs BR triggers AHEAD of both `ExecWithCheckOptions` and
 * `ExecConstraints`. So a coherence violation surfaces as P0001 even under a
 * tenant context, while a forged cross-tenant `org_id` still surfaces as 42501.
 * Both are asserted separately below so neither can be mistaken for the other.
 *
 * THE CI-SUPERUSER BLIND SPOT (W02/W03's lesson, and it applies here twice).
 * The coherence trigger is SECURITY DEFINER, so its lookups run as the function
 * OWNER — the role that applied the migration. On this stack and in CI that role
 * is a SUPERUSER with BYPASSRLS (`breeze_test`), which ignores RLS outright, so
 * every behavioural test in this file passes IDENTICALLY with or without the
 * in-body `set_config('breeze.scope', 'system', true)` elevation. The elevation
 * is load-bearing on a deployment whose migration role lacks BYPASSRLS, because
 * an unelevated read cannot see PARTNER-WIDE definitions at all (there is no
 * partner-wide SELECT branch on `custom_field_definitions` yet — #4944) and the
 * trigger would then reject every legitimate partner-wide value. Hence
 * `pins the in-body scope elevation` below asserts the function's stored BODY
 * from the catalog. On this stack it is the ONLY assertion here that can fail
 * when the elevation is removed. Do not delete it as redundant. And it asserts
 * the BODY, not `pg_proc.proconfig`, because the elegant attribute form
 * (`SET "breeze.scope" = 'system'`) is superuser-only for a custom dotted GUC
 * and 42501s prod's migration role at CREATE FUNCTION time (the v0.97.0 EU
 * crash-loop; `src/db/migrationGucAttributes.test.ts` guards it).
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { customFieldDefinitions, devices } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { partnerConfigurationRoutes } from '../../routes/partnerApi/configuration';
import { persistDeviceCustomFieldValues } from '../../services/customFields/queries';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

vi.mock('../../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env')>();
  return {
    ...actual,
    PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
  };
});

/**
 * Replayed by path, the repo's established shape (see
 * `customFieldShadowing.integration.test.ts`). `autoMigrate.test.ts` asserts
 * every such reference resolves, so a rename of the migration becomes a unit-job
 * failure rather than an ENOENT minutes into Integration Tests.
 */
const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-10-11-160000-device-custom-field-values.sql',
);

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const sys = <T>(fn: () => Promise<T>): Promise<T> => withDbAccessContext(SYSTEM_CTX, fn);

/** An org-scoped session, as a real org token resolves. */
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

/**
 * Seeds through the TEST client, like every db-utils factory, and deliberately
 * NOT inside a system DB context — the partner-export statement triggers enforce
 * "partners shared before orgs exclusive", so seeding a second partner after the
 * first partner's orgs inside ONE transaction raises. Autocommitted statements
 * sidestep it. The writes under test still go through the app pool.
 */
async function createDevice(
  orgId: string,
  siteId: string,
  hostname: string,
  customFields?: Record<string, unknown>,
): Promise<string> {
  deviceSeq += 1;
  const [device] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `agent-dcfv-${Date.now()}-${deviceSeq}`,
    hostname,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x64',
    agentVersion: '1.0.0',
    ...(customFields ? { customFields } : {}),
  }).returning({ id: devices.id });
  return device!.id;
}

async function createDefinition(opts: {
  orgId?: string | null;
  partnerId?: string | null;
  fieldKey: string;
  type?: 'text' | 'number' | 'boolean' | 'dropdown' | 'date';
}): Promise<string> {
  const [row] = await getTestDb().insert(customFieldDefinitions).values({
    orgId: opts.orgId ?? null,
    partnerId: opts.partnerId ?? null,
    name: opts.fieldKey,
    fieldKey: opts.fieldKey,
    type: opts.type ?? 'text',
  }).returning({ id: customFieldDefinitions.id });
  return row!.id;
}

interface ValueInsert {
  deviceId: string;
  orgId: string;
  definitionId: string;
  fieldKey: string;
  valueText?: string | null;
  valueNumber?: number | null;
  source?: string;
}

function insertValue(v: ValueInsert, ctx: DbAccessContext = SYSTEM_CTX): Promise<unknown> {
  return withDbAccessContext(ctx, () => db.execute(sql`
    INSERT INTO device_custom_field_values
      (device_id, org_id, definition_id, field_key, value_text, value_number, source)
    VALUES (
      ${v.deviceId}::uuid, ${v.orgId}::uuid, ${v.definitionId}::uuid, ${v.fieldKey},
      ${v.valueText ?? null}, ${v.valueNumber ?? null}, ${v.source ?? 'manual'}
    )`));
}

async function readProjection(deviceId: string): Promise<Record<string, unknown>> {
  const rows = await sys(() => db.execute<{ customFields: Record<string, unknown> | null }>(sql`
    SELECT custom_fields AS "customFields" FROM public.devices WHERE id = ${deviceId}::uuid`));
  return rows[0]?.customFields ?? {};
}

async function readExportStamp(deviceId: string): Promise<string | null> {
  const rows = await sys(() => db.execute<{ stamp: string | null }>(sql`
    SELECT partner_export_updated_at::text AS stamp
      FROM public.devices WHERE id = ${deviceId}::uuid`));
  return rows[0]?.stamp ?? null;
}

async function seedFixture() {
  const partnerA = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA!.id });
  const orgA2 = await createOrganization({ partnerId: partnerA!.id });
  const siteA = await createSite({ orgId: orgA!.id });
  const siteA2 = await createSite({ orgId: orgA2!.id });
  const partnerB = await createPartner();
  const orgB = await createOrganization({ partnerId: partnerB!.id });
  const siteB = await createSite({ orgId: orgB!.id });

  const deviceId = await createDevice(orgA!.id, siteA!.id, `dcfv-${deviceSeq + 1}`);
  const assetTagDef = await createDefinition({ orgId: orgA!.id, fieldKey: 'asset_tag' });
  const foreignPartnerDef = await createDefinition({ partnerId: partnerB!.id, fieldKey: 'udf7' });
  const partnerWideDef = await createDefinition({ partnerId: partnerA!.id, fieldKey: 'rack_unit' });

  return {
    partnerA: partnerA!.id,
    partnerB: partnerB!.id,
    orgA: orgA!.id,
    orgA2: orgA2!.id,
    orgB: orgB!.id,
    siteA: siteA!.id,
    siteA2: siteA2!.id,
    siteB: siteB!.id,
    deviceId,
    assetTagDef,
    foreignPartnerDef,
    partnerWideDef,
  };
}

describe('device_custom_field_values — projection', () => {
  runDb('projects a written value into devices.custom_fields', async () => {
    const f = await seedFixture();
    await insertValue({
      deviceId: f.deviceId, orgId: f.orgA, definitionId: f.assetTagDef,
      fieldKey: 'asset_tag', valueText: 'AB-1234',
    });
    expect(await readProjection(f.deviceId)).toMatchObject({ asset_tag: 'AB-1234' });
  });

  runDb('bumps devices.partner_export_updated_at when the projection changes', async () => {
    const f = await seedFixture();
    await insertValue({
      deviceId: f.deviceId, orgId: f.orgA, definitionId: f.assetTagDef,
      fieldKey: 'asset_tag', valueText: 'AB-1234',
    });
    const before = await readExportStamp(f.deviceId);
    await sys(() => db.execute(sql`
      UPDATE public.device_custom_field_values SET value_text = 'AB-9999'
       WHERE device_id = ${f.deviceId}::uuid AND field_key = 'asset_tag'`));
    expect(await readProjection(f.deviceId)).toMatchObject({ asset_tag: 'AB-9999' });
    expect(await readExportStamp(f.deviceId)).not.toEqual(before);
  });

  runDb('removes the key from the projection when the value row is deleted', async () => {
    const f = await seedFixture();
    await insertValue({
      deviceId: f.deviceId, orgId: f.orgA, definitionId: f.assetTagDef,
      fieldKey: 'asset_tag', valueText: 'AB-1234',
    });
    await sys(() => db.execute(sql`
      DELETE FROM public.device_custom_field_values WHERE device_id = ${f.deviceId}::uuid`));
    expect(await readProjection(f.deviceId)).not.toHaveProperty('asset_tag');
  });

  runDb('preserves a legacy jsonb key that has no visible definition', async () => {
    const f = await seedFixture();
    // A camelCase key can be READ but was never creatable under the enforced
    // ^[a-z][a-z0-9_]*$ pattern, so a few may exist in the wild. It cannot be
    // represented in the table (the FK needs a definition_id) and the backfill
    // cannot mint one for it — rebuilding the jsonb purely from the table would
    // silently delete it.
    await sys(() => db.execute(sql`
      UPDATE public.devices
         SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) || '{"legacyCamelKey":"keep me"}'::jsonb
       WHERE id = ${f.deviceId}::uuid`));
    await insertValue({
      deviceId: f.deviceId, orgId: f.orgA, definitionId: f.assetTagDef,
      fieldKey: 'asset_tag', valueText: 'AB-1234',
    });
    expect(await readProjection(f.deviceId)).toMatchObject({
      asset_tag: 'AB-1234',
      legacyCamelKey: 'keep me',
    });
  });

  runDb('stores an explicitly cleared value as all-NULL and projects it as jsonb null', async () => {
    const f = await seedFixture();
    await insertValue({
      deviceId: f.deviceId, orgId: f.orgA, definitionId: f.assetTagDef,
      fieldKey: 'asset_tag', valueText: null,
    });
    // customFieldValueSchema has always accepted z.null(); all-NULL is legal.
    expect(await readProjection(f.deviceId)).toMatchObject({ asset_tag: null });
  });
});

describe('device_custom_field_values — coherence and tenancy guards', () => {
  runDb('refuses a row whose device belongs to another org (composite FK)', async () => {
    const f = await seedFixture();
    // A PARTNER-WIDE definition so the coherence trigger passes (orgA2 is under
    // the same partner) and the composite FK is what actually rejects the row.
    await expect(sys(() => db.execute(sql`
      INSERT INTO device_custom_field_values (device_id, org_id, definition_id, field_key, value_text)
      VALUES (${f.deviceId}::uuid, ${f.orgA2}::uuid, ${f.partnerWideDef}::uuid, 'rack_unit', 'x')`)))
      .rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23503');
  });

  runDb('refuses a definition_id owned by ANOTHER partner (coherence trigger)', async () => {
    const f = await seedFixture();
    await expect(insertValue({
      deviceId: f.deviceId, orgId: f.orgA, definitionId: f.foreignPartnerDef,
      fieldKey: 'udf7', valueText: 'x',
    })).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === 'P0001');
  });

  runDb('refuses a definition_id owned by another ORG of the same partner', async () => {
    const f = await seedFixture();
    const otherOrgDef = await createDefinition({ orgId: f.orgA2, fieldKey: 'asset_tag' });
    await expect(insertValue({
      deviceId: f.deviceId, orgId: f.orgA, definitionId: otherOrgDef,
      fieldKey: 'asset_tag', valueText: 'x',
    })).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === 'P0001');
  });

  runDb('refuses a field_key that disagrees with its definition', async () => {
    const f = await seedFixture();
    await expect(insertValue({
      deviceId: f.deviceId, orgId: f.orgA, definitionId: f.assetTagDef,
      fieldKey: 'wrong_key', valueText: 'x',
    })).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === 'P0001');
  });

  runDb('accepts a value under a PARTNER-WIDE definition', async () => {
    const f = await seedFixture();
    await insertValue({
      deviceId: f.deviceId, orgId: f.orgA, definitionId: f.partnerWideDef,
      fieldKey: 'rack_unit', valueText: 'R12',
    });
    expect(await readProjection(f.deviceId)).toMatchObject({ rack_unit: 'R12' });
  });

  runDb('refuses two value columns on one row', async () => {
    const f = await seedFixture();
    await expect(insertValue({
      deviceId: f.deviceId, orgId: f.orgA, definitionId: f.assetTagDef,
      fieldKey: 'asset_tag', valueText: 'x', valueNumber: 1,
    })).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
  });

  runDb('cascade-deletes values when their definition is deleted', async () => {
    const f = await seedFixture();
    await insertValue({
      deviceId: f.deviceId, orgId: f.orgA, definitionId: f.assetTagDef,
      fieldKey: 'asset_tag', valueText: 'AB-1234',
    });
    await sys(() => db.execute(sql`
      DELETE FROM public.custom_field_definitions WHERE id = ${f.assetTagDef}::uuid`));
    const rows = await sys(() => db.execute(sql`
      SELECT 1 FROM public.device_custom_field_values
       WHERE definition_id = ${f.assetTagDef}::uuid`));
    expect(rows).toHaveLength(0);
    // ... and the projection drops the key with them, rather than stranding it.
    expect(await readProjection(f.deviceId)).not.toHaveProperty('asset_tag');
  });

  runDb('an org token cannot forge a row for another org (RLS, 42501)', async () => {
    const f = await seedFixture();
    // RLS is the OUTER wall and is stricter than the trigger: this row would
    // also fail the composite FK, but WITH CHECK rejects it first for a caller
    // with no access to orgA2.
    await expect(insertValue(
      {
        deviceId: f.deviceId, orgId: f.orgA2, definitionId: f.partnerWideDef,
        fieldKey: 'rack_unit', valueText: 'x',
      },
      orgContext(f.orgA, f.partnerA),
    )).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '42501');
  });

  runDb('an org token cannot read another org\'s values (RLS SELECT)', async () => {
    const f = await seedFixture();
    await insertValue({
      deviceId: f.deviceId, orgId: f.orgA, definitionId: f.assetTagDef,
      fieldKey: 'asset_tag', valueText: 'AB-1234',
    });
    const rows = await withDbAccessContext(orgContext(f.orgB, f.partnerB), () => db.execute(sql`
      SELECT id FROM device_custom_field_values WHERE device_id = ${f.deviceId}::uuid`));
    expect(rows).toHaveLength(0);
  });

  runDb('pins the in-body scope elevation on the coherence trigger function', async () => {
    // See this file's header: on a superuser/BYPASSRLS owner every behavioural
    // test above passes with the elevation stripped, so the catalog body is the
    // only thing that can fail. It also pins that the superuser-only ATTRIBUTE
    // form has not crept back in.
    const [row] = await sys(() => db.execute<{ def: string }>(sql`
      SELECT pg_get_functiondef('public.breeze_device_custom_field_value_coherent'::regproc) AS def`));
    expect(row!.def).toContain("set_config('breeze.scope', 'system', true)");
    expect(row!.def).toContain('_prev_scope');
    expect(row!.def).not.toMatch(/SET\s+"breeze\.scope"/);
  });

  runDb('does not leak system scope into the caller\'s transaction', async () => {
    const f = await seedFixture();
    await withDbAccessContext(orgContext(f.orgA, f.partnerA), async () => {
      await db.execute(sql`
        INSERT INTO device_custom_field_values (device_id, org_id, definition_id, field_key, value_text)
        VALUES (${f.deviceId}::uuid, ${f.orgA}::uuid, ${f.assetTagDef}::uuid, 'asset_tag', 'AB-1')`);
      const [scope] = await db.execute<{ scope: string }>(sql`
        SELECT public.breeze_current_scope() AS scope`);
      expect(scope!.scope).toBe('organization');
    });
  });
});

describe('device_custom_field_values — backfill', () => {
  /**
   * The backfill runs once, inside the migration. Replaying the migration file
   * against a database that already has legacy jsonb values is the only way to
   * exercise it — and re-applying it must be a true no-op, which the second
   * replay below asserts.
   */
  runDb('backfills an existing jsonb value and mints a definition for an orphan key', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner!.id });
    const site = await createSite({ orgId: org!.id });
    await createDefinition({ orgId: org!.id, fieldKey: 'asset_tag' });
    await createDefinition({ orgId: org!.id, fieldKey: 'cleared_key' });
    const legacyDeviceId = await createDevice(org!.id, site!.id, 'dcfv-legacy', {
      asset_tag: 'LEGACY-1',
      orphan_key: 'ORPHAN-1',
      legacyCamelKey: 'unmintable',
      cleared_key: null,
    });
    // The device seed wrote the jsonb directly (pre-normalization shape). Clear
    // the table for this device so the replay has real work to do.
    await sys(() => db.execute(sql`
      DELETE FROM public.device_custom_field_values WHERE device_id = ${legacyDeviceId}::uuid`));
    await sys(() => db.execute(sql`
      UPDATE public.devices
         SET custom_fields = '{"asset_tag":"LEGACY-1","orphan_key":"ORPHAN-1","legacyCamelKey":"unmintable","cleared_key":null}'::jsonb
       WHERE id = ${legacyDeviceId}::uuid`));

    await getTestDb().execute(sql.raw(readFileSync(MIGRATION_FILE, 'utf8')));

    const [copied] = await sys(() => db.execute<{ valueText: string; source: string }>(sql`
      SELECT value_text AS "valueText", source FROM public.device_custom_field_values
       WHERE device_id = ${legacyDeviceId}::uuid AND field_key = 'asset_tag'`));
    expect(copied).toMatchObject({ valueText: 'LEGACY-1', source: 'backfill' });

    const [minted] = await sys(() => db.execute<{ type: string; orgId: string }>(sql`
      SELECT type, org_id AS "orgId" FROM public.custom_field_definitions
       WHERE field_key = 'orphan_key' AND org_id = ${org!.id}::uuid`));
    expect(minted).toMatchObject({ type: 'text', orgId: org!.id });

    // A legacy JSON null is an EXPLICITLY CLEARED value and must round-trip as
    // an all-NULL row, not be skipped — the projection rebuilds every
    // pattern-matching key from the table alone, so a skipped null would turn
    // "cleared" into "never set" the first time anything wrote to this device.
    const [cleared] = await sys(() => db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM public.device_custom_field_values
       WHERE device_id = ${legacyDeviceId}::uuid AND field_key = 'cleared_key'
         AND value_text IS NULL AND value_number IS NULL
         AND value_bool IS NULL AND value_date IS NULL`));
    expect(cleared!.n).toBe(1);

    // The projection is unchanged by the backfill — including the unmintable
    // camelCase key, which stays in the jsonb only, and the cleared null.
    expect(await readProjection(legacyDeviceId)).toMatchObject({
      asset_tag: 'LEGACY-1',
      orphan_key: 'ORPHAN-1',
      legacyCamelKey: 'unmintable',
      cleared_key: null,
    });

    // Re-application is a true no-op: no duplicate rows, no duplicate mint.
    await getTestDb().execute(sql.raw(readFileSync(MIGRATION_FILE, 'utf8')));
    const rows = await sys(() => db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM public.device_custom_field_values
       WHERE device_id = ${legacyDeviceId}::uuid`));
    expect(rows[0]!.n).toBe(3);
    const defs = await sys(() => db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM public.custom_field_definitions
       WHERE field_key = 'orphan_key' AND org_id = ${org!.id}::uuid`));
    expect(defs[0]!.n).toBe(1);
  });
});

describe('persistDeviceCustomFieldValues', () => {
  runDb('writes through device_custom_field_values, not the jsonb', async () => {
    const f = await seedFixture();
    const changed = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
      persistDeviceCustomFieldValues(f.deviceId, f.orgA, [
        { definitionId: f.assetTagDef, fieldKey: 'asset_tag', type: 'text', value: 'AB-1' },
      ], 'api'));
    expect(changed).toEqual(['asset_tag']);
    const [row] = await sys(() => db.execute<{ valueText: string; source: string }>(sql`
      SELECT value_text AS "valueText", source FROM public.device_custom_field_values
       WHERE device_id = ${f.deviceId}::uuid`));
    expect(row).toMatchObject({ valueText: 'AB-1', source: 'api' });
    expect(await readProjection(f.deviceId)).toMatchObject({ asset_tag: 'AB-1' });
  });

  runDb('is a no-op when the stored value already equals the incoming one', async () => {
    const f = await seedFixture();
    await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
      persistDeviceCustomFieldValues(f.deviceId, f.orgA, [
        { definitionId: f.assetTagDef, fieldKey: 'asset_tag', type: 'text', value: 'AB-1' },
      ], 'api'));
    const before = await readExportStamp(f.deviceId);
    const changed = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
      persistDeviceCustomFieldValues(f.deviceId, f.orgA, [
        { definitionId: f.assetTagDef, fieldKey: 'asset_tag', type: 'text', value: 'AB-1' },
      ], 'api'));
    // Not cosmetic: an UPDATE that changes custom_fields fires
    // breeze_partner_export_devices_update, which takes an EXCLUSIVE per-org
    // advisory lock held to transaction end. A fleet-wide rewrite of unchanged
    // values would serialise the whole org.
    expect(changed).toEqual([]);
    expect(await readExportStamp(f.deviceId)).toEqual(before);
  });

  runDb('stores each type in its own typed column and clears to all-NULL', async () => {
    const f = await seedFixture();
    const numberDef = await createDefinition({ orgId: f.orgA, fieldKey: 'rack_no', type: 'number' });
    const boolDef = await createDefinition({ orgId: f.orgA, fieldKey: 'is_vm', type: 'boolean' });
    const dateDef = await createDefinition({ orgId: f.orgA, fieldKey: 'bought_on', type: 'date' });
    await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
      persistDeviceCustomFieldValues(f.deviceId, f.orgA, [
        { definitionId: numberDef, fieldKey: 'rack_no', type: 'number', value: 12 },
        { definitionId: boolDef, fieldKey: 'is_vm', type: 'boolean', value: true },
        { definitionId: dateDef, fieldKey: 'bought_on', type: 'date', value: '2026-01-31' },
        { definitionId: f.assetTagDef, fieldKey: 'asset_tag', type: 'text', value: null },
      ], 'manual'));
    const rows = await sys(() => db.execute<{
      fieldKey: string; valueText: string | null; valueNumber: number | null;
      valueBool: boolean | null; valueDate: string | null;
    }>(sql`
      SELECT field_key AS "fieldKey", value_text AS "valueText", value_number AS "valueNumber",
             value_bool AS "valueBool", value_date::text AS "valueDate"
        FROM public.device_custom_field_values
       WHERE device_id = ${f.deviceId}::uuid ORDER BY field_key`));
    expect(rows).toEqual([
      { fieldKey: 'asset_tag', valueText: null, valueNumber: null, valueBool: null, valueDate: null },
      { fieldKey: 'bought_on', valueText: null, valueNumber: null, valueBool: null, valueDate: '2026-01-31' },
      { fieldKey: 'is_vm', valueText: null, valueNumber: null, valueBool: true, valueDate: null },
      { fieldKey: 'rack_no', valueText: null, valueNumber: 12, valueBool: null, valueDate: null },
    ]);
    expect(await readProjection(f.deviceId)).toMatchObject({
      rack_no: 12, is_vm: true, bought_on: '2026-01-31', asset_tag: null,
    });
  });
});

describe('partner export — one record per datum (#3257 W05 defect 1)', () => {
  runDb('emits exactly one record per datum when two definitions share a key', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner!.id });
    const site = await createSite({ orgId: org!.id });
    // The PRE-W03 shape, forged with the anti-shadowing trigger disarmed: this
    // is the historical data the fix has to survive, not a shape anyone can
    // create today. Before this wave the export joined the flat jsonb to a
    // dual-axis definitions table and emitted one record PER DEFINITION.
    await getTestDb().execute(sql`
      ALTER TABLE public.custom_field_definitions DISABLE TRIGGER custom_field_definitions_no_shadow`);
    let orgDefId: string;
    try {
      orgDefId = await createDefinition({ orgId: org!.id, fieldKey: 'udf7' });
      await createDefinition({ partnerId: partner!.id, fieldKey: 'udf7' });
    } finally {
      await getTestDb().execute(sql`
        ALTER TABLE public.custom_field_definitions ENABLE TRIGGER custom_field_definitions_no_shadow`);
    }
    const deviceId = await createDevice(org!.id, site!.id, 'dcfv-export');
    await insertValue({
      deviceId, orgId: org!.id, definitionId: orgDefId, fieldKey: 'udf7', valueText: 'ONE',
    });

    const app = configurationExportApp(partner!.id, org!.id);
    const response = await app.request('/custom-field-values?limit=500');
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as {
      data: Array<{ id: string; fieldKey: string; value: unknown; definitionId: string }>;
    };
    const udf7 = body.data.filter((r) => r.fieldKey === 'udf7');
    expect(udf7).toHaveLength(1);
    expect(udf7[0]).toMatchObject({ value: 'ONE', definitionId: orgDefId });
    // The identity hash shape is unchanged (md5(device_id:definition_id)), so
    // shipped partner-API consumers do not re-sync.
    expect(new Set(body.data.map((r) => r.id)).size).toBe(body.data.length);
  });
});

function configurationExportApp(partnerId: string, orgId: string): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('partnerApiPrincipal', {
      partnerServicePrincipalId: crypto.randomUUID(),
      keyId: crypto.randomUUID(),
      partnerId,
      name: 'W05 integration test',
      scopes: ['configuration:read', 'custom-fields:read'],
      accessibleOrgIds: [orgId],
      rateLimit: 600,
    });
    await withDbAccessContext({
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [orgId],
      accessiblePartnerIds: [partnerId],
      currentPartnerId: partnerId,
      userId: null,
    }, async () => {
      await db.execute(sql`SELECT public.breeze_partner_export_lock_partners_shared(ARRAY[${partnerId}::uuid])`);
      await next();
    });
  });
  app.route('/', partnerConfigurationRoutes);
  return app;
}

describe('device_custom_field_values — device org move', () => {
  runDb('re-homes values onto the target org\'s identically-keyed definition', async () => {
    const f = await seedFixture();
    const targetDef = await createDefinition({ orgId: f.orgA2, fieldKey: 'asset_tag' });
    await insertValue({
      deviceId: f.deviceId, orgId: f.orgA, definitionId: f.assetTagDef,
      fieldKey: 'asset_tag', valueText: 'AB-1',
    });
    await insertValue({
      deviceId: f.deviceId, orgId: f.orgA, definitionId: f.partnerWideDef,
      fieldKey: 'rack_unit', valueText: 'R12',
    });

    const { rehomed, dropped } = await sys(() => rehomeAndMove(f.deviceId, f.orgA2, f.siteA2));
    expect({ rehomed, dropped }).toEqual({ rehomed: 1, dropped: 0 });

    const rows = await sys(() => db.execute<{
      fieldKey: string; orgId: string; definitionId: string;
    }>(sql`
      SELECT field_key AS "fieldKey", org_id AS "orgId", definition_id AS "definitionId"
        FROM public.device_custom_field_values
       WHERE device_id = ${f.deviceId}::uuid ORDER BY field_key`));
    expect(rows).toEqual([
      { fieldKey: 'asset_tag', orgId: f.orgA2, definitionId: targetDef },
      // A partner-wide definition stays visible across orgs of one partner and
      // needs no re-home — only its denormalized org_id travels.
      { fieldKey: 'rack_unit', orgId: f.orgA2, definitionId: f.partnerWideDef },
    ]);
    expect(await readProjection(f.deviceId)).toMatchObject({ asset_tag: 'AB-1', rack_unit: 'R12' });
  });

  runDb('drops a value whose org-owned definition has no counterpart in the target org', async () => {
    const f = await seedFixture();
    await insertValue({
      deviceId: f.deviceId, orgId: f.orgA, definitionId: f.assetTagDef,
      fieldKey: 'asset_tag', valueText: 'AB-1',
    });
    const { rehomed, dropped } = await sys(() => rehomeAndMove(f.deviceId, f.orgA2, f.siteA2));
    expect({ rehomed, dropped }).toEqual({ rehomed: 0, dropped: 1 });
    const rows = await sys(() => db.execute(sql`
      SELECT 1 FROM public.device_custom_field_values WHERE device_id = ${f.deviceId}::uuid`));
    expect(rows).toHaveLength(0);
    expect(await readProjection(f.deviceId)).not.toHaveProperty('asset_tag');
  });
});

/**
 * Exercises the DB-side helper the move path calls, then performs the org flip
 * itself so `breeze_cascade_device_org_id`'s generic loop runs for real. The
 * route is covered by `deviceMoveOrg*.integration.test.ts`; what is under test
 * here is that the flip does not abort on the coherence trigger.
 */
async function rehomeAndMove(
  deviceId: string,
  targetOrgId: string,
  targetSiteId: string,
): Promise<{ rehomed: number; dropped: number }> {
  const [counts] = await db.execute<{ rehomed: number; dropped: number }>(sql`
    SELECT rehomed, dropped
      FROM public.breeze_rehome_device_custom_field_values(${deviceId}::uuid, ${targetOrgId}::uuid)`);
  await db.execute(sql`
    UPDATE public.devices SET org_id = ${targetOrgId}::uuid, site_id = ${targetSiteId}::uuid,
           link_group_id = NULL, link_group_role = NULL
     WHERE id = ${deviceId}::uuid`);
  return { rehomed: Number(counts!.rehomed), dropped: Number(counts!.dropped) };
}

describe('device_custom_field_values — org merge', () => {
  let priorDrain: string | undefined;
  beforeEach(() => {
    priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
  });
  afterEach(() => {
    if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
    else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain;
  });

  runDb('re-homes values under a deduped definition instead of deleting them', async () => {
    // TWO contracts in one merge, both load-bearing:
    //
    //  1. W02's executor drops the loser org's definition when the survivor
    //     already defines the same field_key. Registering this table in
    //     CUSTOM_FIELD_DEFINITION_CHILDREN is what makes rehomeChildrenThenDelete
    //     move the values FIRST; without it the definition_id FK's ON DELETE
    //     CASCADE silently destroys every stored value under it. W02's own PR
    //     body named this as the thing W05 must not forget.
    //
    //  2. The merge repoints `devices.org_id` EARLY (the walk is parents-first),
    //     which restamps this table's denormalized org_id through
    //     breeze_cascade_device_org_id's generic loop — while the value's
    //     definition is still owned by the LOSER org. Without the coherence
    //     trigger's merge fence that restamp raises P0001 and aborts the whole
    //     merge. This test is the only thing that pins the fence.
    const { executeOrgMerge } = await import('../../services/orgMerge');
    const partner = await createPartner();
    const survivor = await createOrganization({ partnerId: partner!.id });
    const loser = await createOrganization({ partnerId: partner!.id });
    const loserSite = await createSite({ orgId: loser!.id });
    const actor = await createUser({ partnerId: partner!.id });
    const survivorDef = await createDefinition({ orgId: survivor!.id, fieldKey: 'asset_tag' });
    const loserDef = await createDefinition({ orgId: loser!.id, fieldKey: 'asset_tag' });
    // A key the survivor does NOT define: that definition simply travels with
    // the loser's row, so its value must survive under the SAME definition_id.
    const soloDef = await createDefinition({ orgId: loser!.id, fieldKey: 'rack_slot' });
    const deviceId = await createDevice(loser!.id, loserSite!.id, 'dcfv-merge');
    await insertValue({
      deviceId, orgId: loser!.id, definitionId: loserDef, fieldKey: 'asset_tag', valueText: 'KEEP-ME',
    });
    await insertValue({
      deviceId, orgId: loser!.id, definitionId: soloDef, fieldKey: 'rack_slot', valueText: 'SLOT-9',
    });

    await executeOrgMerge({
      loserOrgId: loser!.id,
      survivorOrgId: survivor!.id,
      partnerId: partner!.id,
      performedBy: actor.id,
    });

    const rows = await sys(() => db.execute<{
      fieldKey: string; orgId: string; definitionId: string; valueText: string;
    }>(sql`
      SELECT field_key AS "fieldKey", org_id AS "orgId",
             definition_id AS "definitionId", value_text AS "valueText"
        FROM public.device_custom_field_values
       WHERE device_id = ${deviceId}::uuid ORDER BY field_key`));
    expect(rows).toEqual([
      { fieldKey: 'asset_tag', orgId: survivor!.id, definitionId: survivorDef, valueText: 'KEEP-ME' },
      { fieldKey: 'rack_slot', orgId: survivor!.id, definitionId: soloDef, valueText: 'SLOT-9' },
    ]);
    expect(await readProjection(deviceId)).toMatchObject({
      asset_tag: 'KEEP-ME', rack_slot: 'SLOT-9',
    });
  });
});

describe('filterEngine custom.<key>', () => {
  runDb('matches a device on a normalized custom-field value', async () => {
    const { evaluateFilter } = await import('../../services/filterEngine');
    const f = await seedFixture();
    await insertValue({
      deviceId: f.deviceId, orgId: f.orgA, definitionId: f.assetTagDef,
      fieldKey: 'asset_tag', valueText: 'AB-1234',
    });
    const matched = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () => evaluateFilter(
      { operator: 'AND', conditions: [{ field: 'custom.asset_tag', operator: 'equals', value: 'AB-1234' }] },
      { orgId: f.orgA },
    ));
    expect(matched.deviceIds).toContain(f.deviceId);

    const unmatched = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () => evaluateFilter(
      { operator: 'AND', conditions: [{ field: 'custom.asset_tag', operator: 'equals', value: 'NOPE' }] },
      { orgId: f.orgA },
    ));
    expect(unmatched.deviceIds).not.toContain(f.deviceId);
  });

  runDb('matches a value stored under a PARTNER-WIDE definition', async () => {
    const { evaluateFilter } = await import('../../services/filterEngine');
    const f = await seedFixture();
    await insertValue({
      deviceId: f.deviceId, orgId: f.orgA, definitionId: f.partnerWideDef,
      fieldKey: 'rack_unit', valueText: 'R12',
    });
    const matched = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () => evaluateFilter(
      { operator: 'AND', conditions: [{ field: 'custom.rack_unit', operator: 'equals', value: 'R12' }] },
      { orgId: f.orgA },
    ));
    expect(matched.deviceIds).toContain(f.deviceId);
  });
});
