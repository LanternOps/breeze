/**
 * resolveMonitorsForDevice — cumulative resolution against real Postgres
 * (#5287 W02, Task 11 step 3).
 *
 * Unlike `resolveEffectiveConfig`'s closest-wins algorithm for every other
 * feature type, monitor resolution is CUMULATIVE: a partner-wide parent
 * policy's attachments are not dropped just because a closer (child / site)
 * policy also attaches its own monitors — per-MONITOR, the closest attachment
 * wins (enabled flag, overrides), never "closest policy wins outright". This
 * suite builds the exact three-policy chain the plan calls for (partner-wide
 * parent, org child with `parentPolicyId` set, site policy) and proves both
 * the resolver and `getApplicableRules`' 'monitor' target-type wiring against
 * a live database, matching `monitorDefinitionsPartnerRls.integration.test.ts`'s
 * style.
 *
 * Fixtures use direct table inserts (mirroring `seedPolicyWithLink` in that
 * sibling suite) rather than `createConfigPolicy` / `addFeatureLink` /
 * `assignPolicy` from `services/configurationPolicy.ts`: that file is being
 * edited concurrently by another wave session, and the resolver only cares
 * about the row shapes in `configuration_policies` / `config_policy_
 * assignments` / `config_policy_feature_links` / `config_policy_monitors`.
 * Monitor definitions are inserted directly and compiled with
 * `compileMonitorInTx` (see monitorCompiler.integration.test.ts for why that
 * bypasses `monitorService` here too — its validation currently rejects the
 * empty `responses`/`recurrenceActions` these monitors legitimately have).
 */
import './setup';
import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configPolicyMonitors,
  configurationPolicies,
  devices,
  monitorDefinitions,
  type MonitorDefinitionRow,
} from '../../db/schema';
import { compileMonitorInTx } from '../../services/monitors/monitorCompiler';
import { resolveMonitorsForDevice } from '../../services/monitors/monitorResolver';
import { getApplicableRules } from '../../services/alertService';
import { createOrganization, createPartner, createSite } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const createdOrgIds: string[] = [];
const createdPartnerIds: string[] = [];

afterEach(async () => {
  const orgIds = [...new Set(createdOrgIds)];
  const partnerIds = [...new Set(createdPartnerIds)];
  createdOrgIds.length = 0;
  createdPartnerIds.length = 0;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    // configuration_policies -> config_policy_assignments / config_policy_
    // feature_links -> config_policy_monitors all cascade on delete; devices
    // cascade too. monitor_definitions is independent of org/partner cascade
    // deletion of policies, so it needs its own delete.
    if (orgIds.length > 0) {
      await db.delete(devices).where(inArray(devices.orgId, orgIds));
      await db.delete(configurationPolicies).where(inArray(configurationPolicies.orgId, orgIds));
      await db.delete(monitorDefinitions).where(inArray(monitorDefinitions.orgId, orgIds));
    }
    if (partnerIds.length > 0) {
      await db.delete(configurationPolicies).where(inArray(configurationPolicies.partnerId, partnerIds));
      await db.delete(monitorDefinitions).where(inArray(monitorDefinitions.partnerId, partnerIds));
    }
  });
});

function monitorValues(over: Partial<typeof monitorDefinitions.$inferInsert>) {
  return {
    name: `monitor-${randomUUID().slice(0, 8)}`,
    kind: 'disk' as const,
    condition: { operator: 'gt', value: 80 },
    severity: 'high' as const,
    ...over,
  };
}

async function insertAndCompile(
  values: Partial<typeof monitorDefinitions.$inferInsert>,
): Promise<MonitorDefinitionRow> {
  return withDbAccessContext(SYSTEM_CTX, () =>
    db.transaction(async (tx) => {
      const [created] = await tx.insert(monitorDefinitions).values(monitorValues(values)).returning();
      await compileMonitorInTx(tx, created!);
      return created!;
    }),
  );
}

async function insertPolicy(values: {
  orgId?: string | null;
  partnerId?: string | null;
  parentPolicyId?: string | null;
}) {
  const [policy] = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(configurationPolicies)
      .values({
        orgId: values.orgId ?? null,
        partnerId: values.partnerId ?? null,
        parentPolicyId: values.parentPolicyId ?? null,
        name: `policy-${randomUUID().slice(0, 8)}`,
        status: 'active',
      })
      .returning({ id: configurationPolicies.id }),
  );
  return policy!.id;
}

async function attachMonitors(
  policyId: string,
  attachments: Array<{ monitorId: string; enabled?: boolean; overrides?: Record<string, unknown> | null }>,
) {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policyId, featureType: 'monitors' })
      .returning({ id: configPolicyFeatureLinks.id });
    for (const a of attachments) {
      await db.insert(configPolicyMonitors).values({
        featureLinkId: link!.id,
        monitorId: a.monitorId,
        enabled: a.enabled ?? true,
        overrides: a.overrides ?? null,
      });
    }
  });
}

async function assign(policyId: string, level: 'organization' | 'site', targetId: string) {
  await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(configPolicyAssignments).values({ configPolicyId: policyId, level, targetId }),
  );
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

/**
 * Builds the plan's exact chain:
 *   parent (partner-wide, attaches M1 + M2)
 *     -> child (org, parentPolicyId = parent, attaches M3 + M2 disabled), assigned at ORG level
 *   site policy (org, attaches M1 with overrides {value:95}), assigned at SITE level
 */
