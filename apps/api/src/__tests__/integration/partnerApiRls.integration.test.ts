import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Database, DbAccessContext } from '../../db';
import { db, withDbAccessContext } from '../../db';
import { ensureAppRole } from '../../db/ensureAppRole';
import {
  automations,
  backupConfigs,
  backupProfiles,
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  customFieldDefinitions,
  deviceGroups,
  devices,
  partnerExportConfigurationOrgState,
  partnerExportDeviceMaterialState,
  partnerExportSiteMaterialState,
  organizations,
  scripts,
  servicePrincipals,
  sites,
  softwareInventory,
} from '../../db/schema';
import { partnerApiAuthMiddleware } from '../../middleware/partnerApiAuth';
import { partnerConfigurationRoutes } from '../../routes/partnerApi/configuration';
import {
  decodePartnerExportCursor,
  encodePartnerExportCursor,
} from '../../routes/partnerApi/cursor';
import { partnerDeviceRoutes } from '../../routes/partnerApi/devices';
import { partnerInventoryRoutes } from '../../routes/partnerApi/inventory';
import { partnerOrganizationRoutes } from '../../routes/partnerApi/organizations';
import { partnerRelationshipRoutes } from '../../routes/partnerApi/relationships';
import {
  PARTNER_EXPORT_RESOURCES,
  type PartnerExportResource,
} from '../../routes/partnerApi/schemas';
import { issueServicePrincipalKey } from '../../services/servicePrincipalKeys';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getAppDb, getTestDb } from './setup';

vi.mock('../../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env')>();
  return {
    ...actual,
    PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
  };
});

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-28-config-policy-assignment-target-integrity.sql',
);
const ALL_SCOPES = [
  'organizations:read',
  'sites:read',
  'devices:read',
  'inventory:read',
  'configuration:read',
  'scripts:read',
  'backup-configuration:read',
  'custom-fields:read',
] as const;

const EXPECTED_COUNTS: Record<PartnerExportResource, number> = {
  organizations: 2,
  sites: 2,
  devices: 2,
  'device-inventory': 4,
  'device-software': 2,
  'device-relationships': 4,
  'configuration-policies': 2,
  'configuration-assignments': 2,
  scripts: 2,
  automations: 2,
  'backup-configurations': 2,
  'custom-fields': 2,
  'custom-field-values': 2,
};

interface ExportRecord {
  id: string;
  orgId: string;
  [key: string]: unknown;
}

