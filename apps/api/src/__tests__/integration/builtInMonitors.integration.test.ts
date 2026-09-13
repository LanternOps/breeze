/**
 * Built-in default monitors — provisioning contract against real Postgres.
 *
 * Proves: (1) one call provisions three partner-wide built-ins + one partner-
 * level policy and every device under the partner resolves all three;
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
  configPolicyAssignments,
  configurationPolicies,
  devices,
  monitorDefinitions,
  partners,
} from '../../db/schema';
import {
  BUILT_IN_MONITOR_DEFAULTS,
  BUILT_IN_MONITORS_POLICY_NAME,
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
  it('provisions three compiled partner-wide monitors and a partner-level policy that reaches every device', async () => {
    const partner = await newPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    createdOrgIds.push(orgA.id, orgB.id);
    const siteA = await createSite({ orgId: orgA.id });
    const siteB = await createSite({ orgId: orgB.id });
    const deviceA = await insertDevice(orgA.id, siteA.id);
    const deviceB = await insertDevice(orgB.id, siteB.id);

    const result = await withDbAccessContext(SYSTEM_CTX, () => ensureBuiltInMonitorsForPartner(partner.id));
    expect(result.provisioned).toBe(true);
    expect(result.monitorIds).toHaveLength(BUILT_IN_MONITOR_DEFAULTS.length);
    expect(result.policyId).toBeTruthy();

    const rows = await builtInsFor(partner.id);
    expect(rows.map((r) => r.builtinKey).sort()).toEqual(['cpu_high', 'disk_full', 'memory_high']);
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

    const [policy] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(configurationPolicies).where(eq(configurationPolicies.id, result.policyId!)),
    );
    expect(policy).toMatchObject({ partnerId: partner.id, orgId: null, name: BUILT_IN_MONITORS_POLICY_NAME, status: 'active' });
    const assignments = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(configPolicyAssignments).where(eq(configPolicyAssignments.configPolicyId, result.policyId!)),
    );
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({ level: 'partner', targetId: partner.id });

    // Fan-out: devices in BOTH orgs of the partner resolve all three, enabled.
    for (const device of [deviceA, deviceB]) {
      const effective = await withDbAccessContext(SYSTEM_CTX, () => resolveMonitorsForDevice(device.id));
      expect(effective.map((m) => m.monitorId).sort()).toEqual(result.monitorIds.slice().sort());
      expect(effective.every((m) => m.enabled)).toBe(true);
    }

    expect(await marker(partner.id)).toMatchObject({ version: 1, policyId: result.policyId });
  });

  it('is a no-op on the second call', async () => {
    const partner = await newPartner();
    await withDbAccessContext(SYSTEM_CTX, () => ensureBuiltInMonitorsForPartner(partner.id));
    const again = await withDbAccessContext(SYSTEM_CTX, () => ensureBuiltInMonitorsForPartner(partner.id));
    expect(again).toEqual({ provisioned: false, monitorIds: [], policyId: null });
    expect(await builtInsFor(partner.id)).toHaveLength(3);
    const policies = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ id: configurationPolicies.id }).from(configurationPolicies).where(eq(configurationPolicies.partnerId, partner.id)),
    );
    expect(policies).toHaveLength(1);
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
    expect((await builtInsFor(partner.id)).map((r) => r.builtinKey).sort()).toEqual(['disk_full', 'memory_high']);
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
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.createdBy === created.adminUserId)).toBe(true);
    expect(await marker(created.partnerId)).toMatchObject({ version: 1 });
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

    expect(await builtInsFor(fresh.id)).toHaveLength(3);
    expect(await builtInsFor(done.id)).toHaveLength(2);
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