async function buildChain() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const siteMain = await createSite({ orgId: org.id });
  const siteOther = await createSite({ orgId: org.id });
  createdPartnerIds.push(partner.id);
  createdOrgIds.push(org.id);

  const m1 = await insertAndCompile({ partnerId: partner.id, orgId: null, name: `m1-${randomUUID().slice(0, 6)}` });
  const m2 = await insertAndCompile({ partnerId: partner.id, orgId: null, name: `m2-${randomUUID().slice(0, 6)}` });
  const m3 = await insertAndCompile({ orgId: org.id, partnerId: null, name: `m3-${randomUUID().slice(0, 6)}` });

  const parentPolicyId = await insertPolicy({ partnerId: partner.id });
  await attachMonitors(parentPolicyId, [{ monitorId: m1.id }, { monitorId: m2.id }]);

  const childPolicyId = await insertPolicy({ orgId: org.id, parentPolicyId });
  await attachMonitors(childPolicyId, [
    { monitorId: m3.id },
    { monitorId: m2.id, enabled: false },
  ]);
  await assign(childPolicyId, 'organization', org.id);

  const sitePolicyId = await insertPolicy({ orgId: org.id });
  await attachMonitors(sitePolicyId, [{ monitorId: m1.id, overrides: { value: 95 } }]);
  await assign(sitePolicyId, 'site', siteMain.id);

  const deviceInSite = await insertDevice(org.id, siteMain.id);
  const deviceInOtherSite = await insertDevice(org.id, siteOther.id);

  return {
    partner,
    org,
    siteMain,
    siteOther,
    m1,
    m2,
    m3,
    parentPolicyId,
    childPolicyId,
    sitePolicyId,
    deviceInSite,
    deviceInOtherSite,
  };
}

describe('resolveMonitorsForDevice — cumulative resolution (#5289)', () => {
  it('a device in the site with its own attachment gets the site override, plus the inherited/child monitors', async () => {
    const chain = await buildChain();

    const resolution = await withDbAccessContext(SYSTEM_CTX, () =>
      resolveMonitorsForDevice(chain.deviceInSite.id),
    );
    expect(resolution.kind).toBe('resolved');
    if (resolution.kind !== 'resolved') throw new Error('unreachable');
    const byId = new Map(resolution.monitors.map((m) => [m.monitorId, m]));

    expect(byId.size).toBe(3);

    const m1 = byId.get(chain.m1.id);
    expect(m1?.enabled).toBe(true);
    expect(m1?.overrides).toEqual({ value: 95 });
    expect(m1?.sourceLevel).toBe('site');
    expect(m1?.sourcePolicyId).toBe(chain.sitePolicyId);

    const m2 = byId.get(chain.m2.id);
    expect(m2?.enabled).toBe(false);
    expect(m2?.sourcePolicyId).toBe(chain.childPolicyId);

    const m3 = byId.get(chain.m3.id);
    expect(m3?.enabled).toBe(true);
    expect(m3?.sourcePolicyId).toBe(chain.childPolicyId);
  });

  it('a device in another site of the same org gets M1 with no overrides — the parent contribution is not dropped', async () => {
    const chain = await buildChain();

    const resolution = await withDbAccessContext(SYSTEM_CTX, () =>
      resolveMonitorsForDevice(chain.deviceInOtherSite.id),
    );
    expect(resolution.kind).toBe('resolved');
    if (resolution.kind !== 'resolved') throw new Error('unreachable');
    const byId = new Map(resolution.monitors.map((m) => [m.monitorId, m]));

    expect(byId.size).toBe(3);

    const m1 = byId.get(chain.m1.id);
    expect(m1?.enabled).toBe(true);
    expect(m1?.overrides).toBeNull();
    expect(m1?.sourceLevel).toBe('organization');
    expect(m1?.inheritedFromParent).toBe(true);

    expect(byId.get(chain.m2.id)?.enabled).toBe(false);
    expect(byId.get(chain.m3.id)?.enabled).toBe(true);
  });

  it('a device in an org under a DIFFERENT partner resolves nothing', async () => {
    // Build the full chain first so there is real partner-wide / org / site
    // policy state in the database that COULD leak — an empty result here is
    // meaningful only because something real exists to be isolated from.
    await buildChain();

    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const siteB = await createSite({ orgId: orgB.id });
    createdPartnerIds.push(partnerB.id);
    createdOrgIds.push(orgB.id);
    const deviceB = await insertDevice(orgB.id, siteB.id);

    const resolution = await withDbAccessContext(SYSTEM_CTX, () => resolveMonitorsForDevice(deviceB.id));
    expect(resolution).toEqual({ kind: 'resolved', monitors: [] });
  });

  it('a device that has been deleted resolves as device_missing, never as "resolved with zero monitors" (#5677)', async () => {
    const chain = await buildChain();
    const deviceId = chain.deviceInSite.id;

    await withDbAccessContext(SYSTEM_CTX, () => db.delete(devices).where(eq(devices.id, deviceId)));

    const resolution = await withDbAccessContext(SYSTEM_CTX, () => resolveMonitorsForDevice(deviceId));
    expect(resolution).toEqual({ kind: 'device_missing' });
  });

  it('getApplicableRules returns the M1 rule with the overridden value and NOT the disabled M2 rule', async () => {
    const chain = await buildChain();

    const applicable = await withDbAccessContext(SYSTEM_CTX, () =>
      getApplicableRules(chain.deviceInSite.id),
    );
    const byRuleTargetId = new Map(applicable.map((r) => [r.rule.targetId, r]));

    const m1Rule = byRuleTargetId.get(chain.m1.id);
    expect(m1Rule).toBeDefined();
    expect(m1Rule!.rule.targetType).toBe('monitor');
    expect((m1Rule!.effectiveConditions as { value: number }).value).toBe(95);

    expect(byRuleTargetId.has(chain.m2.id)).toBe(false);

    // M3's compiled rule is active and applies too (sanity: cumulative
    // resolution reaches getApplicableRules, not just the resolver itself).
    expect(byRuleTargetId.has(chain.m3.id)).toBe(true);
  });
});