interface ExportEnvelope {
  schemaVersion: '1';
  snapshotAt: string;
  data: ExportRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface SeededPartner {
  partner: { id: string };
  user: { id: string };
  orgs: Array<{ id: string }>;
  sites: Array<{ id: string; orgId: string }>;
  devices: Array<{ id: string; orgId: string }>;
  groups: Array<{ id: string; orgId: string }>;
  policies: Array<{ id: string }>;
  assignments: Array<{ id: string }>;
  featureLinks: Array<{ id: string }>;
}

describe('partner reconstruction export RLS traversal', () => {
  runDb('cursor-walks every resource through actual auth without crossing partners', async () => {
    await ensureAppRole();
    const partnerA = await seedPartner('A');
    const partnerB = await seedPartner('B');
    const keyA = await issueKey(partnerA.partner.id, partnerA.user.id);
    const keyB = await issueKey(partnerB.partner.id, partnerB.user.id);
    const observedRoles: Array<{ who: string; bypass: boolean }> = [];
    const app = actualPartnerApiApp(observedRoles);
    const allTuples = new Set<string>();
    let traversedPages = 0;

    for (const resource of PARTNER_EXPORT_RESOURCES) {
      const traversal = await walkResource(app, keyA, resource);
      traversedPages += traversal.pages;
      expect(traversal.records).toHaveLength(EXPECTED_COUNTS[resource]);
      expect(new Set(traversal.records.map((record) => record.orgId))).toEqual(
        new Set(partnerA.orgs.map((org) => org.id)),
      );
      expect(JSON.stringify(traversal.records)).not.toContain('B-');

      for (const record of traversal.records) {
        const tuple = `${resource}:${record.id}:${record.orgId}`;
        expect(allTuples.has(tuple), `duplicate partner export tuple ${tuple}`).toBe(false);
        allTuples.add(tuple);
      }
    }

    expect(observedRoles).toHaveLength(traversedPages);
    expect(observedRoles.every((role) => role.who === 'breeze_app' && !role.bypass)).toBe(true);

    const foreignOrg = await app.request(`/organizations?orgId=${partnerB.orgs[0]!.id}`, {
      headers: apiHeaders(keyA),
    });
    expect(foreignOrg.status).toBe(404);

    const foreignSite = await app.request(`/devices?siteId=${partnerB.sites[0]!.id}`, {
      headers: apiHeaders(keyA),
    });
    expect(foreignSite.status).toBe(200);
    expect((await foreignSite.json() as ExportEnvelope).data).toEqual([]);

    const firstA = await getEnvelope(app, keyA, '/organizations?limit=1');
    const firstB = await getEnvelope(app, keyB, '/organizations?limit=1');
    expect(firstA.nextCursor).toBeTruthy();
    expect(firstB.nextCursor).toBeTruthy();
    const decodedA = decodePartnerExportCursor(firstA.nextCursor!, {
      partnerId: partnerA.partner.id,
      resource: 'organizations',
      updatedSince: null,
      filters: { orgId: null, siteId: null },
    });

    const forgedCursors = [
      firstB.nextCursor!,
      encodePartnerExportCursor({ ...decodedA, resource: 'sites' }),
      encodePartnerExportCursor({
        ...decodedA,
        filters: { orgId: partnerA.orgs[0]!.id, siteId: null },
      }),
      tamperSnapshotWithoutResigning(firstA.nextCursor!),
    ];
    for (const cursor of forgedCursors) {
      const response = await app.request(
        `/organizations?limit=1&cursor=${encodeURIComponent(cursor)}`,
        { headers: apiHeaders(keyA) },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'invalid_partner_export_cursor' });
    }
  }, 30_000);

  runDb('keeps material clocks and normalized rows protected after app-role bootstrap', async () => {
    await ensureAppRole();
    const partnerA = await seedPartner('A');
    const partnerB = await seedPartner('B');
    const contextA = partnerContext(partnerA);

    const privileges = await getTestDb().execute<{
      tableName: string;
      canSelect: boolean;
      canInsert: boolean;
      canUpdate: boolean;
      canDelete: boolean;
    }>(sql`
      SELECT table_name AS "tableName",
        has_table_privilege('breeze_app', table_name, 'SELECT') AS "canSelect",
        has_table_privilege('breeze_app', table_name, 'INSERT') AS "canInsert",
        has_table_privilege('breeze_app', table_name, 'UPDATE') AS "canUpdate",
        has_table_privilege('breeze_app', table_name, 'DELETE') AS "canDelete"
      FROM unnest(ARRAY[
        'partner_export_device_material_state',
        'partner_export_site_material_state',
        'partner_export_configuration_org_state'
      ]::text[]) AS table_name
      ORDER BY table_name
    `);
    expect(privileges).toHaveLength(3);
    expect(privileges.every((row) => (
      row.canSelect && !row.canInsert && !row.canUpdate && !row.canDelete
    ))).toBe(true);

    const hidden = await withDbAccessContext(contextA, async () => Promise.all([
      db.select({ id: partnerExportDeviceMaterialState.deviceId })
        .from(partnerExportDeviceMaterialState)
        .where(inArray(partnerExportDeviceMaterialState.orgId, partnerB.orgs.map((org) => org.id))),
      db.select({ id: partnerExportSiteMaterialState.siteId })
        .from(partnerExportSiteMaterialState)
        .where(inArray(partnerExportSiteMaterialState.orgId, partnerB.orgs.map((org) => org.id))),
      db.select({ id: partnerExportConfigurationOrgState.orgId })
        .from(partnerExportConfigurationOrgState)
        .where(inArray(partnerExportConfigurationOrgState.orgId, partnerB.orgs.map((org) => org.id))),
      db.select({ id: configPolicyAssignments.id })
        .from(configPolicyAssignments)
        .where(inArray(configPolicyAssignments.id, partnerB.assignments.map((row) => row.id))),
      db.select({ id: configPolicyFeatureLinks.id })
        .from(configPolicyFeatureLinks)
        .where(inArray(configPolicyFeatureLinks.id, partnerB.featureLinks.map((row) => row.id))),
    ]));
    expect(hidden.every((rows) => rows.length === 0)).toBe(true);

    const assignmentError = await captureSqlState(() => withDbAccessContext(contextA, () =>
      db.insert(configPolicyAssignments).values({
        configPolicyId: partnerA.policies[0]!.id,
        level: 'organization',
        targetId: partnerB.orgs[0]!.id,
      }),
    ));

    const [foreignProfile] = await getTestDb().insert(backupProfiles).values({
      orgId: partnerB.orgs[0]!.id,
      name: 'B-foreign-reference-profile',
      selections: {},
    }).returning();
    if (!foreignProfile) throw new Error('foreign backup profile seed failed');
    const referenceError = await captureSqlState(() => withDbAccessContext(contextA, () =>
      db.insert(configPolicyFeatureLinks).values({
        configPolicyId: partnerA.policies[0]!.id,
        featureType: 'backup',
        featurePolicyId: foreignProfile.id,
      }),
    ));
    expect(assignmentError).toBeTruthy();
    expect(referenceError).toBeTruthy();
  }, 20_000);

  runDb('enforces every target level and rejects reverse owner forges', async () => {
    const admin = getTestDb();
    const partnerA = await seedPartner('A');
    const partnerB = await seedPartner('B');
    const contextA = partnerContext(partnerA);
    const [orgPolicy, partnerPolicy] = await admin.insert(configurationPolicies).values([
      { orgId: partnerA.orgs[0]!.id, name: 'A-org-target-policy' },
      { partnerId: partnerA.partner.id, name: 'A-partner-target-policy' },
    ]).returning();
    if (!orgPolicy || !partnerPolicy) throw new Error('target policy seed failed');

    const targetSets = [
      {
        level: 'partner' as const,
        local: partnerA.partner.id,
        samePartnerOther: partnerA.partner.id,
        foreign: partnerB.partner.id,
      },
      {
        level: 'organization' as const,
        local: partnerA.orgs[0]!.id,
        samePartnerOther: partnerA.orgs[1]!.id,
        foreign: partnerB.orgs[0]!.id,
      },
      {
        level: 'site' as const,
        local: partnerA.sites[0]!.id,
        samePartnerOther: partnerA.sites[1]!.id,
        foreign: partnerB.sites[0]!.id,
      },
      {
        level: 'device_group' as const,
        local: partnerA.groups[0]!.id,
        samePartnerOther: partnerA.groups[1]!.id,
        foreign: partnerB.groups[0]!.id,
      },
      {
        level: 'device' as const,
        local: partnerA.devices[0]!.id,
        samePartnerOther: partnerA.devices[1]!.id,
        foreign: partnerB.devices[0]!.id,
      },
    ];

    for (const targets of targetSets) {
      await expect(withDbAccessContext(contextA, () => db.insert(configPolicyAssignments).values({
        configPolicyId: orgPolicy.id,
        level: targets.level,
        targetId: targets.local,
      }))).resolves.toBeDefined();
      await expect(withDbAccessContext(contextA, () => db.insert(configPolicyAssignments).values({
        configPolicyId: partnerPolicy.id,
        level: targets.level,
        targetId: targets.samePartnerOther,
      }))).resolves.toBeDefined();

      if (targets.level !== 'partner') {
        expect(await captureSqlState(() => withDbAccessContext(contextA, () =>
          db.insert(configPolicyAssignments).values({
            configPolicyId: orgPolicy.id,
            level: targets.level,
            targetId: targets.samePartnerOther,
          }),
        ))).toBe('23503');
      }
      expect(await captureSqlState(() => withDbAccessContext(contextA, () =>
        db.insert(configPolicyAssignments).values({
          configPolicyId: partnerPolicy.id,
          level: targets.level,
          targetId: targets.foreign,
        }),
      ))).toBe('23503');
    }

    const movableSite = await createSite({ orgId: partnerA.orgs[0]!.id, name: 'A-movable-site' });
    await withDbAccessContext(contextA, () => db.insert(configPolicyAssignments).values({
      configPolicyId: orgPolicy.id, level: 'site', targetId: movableSite.id,
    }));
    expect(await captureSqlState(() => admin.update(sites)
      .set({ orgId: partnerA.orgs[1]!.id }).where(eq(sites.id, movableSite.id))))
      .toBe('23503');
    expect(await captureSqlState(() => admin.delete(sites)
      .where(eq(sites.id, movableSite.id))))
      .toBe('23503');

    expect(await captureSqlState(() => admin.update(deviceGroups)
      .set({ orgId: partnerA.orgs[1]!.id }).where(eq(deviceGroups.id, partnerA.groups[0]!.id))))
      .toBe('23503');
    const [movableDevice] = await admin.insert(devices).values({
      orgId: partnerA.orgs[0]!.id,
      siteId: partnerA.sites[0]!.id,
      agentId: `assignment-move-${crypto.randomUUID()}`.slice(0, 64),
      hostname: 'A-movable-device',
      osType: 'linux',
      osVersion: '1',
      architecture: 'amd64',
      agentVersion: '1',
    }).returning();
    if (!movableDevice) throw new Error('movable device seed failed');
    await withDbAccessContext(contextA, () => db.insert(configPolicyAssignments).values({
      configPolicyId: orgPolicy.id, level: 'device', targetId: movableDevice.id,
    }));
    expect(await captureSqlState(() => admin.update(devices).set({
      orgId: partnerA.orgs[1]!.id,
      siteId: partnerA.sites[1]!.id,
    }).where(eq(devices.id, movableDevice.id)))).toBe('23503');
    expect(await captureSqlState(() => admin.update(configurationPolicies)
      .set({ orgId: partnerA.orgs[1]!.id }).where(eq(configurationPolicies.id, orgPolicy.id))))
      .toBe('23503');

    const movableOrg = await createOrganization({
      partnerId: partnerA.partner.id,
      name: 'A-movable-organization',
    });
    await withDbAccessContext(contextA, () => db.insert(configPolicyAssignments).values({
      configPolicyId: partnerPolicy.id, level: 'organization', targetId: movableOrg.id,
    }));
    expect(await captureSqlState(() => admin.update(organizations)
      .set({ partnerId: partnerB.partner.id })
      .where(eq(organizations.id, movableOrg.id))))
      .toBe('23503');
  }, 30_000);

  runDb('is idempotent, keeps helpers private, and aborts forged preflight rows as breeze_app', async () => {
    const admin = getTestDb();
    const migration = readFileSync(MIGRATION_FILE, 'utf8');
    await expect(admin.execute(sql.raw(migration))).resolves.toBeDefined();
    await expect(admin.execute(sql.raw(migration))).resolves.toBeDefined();
    await ensureAppRole();

    const [privileges] = await admin.execute<{
      validate: boolean;
      enforce: boolean;
      revalidate: boolean;
    }>(sql`
      SELECT
        has_function_privilege('breeze_app', 'public.breeze_validate_config_policy_assignment_target(uuid,text,uuid)', 'EXECUTE') AS validate,
        has_function_privilege('breeze_app', 'public.breeze_enforce_config_policy_assignment_target()', 'EXECUTE') AS enforce,
        has_function_privilege('breeze_app', 'public.breeze_revalidate_config_policy_assignment_targets()', 'EXECUTE') AS revalidate
    `);
    expect(privileges).toEqual({ validate: false, enforce: false, revalidate: false });

    const partnerA = await seedPartner('A');
    const partnerB = await seedPartner('B');
    let forgedId: string | undefined;
    await admin.execute(sql`ALTER TABLE public.config_policy_assignments DISABLE TRIGGER USER`);
    try {
      const [forged] = await admin.insert(configPolicyAssignments).values({
        configPolicyId: partnerA.policies[0]!.id,
        level: 'organization',
        targetId: partnerB.orgs[0]!.id,
      }).returning({ id: configPolicyAssignments.id });
      forgedId = forged?.id;
    } finally {
      await admin.execute(sql`ALTER TABLE public.config_policy_assignments ENABLE TRIGGER USER`);
    }
    if (!forgedId) throw new Error('preflight forge seed failed');
    try {
      await expect(getAppDb().execute(sql.raw(migration)))
        .rejects.toMatchObject({ cause: expect.objectContaining({ code: '23514' }) });
    } finally {
      await admin.delete(configPolicyAssignments).where(eq(configPolicyAssignments.id, forgedId));
    }
  }, 30_000);
});

