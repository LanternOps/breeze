/**
 * Compliance-violation alerting through the SCHEDULED scan, the way production
 * runs it (browser sweep of #7223 on main 628204785b).
 *
 * `configComplianceAlerts.integration.test.ts` hands each published event to the
 * bridge after the evaluation's transaction has committed. Production does not:
 * the `scan-config-policy-compliance` job runs the whole scan in one system
 * transaction (policyEvaluationWorker `commitThenEnqueue`), and `publishEvent`
 * delivers local subscribers synchronously, on their own connection
 * (eventBus.publish → runOutsideDbContext → invokeLocalHandlers). So this suite
 * drives the real job body and the real event bus with the real
 * `policy-alert-bridge` subscriber registered, against live Postgres + Redis:
 *
 *  1. The first failing check raises the alert. Published inside the scan's
 *     transaction, the bridge saw no committed compliance row and logged
 *     "no persisted compliance row … not alerting".
 *  2. The alert stays open through the alert worker's auto-resolve sweep. The
 *     built-in template was created with `autoResolve: true` and conditions the
 *     condition registry cannot evaluate, so the sweep closed it as
 *     "Auto-resolved: conditions cleared" while the device was still failing.
 *  3. The first compliant check resolves it (the bridge used to read the
 *     previous, still-committed `non_compliant` row and keep it open).
 *  4. Editing the rule set re-creates every rule with a new id. The still-failing
 *     rule keeps exactly one open alert, and it still resolves on compliance.
 *  5. The migration corrects a template row already created with auto_resolve.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  alertRules,
  alerts,
  alertTemplates,
  automationPolicyCompliance,
  configPolicyAssignments,
  configPolicyComplianceRules,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceSoftware,
  devices,
} from '../../db/schema';
import { __processConfigPolicyComplianceScan } from '../../jobs/policyEvaluationWorker';
import { checkAllAutoResolve } from '../../services/alertService';
import { updateFeatureLink } from '../../services/configurationPolicy';
import {
  CONFIG_COMPLIANCE_ALERT_SOURCE,
  CONFIG_COMPLIANCE_TEMPLATE_NAME,
} from '../../services/configComplianceAlertBridge';
import { handlePolicyCompliantEvent, handlePolicyViolationEvent } from '../../services/policyAlertBridge';
import {
  _resetEventSubscriberRegistryForTests,
  registerEventSubscriber,
} from '../../services/eventSubscriberRegistry';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const APP_NAME = 'Contoso Agent';
const OPEN_STATUSES = ['active', 'acknowledged', 'suppressed'] as const;
const MIGRATION = '2026-11-10-120100-config-compliance-alert-template-no-auto-resolve.sql';

beforeAll(() => {
  // The production registration (eventSubscribers.ts), minus the unrelated
  // subscribers whose dependencies this suite does not stand up.
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
      agentId: `cad-agent-${randomUUID()}`,
      hostname: `cad-host-${randomUUID().slice(0, 8)}`,
      osType: 'windows',
      osVersion: '10.0.19045',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      status: 'online',
    })
    .returning());
  return d!;
}

const RULE_ITEM = {
  name: `Keep ${APP_NAME} installed`,
  rules: [{ type: 'required_software', softwareName: APP_NAME, versionOperator: 'any' }],
  enforcementLevel: 'warn' as const,
  checkIntervalMinutes: 60,
};

/** An org-owned policy with one `warn` compliance rule, assigned to the org. */
async function seedPolicy(orgId: string) {
  return withSystemDbAccessContext(async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({ orgId, partnerId: null, name: `cad policy ${randomUUID()}`, status: 'active' })
      .returning();
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: 'compliance', inlineSettings: { items: [RULE_ITEM] } })
      .returning();
    const [rule] = await db
      .insert(configPolicyComplianceRules)
      .values({ featureLinkId: link!.id, ...RULE_ITEM })
      .returning();
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy!.id,
      level: 'organization',
      targetId: orgId,
      priority: 0,
    });
    return { policyId: policy!.id, featureLinkId: link!.id, ruleId: rule!.id };
  });
}

async function seedFailingDevice() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org!.id });
  const device = await seedDevice(org!.id, site!.id);
  const seeded = await seedPolicy(org!.id);
  return { orgId: org!.id, device, ...seeded };
}

