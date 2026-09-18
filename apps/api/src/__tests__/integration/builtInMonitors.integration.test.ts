/**
 * Built-in default monitors — provisioning contract against real Postgres.
 *
 * Proves: (1) one call provisions four compiled partner-wide built-ins and
 * NOTHING is assigned — a device under the partner resolves no monitors until
 * the MSP attaches them to a policy;
 * (2) a second call is a no-op; (3) a partner that deleted a built-in does NOT
 * get it back (partners.settings marker, not row presence, is the source of
 * truth); (4) the boot backfill only touches never-provisioned partners;
 * (5) built-ins are ordinary rows the RLS layer scopes per partner.
 */
import './setup';
import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  alertRules,
  alertTemplates,
  automations,
  configurationPolicies,
  devices,
  monitorDefinitions,
  partners,
} from '../../db/schema';
import {
  BUILT_IN_MONITOR_DEFAULTS,
  ensureBuiltInMonitorsForAllPartners,
  ensureBuiltInMonitorsForPartner,
} from '../../services/monitors/builtInMonitors';
import { resolveMonitorsForDevice } from '../../services/monitors/monitorResolver';
import { createPartner as createPartnerViaService } from '../../services/partnerCreate';
import { roles } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const createdPartnerIds: string[] = [];
const createdOrgIds: string[] = [];

afterEach(async () => {
  const partnerIds = [...new Set(createdPartnerIds)];
  const orgIds = [...new Set(createdOrgIds)];
  createdPartnerIds.length = 0;
  createdOrgIds.length = 0;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (orgIds.length > 0) await db.delete(devices).where(inArray(devices.orgId, orgIds));
    if (partnerIds.length > 0) {
      await db.delete(configurationPolicies).where(inArray(configurationPolicies.partnerId, partnerIds));
      await db.delete(monitorDefinitions).where(inArray(monitorDefinitions.partnerId, partnerIds));
    }
  });
});

async function newPartner() {
  const partner = await createPartner();
  createdPartnerIds.push(partner.id);
  return partner;
}