async function seedPartner(label: 'A' | 'B'): Promise<SeededPartner> {
  const admin = getTestDb();
  const partner = await createPartner({ name: `${label}-Partner` });
  const user = await createUser({ partnerId: partner.id });
  const orgs = [];
  const sites = [];
  const seededDevices = [];
  const groups = [];
  const policies = [];
  const assignments = [];
  const featureLinks = [];

  for (let index = 1; index <= 2; index += 1) {
    const org = await createOrganization({
      partnerId: partner.id,
      name: `${label}-Organization-${index}`,
    });
    const site = await createSite({ orgId: org.id, name: `${label}-Site-${index}` });
    const fieldKey = `rack_${label.toLowerCase()}_${index}`;
    await admin.insert(customFieldDefinitions).values({
      orgId: org.id,
      name: `${label}-Rack-${index}`,
      fieldKey,
      type: 'text',
    });
    const [device] = await admin.insert(devices).values({
      orgId: org.id,
      siteId: site.id,
      agentId: `${label.toLowerCase()}-${index}-${crypto.randomUUID()}`.slice(0, 64),
      hostname: `${label}-device-${index}`,
      osType: 'linux',
      osVersion: 'Ubuntu 24.04',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      customFields: { [fieldKey]: `${label}-rack-value-${index}` },
    }).returning();
    if (!device) throw new Error('device seed failed');
    const [group] = await admin.insert(deviceGroups).values({
      orgId: org.id,
      siteId: site.id,
      name: `${label}-Group-${index}`,
    }).returning();
    if (!group) throw new Error('device group seed failed');
    await admin.insert(softwareInventory).values({
      deviceId: device.id,
      orgId: org.id,
      name: `${label}-Software-${index}`,
      version: '1.0.0',
      vendor: `${label}-Vendor`,
    });

    const [policy] = await admin.insert(configurationPolicies).values({
      orgId: org.id,
      name: `${label}-Policy-${index}`,
      status: 'active',
    }).returning();
    if (!policy) throw new Error('configuration policy seed failed');
    const [assignment] = await admin.insert(configPolicyAssignments).values({
      configPolicyId: policy.id,
      level: 'organization',
      targetId: org.id,
      priority: index,
    }).returning();
    if (!assignment) throw new Error('configuration assignment seed failed');
    const [featureLink] = await admin.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy.id,
      featureType: 'monitoring',
      inlineSettings: { intervalMinutes: 5 },
    }).returning();
    if (!featureLink) throw new Error('configuration feature link seed failed');
    await admin.insert(scripts).values({
      orgId: org.id,
      name: `${label}-Script-${index}`,
      osTypes: ['linux'],
      language: 'bash',
      content: 'printf rebuild-complete',
    });
    await admin.insert(automations).values({
      orgId: org.id,
      name: `${label}-Automation-${index}`,
      trigger: { type: 'manual' },
      actions: [],
    });
    await admin.insert(backupConfigs).values({
      orgId: org.id,
      name: `${label}-Backup-${index}`,
      type: 'system_image',
      provider: 's3',
      providerConfig: { bucket: `${label.toLowerCase()}-fixture` },
    });

    orgs.push(org);
    sites.push(site);
    seededDevices.push(device);
    groups.push(group);
    policies.push(policy);
    assignments.push(assignment);
    featureLinks.push(featureLink);
  }

  return {
    partner,
    user,
    orgs,
    sites,
    devices: seededDevices,
    groups,
    policies,
    assignments,
    featureLinks,
  };
}

