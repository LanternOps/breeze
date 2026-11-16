/**
 * #11976 — configuration-policy compliance rules must reach the agent's probe
 * list, against real PostgreSQL under the agent's own RLS context.
 *
 * A `registry_check` / `config_check` compliance rule is evaluated
 * (`evaluateDeviceComplianceFromConfigPolicy`) against `device_registry_state`
 * / `device_config_state`, which hold only what the agent collected. The agent
 * collects exactly the probes `buildPolicyProbeConfigUpdate` hands it on the
 * heartbeat. Before this fix that list was built from `automation_policies`
 * alone, so a configuration-policy registry check was never collected and
 * reported "Registry value not found" for a value that exists, forever.
 *
 * Runs inside the agent heartbeat's context shape (org-scoped, the device
 * org's partner in `currentPartnerId`, no partner access grant) so the
 * partner-wide case proves the SELECT-only `*_partner_wide_select` branches
 * carry it rather than a system-scope shortcut.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  automationPolicies,
  configPolicyComplianceRules,
  configPolicyFeatureLinks,
  configurationPolicies,
} from '../../db/schema';
import { buildPolicyProbeConfigUpdate } from '../../routes/agents/helpers';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const sys = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

function agentContext(orgId: string, partnerId: string | null): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

async function seedTenant() {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  return { partnerId: partner.id, orgId: org.id };
}

async function seedCompliancePolicy(input: {
  owner: { orgId: string | null; partnerId: string | null };
  rules: unknown[];
  status?: 'active' | 'inactive';
  parentPolicyId?: string;
  withComplianceLink?: boolean;
}): Promise<string> {
  return sys(async () => {
    const [policy] = await db.insert(configurationPolicies).values({
      orgId: input.owner.orgId,
      partnerId: input.owner.partnerId,
      name: `probe compliance ${randomUUID()}`,
      status: input.status ?? 'active',
      parentPolicyId: input.parentPolicyId ?? null,
    } as never).returning();
    if (input.withComplianceLink === false) return policy!.id;
    const [link] = await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id, featureType: 'compliance' as never,
    }).returning();
    await db.insert(configPolicyComplianceRules).values({
      featureLinkId: link!.id, name: 'registry watch', rules: input.rules,
    } as never);
    return policy!.id;
  });
}

const registryRule = (path: string, valueName: string) => ({
  type: 'registry_check', registryPath: path, registryValueName: valueName, registryExpectedValue: '300',
});

const POWER_PATH = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Power\\PowerSettings\\{3C0BC021-C8A8-4E07-A973-6B14CBCB2B7E}';

describe('buildPolicyProbeConfigUpdate: configuration-policy compliance rules (#11976) — real PostgreSQL', () => {
  runDb('an org-owned compliance registry_check rule becomes a registry probe', async () => {
    const t = await seedTenant();
    await seedCompliancePolicy({ owner: { orgId: t.orgId, partnerId: null }, rules: [registryRule(POWER_PATH, 'ACSettingIndex')] });

    const probe = await withDbAccessContext(agentContext(t.orgId, t.partnerId), () =>
      buildPolicyProbeConfigUpdate(t.orgId, { partnerId: t.partnerId }));

    expect(probe?.policy_registry_state_probes).toEqual([{ registry_path: POWER_PATH, value_name: 'ACSettingIndex' }]);
  });

  runDb('a partner-wide compliance rule is visible through the RLS partner-wide branch, and only with the partner', async () => {
    const t = await seedTenant();
    await seedCompliancePolicy({ owner: { orgId: null, partnerId: t.partnerId }, rules: [registryRule(POWER_PATH, 'DCSettingIndex')] });

    const withPartner = await withDbAccessContext(agentContext(t.orgId, t.partnerId), () =>
      buildPolicyProbeConfigUpdate(t.orgId, { partnerId: t.partnerId }));
    expect(withPartner?.policy_registry_state_probes).toEqual([{ registry_path: POWER_PATH, value_name: 'DCSettingIndex' }]);

    // Discriminates: without the GUC the partner-wide row must be invisible
    // (RLS, not a system-scope escape, is doing the work).
    const blind = await withDbAccessContext(agentContext(t.orgId, null), () =>
      buildPolicyProbeConfigUpdate(t.orgId, { partnerId: t.partnerId }));
    expect(blind?.policy_registry_state_probes).toEqual([]);
  });

  runDb('a config_check compliance rule on an allowlisted file becomes a config probe', async () => {
    const t = await seedTenant();
    await seedCompliancePolicy({
      owner: { orgId: t.orgId, partnerId: null },
      rules: [{ type: 'config_check', configFilePath: '/etc/ssh/sshd_config', configKey: 'PermitRootLogin', configExpectedValue: 'no' }],
    });

    const probe = await withDbAccessContext(agentContext(t.orgId, t.partnerId), () =>
      buildPolicyProbeConfigUpdate(t.orgId, { partnerId: t.partnerId }));

    expect(probe?.policy_config_state_probes).toEqual([{ file_path: '/etc/ssh/sshd_config', config_key: 'PermitRootLogin' }]);
  });

  runDb('a compliance rule inherited from a parent policy is probed for the child', async () => {
    const t = await seedTenant();
    // Parent owned by ANOTHER org of the same partner is invisible here; the
    // partner-wide parent is the shape inheritance uses across orgs.
    const parentId = await seedCompliancePolicy({
      owner: { orgId: null, partnerId: t.partnerId },
      status: 'inactive',
      rules: [registryRule(POWER_PATH, 'Inherited')],
    });
    await seedCompliancePolicy({ owner: { orgId: t.orgId, partnerId: null }, parentPolicyId: parentId, rules: [], withComplianceLink: false });

    const probe = await withDbAccessContext(agentContext(t.orgId, t.partnerId), () =>
      buildPolicyProbeConfigUpdate(t.orgId, { partnerId: t.partnerId }));

    expect(probe?.policy_registry_state_probes).toEqual([{ registry_path: POWER_PATH, value_name: 'Inherited' }]);
  });

  runDb('inactive policies and other orgs\' policies are not probed; duplicates with automation policies collapse', async () => {
    const t = await seedTenant();
    const other = await seedTenant();
    await seedCompliancePolicy({ owner: { orgId: t.orgId, partnerId: null }, status: 'inactive', rules: [registryRule(POWER_PATH, 'Inactive')] });
    await seedCompliancePolicy({ owner: { orgId: other.orgId, partnerId: null }, rules: [registryRule(POWER_PATH, 'OtherOrg')] });
    await seedCompliancePolicy({ owner: { orgId: t.orgId, partnerId: null }, rules: [registryRule(POWER_PATH, 'Shared')] });
    await sys(() => db.insert(automationPolicies).values({
      orgId: t.orgId, partnerId: null, name: `legacy ${randomUUID()}`, enabled: true, targets: {},
      rules: [registryRule(POWER_PATH.toLowerCase(), 'shared')],
    } as never));

    const probe = await withDbAccessContext(agentContext(t.orgId, t.partnerId), () =>
      buildPolicyProbeConfigUpdate(t.orgId, { partnerId: t.partnerId }));

    const names = (probe?.policy_registry_state_probes ?? []).map((p) => p.value_name.toLowerCase());
    expect(names).toEqual(['shared']);
  });
});
