/**
 * #6263 W01 / CLAUDE.md "Partner-Wide First" §5: a worker/scheduler evaluating
 * a dual-axis config table against devices MUST fan out by the device org's
 * partner, never `eq(table.orgId, device.orgId)` alone — that silently no-ops
 * on `org_id NULL`. §6 requires ONE integration test proving the fan-out
 * fires against real Postgres; none existed for the `security` feature type
 * (`resolveAllSecurityScanScheduledDevices`, `services/featureConfigResolver.ts`).
 *
 * This seeds a single partner-wide `security` config policy (org_id NULL,
 * partner_id set), assigned at the PARTNER level, under a partner that owns
 * two distinct orgs each with one device. It asserts the resolved
 * schedulable's deviceIds include devices from BOTH orgs — the discriminating
 * proof that the fan-out walks the partner's orgs rather than resolving
 * against a single (or no) org.
 *
 * `resolveAllSecurityScanScheduledDevices` is the scheduler-side "resolve
 * everyone" fan-out (no deviceId argument) — it runs under
 * `withSystemDbAccessContext` per its own docstring, unlike the per-device
 * resolvers in featureConfigResolverPartnerWide.integration.test.ts which are
 * exercised under an org-scoped RLS context. Model for seeding pattern:
 * vulnerabilityCorrelationGating.integration.test.ts's
 * `resolveAllVulnerabilityEnabledDevices (batch)` suite.
 */
import './setup';

import { describe, expect, it } from 'vitest';

import { db, withSystemDbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  devices,
  organizations,
  partners,
  sites,
} from '../../db/schema';
import { resolveAllSecurityScanScheduledDevices } from '../../services/featureConfigResolver';

const runDb = it.runIf(!!process.env.DATABASE_URL);

let counter = 0;
function uniq(): string {
  counter += 1;
  return `${Date.now()}-${counter}`;
}

async function seedOrgWithDevice(partnerId: string): Promise<{ orgId: string; deviceId: string }> {
  return withSystemDbAccessContext(async () => {
    const u = uniq();
    const [org] = await db
      .insert(organizations)
      .values({
        currencyCode: 'USD',
        partnerId,
        name: `Fanout Org ${u}`,
        slug: `fanout-org-${u}`,
        type: 'customer',
        status: 'active',
      })
      .returning({ id: organizations.id });
    const [site] = await db.insert(sites).values({ orgId: org!.id, name: `Fanout Site ${u}` }).returning({ id: sites.id });
    const [device] = await db
      .insert(devices)
      .values({
        orgId: org!.id,
        siteId: site!.id,
        agentId: `fanout-agent-${u}`,
        hostname: `fanout-host-${u}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'offline',
      })
      .returning({ id: devices.id });
    return { orgId: org!.id, deviceId: device!.id };
  });
}

describe('resolveAllSecurityScanScheduledDevices partner-wide fan-out (#6263, Partner-Wide First §5/§6)', () => {
  runDb('a partner-wide security policy resolves devices across more than one org', async () => {
    const u = uniq();

    const { partnerId, policyId } = await withSystemDbAccessContext(async () => {
      const [partner] = await db
        .insert(partners)
        .values({ name: `Fanout Partner ${u}`, slug: `fanout-partner-${u}`, type: 'msp', plan: 'pro', status: 'active' })
        .returning({ id: partners.id });

      const [policy] = await db
        .insert(configurationPolicies)
        .values({ orgId: null, partnerId: partner!.id, name: `Fanout Security Policy ${u}`, status: 'active' })
        .returning({ id: configurationPolicies.id });
      await db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policy!.id,
        featureType: 'security',
        inlineSettings: { scheduledScans: true },
      });
      await db.insert(configPolicyAssignments).values({
        configPolicyId: policy!.id,
        level: 'partner',
        targetId: partner!.id,
        priority: 0,
      });

      return { partnerId: partner!.id, policyId: policy!.id };
    });

    const deviceOrgA = await seedOrgWithDevice(partnerId);
    const deviceOrgB = await seedOrgWithDevice(partnerId);

    const entries = await withSystemDbAccessContext(() => resolveAllSecurityScanScheduledDevices());
    const entry = entries.find((e) => e.configPolicyId === policyId);

    expect(entry).toBeDefined();
    expect(entry!.orgId).toBeNull();
    expect(entry!.partnerId).toBe(partnerId);
    // The discriminating assertion: the fan-out must reach devices in BOTH
    // orgs under the partner-wide policy, not just one (or a single org's
    // devices, which is what `eq(table.orgId, device.orgId)` would silently
    // collapse to).
    expect(entry!.deviceIds).toEqual(
      expect.arrayContaining([deviceOrgA.deviceId, deviceOrgB.deviceId]),
    );
    expect(deviceOrgA.orgId).not.toBe(deviceOrgB.orgId);
  });
});
