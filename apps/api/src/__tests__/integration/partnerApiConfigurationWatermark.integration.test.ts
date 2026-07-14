import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { db as appDb, withDbAccessContext } from '../../db';
import { ensureAppRole } from '../../db/ensureAppRole';
import {
  automations,
  backupConfigs,
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  customFieldDefinitions,
  devices,
  partnerExportConfigurationOrgState,
  scripts,
} from '../../db/schema';
import { partnerConfigurationRoutes } from '../../routes/partnerApi/configuration';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-24-partner-export-configuration-material-state.sql',
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
    await db.update(automations).set({ lastRunAt: new Date(), runCount: 1 }).where(eq(automations.id, automation.id));
    expect(await stateClock(org.id, 'automations')).toEqual(automationBefore);

    const [destination] = await db.insert(backupConfigs).values({
      orgId: org.id, name: 'Provider-only destination', type: 'file', provider: 's3',
      providerConfig: { endpoint: 'https://storage.example.test' },
    }).returning();
    if (!destination) throw new Error('backup destination insert failed');
    const backupBefore = await stateClock(org.id, 'backup-configurations');
    await db.update(backupConfigs).set({
      providerCapabilities: { multipart: true }, providerCapabilitiesCheckedAt: new Date(),
    }).where(eq(backupConfigs.id, destination.id));
    expect(await stateClock(org.id, 'backup-configurations')).toEqual(backupBefore);
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

  runDb('all six routes execute under app-role RLS and cannot expose another partner', async () => {
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
      servicePrincipalId: crypto.randomUUID(), keyId: crypto.randomUUID(), partnerId,
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
    SELECT updated_at AS "updatedAt"
    FROM public.partner_export_configuration_org_state
    WHERE org_id = ${orgId}::uuid AND resource = ${resource}
  `);
  if (!row) throw new Error(`missing ${resource} material clock for ${orgId}`);
  return row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt);
}
