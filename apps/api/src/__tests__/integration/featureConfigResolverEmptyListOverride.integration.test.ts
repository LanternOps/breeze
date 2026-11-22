/**
 * #12488 — an empty Automations or Compliance list on a closer policy overrides
 * a broader policy, the same way every other feature does ("closest wins
 * whole").
 *
 * `resolveAutomationAssignmentForDevice` and
 * `resolveComplianceAssignmentForDevice` used to INNER JOIN the child rows
 * (`config_policy_automations`, `config_policy_compliance_rules`) before
 * picking the winning assignment. A feature link with no child rows then
 * contributed no rows, was never a candidate, and the next assignment up the
 * hierarchy won — so "no automations at this site" could not be expressed.
 * The same join dropped a closer automation link whose rows were all retired.
 *
 * Real database, real RLS, under an org-scoped request context: the mocked
 * unit suite cannot evaluate the join, which is where the bug lived.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  configPolicyAutomations,
  configPolicyComplianceRules,
  devices,
} from '../../db/schema';
import {
  resolveAutomationAssignmentForDevice,
  resolveAutomationsForDevice,
  resolveAutomationsForDeviceWithPolicy,
  resolveComplianceAssignmentForDevice,
  resolveComplianceRulesForDevice,
} from '../../services/featureConfigResolver';
import { createPartner, createOrganization, createSite } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

const createdPolicies: string[] = [];
const createdDevices: string[] = [];

afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const id of createdDevices) await db.delete(devices).where(eq(devices.id, id));
    for (const id of createdPolicies) await db.delete(configurationPolicies).where(eq(configurationPolicies.id, id));
  });
  createdDevices.length = 0;
  createdPolicies.length = 0;
});

type Feature = 'automation' | 'compliance';
type Item = { name: string; retired?: boolean };

interface Tenant {
  partnerId: string;
  orgId: string;
  siteId: string;
  deviceId: string;
}

async function seedTenant(): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org!.id });
  const deviceId = await withDbAccessContext(SYSTEM_CTX, async () => {
    const [d] = await db
      .insert(devices)
      .values({
        orgId: org!.id,
        siteId: site!.id,
        agentId: `agent-${randomUUID()}`,
        hostname: `host-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '1.0',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
        deviceRole: 'workstation',
      })
      .returning();
    createdDevices.push(d!.id);
    return d!.id;
  });
  return { partnerId: partner.id, orgId: org!.id, siteId: site!.id, deviceId };
}

/**
 * An org-owned policy. `items === null` means the policy carries NO link for
 * the feature (a child that inherits it); `[]` means the link exists with an
 * empty list.
 */
async function seedPolicy(
  orgId: string,
  feature: Feature,
  items: Item[] | null,
  parentPolicyId?: string,
): Promise<string> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({
        orgId,
        name: `${feature} policy ${randomUUID()}`,
        status: 'active',
        ...(parentPolicyId ? { parentPolicyId } : {}),
      })
      .returning();
    // Children first so the afterEach delete never trips the parent FK.
    if (parentPolicyId) createdPolicies.unshift(policy!.id);
    else createdPolicies.push(policy!.id);
    if (items === null) return policy!.id;

    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: feature })
      .returning();
    for (const [idx, item] of items.entries()) {
      if (feature === 'automation') {
        await db.insert(configPolicyAutomations).values({
          featureLinkId: link!.id,
          name: item.name,
          triggerType: 'manual',
          actions: [{ type: 'run_script' }],
          sortOrder: idx,
          ...(item.retired ? { retiredAt: new Date(), retiredReason: 'operator' } : {}),
        });
      } else {
        await db.insert(configPolicyComplianceRules).values({
          featureLinkId: link!.id,
          name: item.name,
          rules: { requiredSetting: 'disk_encryption_enabled' },
          sortOrder: idx,
        });
      }
    }
    return policy!.id;
  });
}

async function assign(configPolicyId: string, level: 'organization' | 'site', targetId: string) {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    await db.insert(configPolicyAssignments).values({ configPolicyId, level, targetId, priority: 0 });
  });
}

const ORG_ITEMS: Item[] = [{ name: 'Org item A' }, { name: 'Org item B' }, { name: 'Org item C' }];

/** The winner each feature's Assignment resolver names, and its list's names. */
async function resolveWinner(t: Tenant, feature: Feature): Promise<{ policyId: string; names: string[] } | null> {
  return withDbAccessContext(orgContext(t.orgId, t.partnerId), async () => {
    if (feature === 'automation') {
      const r = await resolveAutomationAssignmentForDevice(t.deviceId);
      return r ? { policyId: r.configPolicyId, names: r.automations.map((a) => a.name) } : null;
    }
    const r = await resolveComplianceAssignmentForDevice(t.deviceId);
    return r ? { policyId: r.configPolicyId, names: r.rules.map((rule) => rule.name) } : null;
  });
}

