/**
 * The custom-field re-home helper is SECURITY DEFINER and accepts source and
 * target UUIDs. Its privilege boundary must reject either a foreign source
 * device or a foreign target organization before entering system scope, while
 * preserving the authorized move path.
 */
import './setup';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { customFieldDefinitions, devices } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-10-15-120002-authorize-custom-field-value-rehome.sql',
);

function context(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
  };
}

async function seedOrg(partnerId?: string) {
  const partner = partnerId ? { id: partnerId } : await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  return { partner, org, site };
}

let deviceSequence = 0;

async function seedDeviceValue(
  orgId: string,
  siteId: string,
  fieldKey: string,
  value: string,
) {
  deviceSequence += 1;
  const [device] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `custom-field-rehome-${Date.now()}-${deviceSequence}`,
    hostname: `custom-field-rehome-${deviceSequence}`,
    osType: 'linux',
    osVersion: '1',
    architecture: 'amd64',
    agentVersion: '1',
  }).returning({ id: devices.id });
  const [definition] = await getTestDb().insert(customFieldDefinitions).values({
    orgId,
    partnerId: null,
    name: fieldKey,
    fieldKey,
    type: 'text',
  }).returning({ id: customFieldDefinitions.id });
  const [row] = await getTestDb().execute<{ id: string }>(sql`
    INSERT INTO public.device_custom_field_values
      (device_id, org_id, definition_id, field_key, value_text)
    VALUES (${device!.id}::uuid, ${orgId}::uuid, ${definition!.id}::uuid, ${fieldKey}, ${value})
    RETURNING id`);
  return { deviceId: device!.id, definitionId: definition!.id, valueId: row!.id };
}

async function callRehome(deviceId: string, targetOrgId: string) {
  return db.execute<{ rehomed: number; dropped: number }>(sql`
    SELECT rehomed, dropped
      FROM public.breeze_rehome_device_custom_field_values(
        ${deviceId}::uuid, ${targetOrgId}::uuid)`);
}

async function readValue(valueId: string) {
  const [row] = await getTestDb().execute<{
    id: string;
    deviceId: string;
    orgId: string;
    definitionId: string;
    fieldKey: string;
    valueText: string | null;
    valueNumber: number | null;
    valueBool: boolean | null;
    valueDate: string | null;
  }>(sql`
    SELECT id, device_id AS "deviceId", org_id AS "orgId",
           definition_id AS "definitionId", field_key AS "fieldKey",
           value_text AS "valueText", value_number AS "valueNumber",
           value_bool AS "valueBool", value_date::text AS "valueDate"
      FROM public.device_custom_field_values
     WHERE id = ${valueId}::uuid`);
  return row;
}

async function waitForAdvisoryLockWait(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [activity] = await getTestDb().execute<{ waitEvent: string | null }>(sql`
      SELECT wait_event AS "waitEvent" FROM pg_stat_activity WHERE pid = ${pid}`);
    if (activity?.waitEvent === 'advisory') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`backend ${pid} did not reach the expected advisory-lock wait`);
}

