import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { db as appDb, withDbAccessContext } from '../../db';
import { ensureAppRole } from '../../db/ensureAppRole';
import {
  automations,
  backupConfigs,
  backupProfiles,
  configPolicyAssignments,
  configPolicyBackupSettings,
  configPolicyFeatureLinks,
  configurationPolicies,
  customFieldDefinitions,
  devices,
  organizations,
  partnerExportConfigurationOrgState,
  scripts,
  sites,
} from '../../db/schema';
import { partnerConfigurationRoutes } from '../../routes/partnerApi/configuration';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
vi.mock('../../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env')>();
  return {
    ...actual,
    PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
  };
});
const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-24-partner-export-configuration-material-state.sql',
);
const TENANT_INTEGRITY_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-26-a-normalized-policy-tenant-integrity.sql',
);
const CANONICAL_PARITY_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-26-b-partner-export-canonical-parity.sql',
);
const FEATURE_REFERENCE_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-27-a-feature-policy-reference-ownership.sql',
);
const ONEDRIVE_REFERENCE_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-27-b-onedrive-reference-ownership.sql',
);
const PATCH_EXPORT_PARITY_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-27-d-patch-export-validation-parity.sql',
);
const PATCH_EXPORT_TYPESCRIPT_VALIDATION_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-27-e-patch-export-typescript-validation.sql',
);
const CUSTOM_VALUE_MOVE_OWNERS_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-31-device-custom-value-move-owners.sql',
);

