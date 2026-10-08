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
import { configPolicyAssignments, configurationPolicies } from '../../db/schema';
import { loadDeviceHierarchy } from '../../services/deviceHierarchy';
import { loadDevicePolicySet } from '../../services/devicePolicySet';
import { inOrg, seedParityWorld, sys, type ParityWorld } from './policySetFixtures';

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

  runDb('candidates are ordered by assignment created_at, then id', async () => {
    const set = await inOrg(w.orgId, w.partnerId, async () => loadDevicePolicySet((await loadDeviceHierarchy(w.deviceId))!));
    const keys = set.candidates.map((c) => [c.assignmentCreatedAt.getTime(), c.assignmentId] as const);
    const sorted = [...keys].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    expect(keys).toEqual(sorted);
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