/**
 * Makes the device's checks due again. The scan only evaluates a rule once its
 * checkIntervalMinutes has elapsed since `last_checked_at`.
 */
async function makeDue(deviceId: string) {
  await withSystemDbAccessContext(() => db
    .update(automationPolicyCompliance)
    .set({ lastCheckedAt: sql`now() - interval '2 hours'` })
    .where(eq(automationPolicyCompliance.deviceId, deviceId)));
}

async function installApp(deviceId: string) {
  await withSystemDbAccessContext(() => db.insert(deviceSoftware).values({ deviceId, name: APP_NAME, version: '7.1' }));
}

async function openAlerts(deviceId: string) {
  return withSystemDbAccessContext(() => db
    .select({ id: alerts.id, status: alerts.status, ruleId: alerts.ruleId, context: alerts.context })
    .from(alerts)
    .where(and(eq(alerts.deviceId, deviceId), inArray(alerts.status, [...OPEN_STATUSES]))));
}

async function allAlerts(deviceId: string) {
  return withSystemDbAccessContext(() => db
    .select({ id: alerts.id, status: alerts.status, resolutionNote: alerts.resolutionNote })
    .from(alerts)
    .where(eq(alerts.deviceId, deviceId)));
}

async function ruleIdsFor(featureLinkId: string) {
  const rows = await withSystemDbAccessContext(() => db
    .select({ id: configPolicyComplianceRules.id })
    .from(configPolicyComplianceRules)
    .where(eq(configPolicyComplianceRules.featureLinkId, featureLinkId)));
  return rows.map((r) => r.id);
}