describe('partner desired-configuration material watermarks', () => {
  runDb('migration is idempotent and creates forced org-axis RLS', async () => {
    const migration = readFileSync(MIGRATION_FILE, 'utf8');
    const db = getTestDb();
    await expect(db.execute(sql.raw(migration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(migration))).resolves.toBeDefined();
    const [state] = await db.execute<{ enabled: boolean; forced: boolean }>(sql`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_catalog.pg_class
      WHERE oid = 'public.partner_export_configuration_org_state'::regclass
    `);
    expect(state).toEqual({ enabled: true, forced: true });
  });

  runDb('custom-value move ownership migration is idempotent, ordered, and private', async () => {
    const db = getTestDb();
    const migration = readFileSync(CUSTOM_VALUE_MOVE_OWNERS_MIGRATION_FILE, 'utf8');
    await expect(db.execute(sql.raw(migration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(migration))).resolves.toBeDefined();

    const triggers = await db.execute<{ name: string; enabled: string }>(sql`
      SELECT tgname AS name, tgenabled AS enabled
      FROM pg_catalog.pg_trigger
      WHERE tgrelid = 'public.devices'::regclass
        AND NOT tgisinternal
        AND tgname IN (
          'breeze_partner_export_custom_values_update',
          'breeze_partner_export_z_custom_values_update'
        )
      ORDER BY tgname
    `);
    expect(triggers).toEqual([
      { name: 'breeze_partner_export_z_custom_values_update', enabled: 'O' },
    ]);

    const [functionState] = await db.execute<{
      securityDefiner: boolean;
      configuration: string | null;
      publicExecute: boolean;
      appExecute: boolean;
    }>(sql`
      SELECT p.prosecdef AS "securityDefiner",
        array_to_string(p.proconfig, ',') AS configuration,
        EXISTS (
          SELECT 1
          FROM pg_catalog.aclexplode(
            COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
          ) privilege
          WHERE privilege.grantee = 0
            AND privilege.privilege_type = 'EXECUTE'
        ) AS "publicExecute",
        has_function_privilege(
          'breeze_app',
          'public.breeze_partner_export_custom_values_update()',
          'EXECUTE'
        ) AS "appExecute"
      FROM pg_catalog.pg_proc p
      WHERE p.oid = 'public.breeze_partner_export_custom_values_update()'::regprocedure
    `);
    expect(functionState).toEqual({
      securityDefiner: true,
      configuration: 'search_path=pg_catalog, public',
      publicExecute: false,
      appExecute: false,
    });
  });

  runDb('tenant-integrity and canonical parity migrations are idempotent and keep helpers private', async () => {
    const db = getTestDb();
    const integrityMigration = readFileSync(TENANT_INTEGRITY_MIGRATION_FILE, 'utf8');
    const parityMigration = readFileSync(CANONICAL_PARITY_MIGRATION_FILE, 'utf8');
    const featureReferenceMigration = readFileSync(FEATURE_REFERENCE_MIGRATION_FILE, 'utf8');
    const onedriveReferenceMigration = readFileSync(ONEDRIVE_REFERENCE_MIGRATION_FILE, 'utf8');
    const patchExportParityMigration = readFileSync(PATCH_EXPORT_PARITY_MIGRATION_FILE, 'utf8');
    const patchExportTypescriptValidationMigration = readFileSync(
      PATCH_EXPORT_TYPESCRIPT_VALIDATION_MIGRATION_FILE,
      'utf8',
    );
    await expect(db.execute(sql.raw(integrityMigration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(integrityMigration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(parityMigration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(parityMigration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(featureReferenceMigration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(featureReferenceMigration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(onedriveReferenceMigration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(onedriveReferenceMigration))).resolves.toBeDefined();
    // Re-applying 07-26-b recreates the pre-parity implementation under the
    // public name. The fix-forward migration must restore its wrapper and must
    // itself remain idempotent.
    await expect(db.execute(sql.raw(patchExportParityMigration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(patchExportParityMigration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(patchExportTypescriptValidationMigration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(patchExportTypescriptValidationMigration))).resolves.toBeDefined();

    const catalog = await db.execute<{ relname: string; enabled: boolean; forced: boolean; commands: string[] }>(sql`
      SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
        array_agg(DISTINCT p.polcmd ORDER BY p.polcmd) AS commands
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_policy p ON p.polrelid = c.oid
      WHERE c.relname = ANY(ARRAY[
        'config_policy_feature_links', 'config_policy_assignments',
        'config_policy_alert_rules', 'config_policy_automations',
        'config_policy_compliance_rules', 'config_policy_patch_settings',
        'config_policy_maintenance_settings', 'config_policy_event_log_settings'
      ]::text[])
      GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
      ORDER BY c.relname
    `);
    expect(catalog).toHaveLength(8);
    expect(catalog.every((row) => row.enabled && row.forced)).toBe(true);
    expect(catalog.every((row) => row.commands.join(',') === 'a,d,r,w')).toBe(true);

    await ensureAppRole();
    const [privileges] = await db.execute<{
      validate: boolean; enforce: boolean; revalidate: boolean;
      featureValidate: boolean; featureEnforce: boolean; featureRevalidate: boolean;
      onedriveSettings: boolean; onedriveLibrary: boolean; onedriveRevalidate: boolean;
      patchProjectionPublic: boolean; patchProjectionApp: boolean;
      patchExportPublic: boolean; patchExportApp: boolean;
      patchPreMaterializerPublic: boolean; patchPreMaterializerApp: boolean;
    }>(sql`
      SELECT
        has_function_privilege('breeze_app', 'public.breeze_validate_config_policy_backup_settings(uuid,uuid,uuid,uuid,uuid)', 'EXECUTE') AS validate,
        has_function_privilege('breeze_app', 'public.breeze_enforce_config_policy_backup_settings()', 'EXECUTE') AS enforce,
        has_function_privilege('breeze_app', 'public.breeze_revalidate_config_policy_backup_settings_reference()', 'EXECUTE') AS revalidate,
        has_function_privilege('breeze_app', 'public.breeze_validate_config_policy_feature_reference(uuid,public.config_feature_type,uuid)', 'EXECUTE') AS "featureValidate",
        has_function_privilege('breeze_app', 'public.breeze_enforce_config_policy_feature_reference()', 'EXECUTE') AS "featureEnforce",
        has_function_privilege('breeze_app', 'public.breeze_revalidate_config_policy_feature_references()', 'EXECUTE') AS "featureRevalidate",
        has_function_privilege('breeze_app', 'public.breeze_validate_config_policy_onedrive_settings(uuid,uuid)', 'EXECUTE') AS "onedriveSettings",
        has_function_privilege('breeze_app', 'public.breeze_validate_config_policy_onedrive_library(uuid,uuid)', 'EXECUTE') AS "onedriveLibrary",
        has_function_privilege('breeze_app', 'public.breeze_revalidate_config_policy_onedrive_reference()', 'EXECUTE') AS "onedriveRevalidate",
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_proc p
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
          ) privilege
          WHERE p.oid = 'public.breeze_partner_export_patch_mirror_projection(jsonb)'::regprocedure
            AND privilege.grantee = 0
            AND privilege.privilege_type = 'EXECUTE'
        ) AS "patchProjectionPublic",
        has_function_privilege('breeze_app', 'public.breeze_partner_export_patch_mirror_projection(jsonb)', 'EXECUTE') AS "patchProjectionApp",
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_proc p
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
          ) privilege
          WHERE p.oid = 'public.breeze_partner_export_effective_policy_settings(uuid,text,jsonb)'::regprocedure
            AND privilege.grantee = 0
            AND privilege.privilege_type = 'EXECUTE'
        ) AS "patchExportPublic",
        has_function_privilege('breeze_app', 'public.breeze_partner_export_effective_policy_settings(uuid,text,jsonb)', 'EXECUTE') AS "patchExportApp",
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_proc p
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
          ) privilege
          WHERE p.oid = 'public.breeze_partner_export_policy_settings_pre_patch(uuid,text,jsonb)'::regprocedure
            AND privilege.grantee = 0
            AND privilege.privilege_type = 'EXECUTE'
        ) AS "patchPreMaterializerPublic",
        has_function_privilege('breeze_app', 'public.breeze_partner_export_policy_settings_pre_patch(uuid,text,jsonb)', 'EXECUTE') AS "patchPreMaterializerApp"
    `);
    expect(privileges).toEqual({
      validate: false, enforce: false, revalidate: false,
      featureValidate: false, featureEnforce: false, featureRevalidate: false,
      onedriveSettings: false, onedriveLibrary: false, onedriveRevalidate: false,
      patchProjectionPublic: false, patchProjectionApp: true,
      patchExportPublic: false, patchExportApp: true,
      patchPreMaterializerPublic: false, patchPreMaterializerApp: true,
    });
  });

  runDb('backup ownership preflight sees forged rows as breeze_app with no prior system context', async () => {
    const db = getTestDb();
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const [profileB] = await db.insert(backupProfiles).values({
      partnerId: partnerB.id,
      name: 'Feature-reference preflight foreign profile',
      selections: {},
    }).returning();
    if (!profileB) throw new Error('feature-reference preflight profile insert failed');
    const [policyA] = await db.insert(configurationPolicies).values({
      orgId: orgA.id,
      name: 'Feature-reference preflight local policy',
      status: 'active',
    }).returning();
    if (!policyA) throw new Error('feature-reference preflight policy insert failed');

    const [linkA] = await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policyA.id,
      featureType: 'backup',
    }).returning();
    if (!linkA) throw new Error('backup ownership preflight link insert failed');

    let forgedId: string | undefined;
    await db.execute(sql`ALTER TABLE public.config_policy_backup_settings DISABLE TRIGGER USER`);
    try {
      const [forged] = await db.execute<{ id: string }>(sql`
        INSERT INTO public.config_policy_backup_settings
          (feature_link_id, org_id, partner_id, backup_profile_id)
        VALUES (${linkA.id}::uuid, ${orgA.id}::uuid, NULL, ${profileB.id}::uuid)
        RETURNING id
      `);
      forgedId = forged?.id;
    } finally {
      await db.execute(sql`ALTER TABLE public.config_policy_backup_settings ENABLE TRIGGER USER`);
    }
    if (!forgedId) throw new Error('backup ownership preflight forged row insert failed');

    const [scopeBefore] = await appDb.execute<{ scope: string | null }>(sql`
      SELECT NULLIF(current_setting('breeze.scope', true), '') AS scope
    `);
    expect(scopeBefore?.scope).toBeNull();
    const migration = readFileSync(FEATURE_REFERENCE_MIGRATION_FILE, 'utf8');
    try {
      await expect(appDb.execute(sql.raw(migration)))
        .rejects.toMatchObject({ cause: { code: '23514' } });
    } finally {
      await db.execute(sql`DELETE FROM public.config_policy_backup_settings WHERE id = ${forgedId}::uuid`);
    }
  });

  runDb('OneDrive preflight aborts on forged rows as breeze_app with no prior system context', async () => {
    const db = getTestDb();
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const [policyB] = await db.insert(configurationPolicies).values({
      orgId: orgB.id, name: 'OneDrive preflight foreign policy', status: 'active',
    }).returning();
    if (!policyB) throw new Error('OneDrive preflight policy insert failed');
    const [linkB] = await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policyB.id, featureType: 'onedrive_helper',
    }).returning();
    if (!linkB) throw new Error('OneDrive preflight link insert failed');

    let forgedId: string | undefined;
    await db.execute(sql`ALTER TABLE public.config_policy_onedrive_settings DISABLE TRIGGER USER`);
    try {
      const [forged] = await db.execute<{ id: string }>(sql`
        INSERT INTO public.config_policy_onedrive_settings (feature_link_id, org_id)
        VALUES (${linkB.id}::uuid, ${orgA.id}::uuid)
        RETURNING id
      `);
      forgedId = forged?.id;
    } finally {
      await db.execute(sql`ALTER TABLE public.config_policy_onedrive_settings ENABLE TRIGGER USER`);
    }
    if (!forgedId) throw new Error('OneDrive preflight forged row insert failed');

    const [scopeBefore] = await appDb.execute<{ scope: string | null }>(sql`
      SELECT NULLIF(current_setting('breeze.scope', true), '') AS scope
    `);
    expect(scopeBefore?.scope).toBeNull();
    const migration = readFileSync(ONEDRIVE_REFERENCE_MIGRATION_FILE, 'utf8');
    try {
      await expect(appDb.execute(sql.raw(migration)))
        .rejects.toMatchObject({ cause: { code: '23514' } });
    } finally {
      await db.execute(sql`DELETE FROM public.config_policy_onedrive_settings WHERE id = ${forgedId}::uuid`);
    }
  });

  runDb('policy feature and assignment changes advance the affected configuration clocks', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [policy] = await db.insert(configurationPolicies).values({
      orgId: org.id, name: 'Task 7 policy', status: 'active',
    }).returning();
    if (!policy) throw new Error('policy insert failed');
    const baseline = await stateClock(org.id, 'configuration-policies');

    const [feature] = await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy.id, featureType: 'patch', inlineSettings: { schedule: 'weekly' },
    }).returning();
    if (!feature) throw new Error('feature insert failed');
    const afterFeature = await stateClock(org.id, 'configuration-policies');
    expect(afterFeature.getTime()).toBeGreaterThan(baseline.getTime());

    const [assignment] = await db.insert(configPolicyAssignments).values({
      configPolicyId: policy.id, level: 'organization', targetId: org.id,
    }).returning();
    if (!assignment) throw new Error('assignment insert failed');
    const afterAssignment = await stateClock(org.id, 'configuration-assignments');
    expect(afterAssignment.getTime()).toBeGreaterThan(baseline.getTime());

    await db.delete(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.id, feature.id));
    expect((await stateClock(org.id, 'configuration-policies')).getTime()).toBeGreaterThan(afterFeature.getTime());
    await db.delete(configPolicyAssignments).where(eq(configPolicyAssignments.id, assignment.id));
    expect((await stateClock(org.id, 'configuration-assignments')).getTime()).toBeGreaterThan(afterAssignment.getTime());
  });

  runDb('normalized backup settings are canonical, clocked, and all-or-blocked when unsafe', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [policy] = await db.insert(configurationPolicies).values({
      orgId: org.id, name: 'Canonical backup policy', status: 'active',
    }).returning();
    if (!policy) throw new Error('policy insert failed');
    const [link] = await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy.id, featureType: 'backup',
      inlineSettings: { schedule: { staleMirror: true } },
    }).returning();
    if (!link) throw new Error('feature link insert failed');
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy.id, level: 'organization', targetId: org.id,
    });
    const [settings] = await db.insert(configPolicyBackupSettings).values({
      featureLinkId: link.id, orgId: org.id, partnerId: null,
      schedule: { frequency: 'daily', time: '02:00' },
      retention: { daily: 14, monthly: 12 }, paths: ['/srv/data'],
      backupMode: 'file', targets: { excludes: ['/srv/cache'] },
    }).returning();
    if (!settings) throw new Error('backup settings insert failed');

    const app = configurationExportApp(partner.id, org.id);
    const first = await app.request('/configuration-policies');
    const firstBody = await first.json() as { data: Array<{ features: Array<{ settings: unknown }> }> };
    expect(firstBody.data[0]!.features[0]!.settings).toEqual({
      schedule: { frequency: 'daily', time: '02:00' },
      retention: { daily: 14, monthly: 12 }, paths: ['/srv/data'],
      backupMode: 'file', targets: { excludes: ['/srv/cache'] },
    });
    expect(JSON.stringify(firstBody)).not.toContain('staleMirror');

    const before = await stateClock(org.id, 'configuration-policies');
    await db.update(configPolicyBackupSettings).set({
      targets: { password: 'hunter2' }, updatedAt: sql`clock_timestamp()`,
    }).where(eq(configPolicyBackupSettings.id, settings.id));
    expect((await stateClock(org.id, 'configuration-policies')).getTime()).toBeGreaterThan(before.getTime());
    const unsafe = await app.request('/configuration-policies');
    const unsafeBody = await unsafe.json() as { data: unknown[]; blocked?: Array<{ id: string; orgId: string }> };
    expect(unsafeBody.data).toEqual([]);
    expect(unsafeBody.blocked).toEqual([expect.objectContaining({ id: policy.id, orgId: org.id })]);
    expect(JSON.stringify(unsafeBody)).not.toContain('hunter2');

    const beforeDelete = await stateClock(org.id, 'configuration-policies');
    await db.delete(configPolicyBackupSettings).where(eq(configPolicyBackupSettings.id, settings.id));
    expect((await stateClock(org.id, 'configuration-policies')).getTime()).toBeGreaterThan(beforeDelete.getTime());
  });

  runDb('canonical policy settings match Breeze empty collections and validated patch projection', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [policy] = await db.insert(configurationPolicies).values({
      orgId: org.id, name: 'Canonical settings parity', status: 'active',
    }).returning();
    if (!policy) throw new Error('canonical parity policy insert failed');
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy.id, level: 'organization', targetId: org.id,
    });
    const links = await db.insert(configPolicyFeatureLinks).values([
      { configPolicyId: policy.id, featureType: 'alert_rule', inlineSettings: { items: [] } },
      { configPolicyId: policy.id, featureType: 'automation', inlineSettings: { items: [] } },
      { configPolicyId: policy.id, featureType: 'compliance', inlineSettings: { items: [] } },
      {
        configPolicyId: policy.id,
        featureType: 'patch',
        inlineSettings: {
          autoApproveDeferralDays: 7,
          apps: [{ source: 'third_party', packageId: 'Example.App', action: 'block' }],
          unexpectedRawExtra: 'must-not-export',
        },
      },
      { configPolicyId: policy.id, featureType: 'maintenance', inlineSettings: { stale: true } },
      { configPolicyId: policy.id, featureType: 'event_log', inlineSettings: { stale: true } },
      { configPolicyId: policy.id, featureType: 'sensitive_data', inlineSettings: { stale: true } },
      { configPolicyId: policy.id, featureType: 'monitoring', inlineSettings: { stale: true } },
      { configPolicyId: policy.id, featureType: 'backup', inlineSettings: { stale: true } },
      { configPolicyId: policy.id, featureType: 'remote_access', inlineSettings: {} },
      { configPolicyId: policy.id, featureType: 'onedrive_helper', inlineSettings: { stale: true } },
    ]).returning();
    const patchLink = links.find((link) => link.featureType === 'patch');
    if (!patchLink) throw new Error('canonical parity patch link insert failed');
    const linkId = (featureType: string) => {
      const link = links.find((candidate) => candidate.featureType === featureType);
      if (!link) throw new Error(`canonical parity ${featureType} link insert failed`);
      return link.id;
    };
    await db.execute(sql`INSERT INTO public.config_policy_patch_settings (feature_link_id) VALUES (${patchLink.id}::uuid)`);
    await db.execute(sql`INSERT INTO public.config_policy_maintenance_settings (feature_link_id) VALUES (${linkId('maintenance')}::uuid)`);
    await db.execute(sql`INSERT INTO public.config_policy_event_log_settings (feature_link_id) VALUES (${linkId('event_log')}::uuid)`);
    await db.execute(sql`INSERT INTO public.config_policy_sensitive_data_settings (feature_link_id) VALUES (${linkId('sensitive_data')}::uuid)`);
    await db.execute(sql`INSERT INTO public.config_policy_monitoring_settings (feature_link_id) VALUES (${linkId('monitoring')}::uuid)`);
    await db.execute(sql`INSERT INTO public.config_policy_backup_settings (feature_link_id, org_id, partner_id)
      VALUES (${linkId('backup')}::uuid, ${org.id}::uuid, NULL)`);
    await db.execute(sql`INSERT INTO public.config_policy_remote_access_settings (feature_link_id) VALUES (${linkId('remote_access')}::uuid)`);
    await db.execute(sql`INSERT INTO public.config_policy_onedrive_settings (feature_link_id, org_id)
      VALUES (${linkId('onedrive_helper')}::uuid, ${org.id}::uuid)`);

    const response = await configurationExportApp(partner.id, org.id).request('/configuration-policies');
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as {
      data: Array<{ features: Array<{ type: string; settings: unknown }> }>;
    };
    expect(body.data, JSON.stringify(body)).toHaveLength(1);
    const settings = Object.fromEntries(body.data[0]!.features.map((feature) => [feature.type, feature.settings]));
    expect(settings.alert_rule).toEqual({ items: [] });
    expect(settings.automation).toEqual({ items: [] });
    expect(settings.compliance).toEqual({ items: [] });
    expect(settings.patch).toEqual({
      sources: ['os'], autoApprove: false, autoApproveSeverities: [],
      autoApproveDeferralDays: 7,
      apps: [{ source: 'third_party', packageId: 'Example.App', action: 'block' }],
      scheduleFrequency: 'weekly', scheduleTime: '02:00', scheduleDayOfWeek: 'sun',
      scheduleDayOfMonth: 1, rebootPolicy: 'if_required', exclusiveWindowsUpdate: false,
    });
    expect(settings.maintenance).toEqual({
      recurrence: 'weekly', durationHours: 2, timezone: 'UTC', windowStart: null,
      suppressAlerts: true, suppressPatching: false, suppressAutomations: false,
      suppressScripts: false, rebootIfPending: false, notifyBeforeMinutes: 15,
      notifyOnStart: true, notifyOnEnd: true,
    });
    expect(settings.event_log).toEqual({
      retentionDays: 30, maxEventsPerCycle: 100,
      collectCategories: ['security', 'hardware', 'application', 'system'],
      minimumLevel: 'info', collectionIntervalMinutes: 15, rateLimitPerHour: 12000,
    });
    expect(settings.sensitive_data).toEqual({
      detectionClasses: ['credential'], includePaths: [], excludePaths: [], fileTypes: [],
      maxFileSizeBytes: 104857600, workers: 4, timeoutSeconds: 300,
      suppressPatternIds: [], scheduleType: 'manual', intervalMinutes: null,
      cron: null, timezone: 'UTC',
    });
    expect(settings.monitoring).toEqual({
      checkIntervalSeconds: 60, watches: [], eventLogAlerts: [], alertRules: [],
    });
    expect(settings.backup).toEqual({
      schedule: {}, retention: {}, paths: [], backupMode: 'file', targets: {},
    });
    expect(settings.remote_access).toEqual({
      sessionPromptMode: 'notify', consentUnavailableBehavior: 'proceed',
      notifyOnSessionEnd: true, showActiveIndicator: true,
      technicianIdentityLevel: 'name_email',
    });
    expect(settings.onedrive_helper).toEqual({
      silentAccountConfig: true, filesOnDemand: true, kfmSilentOptIn: false,
      kfmFolders: ['Desktop', 'Documents', 'Pictures'], kfmBlockOptOut: false,
      tenantAssociationId: null, restartOnChange: true, libraries: [],
    });
    expect(JSON.stringify(settings)).not.toContain('unexpectedRawExtra');

    await db.update(configPolicyFeatureLinks).set({
      inlineSettings: {
        autoApproveDeferralDays: 999999999999999999999999,
        apps: [{ packageId: 'missing-source', action: 'block', unexpected: 'drop-me' }],
      },
    }).where(eq(configPolicyFeatureLinks.id, patchLink.id));
    const malformedResponse = await configurationExportApp(partner.id, org.id)
      .request('/configuration-policies');
    expect(malformedResponse.status, await malformedResponse.clone().text()).toBe(200);
    const malformedBody = await malformedResponse.json() as {
      data: Array<{ features: Array<{ type: string; settings: Record<string, unknown> }> }>;
    };
    const malformedPatch = malformedBody.data[0]!.features
      .find((feature) => feature.type === 'patch')!.settings;
    expect(malformedPatch.autoApproveDeferralDays).toBe(0);
    expect(malformedPatch.apps).toEqual([]);
    expect(JSON.stringify(malformedBody)).not.toContain('drop-me');
  });

  runDb('partner-owned library changes touch every owned org while another partner remains unchanged', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });
    const otherBefore = await stateClock(otherOrg.id, 'scripts');

    const [script] = await db.insert(scripts).values({
      partnerId: partner.id, name: 'Partner rebuild', osTypes: ['linux'], language: 'bash',
      content: 'true', isSystem: false,
    }).returning();
    if (!script) throw new Error('script insert failed');
    const aBefore = await stateClock(orgA.id, 'scripts');
    const bBefore = await stateClock(orgB.id, 'scripts');
    await db.update(scripts).set({ content: 'printf ready' }).where(eq(scripts.id, script.id));
    expect((await stateClock(orgA.id, 'scripts')).getTime()).toBeGreaterThan(aBefore.getTime());
    expect((await stateClock(orgB.id, 'scripts')).getTime()).toBeGreaterThan(bBefore.getTime());
    expect(await stateClock(otherOrg.id, 'scripts')).toEqual(otherBefore);
  });

  runDb('excluded automation runtime and backup provider state do not churn material clocks', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [automation] = await db.insert(automations).values({
      orgId: org.id, name: 'Runtime-only automation', trigger: { type: 'manual' },
      actions: [{ type: 'reboot' }],
    }).returning();
    if (!automation) throw new Error('automation insert failed');
    const automationBefore = await stateClock(org.id, 'automations');
    const app = configurationExportApp(partner.id, org.id);
    const automationInitial = await app.request('/automations');
    expect(automationInitial.status).toBe(200);
    const automationInitialBody = await automationInitial.json() as { data: Array<{ sourceUpdatedAt: string }> };
    const automationSourceClock = automationInitialBody.data[0]!.sourceUpdatedAt;
    await db.update(automations).set({
      lastRunAt: new Date(), runCount: 1, updatedAt: sql`clock_timestamp()`,
    }).where(eq(automations.id, automation.id));
    expect(await stateClock(org.id, 'automations')).toEqual(automationBefore);
    const automationAfter = await app.request('/automations');
    const automationAfterBody = await automationAfter.json() as { data: Array<{ sourceUpdatedAt: string }> };
    expect(automationAfterBody.data[0]!.sourceUpdatedAt).toBe(automationSourceClock);
    const automationIncremental = await app.request(`/automations?updatedSince=${encodeURIComponent(automationSourceClock)}`);
    expect((await automationIncremental.json() as { data: unknown[] }).data).toEqual([]);

    const [destination] = await db.insert(backupConfigs).values({
      orgId: org.id, name: 'Provider-only destination', type: 'file', provider: 's3',
      providerConfig: { endpoint: 'https://storage.example.test' },
    }).returning();
    if (!destination) throw new Error('backup destination insert failed');
    const backupBefore = await stateClock(org.id, 'backup-configurations');
    await db.update(backupConfigs).set({
      providerCapabilities: { multipart: true }, providerCapabilitiesCheckedAt: new Date(),
      updatedAt: sql`clock_timestamp()`,
    }).where(eq(backupConfigs.id, destination.id));
    expect(await stateClock(org.id, 'backup-configurations')).toEqual(backupBefore);
    const backupIncremental = await app.request(`/backup-configurations?updatedSince=${encodeURIComponent(backupBefore.toISOString())}`);
    expect(backupIncremental.status, await backupIncremental.clone().text()).toBe(200);
    expect((await backupIncremental.json() as { data: unknown[] }).data).toEqual([]);
  });

  runDb('device custom-field value changes advance custom-field state without granting app mutation access', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    await db.insert(customFieldDefinitions).values({
      orgId: org.id, name: 'Rack', fieldKey: 'rack', type: 'text',
    });
    const [device] = await db.insert(devices).values({
      orgId: org.id, siteId: site.id, agentId: `task7-${crypto.randomUUID()}`.slice(0, 64),
      hostname: 'task7-device', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1',
      customFields: {},
    }).returning();
    if (!device) throw new Error('device insert failed');
    const before = await stateClock(org.id, 'custom-fields');
    await db.update(devices).set({ customFields: { rack: 'DC1-R07' } }).where(eq(devices.id, device.id));
    expect((await stateClock(org.id, 'custom-fields')).getTime()).toBeGreaterThan(before.getTime());

    // Simulate the post-migration startup call. This blanket-grants table
    // privileges before applying its permanent per-table exceptions.
    await ensureAppRole();
    const [privileges] = await db.execute<{ select: boolean; insert: boolean; update: boolean; delete: boolean; truncate: boolean }>(sql`
      SELECT
        has_table_privilege('breeze_app', 'partner_export_configuration_org_state', 'SELECT') AS select,
        has_table_privilege('breeze_app', 'partner_export_configuration_org_state', 'INSERT') AS insert,
        has_table_privilege('breeze_app', 'partner_export_configuration_org_state', 'UPDATE') AS update,
        has_table_privilege('breeze_app', 'partner_export_configuration_org_state', 'DELETE') AS delete,
        has_table_privilege('breeze_app', 'partner_export_configuration_org_state', 'TRUNCATE') AS truncate
    `);
    expect(privileges).toEqual({ select: true, insert: false, update: false, delete: false, truncate: false });
    const [functionPrivileges] = await db.execute<{ touch: boolean; ownerTrigger: boolean }>(sql`
      SELECT
        has_function_privilege('breeze_app', 'public.breeze_partner_export_touch_configuration_orgs(uuid[],text[])', 'EXECUTE') AS touch,
        has_function_privilege('breeze_app', 'public.breeze_partner_export_configuration_owner_update()', 'EXECUTE') AS "ownerTrigger"
    `);
    expect(functionPrivileges).toEqual({ touch: false, ownerTrigger: false });
    await expect(withDbAccessContext({
      scope: 'partner', orgId: null, accessiblePartnerIds: [partner.id], userId: null,
      accessibleOrgIds: [org.id],
    }, () => appDb.update(partnerExportConfigurationOrgState)
      .set({ updatedAt: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(partnerExportConfigurationOrgState.orgId, org.id))))
      .rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
  });

  runDb.each([
    {
      direction: 'low-to-high with unchanged values',
      sourceOrgId: '10000000-0000-4000-8000-000000000001',
      targetOrgId: 'f0000000-0000-4000-8000-000000000002',
      changedValue: false,
    },
    {
      direction: 'low-to-high with changed values',
      sourceOrgId: '10000000-0000-4000-8000-000000000001',
      targetOrgId: 'f0000000-0000-4000-8000-000000000002',
      changedValue: true,
    },
    {
      direction: 'high-to-low with unchanged values',
      sourceOrgId: 'f0000000-0000-4000-8000-000000000002',
      targetOrgId: '10000000-0000-4000-8000-000000000001',
      changedValue: false,
    },
    {
      direction: 'high-to-low with changed values',
      sourceOrgId: 'f0000000-0000-4000-8000-000000000002',
      targetOrgId: '10000000-0000-4000-8000-000000000001',
      changedValue: true,
    },
  ])('device org/site move $direction touches both custom-field owners', async ({
    sourceOrgId,
    targetOrgId,
    changedValue,
  }) => {
    const db = getTestDb();
    const partner = await createPartner();
    await db.insert(organizations).values([
      {
        id: '10000000-0000-4000-8000-000000000001',
        partnerId: partner.id,
        name: 'Deterministic low organization',
        slug: `custom-move-low-${crypto.randomUUID()}`,
      },
      {
        id: 'f0000000-0000-4000-8000-000000000002',
        partnerId: partner.id,
        name: 'Deterministic high organization',
        slug: `custom-move-high-${crypto.randomUUID()}`,
      },
    ]);
    const [sourceSite, targetSite] = await db.insert(sites).values([
      { orgId: sourceOrgId, name: 'Custom value move source' },
      { orgId: targetOrgId, name: 'Custom value move target' },
    ]).returning();
    if (!sourceSite || !targetSite) throw new Error('custom value move site seed failed');
    await db.insert(customFieldDefinitions).values([
      { orgId: sourceOrgId, name: 'Rack', fieldKey: 'rack', type: 'text' },
      { orgId: targetOrgId, name: 'Rack', fieldKey: 'rack', type: 'text' },
    ]);
    const [device] = await db.insert(devices).values({
      orgId: sourceOrgId,
      siteId: sourceSite.id,
      agentId: `custom-move-${crypto.randomUUID()}`.slice(0, 64),
      hostname: 'custom-value-moving-device',
      osType: 'linux',
      osVersion: '1',
      architecture: 'amd64',
      agentVersion: '1',
      customFields: { rack: 'source-rack' },
    }).returning();
    if (!device) throw new Error('custom value move device seed failed');

    const sourceBefore = await stateClock(sourceOrgId, 'custom-fields');
    const targetBefore = await stateClock(targetOrgId, 'custom-fields');
    const sourceApp = configurationExportApp(partner.id, sourceOrgId);
    const targetApp = configurationExportApp(partner.id, targetOrgId);
    const sourceInitial = await sourceApp.request('/custom-field-values');
    const targetInitial = await targetApp.request('/custom-field-values');
    expect(sourceInitial.status, await sourceInitial.clone().text()).toBe(200);
    expect(targetInitial.status, await targetInitial.clone().text()).toBe(200);
    expect((await sourceInitial.json() as { data: unknown[] }).data).toHaveLength(1);
    expect((await targetInitial.json() as { data: unknown[] }).data).toEqual([]);

    await expect(db.update(devices).set({
      orgId: targetOrgId,
      siteId: targetSite.id,
      ...(changedValue ? { customFields: { rack: 'target-rack' } } : {}),
    }).where(eq(devices.id, device.id))).resolves.toBeDefined();

    expect((await stateClock(sourceOrgId, 'custom-fields')).getTime())
      .toBeGreaterThan(sourceBefore.getTime());
    expect((await stateClock(targetOrgId, 'custom-fields')).getTime())
      .toBeGreaterThan(targetBefore.getTime());
    const sourceAfter = await sourceApp.request('/custom-field-values');
    const targetAfter = await targetApp.request('/custom-field-values');
    expect(sourceAfter.status, await sourceAfter.clone().text()).toBe(200);
    expect(targetAfter.status, await targetAfter.clone().text()).toBe(200);
    expect((await sourceAfter.json() as { data: unknown[] }).data).toEqual([]);
    const targetBody = await targetAfter.json() as { data: Array<{ value: string }> };
    expect(targetBody.data).toEqual([
      expect.objectContaining({ value: changedValue ? 'target-rack' : 'source-rack' }),
    ]);
  });

  runDb('custom-field values traverse more than 500 definitions on one device and block secret semantics', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const fieldValues = Object.fromEntries(Array.from({ length: 501 }, (_, index) => [
      `field_${String(index).padStart(4, '0')}`,
      `value-${index}`,
    ]));
    await db.insert(customFieldDefinitions).values(Array.from({ length: 501 }, (_, index) => ({
      orgId: org.id,
      name: `Field ${index}`,
      fieldKey: `field_${String(index).padStart(4, '0')}`,
      type: 'text' as const,
    })));
    const [device] = await db.insert(devices).values({
      orgId: org.id,
      siteId: site.id,
      agentId: `task7-page-${crypto.randomUUID()}`.slice(0, 64),
      hostname: 'task7-page-single-device',
      osType: 'linux' as const,
      osVersion: '1',
      architecture: 'amd64',
      agentVersion: '1',
      customFields: fieldValues,
    }).returning();
    if (!device) throw new Error('custom-value device insert failed');
    const app = configurationExportApp(partner.id, org.id);
    const first = await app.request('/custom-field-values?limit=500');
    expect(first.status, await first.clone().text()).toBe(200);
    const firstBody = await first.json() as {
      data: Array<{ id: string; orgId: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(firstBody).toMatchObject({ hasMore: true });
    expect(firstBody.data).toHaveLength(500);
    const second = await app.request(`/custom-field-values?limit=500&cursor=${encodeURIComponent(firstBody.nextCursor!)}`);
    expect(second.status, await second.clone().text()).toBe(200);
    const secondBody = await second.json() as { data: Array<{ id: string; orgId: string }>; hasMore: boolean };
    expect(secondBody).toMatchObject({ hasMore: false });
    expect(secondBody.data).toHaveLength(1);
    const identities = [...firstBody.data, ...secondBody.data].map((row) => `${row.id}:${row.orgId}`);
    expect(new Set(identities).size).toBe(501);
    expect(new Set([...firstBody.data, ...secondBody.data].map((row: any) => row.definitionId)).size).toBe(501);
    expect([...firstBody.data, ...secondBody.data].every((row: any) => row.deviceId === device.id)).toBe(true);

    await db.insert(customFieldDefinitions).values({
      orgId: org.id, name: 'local_admin_password', fieldKey: 'local_admin_password', type: 'text',
    });
    await db.update(devices).set({
      customFields: { ...fieldValues, local_admin_password: 'Summer2026!' },
    }).where(eq(devices.id, device.id));
    const collectExportPages = async (path: string) => {
      const pages: Array<{ blocked?: Array<{ id: string; orgId: string }>; data: unknown[] }> = [];
      let cursor: string | null = null;
      do {
        const response = await app.request(`${path}?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        expect(response.status, await response.clone().text()).toBe(200);
        const body = await response.json() as {
          blocked?: Array<{ id: string; orgId: string }>;
          data: unknown[];
          nextCursor: string | null;
        };
        pages.push(body);
        cursor = body.nextCursor;
      } while (cursor);
      return pages;
    };
    const definitionPages = await collectExportPages('/custom-fields');
    expect(definitionPages.flatMap((page) => page.blocked ?? []))
      .toEqual([expect.objectContaining({ orgId: org.id })]);
    expect(JSON.stringify(definitionPages)).not.toContain('local_admin_password');
    const valuePages = await collectExportPages('/custom-field-values');
    expect(valuePages.flatMap((page) => page.blocked ?? []))
      .toContainEqual(expect.objectContaining({ orgId: org.id }));
    expect(JSON.stringify(valuePages)).not.toContain('Summer2026');
  });

  runDb('all seven routes execute under app-role RLS and cannot expose another partner', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const [device] = await db.insert(devices).values({
      orgId: org.id, siteId: site.id, agentId: `task7-route-${crypto.randomUUID()}`.slice(0, 64),
      hostname: 'task7-route', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1',
      customFields: { rack: 'R01' },
    }).returning();
    if (!device) throw new Error('route device insert failed');
    const [policy] = await db.insert(configurationPolicies).values({ orgId: org.id, name: 'Route policy' }).returning();
    if (!policy) throw new Error('route policy insert failed');
    await db.insert(configPolicyFeatureLinks).values({ configPolicyId: policy.id, featureType: 'patch', inlineSettings: {} });
    await db.insert(configPolicyAssignments).values({ configPolicyId: policy.id, level: 'organization', targetId: org.id });
    await db.insert(scripts).values({ orgId: org.id, name: 'Route script', osTypes: ['linux'], language: 'bash', content: 'true' });
    await db.insert(automations).values({
      orgId: org.id, name: 'Route automation', trigger: { type: 'manual' }, actions: [{ type: 'reboot' }],
    });
    await db.insert(customFieldDefinitions).values({ orgId: org.id, name: 'Rack', fieldKey: 'rack', type: 'text' });

    const foreignPartner = await createPartner();
    const foreignOrg = await createOrganization({ partnerId: foreignPartner.id });
    await db.insert(scripts).values({ orgId: foreignOrg.id, name: 'Foreign script', osTypes: ['linux'], language: 'bash', content: 'true' });

    const app = configurationExportApp(partner.id, org.id);
    for (const path of [
      '/configuration-policies', '/configuration-assignments', '/scripts',
      '/automations', '/backup-configurations', '/custom-fields',
      '/custom-field-values',
    ]) {
      const response = await app.request(path);
      expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
      const body = await response.json() as { data: Array<{ orgId: string }> };
      expect(body.data.every((record) => record.orgId === org.id)).toBe(true);
    }
  });
});

function configurationExportApp(partnerId: string, orgId: string): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('partnerApiPrincipal', {
      partnerServicePrincipalId: crypto.randomUUID(), keyId: crypto.randomUUID(), partnerId,
      name: 'Task 7 integration test',
      scopes: ['configuration:read', 'scripts:read', 'backup-configuration:read', 'custom-fields:read'],
      accessibleOrgIds: [orgId], rateLimit: 600,
    });
    await withDbAccessContext({
      scope: 'partner', orgId: null, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId],
      currentPartnerId: partnerId, userId: null,
    }, async () => {
      await appDb.execute(sql`SELECT public.breeze_partner_export_lock_partners_shared(ARRAY[${partnerId}::uuid])`);
      await next();
    });
  });
  app.route('/', partnerConfigurationRoutes);
  return app;
}

async function stateClock(orgId: string, resource: string): Promise<Date> {
  const [row] = await getTestDb().execute<{ updatedAt: Date | string }>(sql`
    SELECT updated_at AT TIME ZONE 'UTC' AS "updatedAt"
    FROM public.partner_export_configuration_org_state
    WHERE org_id = ${orgId}::uuid AND resource = ${resource}
  `);
  if (!row) throw new Error(`missing ${resource} material clock for ${orgId}`);
  return row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt);
}