/** The plain list resolver each consumer reads. */
async function resolveList(t: Tenant, feature: Feature): Promise<string[]> {
  return withDbAccessContext(orgContext(t.orgId, t.partnerId), async () => {
    const rows = feature === 'automation'
      ? await resolveAutomationsForDevice(t.deviceId)
      : await resolveComplianceRulesForDevice(t.deviceId);
    return rows.map((row) => row.name);
  });
}

describe.each<Feature>(['automation', 'compliance'])('%s — an empty closer list overrides a broader one (#12488)', (feature) => {
  it('control: with no closer link the device gets the organization policy\'s list', async () => {
    const t = await seedTenant();
    const orgPolicy = await seedPolicy(t.orgId, feature, ORG_ITEMS);
    await assign(orgPolicy, 'organization', t.orgId);

    expect(await resolveWinner(t, feature)).toEqual({ policyId: orgPolicy, names: ORG_ITEMS.map((i) => i.name) });
    expect(await resolveList(t, feature)).toEqual(ORG_ITEMS.map((i) => i.name));
  });

  it('a site policy with the feature and an EMPTY list wins: the device gets nothing', async () => {
    const t = await seedTenant();
    const orgPolicy = await seedPolicy(t.orgId, feature, ORG_ITEMS);
    await assign(orgPolicy, 'organization', t.orgId);
    const sitePolicy = await seedPolicy(t.orgId, feature, []);
    await assign(sitePolicy, 'site', t.siteId);

    expect(await resolveWinner(t, feature)).toEqual({ policyId: sitePolicy, names: [] });
    expect(await resolveList(t, feature)).toEqual([]);
  });

  it('a site policy WITHOUT the feature does not override: the device keeps the organization list', async () => {
    const t = await seedTenant();
    const orgPolicy = await seedPolicy(t.orgId, feature, ORG_ITEMS);
    await assign(orgPolicy, 'organization', t.orgId);
    const sitePolicy = await seedPolicy(t.orgId, feature, null);
    await assign(sitePolicy, 'site', t.siteId);

    expect(await resolveWinner(t, feature)).toEqual({ policyId: orgPolicy, names: ORG_ITEMS.map((i) => i.name) });
  });

  it('an inheriting child that overrides the feature with an EMPTY list wins over its parent', async () => {
    const t = await seedTenant();
    const parent = await seedPolicy(t.orgId, feature, ORG_ITEMS);
    await assign(parent, 'organization', t.orgId);
    const child = await seedPolicy(t.orgId, feature, [], parent);
    await assign(child, 'site', t.siteId);

    expect(await resolveWinner(t, feature)).toEqual({ policyId: child, names: [] });
    expect(await resolveList(t, feature)).toEqual([]);
  });

  it('an inheriting child with NO own link gets the parent\'s list, under the child\'s policy id', async () => {
    const t = await seedTenant();
    const parent = await seedPolicy(t.orgId, feature, ORG_ITEMS);
    await assign(parent, 'organization', t.orgId);
    const child = await seedPolicy(t.orgId, feature, null, parent);
    await assign(child, 'site', t.siteId);

    expect(await resolveWinner(t, feature)).toEqual({ policyId: child, names: ORG_ITEMS.map((i) => i.name) });
  });

  it('nothing assigned stays null ("not configured"), distinct from an empty winner', async () => {
    const t = await seedTenant();
    expect(await resolveWinner(t, feature)).toBeNull();
  });
});

describe('automation — a closer list whose rows are all retired still wins (#12488)', () => {
  it('a site policy whose only automation is retired (no live conversion) wins with an empty runnable list', async () => {
    const t = await seedTenant();
    const orgPolicy = await seedPolicy(t.orgId, 'automation', ORG_ITEMS);
    await assign(orgPolicy, 'organization', t.orgId);
    const sitePolicy = await seedPolicy(t.orgId, 'automation', [{ name: 'Retired site item', retired: true }]);
    await assign(sitePolicy, 'site', t.siteId);

    // The retired row carries no live monitor conversion, so it is not part
    // of the winner's list either; the winner is still the site policy.
    expect(await resolveWinner(t, 'automation')).toEqual({ policyId: sitePolicy, names: [] });
    const withPolicy = await withDbAccessContext(orgContext(t.orgId, t.partnerId), () =>
      resolveAutomationsForDeviceWithPolicy(t.deviceId),
    );
    expect(withPolicy).toEqual({ configPolicyId: sitePolicy, automations: [] });
  });

  it('a retired row next to a live one: only the live row is returned, from the closer policy', async () => {
    const t = await seedTenant();
    const orgPolicy = await seedPolicy(t.orgId, 'automation', ORG_ITEMS);
    await assign(orgPolicy, 'organization', t.orgId);
    const sitePolicy = await seedPolicy(t.orgId, 'automation', [
      { name: 'Retired site item', retired: true },
      { name: 'Live site item' },
    ]);
    await assign(sitePolicy, 'site', t.siteId);

    expect(await resolveWinner(t, 'automation')).toEqual({ policyId: sitePolicy, names: ['Live site item'] });
  });
});