async function issueKey(partnerId: string, userId: string): Promise<string> {
  const admin = getTestDb();
  const [principal] = await admin.insert(servicePrincipals).values({
    partnerId,
    name: `Reconstruction export ${crypto.randomUUID()}`,
    scopes: [...ALL_SCOPES],
    createdBy: userId,
    updatedBy: userId,
  }).returning();
  if (!principal) throw new Error('service principal seed failed');
  return (await issueServicePrincipalKey(admin as unknown as Database, {
    servicePrincipalId: principal.id,
    partnerId,
    name: 'Integration traversal key',
    actorId: userId,
  })).rawKey;
}

function actualPartnerApiApp(observedRoles: Array<{ who: string; bypass: boolean }>): Hono {
  const app = new Hono();
  app.use('*', partnerApiAuthMiddleware);
  app.use('*', async (_c, next) => {
    const [role] = await db.execute<{ who: string; bypass: boolean }>(sql`
      SELECT current_user AS who, rolbypassrls AS bypass
      FROM pg_roles WHERE rolname = current_user
    `);
    if (!role) throw new Error('app role probe returned no row');
    observedRoles.push(role);
    await next();
  });
  app.route('/', partnerOrganizationRoutes);
  app.route('/', partnerDeviceRoutes);
  app.route('/', partnerInventoryRoutes);
  app.route('/', partnerRelationshipRoutes);
  app.route('/', partnerConfigurationRoutes);
  return app;
}