async function insertDevice(orgId: string, siteId: string) {
  const [device] = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `agent-${randomUUID()}`,
        hostname: `host-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '1.0',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
        deviceRole: 'workstation',
      })
      .returning(),
  );
  return device!;
}

async function builtInsFor(partnerId: string) {
  return withDbAccessContext(SYSTEM_CTX, () =>
    db
      .select()
      .from(monitorDefinitions)
      .where(and(eq(monitorDefinitions.partnerId, partnerId), sql`${monitorDefinitions.builtinKey} IS NOT NULL`)),
  );
}

async function marker(partnerId: string) {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .select({ m: sql<Record<string, unknown> | null>`${partners.settings} -> 'builtInMonitors'` })
      .from(partners)
      .where(eq(partners.id, partnerId)),
  );
  return row?.m ?? null;
}

describe('ensureBuiltInMonitorsForPartner', () => {
  it('provisions four compiled partner-wide monitors and assigns NOTHING by default', async () => {
    const partner = await newPartner();
    const org = await createOrganization({ partnerId: partner.id });
    createdOrgIds.push(org.id);
    const site = await createSite({ orgId: org.id });
    const device = await insertDevice(org.id, site.id);

    const result = await withDbAccessContext(SYSTEM_CTX, () => ensureBuiltInMonitorsForPartner(partner.id));
    expect(result.provisioned).toBe(true);
    expect(result.monitorIds).toHaveLength(BUILT_IN_MONITOR_DEFAULTS.length);

    const rows = await builtInsFor(partner.id);
    expect(rows.map((r) => r.builtinKey).sort()).toEqual(['cpu_high', 'disk_full', 'memory_high', 'patch_compliance_low']);
    expect(rows.every((r) => r.orgId === null && r.enabled && r.autoResolve)).toBe(true);

    // Each definition compiled into its three managed rows.
    for (const row of rows) {
      const [tpl] = await withDbAccessContext(SYSTEM_CTX, () =>
        db.select({ id: alertTemplates.id }).from(alertTemplates).where(eq(alertTemplates.id, row.compiledAlertTemplateId!)),
      );
      const [rule] = await withDbAccessContext(SYSTEM_CTX, () =>
        db.select({ id: alertRules.id }).from(alertRules).where(eq(alertRules.id, row.compiledAlertRuleId!)),
      );
      const [auto] = await withDbAccessContext(SYSTEM_CTX, () =>
        db.select({ id: automations.id }).from(automations).where(eq(automations.id, row.compiledAutomationId!)),
      );
      expect(tpl && rule && auto).toBeTruthy();
    }

    // No policy, no assignment: a device under the partner resolves nothing.
    const policies = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ id: configurationPolicies.id }).from(configurationPolicies).where(eq(configurationPolicies.partnerId, partner.id)),
    );
    expect(policies).toEqual([]);
    const resolution = await withDbAccessContext(SYSTEM_CTX, () => resolveMonitorsForDevice(device.id));
    expect(resolution).toEqual({ kind: 'resolved', monitors: [] });

    expect(await marker(partner.id)).toMatchObject({ version: 2 });
  });

  it('is a no-op on the second call', async () => {
    const partner = await newPartner();
    await withDbAccessContext(SYSTEM_CTX, () => ensureBuiltInMonitorsForPartner(partner.id));
    const again = await withDbAccessContext(SYSTEM_CTX, () => ensureBuiltInMonitorsForPartner(partner.id));
    expect(again).toEqual({ provisioned: false, monitorIds: [] });
    expect(await builtInsFor(partner.id)).toHaveLength(4);
  });

  it('never resurrects a built-in the partner deleted', async () => {
    const partner = await newPartner();
    await withDbAccessContext(SYSTEM_CTX, () => ensureBuiltInMonitorsForPartner(partner.id));
    await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .delete(monitorDefinitions)
        .where(and(eq(monitorDefinitions.partnerId, partner.id), eq(monitorDefinitions.builtinKey, 'cpu_high'))),
    );
    const again = await withDbAccessContext(SYSTEM_CTX, () => ensureBuiltInMonitorsForPartner(partner.id));
    expect(again.provisioned).toBe(false);
    expect((await builtInsFor(partner.id)).map((r) => r.builtinKey).sort()).toEqual(['disk_full', 'memory_high', 'patch_compliance_low']);
  });

  // W04 (#5750): the production shape every existing partner is in — marker
  // at version 1 with the three legacy rows (one of them deleted) — must gain
  // ONLY patch_compliance_low, keep the surviving rows' ids, never resurrect
  // the deleted one, and move the marker to version 2 with provisionedAt kept.
  it('upgrades a version-1 partner in place: one new row, existing rows untouched, deleted one stays gone', async () => {
    const partner = await newPartner();
    await withDbAccessContext(SYSTEM_CTX, () => ensureBuiltInMonitorsForPartner(partner.id));
    // Rewind to the v1 shape: drop the v2 row and stamp the legacy marker.
    await withDbAccessContext(SYSTEM_CTX, async () => {
      await db.delete(monitorDefinitions)
        .where(and(eq(monitorDefinitions.partnerId, partner.id), eq(monitorDefinitions.builtinKey, 'patch_compliance_low')));
      await db.delete(monitorDefinitions)
        .where(and(eq(monitorDefinitions.partnerId, partner.id), eq(monitorDefinitions.builtinKey, 'cpu_high')));
      await db.update(partners)
        .set({ settings: sql`jsonb_build_object('builtInMonitors', jsonb_build_object('version', 1, 'provisionedAt', '2026-01-01T00:00:00.000Z'))` })
        .where(eq(partners.id, partner.id));
    });
    const before = await builtInsFor(partner.id);
    expect(before.map((r) => r.builtinKey).sort()).toEqual(['disk_full', 'memory_high']);
    const beforeIds = new Set(before.map((r) => r.id));

    // The boot backfill sees a stale-version partner; the per-partner call upgrades it.
    const backfill = await ensureBuiltInMonitorsForAllPartners();
    expect(backfill.provisioned).toBeGreaterThanOrEqual(1);

    const after = await builtInsFor(partner.id);
    expect(after.map((r) => r.builtinKey).sort()).toEqual(['disk_full', 'memory_high', 'patch_compliance_low']);
    for (const row of after) {
      if (row.builtinKey !== 'patch_compliance_low') expect(beforeIds.has(row.id)).toBe(true);
    }
    expect(await marker(partner.id)).toMatchObject({ version: 2, provisionedAt: '2026-01-01T00:00:00.000Z' });

    // Idempotent: a second pass at version 2 is a no-op.
    const again = await withDbAccessContext(SYSTEM_CTX, () => ensureBuiltInMonitorsForPartner(partner.id));
    expect(again).toEqual({ provisioned: false, monitorIds: [] });
  });

  it('refuses an org-owned row carrying a builtin_key (CHECK)', async () => {
    const partner = await newPartner();
    const org = await createOrganization({ partnerId: partner.id });
    createdOrgIds.push(org.id);
    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db.insert(monitorDefinitions).values({
          orgId: org.id,
          partnerId: null,
          name: 'forged',
          kind: 'cpu',
          condition: { operator: 'gt', value: 90 },
          severity: 'high',
          builtinKey: 'cpu_high',
        }),
      ),
    ).rejects.toMatchObject({ cause: { constraint_name: 'monitor_definitions_builtin_partner_chk' } });
  });
});

describe('createPartner() hook', () => {
  it('provisions the built-ins inside the signup transaction with the admin user as creator', async () => {
    // createPartner copies permissions from the system "Partner Admin" role.
    await withDbAccessContext(SYSTEM_CTX, async () => {
      const [existing] = await db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.name, 'Partner Admin'), eq(roles.isSystem, true), sql`${roles.partnerId} IS NULL`));
      if (!existing) {
        await db.insert(roles).values({ partnerId: null, scope: 'partner', name: 'Partner Admin', description: 'System partner admin', isSystem: true });
      }
    });
    const suffix = randomUUID().slice(0, 8);
    const created = await withDbAccessContext(SYSTEM_CTX, () =>
      createPartnerViaService({
        orgName: `BuiltIn Co ${suffix}`,
        adminEmail: `builtin-${suffix}@example.test`,
        adminName: 'Built In',
        passwordHash: 'x',
        origin: { mcp: false },
        status: 'active',
      }),
    );
    createdPartnerIds.push(created.partnerId);
    createdOrgIds.push(created.orgId);

    const rows = await builtInsFor(created.partnerId);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.createdBy === created.adminUserId)).toBe(true);
    expect(await marker(created.partnerId)).toMatchObject({ version: 2 });
  });
});

describe('ensureBuiltInMonitorsForAllPartners', () => {
  it('provisions only partners without the marker and leaves provisioned ones untouched', async () => {
    const fresh = await newPartner();
    const done = await newPartner();
    await withDbAccessContext(SYSTEM_CTX, () => ensureBuiltInMonitorsForPartner(done.id));
    await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .delete(monitorDefinitions)
        .where(and(eq(monitorDefinitions.partnerId, done.id), eq(monitorDefinitions.builtinKey, 'disk_full'))),
    );

    const summary = await ensureBuiltInMonitorsForAllPartners();
    expect(summary.failed).toBe(0);
    expect(summary.provisioned).toBeGreaterThanOrEqual(1);

    expect(await builtInsFor(fresh.id)).toHaveLength(4);
    expect(await builtInsFor(done.id)).toHaveLength(3);
  });

  it('is disabled by BREEZE_BUILTIN_MONITORS_AUTOSEED=false', async () => {
    const partner = await newPartner();
    const prev = process.env.BREEZE_BUILTIN_MONITORS_AUTOSEED;
    process.env.BREEZE_BUILTIN_MONITORS_AUTOSEED = 'false';
    try {
      const summary = await ensureBuiltInMonitorsForAllPartners();
      expect(summary).toEqual({ provisioned: 0, skipped: 0, failed: 0 });
      expect(await builtInsFor(partner.id)).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.BREEZE_BUILTIN_MONITORS_AUTOSEED;
      else process.env.BREEZE_BUILTIN_MONITORS_AUTOSEED = prev;
    }
  });
});
