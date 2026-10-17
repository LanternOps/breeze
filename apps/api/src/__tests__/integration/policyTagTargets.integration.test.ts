/**
 * Compliance (automation) policies targeted at tags, against real Postgres
 * (#8857). The tags branch of resolveTargetDevices bound the JS tag list as a
 * row tuple: one tag failed with "malformed array literal", two or more with
 * "operator does not exist: text[] && record", so every tag-targeted policy
 * threw on every evaluation. Runs the real evaluate-policy job body.
 *
 * Tag-targeted results are observe-only: compliance rows are written, but no
 * remediation is dispatched and no policy.* event is published, so the policy
 * alert bridge raises no alert either. Unit coverage of the gate:
 * services/policyEvaluationService.tagTargets.test.ts.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  alerts,
  automationPolicies,
  automationPolicyCompliance,
  automationRuns,
  automations,
  devices,
} from '../../db/schema';
import { __processEvaluatePolicy } from '../../jobs/policyEvaluationWorker';
import { automationPolicyTargetedDeviceIds } from '../../services/policyEvaluationService';
import { handlePolicyCompliantEvent, handlePolicyViolationEvent } from '../../services/policyAlertBridge';
import {
  _resetEventSubscriberRegistryForTests,
  registerEventSubscriber,
} from '../../services/eventSubscriberRegistry';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

beforeAll(() => {
  _resetEventSubscriberRegistryForTests();
  registerEventSubscriber({
    id: 'policy-alert-bridge',
    eventTypes: ['policy.violation', 'policy.compliant'],
    handler: (event) => (event.type === 'policy.violation'
      ? handlePolicyViolationEvent(event)
      : handlePolicyCompliantEvent(event)),
  });
});

afterAll(() => {
  _resetEventSubscriberRegistryForTests();
});

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org!.id });
  const orgId = org!.id;
  return withSystemDbAccessContext(async () => {
    const tagSets = [['finance'], ['finance', 'pos'], ['pos'], ['other'], []];
    const rows = await db
      .insert(devices)
      .values(tagSets.map((tags, i) => ({
        orgId,
        siteId: site!.id,
        agentId: `ptt-agent-${randomUUID()}`,
        hostname: `ptt-host-${i}-${randomUUID().slice(0, 6)}`,
        osType: 'windows' as const,
        // Never satisfies the os_version rule below, so every targeted device
        // is non-compliant without seeding inventory.
        osVersion: '10.0.19045',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online' as const,
        tags,
      })))
      .returning({ id: devices.id, tags: devices.tags });
    const byTags = (tags: string[]) => rows.find((r) => JSON.stringify(r.tags) === JSON.stringify(tags))!.id;

    // A real remediation automation the policy names explicitly, so the
    // assertion that nothing was dispatched is not vacuous.
    const [automation] = await db
      .insert(automations)
      .values({
        orgId,
        name: `ptt remediation ${randomUUID()}`,
        enabled: true,
        trigger: { type: 'manual' },
        actions: [{ type: 'run_script', scriptId: randomUUID() }],
        onFailure: 'stop',
      })
      .returning({ id: automations.id });

    const makePolicy = async (tags: string[]) => {
      const [policy] = await db
        .insert(automationPolicies)
        .values({
          orgId,
          name: `ptt policy ${randomUUID()}`,
          enabled: true,
          targets: { targetType: 'tags', targetIds: tags },
          rules: [{ type: 'os_version', minOsVersion: '99.0.0', remediationAutomationId: automation!.id }],
          enforcement: 'enforce',
          checkIntervalMinutes: 60,
        })
        .returning();
      return policy!;
    };

    return {
      automationId: automation!.id,
      finance: byTags(['finance']),
      financePos: byTags(['finance', 'pos']),
      pos: byTags(['pos']),
      other: byTags(['other']),
      untagged: byTags([]),
      oneTagPolicy: await makePolicy(['finance']),
      twoTagPolicy: await makePolicy(['finance', 'pos']),
    };
  });
}

async function complianceDeviceIds(policyId: string) {
  const rows = await withSystemDbAccessContext(() => db
    .select({ deviceId: automationPolicyCompliance.deviceId, status: automationPolicyCompliance.status })
    .from(automationPolicyCompliance)
    .where(eq(automationPolicyCompliance.policyId, policyId)));
  expect(new Set(rows.map((r) => r.status))).toEqual(new Set(['non_compliant']));
  return new Set(rows.map((r) => r.deviceId));
}

describe('tag-targeted compliance policies against Postgres (#8857)', () => {
  runDb('one tag and two tags each evaluate exactly the tagged devices, observe-only', async () => {
    const s = await seed();

    const one = await __processEvaluatePolicy(s.oneTagPolicy.id);
    expect(one).toMatchObject({ devicesEvaluated: 2, nonCompliant: 2 });
    expect(await complianceDeviceIds(s.oneTagPolicy.id)).toEqual(new Set([s.finance, s.financePos]));

    const two = await __processEvaluatePolicy(s.twoTagPolicy.id);
    expect(two).toMatchObject({ devicesEvaluated: 3, nonCompliant: 3 });
    expect(await complianceDeviceIds(s.twoTagPolicy.id)).toEqual(new Set([s.finance, s.financePos, s.pos]));

    await withSystemDbAccessContext(async () => {
      // No remediation run for the enforce policy's explicit automation…
      const runs = await db
        .select({ id: automationRuns.id })
        .from(automationRuns)
        .where(eq(automationRuns.automationId, s.automationId));
      expect(runs).toEqual([]);
      // …and no policy.violation reached the alert bridge.
      const opened = await db
        .select({ id: alerts.id })
        .from(alerts)
        .where(inArray(alerts.deviceId, [s.finance, s.financePos, s.pos]));
      expect(opened).toEqual([]);
    });
  });

  runDb('the alert-reconcile membership check resolves tag targets instead of throwing', async () => {
    const s = await seed();
    const all = [s.finance, s.financePos, s.pos, s.other, s.untagged];

    const targeted = await withSystemDbAccessContext(() => automationPolicyTargetedDeviceIds(s.twoTagPolicy, all));
    expect(targeted).toEqual(new Set([s.finance, s.financePos, s.pos]));

    const oneTargeted = await withSystemDbAccessContext(() => automationPolicyTargetedDeviceIds(s.oneTagPolicy, all));
    expect(oneTargeted).toEqual(new Set([s.finance, s.financePos]));
  });
});