describe('compliance alerts through the scheduled scan', () => {
  runDb('the first failing check raises the alert', async () => {
    const { device } = await seedFailingDevice();

    const scan = await __processConfigPolicyComplianceScan();
    expect(scan.devicesEvaluated).toBe(1);

    const open = await openAlerts(device.id);
    expect(open).toHaveLength(1);
    expect(open[0]!.status).toBe('active');
    expect(open[0]!.context).toMatchObject({ source: CONFIG_COMPLIANCE_ALERT_SOURCE });
  });

  runDb('the alert stays open through the auto-resolve sweep while the device is still failing', async () => {
    const { orgId, device } = await seedFailingDevice();

    // Two checks, so an alert exists whatever the first check does.
    await __processConfigPolicyComplianceScan();
    await makeDue(device.id);
    await __processConfigPolicyComplianceScan();
    expect(await openAlerts(device.id)).toHaveLength(1);

    const [template] = await withSystemDbAccessContext(() => db
      .select({ autoResolve: alertTemplates.autoResolve })
      .from(alertTemplates)
      .where(eq(alertTemplates.name, CONFIG_COMPLIANCE_TEMPLATE_NAME)));
    expect(template?.autoResolve).toBe(false);

    // The alert worker's periodic sweep.
    const resolvedBySweep = await withSystemDbAccessContext(() => checkAllAutoResolve(orgId));
    expect(resolvedBySweep).toBe(0);
    expect(await openAlerts(device.id)).toHaveLength(1);
  });

  runDb('the first compliant check resolves the alert', async () => {
    const { device } = await seedFailingDevice();

    await __processConfigPolicyComplianceScan();
    await makeDue(device.id);
    await __processConfigPolicyComplianceScan();
    expect(await openAlerts(device.id)).toHaveLength(1);

    await installApp(device.id);
    await makeDue(device.id);
    await __processConfigPolicyComplianceScan();

    expect(await openAlerts(device.id)).toHaveLength(0);
    const rows = await allAlerts(device.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('resolved');
    expect(rows[0]!.resolutionNote).toBe('Auto-resolved: device returned to compliance');
  });

  runDb('editing the rule set keeps one open alert for a still-failing rule, and it still resolves', async () => {
    const { orgId, device, policyId, featureLinkId, ruleId } = await seedFailingDevice();

    await __processConfigPolicyComplianceScan();
    await makeDue(device.id);
    await __processConfigPolicyComplianceScan();
    const [raised] = await openAlerts(device.id);
    expect(raised).toBeDefined();

    // The Compliance tab's Save: PATCH the link with the same rule set. The
    // normalized rules are deleted and re-inserted, so the rule gets a new id.
    await withSystemDbAccessContext(() => updateFeatureLink(
      featureLinkId,
      { inlineSettings: { items: [RULE_ITEM] } },
      policyId,
    ));
    const [newRuleId] = await ruleIdsFor(featureLinkId);
    expect(newRuleId).toBeDefined();
    expect(newRuleId).not.toBe(ruleId);

    // Still failing: the alert that is already open stands for it — no second one.
    await makeDue(device.id);
    expect((await __processConfigPolicyComplianceScan()).devicesEvaluated).toBe(1);
    const open = await openAlerts(device.id);
    expect(open.map((a) => a.id)).toEqual([raised!.id]);
    expect(await withSystemDbAccessContext(() => checkAllAutoResolve(orgId))).toBe(0);

    // Compliant under the new id: the alert raised under the old one clears.
    await installApp(device.id);
    await makeDue(device.id);
    await __processConfigPolicyComplianceScan();
    expect(await openAlerts(device.id)).toHaveLength(0);
  });

  runDb('an edit does not mint another alert rule for the same compliance rule', async () => {
    const { device, policyId, featureLinkId } = await seedFailingDevice();

    await __processConfigPolicyComplianceScan();
    await makeDue(device.id);
    await __processConfigPolicyComplianceScan();
    const alertRuleIdsBefore = (await openAlerts(device.id)).map((a) => a.ruleId);
    expect(alertRuleIdsBefore).toHaveLength(1);

    await withSystemDbAccessContext(() => updateFeatureLink(
      featureLinkId,
      { inlineSettings: { items: [RULE_ITEM] } },
      policyId,
    ));
    await makeDue(device.id);
    expect((await __processConfigPolicyComplianceScan()).devicesEvaluated).toBe(1);

    // The same org-owned alert rule serves the rule across the edit, so there is
    // one rule per (org, compliance rule) — not one more per save.
    const rules = await withSystemDbAccessContext(() => db
      .select({ id: alertRules.id })
      .from(alertRules)
      .where(eq(alertRules.orgId, device.orgId)));
    expect(rules.map((r) => r.id)).toEqual(alertRuleIdsBefore);
  });
});

describe(`migration ${MIGRATION}`, () => {
  // Replayed the way autoMigrate applies it. This role bypasses RLS, so the test
  // cannot catch a missing system-scope line; migrationRlsScope.test.ts does.
  const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 1, onnotice: () => {} });
  afterAll(async () => { await adminSql.end({ timeout: 5 }); });

  async function insertTemplate(values: { orgId: string | null; isBuiltIn: boolean }) {
    const [row] = await withSystemDbAccessContext(() => db
      .insert(alertTemplates)
      .values({
        orgId: values.orgId,
        partnerId: null,
        name: CONFIG_COMPLIANCE_TEMPLATE_NAME,
        conditions: { source: CONFIG_COMPLIANCE_ALERT_SOURCE },
        severity: 'medium',
        titleTemplate: 'Compliance violation on {{hostname}}',
        messageTemplate: '{{ruleName}} is not met on {{hostname}}',
        autoResolve: true,
        isBuiltIn: values.isBuiltIn,
        cooldownMinutes: 30,
      })
      .returning({ id: alertTemplates.id }));
    return row!.id;
  }

  async function autoResolveOf(id: string) {
    const [row] = await withSystemDbAccessContext(() => db
      .select({ autoResolve: alertTemplates.autoResolve })
      .from(alertTemplates)
      .where(eq(alertTemplates.id, id)));
    return row?.autoResolve;
  }

  runDb('turns auto_resolve off on the built-in template already created, touches nothing else, and re-runs as a no-op', async () => {
    const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const builtIn = await insertTemplate({ orgId: null, isBuiltIn: true });
    // A same-named template someone created in their own org is theirs, not ours.
    const orgOwned = await insertTemplate({ orgId: org!.id, isBuiltIn: false });

    await adminSql.unsafe(migrationSql);
    expect(await autoResolveOf(builtIn)).toBe(false);
    expect(await autoResolveOf(orgOwned)).toBe(true);

    await adminSql.unsafe(migrationSql);
    expect(await autoResolveOf(builtIn)).toBe(false);
  });
});
