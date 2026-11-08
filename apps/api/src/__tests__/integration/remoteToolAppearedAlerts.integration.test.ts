/**
 * #11306 — a remote access / RMM tool that appears on a device raises a
 * built-in alert, against real Postgres + Redis with the real createAlert.
 *
 *  - the first fire creates the global template and the org's per-tool rule
 *    under the `management-posture` built-in source, and one active alert on
 *    the device;
 *  - a second appearance while that alert is open raises nothing new;
 *  - another tool on the same device gets its own rule and its own alert;
 *  - switching the org's rule off for a tool silences that tool only.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/remoteToolAppearedAlerts.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { alertRules, alertTemplates, alerts, devices } from '../../db/schema';
import { raiseRemoteToolAppearedAlerts } from '../../services/remoteToolAlerts/alerts';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const DETECTED_AT = '2026-11-06T10:00:00.000Z';

async function insertDevice(orgId: string, siteId: string, hostname: string): Promise<string> {
  const [device] = await withSystemDbAccessContext(() => db
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `rt-agent-${randomUUID()}`,
      hostname,
      osType: 'windows',
      osVersion: '10.0.19045',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      status: 'online',
    })
    .returning({ id: devices.id }));
  return device!.id;
}

async function seedDevice() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org!.id });
  const hostname = `rt-host-${randomUUID().slice(0, 8)}`;
  return { orgId: org!.id, deviceId: await insertDevice(org!.id, site!.id, hostname), hostname };
}

async function seedDeviceInOrg(orgId: string): Promise<string> {
  const site = await createSite({ orgId });
  return insertDevice(orgId, site!.id, `rt-host-${randomUUID().slice(0, 8)}`);
}

function deviceAlerts(deviceId: string) {
  return withSystemDbAccessContext(() => db
    .select({ id: alerts.id, ruleId: alerts.ruleId, status: alerts.status, severity: alerts.severity, title: alerts.title, context: alerts.context })
    .from(alerts)
    .where(eq(alerts.deviceId, deviceId)));
}

function orgRule(orgId: string, name: string) {
  return withSystemDbAccessContext(() => db
    .select({ id: alertRules.id, isActive: alertRules.isActive, overrideSettings: alertRules.overrideSettings, templateId: alertRules.templateId })
    .from(alertRules)
    .where(and(eq(alertRules.orgId, orgId), eq(alertRules.name, name), isNull(alertRules.retiredAt))));
}

describe('new remote access tool alerts (#11306)', () => {
  runDb('raises one alert per tool per device, on a built-in per-tool rule the org can switch off', async () => {
    const { orgId, deviceId, hostname } = await seedDevice();
    const ultraViewer = { name: 'UltraViewer', category: 'remoteAccess' as const, status: 'installed' };

    const first = await raiseRemoteToolAppearedAlerts({ deviceId, orgId, detectedAt: DETECTED_AT, tools: [ultraViewer] });
    expect(first).toEqual({ raised: ['UltraViewer'], held: [], failed: [], suppressedByMaintenance: false });

    const [rule] = await orgRule(orgId, 'New remote access tool: UltraViewer');
    expect(rule).toBeDefined();
    expect(rule!.isActive).toBe(true);
    expect(rule!.overrideSettings).toMatchObject({ source: 'management-posture', toolName: 'UltraViewer' });
    const [template] = await withSystemDbAccessContext(() => db
      .select({ isBuiltIn: alertTemplates.isBuiltIn, orgId: alertTemplates.orgId, severity: alertTemplates.severity })
      .from(alertTemplates)
      .where(eq(alertTemplates.id, rule!.templateId)));
    expect(template).toEqual({ isBuiltIn: true, orgId: null, severity: 'medium' });

    let rows = await deviceAlerts(deviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ruleId: rule!.id,
      status: 'active',
      severity: 'medium',
      title: `New remote access tool on ${hostname}: UltraViewer`,
    });
    expect(rows[0]!.context).toMatchObject({ source: 'management-posture', toolName: 'UltraViewer', detectedAt: DETECTED_AT });

    // Seen again while its alert is open: nothing new.
    const again = await raiseRemoteToolAppearedAlerts({ deviceId, orgId, detectedAt: DETECTED_AT, tools: [ultraViewer] });
    expect(again.raised).toEqual([]);
    expect(again.held).toEqual(['UltraViewer']);
    expect(await deviceAlerts(deviceId)).toHaveLength(1);

    // A second tool is its own rule and its own alert.
    const anyDesk = { name: 'AnyDesk', category: 'remoteAccess' as const, status: 'active' };
    await raiseRemoteToolAppearedAlerts({ deviceId, orgId, detectedAt: DETECTED_AT, tools: [anyDesk] });
    rows = await deviceAlerts(deviceId);
    expect(rows).toHaveLength(2);
    const [anyDeskRule] = await orgRule(orgId, 'New remote access tool: AnyDesk');
    expect(anyDeskRule!.id).not.toBe(rule!.id);

    // The org switches the AnyDesk rule off (its own tool). On a second device
    // (no open alert, no cooldown) AnyDesk stays quiet while UltraViewer, whose
    // rule is still on, raises: only the switch tells the two apart.
    await withSystemDbAccessContext(() => db.update(alertRules).set({ isActive: false }).where(eq(alertRules.id, anyDeskRule!.id)));
    const second = await seedDeviceInOrg(orgId);
    const off = await raiseRemoteToolAppearedAlerts({ deviceId: second, orgId, detectedAt: DETECTED_AT, tools: [anyDesk, ultraViewer] });
    expect(off).toEqual({ raised: ['UltraViewer'], held: ['AnyDesk'], failed: [], suppressedByMaintenance: false });
    const secondRows = await deviceAlerts(second);
    expect(secondRows.map((row) => row.ruleId)).toEqual([rule!.id]);
  });

  runDb("never reuses an operator's own rule that happens to share the name", async () => {
    const { orgId, deviceId } = await seedDevice();
    const [template] = await withSystemDbAccessContext(() => db
      .insert(alertTemplates)
      .values({ orgId, name: `Operator template ${randomUUID().slice(0, 6)}`, conditions: {}, severity: 'low', titleTemplate: 't', messageTemplate: 'm' })
      .returning({ id: alertTemplates.id }));
    const [operatorRule] = await withSystemDbAccessContext(() => db
      .insert(alertRules)
      .values({ orgId, templateId: template!.id, name: 'New remote access tool: TeamViewer', targetType: 'org', targetId: orgId })
      .returning({ id: alertRules.id }));

    await raiseRemoteToolAppearedAlerts({
      deviceId, orgId, detectedAt: DETECTED_AT,
      tools: [{ name: 'TeamViewer', category: 'remoteAccess', status: 'active' }],
    });
    const rows = await deviceAlerts(deviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ruleId).not.toBe(operatorRule!.id);
    expect(rows[0]!.severity).toBe('medium');
  });

  runDb('raises an RMM agent at info', async () => {
    const { orgId, deviceId } = await seedDevice();
    await raiseRemoteToolAppearedAlerts({
      deviceId,
      orgId,
      detectedAt: DETECTED_AT,
      tools: [{ name: 'ScreenConnect', category: 'rmm', status: 'active' }],
    });
    const rows = await deviceAlerts(deviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.severity).toBe('info');
    expect(await orgRule(orgId, 'New RMM agent: ScreenConnect')).toHaveLength(1);
  });
});
