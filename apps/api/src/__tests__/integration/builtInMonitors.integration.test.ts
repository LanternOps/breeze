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
    expect(rows.map((r) => r.builtinKey).sort()).toEqual(BUILT_IN_MONITOR_DEFAULTS.map((d) => d.key).sort());
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

    expect(await marker(partner.id)).toMatchObject({ version: 3 });
  });

  it('is a no-op on the second call', async () => {
    const partner = await newPartner();
    await withDbAccessContext(SYSTEM_CTX, () => ensureBuiltInMonitorsForPartner(partner.id));
    const again = await withDbAccessContext(SYSTEM_CTX, () => ensureBuiltInMonitorsForPartner(partner.id));
    expect(again).toEqual({ provisioned: false, monitorIds: [] });
    expect(await builtInsFor(partner.id)).toHaveLength(BUILT_IN_MONITOR_DEFAULTS.length);
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
    expect((await builtInsFor(partner.id)).map((r) => r.builtinKey).sort()).toEqual(
      BUILT_IN_MONITOR_DEFAULTS.filter((d) => d.key !== 'cpu_high').map((d) => d.key).sort(),
    );
  });

  // The production shape every existing partner is in — marker at version 2
  // with the legacy rows (one of them deleted, plus an edited row) — must
  // gain ONLY the four hardware defaults, keep the surviving rows' ids and
  // edits, never resurrect the deleted one, and move the marker to version 3
  // with provisionedAt kept.
  it('upgrades version 2 without restoring deleted defaults or overwriting edits', async () => {
    const partner = await newPartner();
    await withDbAccessContext(SYSTEM_CTX, () => ensureBuiltInMonitorsForPartner(partner.id));
    const hardwareKeys = ['raid_array_degraded', 'physical_disk_failed', 'cache_battery_problem', 'hardware_collector_failing'];
    await withDbAccessContext(SYSTEM_CTX, async () => {
      await db.delete(monitorDefinitions).where(and(eq(monitorDefinitions.partnerId, partner.id),
        inArray(monitorDefinitions.builtinKey, [...hardwareKeys, 'cpu_high'])));
      await db.update(monitorDefinitions).set({ enabled: false, cooldownMinutes: 321 })
        .where(and(eq(monitorDefinitions.partnerId, partner.id), eq(monitorDefinitions.builtinKey, 'memory_high')));
      await db.update(partners).set({ settings: sql`jsonb_build_object('builtInMonitors', jsonb_build_object(
        'version', 2, 'provisionedAt', '2026-01-01T00:00:00.000Z'))` }).where(eq(partners.id, partner.id));
    });
    const before = await builtInsFor(partner.id);
    const result = await withDbAccessContext(SYSTEM_CTX, () => ensureBuiltInMonitorsForPartner(partner.id));
    expect(result.monitorIds).toHaveLength(4);
    const after = await builtInsFor(partner.id);
    expect(after.filter((row) => hardwareKeys.includes(row.builtinKey!))).toHaveLength(4);
    expect(after.some((row) => row.builtinKey === 'cpu_high')).toBe(false);
    for (const row of before) expect(after.find((next) => next.id === row.id)).toEqual(row);
    expect(await marker(partner.id)).toMatchObject({ version: 3, provisionedAt: '2026-01-01T00:00:00.000Z' });
    expect(await withDbAccessContext(SYSTEM_CTX, () => ensureBuiltInMonitorsForPartner(partner.id))).toEqual({ provisioned: false, monitorIds: [] });
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
    expect(rows).toHaveLength(BUILT_IN_MONITOR_DEFAULTS.length);
    expect(rows.every((r) => r.createdBy === created.adminUserId)).toBe(true);
    expect(await marker(created.partnerId)).toMatchObject({ version: 3 });
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

    expect(await builtInsFor(fresh.id)).toHaveLength(BUILT_IN_MONITOR_DEFAULTS.length);
    expect(await builtInsFor(done.id)).toHaveLength(BUILT_IN_MONITOR_DEFAULTS.length - 1);
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
