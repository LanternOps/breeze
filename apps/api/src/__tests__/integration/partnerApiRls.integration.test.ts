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
  partnerServicePrincipals,
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
import { issuePartnerServicePrincipalKey } from '../../services/partnerServicePrincipalKeys';
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
const SERIALIZATION_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-29-serialize-config-policy-assignment-integrity.sql',
);
const BULK_SERIALIZATION_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-30-serialize-bulk-config-assignment-target-moves.sql',
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
  'custom-fields': 4,
  'custom-field-values': 4,
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
    const [partnerA, partnerB] = await seedInterleavedPartners();
    const [partnerField] = await getTestDb().insert(customFieldDefinitions).values({
      partnerId: partnerA.partner.id,
      name: 'A-Partner-Inventory-Label',
      fieldKey: 'partner_inventory_label',
      type: 'text',
    }).returning();
    if (!partnerField) throw new Error('partner custom field seed failed');
    for (const [index, device] of partnerA.devices.entries()) {
      await getTestDb().update(devices).set({
        customFields: {
          [`rack_a_${index + 1}`]: `A-rack-value-${index + 1}`,
          partner_inventory_label: `A-partner-value-${index + 1}`,
        },
      }).where(eq(devices.id, device.id));
    }
    const keyA = await issueKey(partnerA.partner.id, partnerA.user.id);
    const keyB = await issueKey(partnerB.partner.id, partnerB.user.id);
    const observedRoles: Array<{ who: string; bypass: boolean }> = [];
    const app = actualPartnerApiApp(observedRoles);
    const allTuples = new Set<string>();
    const traversals = new Map<PartnerExportResource, ExportRecord[]>();
    let traversedPages = 0;

    for (const resource of PARTNER_EXPORT_RESOURCES) {
      const traversal = await walkResource(app, keyA, resource);
      traversedPages += traversal.pages;
      expect(traversal.records).toHaveLength(EXPECTED_COUNTS[resource]);
      expect(new Set(traversal.records.map((record) => record.orgId))).toEqual(
        new Set(partnerA.orgs.map((org) => org.id)),
      );
      expect(JSON.stringify(traversal.records)).not.toContain('B-');
      traversals.set(resource, traversal.records);

      for (const record of traversal.records) {
        const tuple = `${resource}:${record.id}:${record.orgId}`;
        expect(allTuples.has(tuple), `duplicate partner export tuple ${tuple}`).toBe(false);
        allTuples.add(tuple);
      }
    }

    const fannedDefinitions = traversals.get('custom-fields')!
      .filter((record) => record.id === partnerField.id);
    expect(fannedDefinitions).toHaveLength(2);
    expect(new Set(fannedDefinitions.map((record) => record.orgId))).toEqual(
      new Set(partnerA.orgs.map((org) => org.id)),
    );

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
    expect(await captureSqlState(() => admin.delete(deviceGroups)
      .where(eq(deviceGroups.id, partnerA.groups[0]!.id))))
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
    expect(await captureSqlState(() => admin.delete(devices)
      .where(eq(devices.id, movableDevice.id))))
      .toBe('23503');
    expect(await captureSqlState(() => admin.update(configurationPolicies)
      .set({ orgId: partnerA.orgs[1]!.id }).where(eq(configurationPolicies.id, orgPolicy.id))))
      .toBe('23503');
    expect(await captureSqlState(() => admin.update(configurationPolicies)
      .set({ partnerId: partnerB.partner.id }).where(eq(configurationPolicies.id, partnerPolicy.id))))
      .toBe('23503');

    const [updatableAssignment] = await withDbAccessContext(contextA, () =>
      db.insert(configPolicyAssignments).values({
        configPolicyId: partnerPolicy.id,
        level: 'organization',
        targetId: partnerA.orgs[0]!.id,
      }).returning());
    if (!updatableAssignment) throw new Error('updatable assignment seed failed');
    expect(await captureSqlState(() => withDbAccessContext(contextA, () =>
      db.update(configPolicyAssignments).set({ targetId: partnerB.orgs[0]!.id })
        .where(eq(configPolicyAssignments.id, updatableAssignment.id)),
    ))).toBe('23503');

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
    expect(await captureSqlState(() => admin.delete(organizations)
      .where(eq(organizations.id, movableOrg.id))))
      .toBe('23503');
  }, 30_000);

  runDb('serializes concurrent target and policy owner moves before assignment validation', async () => {
    const admin = getTestDb();
    const first = await seedPartner('A');
    const second = await seedPartner('B');
    const ordered = [first, second].sort((left, right) =>
      left.partner.id.localeCompare(right.partner.id));
    const low = ordered[0]!;
    const high = ordered[1]!;

    for (const [source, target] of [[low, high], [high, low]] as const) {
      const context = partnerContext(source);
      const site = await createSite({ orgId: source.orgs[0]!.id, name: 'Concurrent target site' });
      const [policy] = await admin.insert(configurationPolicies).values({
        orgId: source.orgs[0]!.id,
        name: 'Concurrent target policy',
      }).returning();
      if (!policy) throw new Error('concurrent target policy seed failed');

      const targetMove = deferred<void>();
      const releaseTargetMove = deferred<void>();
      const mover = admin.transaction(async (tx) => {
        await tx.update(sites).set({ orgId: target.orgs[0]!.id }).where(eq(sites.id, site.id));
        targetMove.resolve();
        await releaseTargetMove.promise;
      });
      await targetMove.promise;
      const assignment = captureSqlState(() => withDbAccessContext(context, () =>
        db.insert(configPolicyAssignments).values({
          configPolicyId: policy.id,
          level: 'site',
          targetId: site.id,
        }),
      ));
      await waitForPartnerExportWaiter();
      releaseTargetMove.resolve();
      await mover;
      expect(await assignment).toBe('23503');

      const ownerMove = deferred<void>();
      const releaseOwnerMove = deferred<void>();
      const [movingPolicy] = await admin.insert(configurationPolicies).values({
        orgId: source.orgs[0]!.id,
        name: 'Concurrent owner policy',
      }).returning();
      if (!movingPolicy) throw new Error('concurrent owner policy seed failed');
      const policyMover = admin.transaction(async (tx) => {
        await tx.update(configurationPolicies).set({ orgId: target.orgs[0]!.id })
          .where(eq(configurationPolicies.id, movingPolicy.id));
        ownerMove.resolve();
        await releaseOwnerMove.promise;
      });
      await ownerMove.promise;
      const ownerAssignment = captureSqlState(() => withDbAccessContext(context, () =>
        db.insert(configPolicyAssignments).values({
          configPolicyId: movingPolicy.id,
          level: 'organization',
          targetId: source.orgs[0]!.id,
        }),
      ));
      await waitForPartnerExportWaiter();
      releaseOwnerMove.resolve();
      await policyMover;
      expect(await ownerAssignment).toBe('23503');

      const bulkSourceSite = await createSite({
        orgId: source.orgs[0]!.id,
        name: 'Concurrent bulk source site',
      });
      const bulkOtherSite = await createSite({
        orgId: target.orgs[0]!.id,
        name: 'Concurrent bulk other site',
      });
      const [bulkPolicy] = await admin.insert(configurationPolicies).values({
        orgId: source.orgs[0]!.id,
        name: 'Concurrent bulk policy',
      }).returning();
      if (!bulkPolicy) throw new Error('concurrent bulk policy seed failed');
      const bulkMove = deferred<void>();
      const releaseBulkMove = deferred<void>();
      const bulkMover = admin.transaction(async (tx) => {
        await tx.update(sites).set({
          orgId: sql`CASE WHEN ${sites.id} = ${bulkSourceSite.id}::uuid
            THEN ${source.orgs[1]!.id}::uuid ELSE ${target.orgs[1]!.id}::uuid END`,
        }).where(inArray(sites.id, [bulkSourceSite.id, bulkOtherSite.id]));
        bulkMove.resolve();
        await releaseBulkMove.promise;
      });
      await bulkMove.promise;
      const bulkAssignment = captureSqlState(() => withDbAccessContext(context, () =>
        db.insert(configPolicyAssignments).values({
          configPolicyId: bulkPolicy.id,
          level: 'site',
          targetId: bulkSourceSite.id,
        }),
      ));
      await waitForPartnerExportWaiter();
      releaseBulkMove.resolve();
      await bulkMover;
      expect(await bulkAssignment).toBe('23503');
    }
  }, 30_000);

  runDb('serializes complete bulk owner sets across partners and descending organizations', async () => {
    const admin = getTestDb();
    const first = await seedPartner('A');
    const second = await seedPartner('B');
    const orderedPartners = [first, second].sort((left, right) =>
      left.partner.id.localeCompare(right.partner.id));

    for (const seeds of [orderedPartners, [...orderedPartners].reverse()]) {
      const movingSites = [];
      for (const seed of seeds) {
        movingSites.push(await createSite({
          orgId: seed.orgs[0]!.id,
          name: `Bulk site ${crypto.randomUUID()}`,
        }));
      }
      await expect(admin.update(sites).set({
        orgId: sql`CASE
          WHEN ${sites.id} = ${movingSites[0]!.id}::uuid THEN ${seeds[0]!.orgs[1]!.id}::uuid
          ELSE ${seeds[1]!.orgs[1]!.id}::uuid
        END`,
      }).where(inArray(sites.id, movingSites.map((site) => site.id)))).resolves.toBeDefined();
      await expect(admin.delete(sites)
        .where(inArray(sites.id, movingSites.map((site) => site.id)))).resolves.toBeDefined();
    }

    const samePartnerOrgs = [
      ...first.orgs,
      await createOrganization({ partnerId: first.partner.id, name: 'Bulk third org' }),
    ].sort((left, right) => left.id.localeCompare(right.id));
    const descendingSites = [
      await createSite({ orgId: samePartnerOrgs[2]!.id, name: 'Descending high site' }),
      await createSite({ orgId: samePartnerOrgs[1]!.id, name: 'Descending middle site' }),
    ];
    await expect(admin.update(sites).set({
      orgId: sql`CASE
        WHEN ${sites.id} = ${descendingSites[0]!.id}::uuid THEN ${samePartnerOrgs[1]!.id}::uuid
        ELSE ${samePartnerOrgs[0]!.id}::uuid
      END`,
    }).where(inArray(sites.id, descendingSites.map((site) => site.id)))).resolves.toBeDefined();

    const [policyA, policyB] = await admin.insert(configurationPolicies).values([
      { partnerId: first.partner.id, name: 'Bulk partner policy A' },
      { partnerId: second.partner.id, name: 'Bulk partner policy B' },
    ]).returning();
    if (!policyA || !policyB) throw new Error('bulk policy seed failed');
    await expect(admin.update(configurationPolicies).set({
      partnerId: sql`CASE
        WHEN ${configurationPolicies.id} = ${policyA.id}::uuid THEN ${second.partner.id}::uuid
        ELSE ${first.partner.id}::uuid
      END`,
    }).where(inArray(configurationPolicies.id, [policyA.id, policyB.id]))).resolves.toBeDefined();
    await expect(admin.delete(configurationPolicies)
      .where(inArray(configurationPolicies.id, [policyA.id, policyB.id]))).resolves.toBeDefined();

    const emptyOrgs = [
      await createOrganization({ partnerId: first.partner.id, name: 'Bulk empty org A' }),
      await createOrganization({ partnerId: second.partner.id, name: 'Bulk empty org B' }),
    ];
    await expect(admin.update(organizations).set({
      partnerId: sql`CASE
        WHEN ${organizations.id} = ${emptyOrgs[0]!.id}::uuid THEN ${second.partner.id}::uuid
        ELSE ${first.partner.id}::uuid
      END`,
    }).where(inArray(organizations.id, emptyOrgs.map((org) => org.id)))).resolves.toBeDefined();
    await expect(admin.delete(organizations)
      .where(inArray(organizations.id, emptyOrgs.map((org) => org.id)))).resolves.toBeDefined();

    const [groupA, groupB] = await admin.insert(deviceGroups).values([
      { orgId: first.orgs[0]!.id, siteId: first.sites[0]!.id, name: 'Bulk group A' },
      { orgId: second.orgs[0]!.id, siteId: second.sites[0]!.id, name: 'Bulk group B' },
    ]).returning();
    if (!groupA || !groupB) throw new Error('bulk group seed failed');
    await expect(admin.update(deviceGroups).set({
      orgId: sql`CASE
        WHEN ${deviceGroups.id} = ${groupA.id}::uuid THEN ${first.orgs[1]!.id}::uuid
        ELSE ${second.orgs[1]!.id}::uuid
      END`,
      siteId: sql`CASE
        WHEN ${deviceGroups.id} = ${groupA.id}::uuid THEN ${first.sites[1]!.id}::uuid
        ELSE ${second.sites[1]!.id}::uuid
      END`,
    }).where(inArray(deviceGroups.id, [groupA.id, groupB.id]))).resolves.toBeDefined();
    await expect(admin.delete(deviceGroups)
      .where(inArray(deviceGroups.id, [groupA.id, groupB.id]))).resolves.toBeDefined();

    const movingDevices = [first, second].map((seed, index) => ({
      id: seed.devices[0]!.id,
      index,
    }));
    await expect(admin.update(devices).set({
      hostname: sql`CASE WHEN ${devices.id} = ${movingDevices[0]!.id}::uuid
        THEN 'Bulk device A' ELSE 'Bulk device B' END`,
    }).where(inArray(devices.id, movingDevices.map((device) => device.id)))).resolves.toBeDefined();
  }, 30_000);

  runDb('composes ordinary export locks with valid and invalid assignment writes', async () => {
    const admin = getTestDb();
    const partnerA = await seedPartner('A');
    const partnerB = await seedPartner('B');
    const [policy] = await admin.insert(configurationPolicies).values({
      orgId: partnerA.orgs[0]!.id,
      name: 'Export-lock composition policy',
    }).returning();
    if (!policy) throw new Error('composition policy seed failed');

    await expect(admin.transaction(async (tx) => {
      await tx.update(sites).set({ name: 'Valid export-lock mutation' })
        .where(eq(sites.id, partnerA.sites[0]!.id));
      await tx.insert(configPolicyAssignments).values({
        configPolicyId: policy.id,
        level: 'site',
        targetId: partnerA.sites[0]!.id,
      });
    })).resolves.toBeUndefined();

    expect(await captureSqlState(() => admin.transaction(async (tx) => {
      await tx.update(sites).set({ name: 'Invalid export-lock mutation' })
        .where(eq(sites.id, partnerA.sites[1]!.id));
      await tx.insert(configPolicyAssignments).values({
        configPolicyId: policy.id,
        level: 'site',
        targetId: partnerB.sites[0]!.id,
      });
    }))).toBe('23503');
  }, 20_000);

  runDb('resolves FORCE-RLS owners via in-body system elevation for a non-bypass definer', async () => {
    const admin = getTestDb();
    const [current] = await admin.execute<{ roleName: string }>(sql`
      SELECT current_user AS "roleName"
    `);
    if (!current) throw new Error('database owner probe failed');
    const ownerRole = 'breeze_assignment_validator_owner';
    await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${ownerRole}`));
    await admin.execute(sql.raw(`CREATE ROLE ${ownerRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`));
    try {
      await admin.execute(sql.raw(`
        GRANT USAGE ON SCHEMA public TO ${ownerRole};
        GRANT SELECT ON public.config_policy_assignments, public.configuration_policies,
          public.organizations, public.sites, public.device_groups, public.devices TO ${ownerRole};
        GRANT UPDATE ON public.configuration_policies, public.organizations,
          public.sites, public.device_groups, public.devices TO ${ownerRole};
        GRANT EXECUTE ON FUNCTION public.breeze_partner_export_lock_partners_exclusive(uuid[]),
          public.breeze_partner_export_lock_orgs_under_exclusive_partners(uuid[], uuid[])
          TO ${ownerRole};
        ALTER FUNCTION public.breeze_validate_config_policy_assignment_target(uuid, text, uuid) OWNER TO ${ownerRole};
        ALTER FUNCTION public.breeze_validate_config_policy_assignment_new_rows(jsonb[]) OWNER TO ${ownerRole};
        ALTER FUNCTION public.breeze_enforce_config_policy_assignment_integrity() OWNER TO ${ownerRole};
        ALTER FUNCTION public.breeze_serialize_config_policy_assignment_owner_updates() OWNER TO ${ownerRole};
        ALTER FUNCTION public.breeze_serialize_config_policy_assignment_owner_deletes() OWNER TO ${ownerRole};
      `));

      const [roleFlags] = await admin.execute<{ superuser: boolean; bypass: boolean }>(sql.raw(`
        SELECT rolsuper AS superuser, rolbypassrls AS bypass
        FROM pg_catalog.pg_roles WHERE rolname = '${ownerRole}'
      `));
      expect(roleFlags).toEqual({ superuser: false, bypass: false });
      const configured = await admin.execute<{ name: string; config: string[] }>(sql`
        SELECT proname AS name, proconfig AS config
        FROM pg_catalog.pg_proc
        WHERE proname IN (
          'breeze_validate_config_policy_assignment_target',
          'breeze_validate_config_policy_assignment_new_rows',
          'breeze_enforce_config_policy_assignment_integrity',
          'breeze_serialize_config_policy_assignment_owner_updates',
          'breeze_serialize_config_policy_assignment_owner_deletes'
        )
      `);
      expect(configured).toHaveLength(5);
      // Elevation moved into the function bodies (set_config save/restore):
      // prod's non-superuser migration role cannot SET custom GUCs as
      // function attributes (42501), so proconfig must stay breeze.*-free.
      expect(configured.every((fn) =>
        fn.config.includes('search_path=pg_catalog, public')
        && !fn.config.some((entry) => entry.startsWith('breeze.')),
      )).toBe(true);

      const partnerA = await seedPartner('A');
      const partnerB = await seedPartner('B');
      const [policy] = await admin.insert(configurationPolicies).values({
        partnerId: partnerA.partner.id,
        name: 'Non-bypass definer policy',
      }).returning();
      if (!policy) throw new Error('non-bypass policy seed failed');

      const insertedIds: string[] = [];
      for (const [index, callerScope] of ['', 'org'].entries()) {
        await admin.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_catalog.set_config('breeze.scope', ${callerScope}, true)`);
          await tx.execute(sql`SELECT pg_catalog.set_config(
            'breeze.accessible_org_ids', ${partnerB.orgs[0]!.id}, true
          )`);
          await tx.execute(sql`SELECT pg_catalog.set_config(
            'breeze.accessible_partner_ids', ${partnerB.partner.id}, true
          )`);
          const [assignment] = await tx.insert(configPolicyAssignments).values({
            configPolicyId: policy.id,
            level: 'organization',
            targetId: partnerA.orgs[index]!.id,
          }).returning({ id: configPolicyAssignments.id });
          if (!assignment) throw new Error('non-bypass assignment insert failed');
          insertedIds.push(assignment.id);
        });
      }
      await admin.delete(configPolicyAssignments)
        .where(inArray(configPolicyAssignments.id, insertedIds));
    } finally {
      const quotedCurrent = `"${current.roleName.replaceAll('"', '""')}"`;
      await admin.execute(sql.raw(`REASSIGN OWNED BY ${ownerRole} TO ${quotedCurrent}`));
      await admin.execute(sql.raw(`DROP OWNED BY ${ownerRole}`));
      await admin.execute(sql.raw(`DROP ROLE ${ownerRole}`));
    }
  }, 30_000);

  runDb('is idempotent, keeps helpers private, and aborts forged preflight rows as breeze_app', async () => {
    const admin = getTestDb();
    const migration = readFileSync(MIGRATION_FILE, 'utf8');
    const serializationMigration = readFileSync(SERIALIZATION_MIGRATION_FILE, 'utf8');
    const bulkSerializationMigration = readFileSync(BULK_SERIALIZATION_MIGRATION_FILE, 'utf8');
    await expect(admin.execute(sql.raw(migration))).resolves.toBeDefined();
    await expect(admin.execute(sql.raw(serializationMigration))).resolves.toBeDefined();
    await expect(admin.execute(sql.raw(bulkSerializationMigration))).resolves.toBeDefined();
    await expect(admin.execute(sql.raw(migration))).resolves.toBeDefined();
    await expect(admin.execute(sql.raw(serializationMigration))).resolves.toBeDefined();
    await expect(admin.execute(sql.raw(bulkSerializationMigration))).resolves.toBeDefined();
    await ensureAppRole();

    const [privileges] = await admin.execute<{ helpersPrivate: boolean }>(sql`
      SELECT bool_and(NOT has_function_privilege('breeze_app', signature, 'EXECUTE'))
        AS "helpersPrivate"
      FROM unnest(ARRAY[
        'public.breeze_validate_config_policy_assignment_target(uuid,text,uuid)',
        'public.breeze_validate_config_policy_assignment_new_rows(jsonb[])',
        'public.breeze_enforce_config_policy_assignment_integrity()',
        'public.breeze_serialize_config_policy_assignment_owner_updates()',
        'public.breeze_serialize_config_policy_assignment_owner_deletes()'
      ]::text[]) signature
    `);
    expect(privileges).toEqual({ helpersPrivate: true });

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
      await expect(getAppDb().execute(sql.raw(serializationMigration)))
        .rejects.toMatchObject({ cause: expect.objectContaining({ code: '23514' }) });
    } finally {
      await admin.delete(configPolicyAssignments).where(eq(configPolicyAssignments.id, forgedId));
    }
  }, 30_000);
});

