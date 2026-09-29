/**
 * Compliance alerts close when their rule stops applying (follow-up to #7518).
 *
 * With auto-resolve off, a compliance alert closes only on a compliance event:
 * policy.compliant, or a violation for a rule downgraded to monitor. A rule
 * that stops applying never gets another event — it is not evaluated any more
 * — so before the reconcile its alert stayed open forever. That covers a
 * renamed or removed rule set, a removed compliance feature, a deleted or
 * deactivated policy, an unassigned policy, a device another policy now
 * governs, and (automation policies) a disabled or deleted policy or a device
 * it no longer targets.
 *
 * Real Postgres + Redis. Alerts are raised through the real scheduled jobs and
 * the real event bus with the real `policy-alert-bridge` subscriber; the
 * config changes go through the real service functions.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  alerts,
  automationPolicies,
  automationPolicyCompliance,
  configPolicyAssignments,
  configPolicyComplianceRules,
  configPolicyFeatureLinks,
  configurationPolicies,
  devices,
} from '../../db/schema';
import {
  __processConfigPolicyComplianceScan,
  __processEvaluatePolicy,
  __processReconcileComplianceAlerts,
  getPolicyEvaluationQueue,
} from '../../jobs/policyEvaluationWorker';
import {
  deleteConfigPolicy,
  removeFeatureLink,
  unassignPolicy,
  updateConfigPolicy,
  updateFeatureLink,
} from '../../services/configurationPolicy';
import { createSystemAuthContext } from '../../services/featureConfigResolver';
import { reconcileComplianceAlerts } from '../../services/complianceAlertReconcile';
import { handlePolicyCompliantEvent, handlePolicyViolationEvent } from '../../services/policyAlertBridge';
import {
  _resetEventSubscriberRegistryForTests,
  registerEventSubscriber,
} from '../../services/eventSubscriberRegistry';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const OPEN_STATUSES = ['active', 'acknowledged', 'suppressed'] as const;
const APP_NAME = 'Northwind Agent';
const RULE_NAME = `Keep ${APP_NAME} installed`;
type RuleSet = {
  name: string;
  rules: Array<Record<string, unknown>>;
  enforcementLevel: 'monitor' | 'warn' | 'enforce';
  checkIntervalMinutes: number;
};
const rule = (name = RULE_NAME): RuleSet => ({
  name,
  rules: [{ type: 'required_software', softwareName: APP_NAME, versionOperator: 'any' }],
  enforcementLevel: 'warn',
  checkIntervalMinutes: 60,
});
const OTHER_RULE = (): RuleSet => ({
  name: 'Keep 5 GB free',
  rules: [{ type: 'disk_space_minimum', minGb: 5 }],
  enforcementLevel: 'monitor',
  checkIntervalMinutes: 60,
});
const systemAuth = createSystemAuthContext();

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

async function seedDevice(orgId: string, siteId: string) {
  const [d] = await withSystemDbAccessContext(() => db
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `car-agent-${randomUUID()}`,
      hostname: `car-host-${randomUUID().slice(0, 8)}`,
      osType: 'windows',
      osVersion: '10.0.19045',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      status: 'online',
    })
    .returning());
  return d!;
}

type Owner = { orgId: string | null; partnerId: string | null };

/** A configuration policy with one compliance link holding `items`, assigned to `target`. */
async function seedConfigPolicy(owner: Owner, items: RuleSet[], target: { level: 'partner' | 'organization'; targetId: string }) {
  return withSystemDbAccessContext(async () => {
    const name = `car policy ${randomUUID().slice(0, 8)}`;
    const [policy] = await db
      .insert(configurationPolicies)
      .values({ orgId: owner.orgId, partnerId: owner.partnerId, name, status: 'active' })
      .returning();
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: 'compliance', inlineSettings: { items } })
      .returning();
    await db.insert(configPolicyComplianceRules).values(items.map((item, i) => ({ featureLinkId: link!.id, ...item, sortOrder: i })));
    const [assignment] = await db
      .insert(configPolicyAssignments)
      .values({ configPolicyId: policy!.id, level: target.level, targetId: target.targetId, priority: 0 })
      .returning();
    return { policyId: policy!.id, policyName: name, featureLinkId: link!.id, assignmentId: assignment!.id };
  });
}

/** An org with one device failing an org-owned policy's `warn` rule, and its open alert. */
async function seedFailingDevice() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org!.id });
  const device = await seedDevice(org!.id, site!.id);
  const policy = await seedConfigPolicy({ orgId: org!.id, partnerId: null }, [rule()], { level: 'organization', targetId: org!.id });
  await __processConfigPolicyComplianceScan();
  const open = await openAlerts(device.id);
  expect(open).toHaveLength(1);
  return { orgId: org!.id, partnerId: partner.id, siteId: site!.id, device, alertId: open[0]!.id, ...policy };
}

async function openAlerts(deviceId: string) {
  return withSystemDbAccessContext(() => db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(eq(alerts.deviceId, deviceId), inArray(alerts.status, [...OPEN_STATUSES]))));
}

