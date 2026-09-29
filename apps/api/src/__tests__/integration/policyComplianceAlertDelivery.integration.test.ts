/**
 * Automation-policy compliance alerts through the `evaluate-policy` job, the
 * way production runs it. The same two faults #7518 fixed on the
 * configuration-policy path:
 *
 *  1. The job evaluates inside one system transaction (policyEvaluationWorker
 *     `commitThenEnqueue`), and published its policy.* events inside it.
 *     publishEvent delivers the policy-alert-bridge on its own connection, and
 *     the bridge judges a violation by the persisted automation_policy_compliance
 *     row, so it saw the PREVIOUS evaluation: a compliant → failing transition
 *     was dropped as a stale violation and raised nothing.
 *  2. The bridge's per-org "Policy Compliance Violation" template was created
 *     with `autoResolve: true` and a source-marker condition the condition
 *     registry cannot evaluate, so the alert worker's sweep closed every alert
 *     while the device was still failing.
 *
 * Real Postgres + Redis, the real job body and the real event bus with the real
 * `policy-alert-bridge` subscriber registered.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  alerts,
  alertTemplates,
  automationPolicies,
  deviceSoftware,
  devices,
} from '../../db/schema';
import { __processEvaluatePolicy } from '../../jobs/policyEvaluationWorker';
import { checkAllAutoResolve } from '../../services/alertService';
import { handlePolicyCompliantEvent, handlePolicyViolationEvent } from '../../services/policyAlertBridge';
import {
  _resetEventSubscriberRegistryForTests,
  registerEventSubscriber,
} from '../../services/eventSubscriberRegistry';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const APP_NAME = 'Fabrikam Agent';
const OPEN_STATUSES = ['active', 'acknowledged', 'suppressed'] as const;
const TEMPLATE_NAME = 'Policy Compliance Violation';
const MIGRATION = '2026-11-10-130000-policy-compliance-alert-template-no-auto-resolve.sql';

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
  return withSystemDbAccessContext(async () => {
    const [device] = await db
      .insert(devices)
      .values({
        orgId: org!.id,
        siteId: site!.id,
        agentId: `pcad-agent-${randomUUID()}`,
        hostname: `pcad-host-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '10.0.19045',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
      })
      .returning();
    const [policy] = await db
      .insert(automationPolicies)
      .values({
        orgId: org!.id,
        name: `pcad policy ${randomUUID()}`,
        enabled: true,
        targets: { deviceIds: [device!.id] },
        rules: [{ type: 'required_software', softwareName: APP_NAME, versionOperator: 'any' }],
        enforcement: 'warn',
        checkIntervalMinutes: 60,
      })
      .returning();
    return { orgId: org!.id, device: device!, policyId: policy!.id };
  });
}

async function installApp(deviceId: string) {
  await withSystemDbAccessContext(() => db.insert(deviceSoftware).values({ deviceId, name: APP_NAME, version: '2.0' }));
}

async function uninstallApp(deviceId: string) {
  await withSystemDbAccessContext(() => db.delete(deviceSoftware).where(eq(deviceSoftware.deviceId, deviceId)));
}

async function openAlerts(deviceId: string) {
  return withSystemDbAccessContext(() => db
    .select({ id: alerts.id, status: alerts.status, resolutionNote: alerts.resolutionNote })
    .from(alerts)
    .where(and(eq(alerts.deviceId, deviceId), inArray(alerts.status, [...OPEN_STATUSES]))));
}

describe('automation-policy compliance alerts through the evaluate-policy job', () => {
  runDb('a compliant → failing transition raises the alert', async () => {
    const { device, policyId } = await seed();
    await installApp(device.id);

    const first = await __processEvaluatePolicy(policyId);
    expect(first).toMatchObject({ devicesEvaluated: 1, compliant: 1 });
    expect(await openAlerts(device.id)).toHaveLength(0);

    await uninstallApp(device.id);
    const second = await __processEvaluatePolicy(policyId);
    expect(second).toMatchObject({ devicesEvaluated: 1, nonCompliant: 1 });

    // Published inside the job's transaction, the bridge read the committed
    // `compliant` row from the first run and dropped this as stale.
    expect(await openAlerts(device.id)).toHaveLength(1);
  });

  runDb('the alert stays open through the auto-resolve sweep while the device still fails, then clears on compliance', async () => {
    const { orgId, device, policyId } = await seed();

    await __processEvaluatePolicy(policyId);
    expect(await openAlerts(device.id)).toHaveLength(1);

    const [template] = await withSystemDbAccessContext(() => db
      .select({ autoResolve: alertTemplates.autoResolve })
      .from(alertTemplates)
      .where(and(eq(alertTemplates.orgId, orgId), eq(alertTemplates.name, TEMPLATE_NAME))));
    expect(template?.autoResolve).toBe(false);

    expect(await withSystemDbAccessContext(() => checkAllAutoResolve(orgId))).toBe(0);
    expect(await openAlerts(device.id)).toHaveLength(1);

    await installApp(device.id);
    await __processEvaluatePolicy(policyId);
    expect(await openAlerts(device.id)).toHaveLength(0);
  });
});

describe(`migration ${MIGRATION}`, () => {
  const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 1, onnotice: () => {} });
  afterAll(async () => { await adminSql.end({ timeout: 5 }); });

  async function insertTemplate(values: { orgId: string; isBuiltIn: boolean; source: string }) {
    const [row] = await withSystemDbAccessContext(() => db
      .insert(alertTemplates)
      .values({
        orgId: values.orgId,
        name: TEMPLATE_NAME,
        conditions: { source: values.source },
        severity: 'medium',
        titleTemplate: 'Policy violation on {{hostname}}',
        messageTemplate: '{{policyName}} reported a compliance violation on {{hostname}}',
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

  runDb('turns auto_resolve off on the bridge templates already created, touches nothing else, and re-runs as a no-op', async () => {
    const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const bridgeTemplate = await insertTemplate({ orgId: org!.id, isBuiltIn: true, source: 'policy-evaluation' });
    // A same-named template the org authored itself is theirs, not the bridge's.
    const orgAuthored = await insertTemplate({ orgId: org!.id, isBuiltIn: false, source: 'policy-evaluation' });
    const otherSource = await insertTemplate({ orgId: org!.id, isBuiltIn: true, source: 'something-else' });

    await adminSql.unsafe(migrationSql);
    expect(await autoResolveOf(bridgeTemplate)).toBe(false);
    expect(await autoResolveOf(orgAuthored)).toBe(true);
    expect(await autoResolveOf(otherSource)).toBe(true);

    await adminSql.unsafe(migrationSql);
    expect(await autoResolveOf(bridgeTemplate)).toBe(false);
  });
});