async function seedPartner(label: 'A' | 'B'): Promise<SeededPartner> {
  const seed = await createPartnerSeed(label);
  for (let index = 1; index <= 2; index += 1) await seedPartnerOrg(seed, label, index);
  return seed;
}

async function seedInterleavedPartners(): Promise<[SeededPartner, SeededPartner]> {
  const partnerA = await createPartnerSeed('A');
  const partnerB = await createPartnerSeed('B');
  for (let index = 1; index <= 2; index += 1) {
    await seedPartnerOrg(partnerA, 'A', index);
    await seedPartnerOrg(partnerB, 'B', index);
  }
  return [partnerA, partnerB];
}

async function createPartnerSeed(label: 'A' | 'B'): Promise<SeededPartner> {
  const partner = await createPartner({ name: `${label}-Partner` });
  const user = await createUser({ partnerId: partner.id });
  return {
    partner,
    user,
    orgs: [], sites: [], devices: [], groups: [], policies: [], assignments: [], featureLinks: [],
  };
}

async function seedPartnerOrg(seed: SeededPartner, label: 'A' | 'B', index: number): Promise<void> {
  const admin = getTestDb();
  const org = await createOrganization({
    partnerId: seed.partner.id,
    name: `${label}-Organization-${index}`,
  });
  const site = await createSite({ orgId: org.id, name: `${label}-Site-${index}` });
  const fieldKey = `rack_${label.toLowerCase()}_${index}`;
  await admin.insert(customFieldDefinitions).values({
    orgId: org.id, name: `${label}-Rack-${index}`, fieldKey, type: 'text',
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
    orgId: org.id, siteId: site.id, name: `${label}-Group-${index}`,
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
    orgId: org.id, name: `${label}-Policy-${index}`, status: 'active',
  }).returning();
  if (!policy) throw new Error('configuration policy seed failed');
  const [assignment] = await admin.insert(configPolicyAssignments).values({
    configPolicyId: policy.id, level: 'organization', targetId: org.id, priority: index,
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
    orgId: org.id, name: `${label}-Automation-${index}`, trigger: { type: 'manual' }, actions: [],
  });
  await admin.insert(backupConfigs).values({
    orgId: org.id,
    name: `${label}-Backup-${index}`,
    type: 'system_image',
    provider: 's3',
    providerConfig: { bucket: `${label.toLowerCase()}-fixture` },
  });
  seed.orgs.push(org);
  seed.sites.push(site);
  seed.devices.push(device);
  seed.groups.push(group);
  seed.policies.push(policy);
  seed.assignments.push(assignment);
  seed.featureLinks.push(featureLink);
}

async function issueKey(partnerId: string, userId: string): Promise<string> {
  const admin = getTestDb();
  const [principal] = await admin.insert(partnerServicePrincipals).values({
    partnerId,
    name: `Reconstruction export ${crypto.randomUUID()}`,
    scopes: [...ALL_SCOPES],
    createdBy: userId,
    updatedBy: userId,
  }).returning();
  if (!principal) throw new Error('service principal seed failed');
  return (await issuePartnerServicePrincipalKey(admin as unknown as Database, {
    partnerServicePrincipalId: principal.id,
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForPartnerExportWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await getTestDb().execute(sql`
      SELECT 1 FROM pg_catalog.pg_locks
      WHERE NOT granted
        AND (locktype IN ('transactionid', 'tuple')
          OR (locktype = 'advisory' AND classid IN (1000202, 1000301)))
      LIMIT 1
    `);
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('assignment writer never waited on its integrity lock');
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