async function alertRow(id: string) {
  const [row] = await withSystemDbAccessContext(() => db
    .select({ status: alerts.status, resolutionNote: alerts.resolutionNote, resolutionReason: alerts.resolutionReason })
    .from(alerts)
    .where(eq(alerts.id, id)));
  return row!;
}

function expectClosedBecause(row: Awaited<ReturnType<typeof alertRow>>, reason: string) {
  expect(row.status).toBe('resolved');
  expect(row.resolutionNote).toBe(`Rule no longer applies: ${reason}`);
  expect(row.resolutionReason).toBe('source_retired');
}

const reconcile = (scope?: Parameters<typeof reconcileComplianceAlerts>[0]) =>
  reconcileComplianceAlerts(scope);

describe('configuration-policy compliance alerts close when their rule stops applying', () => {
  runDb('a renamed rule set', async () => {
    const s = await seedFailingDevice();
    await withSystemDbAccessContext(() => updateFeatureLink(s.featureLinkId, { inlineSettings: { items: [rule('Renamed rule set')] } }, s.policyId));

    expect((await reconcile({ orgId: s.orgId })).alertsResolved).toBe(1);
    expectClosedBecause(await alertRow(s.alertId), `rule set "${RULE_NAME}" was renamed or removed in configuration policy "${s.policyName}"`);
  });

  runDb('a rule set removed while others remain', async () => {
    const s = await seedFailingDevice();
    await withSystemDbAccessContext(() => updateFeatureLink(s.featureLinkId, { inlineSettings: { items: [OTHER_RULE()] } }, s.policyId));

    await reconcile({ orgId: s.orgId });
    expectClosedBecause(await alertRow(s.alertId), `rule set "${RULE_NAME}" was renamed or removed in configuration policy "${s.policyName}"`);
  });

  runDb('the compliance feature removed from the policy', async () => {
    const s = await seedFailingDevice();
    await withSystemDbAccessContext(() => removeFeatureLink(s.featureLinkId, s.policyId));

    await reconcile({ orgId: s.orgId });
    expectClosedBecause(await alertRow(s.alertId), `the compliance feature was removed from configuration policy "${s.policyName}"`);
  });

  runDb('the policy deleted', async () => {
    const s = await seedFailingDevice();
    await withSystemDbAccessContext(() => deleteConfigPolicy(s.policyId, systemAuth));

    await reconcile({ orgId: s.orgId });
    expectClosedBecause(await alertRow(s.alertId), `configuration policy "${s.policyName}" was deleted`);
  });

  runDb('the policy deactivated', async () => {
    const s = await seedFailingDevice();
    await withSystemDbAccessContext(() => updateConfigPolicy(s.policyId, { status: 'inactive' }, systemAuth));

    await reconcile({ orgId: s.orgId });
    expectClosedBecause(await alertRow(s.alertId), `configuration policy "${s.policyName}" is inactive`);
  });

  runDb('the policy unassigned', async () => {
    const s = await seedFailingDevice();
    await withSystemDbAccessContext(() => unassignPolicy(s.assignmentId, s.policyId));

    await reconcile({ orgId: s.orgId });
    expectClosedBecause(await alertRow(s.alertId), `configuration policy "${s.policyName}" is no longer assigned to this device`);
  });

  runDb('a rule set that still applies and still fails stays open, across a save that re-creates it', async () => {
    const s = await seedFailingDevice();
    // The Compliance tab's Save: same rule set, new row id.
    await withSystemDbAccessContext(() => updateFeatureLink(s.featureLinkId, { inlineSettings: { items: [rule(), OTHER_RULE()] } }, s.policyId));

    expect((await reconcile({ orgId: s.orgId })).alertsResolved).toBe(0);
    expect(await reconcile()).toMatchObject({ alertsResolved: 0 });
    expect((await openAlerts(s.device.id)).map((a) => a.id)).toEqual([s.alertId]);
  });

  runDb('a partner-wide policy is judged per device org: only the org another policy now governs closes', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: orgA!.id });
    const siteB = await createSite({ orgId: orgB!.id });
    const deviceA = await seedDevice(orgA!.id, siteA!.id);
    const deviceB = await seedDevice(orgB!.id, siteB!.id);
    await seedConfigPolicy({ orgId: null, partnerId: partner.id }, [rule()], { level: 'partner', targetId: partner.id });
    await __processConfigPolicyComplianceScan();
    const [alertA] = await openAlerts(deviceA.id);
    const [alertB] = await openAlerts(deviceB.id);
    expect(alertA).toBeDefined();
    expect(alertB).toBeDefined();

    // Org A gets its own compliance policy. An org-level assignment is closer
    // than the partner-level one, so it wins for org A's devices only.
    const orgPolicy = await seedConfigPolicy({ orgId: orgA!.id, partnerId: null }, [OTHER_RULE()], { level: 'organization', targetId: orgA!.id });

    expect((await reconcile({ partnerId: partner.id })).alertsResolved).toBe(1);
    expectClosedBecause(await alertRow(alertA!.id), `configuration policy "${orgPolicy.policyName}" now takes precedence for this device`);
    expect((await alertRow(alertB!.id)).status).toBe('active');
  });

  runDb('a scoped reconcile looks only at its scope; a policy scope resolves to the policy owner', async () => {
    const s = await seedFailingDevice();
    const otherOrg = await createOrganization({ partnerId: s.partnerId });
    await withSystemDbAccessContext(() => unassignPolicy(s.assignmentId, s.policyId));

    expect((await reconcile({ orgId: otherOrg!.id })).alertsResolved).toBe(0);
    expect((await alertRow(s.alertId)).status).toBe('active');

    expect((await reconcile({ configPolicyId: s.policyId })).alertsResolved).toBe(1);
    expect((await alertRow(s.alertId)).status).toBe('resolved');
  });

  runDb('the reconcile job body resolves the same way', async () => {
    const s = await seedFailingDevice();
    await withSystemDbAccessContext(() => updateConfigPolicy(s.policyId, { status: 'archived' }, systemAuth));

    const result = await __processReconcileComplianceAlerts({ type: 'reconcile-compliance-alerts', orgId: s.orgId });
    expect(result.alertsResolved).toBe(1);
    expectClosedBecause(await alertRow(s.alertId), `configuration policy "${s.policyName}" is archived`);
  });

  runDb('a config write schedules a reconcile for the policy once its transaction commits', async () => {
    const s = await seedFailingDevice();
    await withSystemDbAccessContext(() => updateFeatureLink(s.featureLinkId, { inlineSettings: { items: [rule('Renamed')] } }, s.policyId));

    const queue = getPolicyEvaluationQueue();
    let job: { data: Record<string, unknown> } | undefined;
    for (let i = 0; i < 40 && !job; i++) {
      const jobs = await queue.getJobs(['delayed', 'waiting', 'prioritized']);
      job = jobs.find((j) => j?.data && (j.data as Record<string, unknown>).configPolicyId === s.policyId);
      if (!job) await new Promise((r) => setTimeout(r, 50));
    }
    expect(job?.data).toEqual({ type: 'reconcile-compliance-alerts', configPolicyId: s.policyId });
  });
});

