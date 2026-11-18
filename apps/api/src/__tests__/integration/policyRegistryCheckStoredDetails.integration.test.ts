/**
 * #11976 — a configuration-policy `registry_check` stores its outcome, never
 * the value the device reported, against real PostgreSQL.
 *
 * Compliance details (`automation_policy_compliance.details`) are returned to
 * devices:read callers, while reading a registry value live needs
 * devices:execute. Now that configuration-policy registry rules are collected,
 * a mismatch must store only `mismatched` and the expected value the author
 * wrote.
 */
import './setup';

import { vi } from 'vitest';

vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: vi.fn(async () => 'test-event-id') };
});

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  automationPolicyCompliance,
  configPolicyAssignments,
  configPolicyComplianceRules,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceConfigState,
  deviceRegistryState,
  devices,
} from '../../db/schema';
import { evaluateDeviceComplianceFromConfigPolicy } from '../../services/policyEvaluationService';
import { MAX_POLICY_STATE_PROBES_PER_ORG } from '../../services/policyStateProbes';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const REGISTRY_PATH = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Personalization';
const OBSERVED = `observed-${randomUUID()}`;

async function seed(rules: unknown[]) {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  return withSystemDbAccessContext(async () => {
    const [device] = await db.insert(devices).values({
      orgId: org.id,
      siteId: site.id,
      agentId: `rc-agent-${randomUUID()}`,
      hostname: `rc-host-${randomUUID().slice(0, 8)}`,
      osType: 'windows',
      osVersion: '10.0.19045',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      status: 'online',
    }).returning();
    const [policy] = await db.insert(configurationPolicies)
      .values({ orgId: org.id, partnerId: null, name: `rc policy ${randomUUID()}`, status: 'active' })
      .returning();
    const [link] = await db.insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: 'compliance' })
      .returning();
    await db.insert(configPolicyComplianceRules).values({
      featureLinkId: link!.id, name: `Lock screen ${randomUUID().slice(0, 6)}`, rules, enforcementLevel: 'monitor',
    });
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy!.id, level: 'organization', targetId: org.id, priority: 0,
    });
    await db.insert(deviceRegistryState).values({
      deviceId: device!.id, orgId: org.id, registryPath: REGISTRY_PATH, valueName: 'NoLockScreen',
      valueData: OBSERVED, valueType: 'REG_SZ',
    });
    return { deviceId: device!.id, featureLinkId: link!.id, orgId: org.id };
  });
}

async function storedDetails(featureLinkId: string) {
  return withSystemDbAccessContext(() => db
    .select({ status: automationPolicyCompliance.status, details: automationPolicyCompliance.details })
    .from(automationPolicyCompliance)
    .where(eq(automationPolicyCompliance.configPolicyId, featureLinkId)));
}

describe('configuration-policy registry_check stored details (#11976) — real PostgreSQL', () => {
  runDb('a mismatch stores the outcome and the expected value, never the observed value', async () => {
    const { deviceId, featureLinkId } = await seed([
      { type: 'registry_check', registryPath: REGISTRY_PATH, registryValueName: 'NoLockScreen', registryExpectedValue: '1' },
    ]);

    await withSystemDbAccessContext(() => evaluateDeviceComplianceFromConfigPolicy(deviceId));

    const rows = await storedDetails(featureLinkId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('non_compliant');
    const serialized = JSON.stringify(rows[0]!.details);
    expect(serialized).not.toContain(OBSERVED);
    expect(serialized).not.toContain('REG_SZ');
    const ruleResults = (rows[0]!.details as { ruleResults: Array<Record<string, unknown>> }).ruleResults;
    expect(ruleResults[0]).toMatchObject({
      ruleType: 'registry_check',
      passed: false,
      data: { outcome: 'mismatched', expectedValue: '1' },
    });
  });

  runDb('#12130: a config_check mismatch stores the outcome and the expected value, never the observed value', async () => {
    const filePath = '/etc/ssh/sshd_config';
    const { deviceId, featureLinkId, orgId } = await seed([
      { type: 'config_check', configFilePath: filePath, configKey: 'PermitRootLogin', configExpectedValue: 'no' },
    ]);
    await withSystemDbAccessContext(() => db.insert(deviceConfigState).values({
      deviceId, orgId, filePath, configKey: 'PermitRootLogin', configValue: OBSERVED,
    }));

    await withSystemDbAccessContext(() => evaluateDeviceComplianceFromConfigPolicy(deviceId));

    const rows = await storedDetails(featureLinkId);
    expect(rows[0]!.status).toBe('non_compliant');
    expect(JSON.stringify(rows[0]!.details)).not.toContain(OBSERVED);
    const ruleResults = (rows[0]!.details as { ruleResults: Array<Record<string, unknown>> }).ruleResults;
    expect(ruleResults[0]).toMatchObject({
      ruleType: 'config_check',
      passed: false,
      data: { outcome: 'mismatched', expectedValue: 'no' },
    });
  });

  runDb('#12130: a rule pushed past the per-org probe cap is stored as pending / not_collected, not non-compliant', async () => {
    const { deviceId, featureLinkId, orgId } = await seed([
      { type: 'registry_check', registryPath: REGISTRY_PATH, registryValueName: 'NoLockScreen', registryExpectedValue: '1' },
    ]);
    // An active org policy that is not assigned to the device still feeds the
    // org's probe list, and its probes sort ahead of REGISTRY_PATH.
    await withSystemDbAccessContext(async () => {
      const [filler] = await db.insert(configurationPolicies)
        .values({ orgId, partnerId: null, name: `rc filler ${randomUUID()}`, status: 'active' })
        .returning();
      const [link] = await db.insert(configPolicyFeatureLinks)
        .values({ configPolicyId: filler!.id, featureType: 'compliance' })
        .returning();
      await db.insert(configPolicyComplianceRules).values({
        featureLinkId: link!.id,
        name: 'filler',
        enforcementLevel: 'monitor',
        rules: Array.from({ length: MAX_POLICY_STATE_PROBES_PER_ORG }, (_, i) => ({
          type: 'registry_check',
          registryPath: `HKLM\\SOFTWARE\\AAA\\Key${String(i).padStart(4, '0')}`,
          registryValueName: 'Enabled',
        })),
      });
    });

    const results = await withSystemDbAccessContext(() => evaluateDeviceComplianceFromConfigPolicy(deviceId));

    expect(results).toEqual([expect.objectContaining({ status: 'pending', remediationTriggered: false })]);
    const rows = await storedDetails(featureLinkId);
    expect(rows[0]!.status).toBe('pending');
    const ruleResults = (rows[0]!.details as { ruleResults: Array<Record<string, unknown>> }).ruleResults;
    expect(ruleResults[0]).toMatchObject({
      ruleType: 'registry_check',
      passed: null,
      data: { outcome: 'not_collected', expectedValue: '1' },
    });
  });
});