async function walkResource(app: Hono, rawKey: string, resource: PartnerExportResource) {
  const records: ExportRecord[] = [];
  const snapshots = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const query = new URLSearchParams({ limit: '1' });
    if (cursor) query.set('cursor', cursor);
    const envelope = await getEnvelope(app, rawKey, `/${resource}?${query}`);
    expect(envelope.schemaVersion).toBe('1');
    expect(envelope.hasMore).toBe(envelope.nextCursor !== null);
    snapshots.add(envelope.snapshotAt);
    records.push(...envelope.data);
    cursor = envelope.nextCursor;
    pages += 1;
    expect(pages).toBeLessThan(20);
  } while (cursor);
  expect(snapshots.size).toBe(1);
  return { records, pages };
}

async function getEnvelope(app: Hono, rawKey: string, path: string): Promise<ExportEnvelope> {
  const response = await app.request(path, { headers: apiHeaders(rawKey) });
  expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
  return response.json() as Promise<ExportEnvelope>;
}

function apiHeaders(rawKey: string) {
  return { 'X-API-Key': rawKey };
}

function tamperSnapshotWithoutResigning(token: string): string {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw new Error('expected two-part cursor');
  const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  value.snapshotAt = new Date(Date.parse(String(value.snapshotAt)) + 1_000).toISOString();
  return `${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}.${signature}`;
}

function partnerContext(seed: SeededPartner): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: seed.orgs.map((org) => org.id),
    accessiblePartnerIds: [seed.partner.id],
    userId: seed.user.id,
  };
}

async function captureSqlState(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    const wrapped = error as { code?: string; cause?: { code?: string } };
    return wrapped.cause?.code ?? wrapped.code;
  }
}
