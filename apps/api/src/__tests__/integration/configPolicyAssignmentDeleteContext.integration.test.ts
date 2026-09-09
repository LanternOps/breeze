/**
 * The five assignment-owner DELETE triggers temporarily enter system scope.
 * A zero-row DELETE must restore the exact request context before the next
 * statement in the same transaction.
 */
import './setup';

import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-10-15-120001-restore-assignment-delete-context.sql',
);
const DELETE_TRIGGER_TABLES = [
  'configuration_policies',
  'organizations',
  'sites',
  'device_groups',
  'devices',
] as const;
const createdPartnerIds: string[] = [];

function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: null,
  };
}

async function seedTenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  createdPartnerIds.push(partner.id);
  return { partner, org, site };
}

afterEach(async () => {
  const testDb = getTestDb();
  for (const partnerId of createdPartnerIds.splice(0)) {
    await testDb.execute(sql`
      DELETE FROM config_policy_assignments
      WHERE config_policy_id IN (
        SELECT policy.id FROM configuration_policies policy
        JOIN organizations organization ON organization.id = policy.org_id
        WHERE organization.partner_id = ${partnerId}::uuid
      )`);
    await testDb.execute(sql`
      DELETE FROM configuration_policies
      WHERE org_id IN (SELECT id FROM organizations WHERE partner_id = ${partnerId}::uuid)`);
    await testDb.execute(sql`
      DELETE FROM sites
      WHERE org_id IN (SELECT id FROM organizations WHERE partner_id = ${partnerId}::uuid)`);
    await testDb.execute(sql`DELETE FROM organizations WHERE partner_id = ${partnerId}::uuid`);
    await testDb.execute(sql`DELETE FROM partners WHERE id = ${partnerId}::uuid`);
  }
});

describe('configuration-policy assignment owner DELETE context', () => {
  runDb('forward migration is repeatable and preserves function security attributes', async () => {
    const testDb = getTestDb();
    const before = await testDb.execute(sql`
      SELECT owner.rolname AS owner,
             function.prosecdef AS security_definer,
             function.proconfig AS config,
             function.proacl AS acl
      FROM pg_proc function
      JOIN pg_roles owner ON owner.oid = function.proowner
      WHERE function.oid =
        'public.breeze_serialize_config_policy_assignment_owner_deletes()'::regprocedure`);
    const migration = readFileSync(MIGRATION_FILE, 'utf8');
    await testDb.execute(sql.raw(migration));
    await testDb.execute(sql.raw(migration));
    const after = await testDb.execute(sql`
      SELECT owner.rolname AS owner,
             function.prosecdef AS security_definer,
             function.proconfig AS config,
             function.proacl AS acl,
             pg_get_functiondef(function.oid) AS definition
      FROM pg_proc function
      JOIN pg_roles owner ON owner.oid = function.proowner
      WHERE function.oid =
        'public.breeze_serialize_config_policy_assignment_owner_deletes()'::regprocedure`);

    expect(after[0]).toMatchObject(before[0]!);
    expect(after[0]).toMatchObject({
      security_definer: true,
      config: ['search_path=pg_catalog, public'],
      definition: expect.stringContaining(
        "set_config('breeze.accessible_partner_ids', COALESCE(_prev_partner_ids, ''), true)",
      ),
    });
  });

  runDb('is bound to exactly the five intended statement-level DELETE triggers', async () => {
    const rows = await getTestDb().execute(sql`
      SELECT trigger.tgname AS trigger_name,
             relation.relname AS table_name,
             trigger.tgenabled AS enabled,
             trigger.tgoldtable AS old_table
      FROM pg_trigger trigger
      JOIN pg_class relation ON relation.oid = trigger.tgrelid
      WHERE NOT trigger.tgisinternal
        AND trigger.tgfoid =
          'public.breeze_serialize_config_policy_assignment_owner_deletes()'::regprocedure
        AND (trigger.tgtype & 8) = 8
        AND (trigger.tgtype & 1) = 0
        AND (trigger.tgtype & 2) = 0
        AND (trigger.tgtype & 64) = 0
      ORDER BY relation.relname`);

    expect(rows).toEqual([
      { trigger_name: 'ab_config_policy_assignment_policy_owner_delete', table_name: 'configuration_policies', enabled: 'O', old_table: 'old_rows' },
      { trigger_name: 'ab_config_policy_assignment_group_owner_delete', table_name: 'device_groups', enabled: 'O', old_table: 'old_rows' },
      { trigger_name: 'ab_config_policy_assignment_device_owner_delete', table_name: 'devices', enabled: 'O', old_table: 'old_rows' },
      { trigger_name: 'ab_config_policy_assignment_org_owner_delete', table_name: 'organizations', enabled: 'O', old_table: 'old_rows' },
      { trigger_name: 'ab_config_policy_assignment_site_owner_delete', table_name: 'sites', enabled: 'O', old_table: 'old_rows' },
    ]);
  });

  runDb.each(DELETE_TRIGGER_TABLES)(
    '%s zero-row DELETE restores all changed GUCs and keeps foreign rows hidden',
    async (table) => {
      const own = await seedTenant();
      const foreign = await seedTenant();
      const missingId = randomUUID();

      const observed = await withDbAccessContext(orgContext(own.org.id, own.partner.id), async () => {
        const roleRows = await db.execute(sql`
          SELECT current_user AS role_name, role.rolsuper, role.rolbypassrls
          FROM pg_roles role WHERE role.rolname = current_user`);
        expect((roleRows as unknown as Array<{
          role_name: string;
          rolsuper: boolean;
          rolbypassrls: boolean;
        }>)[0]).toEqual({ role_name: 'breeze_app', rolsuper: false, rolbypassrls: false });

        await db.execute(sql.raw(`DELETE FROM public.${table} WHERE id = '${missingId}'::uuid`));
        const rows = await db.execute(sql`
          SELECT public.breeze_current_scope() AS scope,
                 current_setting('breeze.accessible_org_ids', true) AS org_ids,
                 current_setting('breeze.accessible_partner_ids', true) AS partner_ids,
                 (SELECT count(*)::integer FROM organizations WHERE id = ${own.org.id}::uuid) AS own_visible,
                 (SELECT count(*)::integer FROM organizations WHERE id = ${foreign.org.id}::uuid) AS foreign_visible`);
        const context = (rows as unknown as Array<{
          scope: string;
          org_ids: string;
          partner_ids: string;
          own_visible: number;
          foreign_visible: number;
        }>)[0]!;
        const changed = await db.execute(sql`
          WITH updated AS (
            UPDATE organizations SET name = name WHERE id = ${foreign.org.id}::uuid
            RETURNING id
          )
          SELECT count(*)::integer AS count FROM updated`);
        return {
          ...context,
          foreign_updated: (changed as unknown as Array<{ count: number }>)[0]!.count,
        };
      });

      expect(observed).toEqual({
        scope: 'organization',
        org_ids: own.org.id,
        partner_ids: own.partner.id,
        own_visible: 1,
        foreign_visible: 0,
        foreign_updated: 0,
      });
    },
  );
});