describe('automation-policy alerts close when the policy stops applying', () => {
  async function seedAutomationPolicyAlert() {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org!.id });
    const device = await seedDevice(org!.id, site!.id);
    const name = `car automation policy ${randomUUID().slice(0, 8)}`;
    const [policy] = await withSystemDbAccessContext(() => db
      .insert(automationPolicies)
      .values({
        orgId: org!.id,
        name,
        enabled: true,
        targets: { deviceIds: [device.id] },
        rules: [{ type: 'required_software', softwareName: APP_NAME, versionOperator: 'any' }],
        enforcement: 'warn',
      })
      .returning());
    await __processEvaluatePolicy(policy!.id);
    const [alert] = await openAlerts(device.id);
    expect(alert).toBeDefined();
    return { orgId: org!.id, device, policyId: policy!.id, policyName: name, alertId: alert!.id };
  }

  runDb('a disabled policy', async () => {
    const s = await seedAutomationPolicyAlert();
    await withSystemDbAccessContext(() => db.update(automationPolicies).set({ enabled: false }).where(eq(automationPolicies.id, s.policyId)));

    expect((await reconcile({ orgId: s.orgId })).alertsResolved).toBe(1);
    expectClosedBecause(await alertRow(s.alertId), `automation policy "${s.policyName}" is disabled`);
  });

  runDb('a deleted policy', async () => {
    const s = await seedAutomationPolicyAlert();
    await withSystemDbAccessContext(async () => {
      await db.delete(automationPolicyCompliance).where(eq(automationPolicyCompliance.policyId, s.policyId));
      await db.delete(automationPolicies).where(eq(automationPolicies.id, s.policyId));
    });

    await reconcile({ orgId: s.orgId });
    expectClosedBecause(await alertRow(s.alertId), `automation policy "${s.policyName}" was deleted`);
  });

  runDb('a device the policy no longer targets', async () => {
    const s = await seedAutomationPolicyAlert();
    await withSystemDbAccessContext(() => db
      .update(automationPolicies)
      .set({ targets: sql`jsonb_build_object('deviceIds', jsonb_build_array(${randomUUID()}::text))` })
      .where(eq(automationPolicies.id, s.policyId)));

    await reconcile({ orgId: s.orgId });
    expectClosedBecause(await alertRow(s.alertId), `this device is no longer targeted by automation policy "${s.policyName}"`);
  });

  runDb('a policy that still targets the failing device stays open', async () => {
    const s = await seedAutomationPolicyAlert();

    expect((await reconcile({ orgId: s.orgId })).alertsResolved).toBe(0);
    expect((await alertRow(s.alertId)).status).toBe('active');
  });
});
