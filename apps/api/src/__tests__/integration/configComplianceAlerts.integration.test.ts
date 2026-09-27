/**
 * #6669 — configuration-policy compliance violations raise alerts.
 *
 * Before this fix `evaluateDeviceComplianceFromConfigPolicy` published
 * `policy.violation` with `configPolicyComplianceRuleId` and no `policyId`,
 * and `policyAlertBridge.handlePolicyViolation` returned early on
 * `!payload.policyId`, so a failing compliance rule never became an alert.
 *
 * Against live PostgreSQL, through the REAL evaluator and the REAL bridge
 * (event delivery is simulated by handing each published policy.* event to
 * the registered bridge handlers after the evaluation returns, the way the
 * durable subscriber delivers it):
 *
 *  1. A `warn` required_software rule on an org-owned policy raises exactly
 *     one alert in the device's org; re-evaluating does not raise a second;
 *     installing the app resolves it.
 *  2. A PARTNER-WIDE policy (org_id NULL) assigned at partner level fans out:
 *     each org's device gets its own alert carrying the DEVICE's org.
 *  3. A `monitor` (report-only) rule never alerts.
 *  4. A stale violation delivered after the compliant evaluation does not
 *     re-open the alert.
 */
import './setup';

import { vi } from 'vitest';

const { publishedEvents } = vi.hoisted(() => ({
  publishedEvents: [] as Array<{ type: string; orgId: string; payload: Record<string, unknown> }>,
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return {
    ...actual,
    publishEvent: vi.fn(async (type: string, orgId: string, payload: Record<string, unknown>) => {
      publishedEvents.push({ type, orgId, payload });
      return 'test-event-id';
    }),
  };
});

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  alertRules,
  alerts,
  alertTemplates,
  configPolicyAssignments,
  configPolicyComplianceRules,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceSoftware,
  devices,
} from '../../db/schema';
import { evaluateDeviceComplianceFromConfigPolicy } from '../../services/policyEvaluationService';
import { handlePolicyCompliantEvent, handlePolicyViolationEvent } from '../../services/policyAlertBridge';
import type { BreezeEvent } from '../../services/eventBus';
import { clearCooldown } from '../../services/alertCooldown';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const APP_NAME = 'Contoso Agent';
const OPEN_STATUSES = ['active', 'acknowledged', 'suppressed'] as const;

type Owner = { orgId: string | null; partnerId: string | null };
type Enforcement = 'monitor' | 'warn' | 'enforce';

async function seedDevice(orgId: string, siteId: string) {
  const [d] = await withSystemDbAccessContext(() => db
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `cc-agent-${randomUUID()}`,
      hostname: `cc-host-${randomUUID().slice(0, 8)}`,
      osType: 'windows',
      osVersion: '10.0.19045',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      status: 'online',
    })
    .returning());
  return d!;
}

async function seedCompliancePolicy(
  owner: Owner,
  enforcementLevel: Enforcement,
  assignment: { level: 'partner' | 'organization'; targetId: string },
) {
  return withSystemDbAccessContext(async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({ orgId: owner.orgId, partnerId: owner.partnerId, name: `cc policy ${randomUUID()}`, status: 'active' })
      .returning();
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: 'compliance' })
      .returning();
    const [rule] = await db
      .insert(configPolicyComplianceRules)
      .values({
        featureLinkId: link!.id,
        name: `Keep ${APP_NAME} installed ${randomUUID().slice(0, 6)}`,
        rules: [{ type: 'required_software', softwareName: APP_NAME, versionOperator: 'any' }],
        enforcementLevel,
      })
      .returning();
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy!.id,
      level: assignment.level,
      targetId: assignment.targetId,
      priority: 0,
    });
    return { policyId: policy!.id, featureLinkId: link!.id, ruleId: rule!.id, ruleName: rule!.name };
  });
}

async function installApp(deviceId: string) {
  await withSystemDbAccessContext(() => db.insert(deviceSoftware).values({ deviceId, name: APP_NAME, version: '7.1' }));
}

/** Evaluate, then deliver every policy.violation / policy.compliant it published to the bridge. */
async function evaluateAndDeliver(deviceId: string) {
  publishedEvents.length = 0;
  const results = await withSystemDbAccessContext(() => evaluateDeviceComplianceFromConfigPolicy(deviceId));
  const delivered = publishedEvents.filter((e) => e.type === 'policy.violation' || e.type === 'policy.compliant');
  for (const e of delivered) {
    await deliver(e);
  }
  return { results, delivered };
}

async function deliver(e: { type: string; orgId: string; payload: Record<string, unknown> }) {
  const event = { id: randomUUID(), type: e.type, orgId: e.orgId, payload: e.payload } as unknown as BreezeEvent;
  if (e.type === 'policy.violation') await handlePolicyViolationEvent(event);
  else await handlePolicyCompliantEvent(event);
}

async function alertsForDevice(deviceId: string) {
  return withSystemDbAccessContext(() => db
    .select({
      id: alerts.id,
      orgId: alerts.orgId,
      status: alerts.status,
      severity: alerts.severity,
      title: alerts.title,
      message: alerts.message,
      context: alerts.context,
      ruleOrgId: alertRules.orgId,
      templateBuiltIn: alertTemplates.isBuiltIn,
    })
    .from(alerts)
    .innerJoin(alertRules, eq(alertRules.id, alerts.ruleId))
    .innerJoin(alertTemplates, eq(alertTemplates.id, alertRules.templateId))
    .where(eq(alerts.deviceId, deviceId)));
}

