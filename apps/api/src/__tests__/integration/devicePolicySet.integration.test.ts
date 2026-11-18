/**
 * #8142 — the policy-set statement against real Postgres: it is a superset of
 * the per-resolver reads, and in the heartbeat's org-scoped context RLS by
 * itself hides every cross-tenant row (other org, other partner), whatever the
 * WHERE clause says. Same-partner partner-wide rows targeting SIBLINGS stay
 * RLS-visible by design; their exclusion is the selectors' job (parity suite).
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { configPolicyAssignments, configPolicyFeatureLinks, configurationPolicies, softwarePolicies } from '../../db/schema';
import { loadDeviceHierarchy } from '../../services/deviceHierarchy';
import { loadDevicePolicySet } from '../../services/devicePolicySet';
import { createOrganization, createPartner, createSite } from './db-utils';
import { inOrg, seedDevice, seedParityWorld, seedPolicy, sys, type ParityWorld } from './policySetFixtures';

const runDb = it.runIf(!!process.env.DATABASE_URL);
let w: ParityWorld;

describe('loadDevicePolicySet (#8142) — real PostgreSQL', () => {
  beforeEach(async () => {
    if (!process.env.DATABASE_URL) return;
    w = await seedParityWorld();
  });

  runDb('org-scoped load returns the same candidates as a system-scoped load, and none of the forged rows', async () => {
    const asOrg = await inOrg(w.orgId, w.partnerId, async () => {
      const h = await loadDeviceHierarchy(w.deviceId);
      return loadDevicePolicySet(h!);
    });
    const asSystem = await sys(async () => {
      const h = await loadDeviceHierarchy(w.deviceId);
      return loadDevicePolicySet(h!);
    });
    const ids = (s: typeof asOrg) => s.candidates.map((c) => c.policyId);
    expect(ids(asOrg)).toEqual(ids(asSystem));
    for (const forged of w.forgedPolicyIds) expect(ids(asOrg)).not.toContain(forged);
    // The parity world's applicable rows are all present.
    const types = new Set(asOrg.candidates.flatMap((c) => Object.keys(c.links)));
    for (const t of ['helper', 'warranty', 'event_log', 'hardware_monitoring', 'pam', 'patch', 'time_sync', 'monitors', 'onedrive_helper']) {
      expect(types.has(t), t).toBe(true);
    }
  });

  runDb('candidates are ordered by assignment created_at, then id — insert order is deliberately NOT that order', async () => {
    const partner = (await createPartner())!;
    const org = (await createOrganization({ partnerId: partner.id }))!;
    const site = (await createSite({ orgId: org.id }))!;
    const deviceId = await seedDevice(org.id, site.id, 'order');
    const day = (n: number) => new Date(Date.UTC(2026, 0, n));
    const ids = {
      newest: '55555555-0000-4000-8000-000000000005',
      oldest: '99999999-0000-4000-8000-000000000009', // highest id, but earliest created_at
      tieHigh: 'cccccccc-0000-4000-8000-00000000000c',
      tieLow: '11111111-0000-4000-8000-000000000001',
    };
    // Insert order: newest, tieHigh, oldest, tieLow. Expected: oldest (d1),
    // then the d2 pair by id (tieLow before tieHigh), then newest (d3).
    const insertOrder: Array<[string, Date]> = [
      [ids.newest, day(3)], [ids.tieHigh, day(2)], [ids.oldest, day(1)], [ids.tieLow, day(2)],
    ];
    for (const [id, createdAt] of insertOrder) {
      await seedPolicy({ owner: { orgId: org.id, partnerId: null },
        links: [{ featureType: 'pam', inlineSettings: { uacInterceptionEnabled: true } }],
        assignments: [{ id, level: 'organization', targetId: org.id, createdAt }] });
    }
    const set = await inOrg(org.id, partner.id, async () => loadDevicePolicySet((await loadDeviceHierarchy(deviceId))!));
    expect(set.candidates.map((c) => c.assignmentId)).toEqual([ids.oldest, ids.tieLow, ids.tieHigh, ids.newest]);
  });

  runDb('the inherited time_sync link of an INACTIVE partner-wide parent reaches the org child, with its settings', async () => {
    const set = await inOrg(w.orgId, w.partnerId, async () => loadDevicePolicySet((await loadDeviceHierarchy(w.deviceId))!));
    const child = set.candidates.find((c) => c.level === 'device' && c.links.time_sync);
    expect(child?.links.time_sync?.timeSync?.ntpServers).toEqual(['time.parent.example']);
  });

  runDb('a link without its settings row carries null settings', async () => {
    const set = await inOrg(w.orgId, w.partnerId, async () => loadDevicePolicySet((await loadDeviceHierarchy(w.deviceId))!));
    const bare = set.candidates.find((c) => c.level === 'device' && c.links.event_log);
    expect(bare?.links.event_log?.eventLog).toBeNull();
  });

  runDb('#6958 PR E: software_policy and security_agents links ride the set as presence only (nested settings null)', async () => {
    const partner = (await createPartner())!;
    const org = (await createOrganization({ partnerId: partner.id }))!;
    const site = (await createSite({ orgId: org.id }))!;
    const deviceId = await seedDevice(org.id, site.id, 'swlinks');
    const policyId = await seedPolicy({
      owner: { orgId: org.id, partnerId: null },
      links: [{ featureType: 'pam', inlineSettings: { uacInterceptionEnabled: true } }],
      assignments: [{ level: 'organization', targetId: org.id }],
    });
    const softwarePolicyId = await sys(async () => {
      const [sw] = await db.insert(softwarePolicies).values({
        orgId: org.id, name: 'set swlinks', mode: 'allowlist', rules: { software: [] },
      }).returning({ id: softwarePolicies.id });
      await db.insert(configPolicyFeatureLinks).values([
        { configPolicyId: policyId, featureType: 'software_policy' as const, featurePolicyId: sw!.id },
        { configPolicyId: policyId, featureType: 'security_agents' as const, inlineSettings: { version: 1, agents: [] } },
      ]);
      return sw!.id;
    });

    const set = await inOrg(org.id, partner.id, async () => loadDevicePolicySet((await loadDeviceHierarchy(deviceId))!));
    const candidate = set.candidates.find((c) => c.policyId === policyId);
    expect(candidate?.links.software_policy?.featurePolicyId).toBe(softwarePolicyId);
    expect(candidate?.links.security_agents).toBeDefined();
    for (const link of [candidate?.links.software_policy, candidate?.links.security_agents]) {
      expect(link).toMatchObject({ eventLog: null, hardwareMonitoring: null, patch: null, timeSync: null, onedrive: null });
    }
    // The pre-existing link is unchanged.
    expect(candidate?.links.pam).toBeDefined();
  });

  runDb('RLS ALONE hides cross-tenant assignments: an unfiltered read in the org context never sees them', async () => {
    const unfiltered = () => db
      .select({ policyId: configurationPolicies.id })
      .from(configPolicyAssignments)
      .innerJoin(configurationPolicies, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
      .where(inArray(configurationPolicies.id, w.forgedPolicyIds));
    // Control: the rows exist.
    expect((await sys(unfiltered)).length).toBe(w.forgedPolicyIds.length);
    // The heartbeat's context: none of them.
    expect(await inOrg(w.orgId, w.partnerId, unfiltered)).toEqual([]);
  });
});