describe('breeze_rehome_device_custom_field_values authorization', () => {
  runDb('forward migration is repeatable and stores the authorization before elevation', async () => {
    const migration = readFileSync(MIGRATION_FILE, 'utf8');
    await getTestDb().execute(sql.raw(migration));
    await getTestDb().execute(sql.raw(migration));

    const [stored] = await getTestDb().execute<{
      securityDefiner: boolean;
      configuration: string[];
      definition: string;
    }>(sql`
      SELECT p.prosecdef AS "securityDefiner",
             p.proconfig AS configuration,
             pg_get_functiondef(p.oid) AS definition
        FROM pg_proc p
       WHERE p.oid =
         'public.breeze_rehome_device_custom_field_values(uuid,uuid)'::regprocedure`);
    expect(stored?.securityDefiner).toBe(true);
    expect(stored?.configuration).toEqual(['search_path=pg_catalog, public']);
    expect(stored?.definition).toContain('breeze_has_org_access(source_org_id)');
    expect(stored?.definition).toContain('breeze_has_org_access(p_target_org_id)');
    const definition = stored!.definition;
    expect(definition.indexOf('breeze_has_org_access(source_org_id)'))
      .toBeLessThan(definition.indexOf("set_config('breeze.scope', 'system', true)"));
  });

  runDb('is executable by breeze_app but not PUBLIC', async () => {
    const [acl] = await getTestDb().execute<{
      appExecute: boolean;
      publicExecute: boolean;
    }>(sql`
      SELECT has_function_privilege(
               'breeze_app',
               'public.breeze_rehome_device_custom_field_values(uuid,uuid)',
               'EXECUTE') AS "appExecute",
             has_function_privilege(
               'public',
               'public.breeze_rehome_device_custom_field_values(uuid,uuid)',
               'EXECUTE') AS "publicExecute"`);
    expect(acl).toEqual({ appExecute: true, publicExecute: false });
  });

  runDb('rejects a foreign source device and leaves its hidden value intact', async () => {
    const caller = await seedOrg();
    const foreign = await seedOrg(caller.partner.id);
    const value = await seedDeviceValue(
      foreign.org.id,
      foreign.site.id,
      'foreign_source',
      'must-survive',
    );
    const before = await readValue(value.valueId);

    await expect(withDbAccessContext(
      context(caller.partner.id, [caller.org.id]),
      () => callRehome(value.deviceId, caller.org.id),
    )).rejects.toMatchObject({ cause: { code: '42501' } });

    expect(await readValue(value.valueId)).toEqual(before);
  });

  runDb('rejects a foreign target organization and leaves the source value intact', async () => {
    const caller = await seedOrg();
    const foreign = await seedOrg(caller.partner.id);
    const value = await seedDeviceValue(
      caller.org.id,
      caller.site.id,
      'foreign_target',
      'must-survive',
    );
    const before = await readValue(value.valueId);

    await expect(withDbAccessContext(
      context(caller.partner.id, [caller.org.id]),
      () => callRehome(value.deviceId, foreign.org.id),
    )).rejects.toMatchObject({ cause: { code: '42501' } });

    expect(await readValue(value.valueId)).toEqual(before);
  });

  runDb('rejects a non-system cross-partner move even if both org UUIDs are allowlisted', async () => {
    const source = await seedOrg();
    const foreign = await seedOrg();
    const value = await seedDeviceValue(
      source.org.id,
      source.site.id,
      'cross_partner',
      'must-survive',
    );
    const before = await readValue(value.valueId);

    await expect(withDbAccessContext(
      context(source.partner.id, [source.org.id, foreign.org.id]),
      () => callRehome(value.deviceId, foreign.org.id),
    )).rejects.toMatchObject({ cause: { code: '42501' } });

    expect(await readValue(value.valueId)).toEqual(before);
  });

  runDb('re-authorizes after a blocking export lock before entering system scope', async () => {
    const source = await seedOrg();
    const target = await seedOrg(source.partner.id);
    const newTargetPartner = await createPartner();
    const value = await seedDeviceValue(
      source.org.id,
      source.site.id,
      'lock_race',
      'must-survive',
    );
    const before = await readValue(value.valueId);

    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    const app = postgres(process.env.DATABASE_URL_APP!, { max: 1 });
    let mover: Promise<unknown> | undefined;
    try {
      // The organization update trigger takes exclusive partner/export locks
      // and retains them to commit. Its uncommitted row version remains hidden
      // while the app-side helper authorizes against the old ownership facts.
      await admin`BEGIN`;
      await admin`
        UPDATE public.organizations
           SET partner_id = ${newTargetPartner.id}::uuid
         WHERE id = ${target.org.id}::uuid`;

      await app`BEGIN`;
      await app`SELECT set_config('breeze.scope', 'partner', true)`;
      await app`SELECT set_config(
        'breeze.accessible_org_ids', ${`${source.org.id},${target.org.id}`}, true)`;
      await app`SELECT set_config(
        'breeze.accessible_partner_ids', ${source.partner.id}, true)`;
      const [backend] = await app<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;

      // Force execution immediately. It passes the pre-lock check against the
      // old committed row and then waits behind the updater's advisory lock.
      mover = Promise.resolve(app`
        SELECT rehomed, dropped
          FROM public.breeze_rehome_device_custom_field_values(
            ${value.deviceId}::uuid, ${target.org.id}::uuid)`);
      await waitForAdvisoryLockWait(backend!.pid);

      await admin`COMMIT`;
      await expect(mover).rejects.toMatchObject({ code: '42501' });
      await app`ROLLBACK`;
    } finally {
      await admin`ROLLBACK`.catch(() => undefined);
      if (mover) await mover.catch(() => undefined);
      await app`ROLLBACK`.catch(() => undefined);
      await Promise.all([admin.end(), app.end()]);
    }

    expect(await readValue(value.valueId)).toEqual(before);
  });

  runDb('allows a same-partner caller with access to both move endpoints', async () => {
    const source = await seedOrg();
    const target = await seedOrg(source.partner.id);
    const value = await seedDeviceValue(
      source.org.id,
      source.site.id,
      'asset_tag',
      'AB-168',
    );
    const [targetDefinition] = await getTestDb().insert(customFieldDefinitions).values({
      orgId: target.org.id,
      partnerId: null,
      name: 'asset_tag',
      fieldKey: 'asset_tag',
      type: 'text',
    }).returning({ id: customFieldDefinitions.id });

    const counts = await withDbAccessContext(
      context(source.partner.id, [source.org.id, target.org.id]),
      async () => {
        const [role] = await db.execute<{
          roleName: string;
          rolsuper: boolean;
          rolbypassrls: boolean;
        }>(sql`
          SELECT current_user AS "roleName", r.rolsuper, r.rolbypassrls
            FROM pg_roles r WHERE r.rolname = current_user`);
        expect(role).toEqual({ roleName: 'breeze_app', rolsuper: false, rolbypassrls: false });

        const [result] = await callRehome(value.deviceId, target.org.id);
        const [restored] = await db.execute<{ scope: string }>(sql`
          SELECT current_setting('breeze.scope', true) AS scope`);
        expect(restored?.scope).toBe('partner');
        await db.execute(sql`
          UPDATE public.devices
             SET org_id = ${target.org.id}::uuid, site_id = ${target.site.id}::uuid
           WHERE id = ${value.deviceId}::uuid`);
        return result;
      },
    );
    expect({ rehomed: Number(counts?.rehomed), dropped: Number(counts?.dropped) })
      .toEqual({ rehomed: 1, dropped: 0 });

    const [moved] = await getTestDb().execute<{
      orgId: string;
      definitionId: string;
      valueText: string;
    }>(sql`
      SELECT org_id AS "orgId", definition_id AS "definitionId", value_text AS "valueText"
        FROM public.device_custom_field_values
       WHERE id = ${value.valueId}::uuid`);
    expect(moved).toEqual({
      orgId: target.org.id,
      definitionId: targetDefinition!.id,
      valueText: 'AB-168',
    });
  });
});