async function openAlertCount(deviceId: string) {
  const rows = await withSystemDbAccessContext(() => db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(eq(alerts.deviceId, deviceId), inArray(alerts.status, [...OPEN_STATUSES]))));
  return rows.length;
}

describe('configuration-policy compliance → alerts (#6669)', () => {
  beforeEach(() => {
    publishedEvents.length = 0;
  });

  runDb('a warn required_software rule raises exactly one alert, dedupes, and resolves when the app returns', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org!.id });
    const device = await seedDevice(org!.id, site!.id);
    const seeded = await seedCompliancePolicy({ orgId: org!.id, partnerId: null }, 'warn', { level: 'organization', targetId: org!.id });

    const first = await evaluateAndDeliver(device.id);
    expect(first.results).toHaveLength(1);
    expect(first.results[0]!.status).toBe('non_compliant');
    expect(first.delivered.map((e) => e.type)).toEqual(['policy.violation']);

    let rows = await alertsForDevice(device.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: org!.id,
      ruleOrgId: org!.id,
      status: 'active',
      severity: 'medium',
      templateBuiltIn: true,
    });
    expect(rows[0]!.title).toContain(seeded.ruleName);
    expect(rows[0]!.message).toContain(APP_NAME);
    expect(rows[0]!.context).toMatchObject({
      source: 'config-policy-compliance',
      configPolicyId: seeded.policyId,
      configPolicyComplianceRuleId: seeded.ruleId,
    });

    // Re-evaluation while still non-compliant: no second alert.
    await evaluateAndDeliver(device.id);
    expect(await openAlertCount(device.id)).toBe(1);
    expect(await alertsForDevice(device.id)).toHaveLength(1);

    // App comes back → compliant → alert auto-resolves.
    await installApp(device.id);
    const healed = await evaluateAndDeliver(device.id);
    expect(healed.delivered.map((e) => e.type)).toEqual(['policy.compliant']);
    rows = await alertsForDevice(device.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('resolved');
    expect(await openAlertCount(device.id)).toBe(0);
  });

  runDb('a partner-wide policy fans out: each org\'s device gets one alert in its OWN org', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: orgA!.id });
    const siteB = await createSite({ orgId: orgB!.id });
    const deviceA = await seedDevice(orgA!.id, siteA!.id);
    const deviceB = await seedDevice(orgB!.id, siteB!.id);
    await seedCompliancePolicy({ orgId: null, partnerId: partner.id }, 'enforce', { level: 'partner', targetId: partner.id });

    await evaluateAndDeliver(deviceA.id);
    await evaluateAndDeliver(deviceB.id);

    const rowsA = await alertsForDevice(deviceA.id);
    const rowsB = await alertsForDevice(deviceB.id);
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0]).toMatchObject({ orgId: orgA!.id, ruleOrgId: orgA!.id, status: 'active', severity: 'high' });
    expect(rowsB[0]).toMatchObject({ orgId: orgB!.id, ruleOrgId: orgB!.id, status: 'active', severity: 'high' });

    await installApp(deviceA.id);
    await evaluateAndDeliver(deviceA.id);
    expect(await openAlertCount(deviceA.id)).toBe(0);
    // B is untouched by A's recovery.
    expect(await openAlertCount(deviceB.id)).toBe(1);
  });

  runDb('a monitor-only (report) rule never alerts', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org!.id });
    const device = await seedDevice(org!.id, site!.id);
    await seedCompliancePolicy({ orgId: org!.id, partnerId: null }, 'monitor', { level: 'organization', targetId: org!.id });

    const { results, delivered } = await evaluateAndDeliver(device.id);
    expect(results[0]!.status).toBe('non_compliant');
    // The event WAS published and delivered — the bridge chose not to alert.
    expect(delivered.map((e) => e.type)).toEqual(['policy.violation']);
    expect(await alertsForDevice(device.id)).toHaveLength(0);
  });

  runDb('a stale violation delivered after the compliant evaluation does not re-open the alert', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org!.id });
    const device = await seedDevice(org!.id, site!.id);
    await seedCompliancePolicy({ orgId: org!.id, partnerId: null }, 'warn', { level: 'organization', targetId: org!.id });

    const { delivered } = await evaluateAndDeliver(device.id);
    const staleViolation = delivered[0]!;
    await installApp(device.id);
    await evaluateAndDeliver(device.id);
    expect(await openAlertCount(device.id)).toBe(0);

    // Clear the Redis re-alert cooldown the first alert armed, so the only thing
    // that can stop a new alert below is the bridge's persisted-state guard.
    const [resolved] = await withSystemDbAccessContext(() => db
      .select({ ruleId: alerts.ruleId })
      .from(alerts)
      .where(eq(alerts.deviceId, device.id)));
    await clearCooldown(resolved!.ruleId!, device.id);

    // Retried delivery of the older violation lands after the compliant one.
    await deliver(staleViolation);
    expect(await openAlertCount(device.id)).toBe(0);
  });
});
