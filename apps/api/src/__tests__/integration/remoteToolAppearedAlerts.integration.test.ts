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

async function seedDevice() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org!.id });
  const hostname = `rt-host-${randomUUID().slice(0, 8)}`;
  const [device] = await withSystemDbAccessContext(() => db
    .insert(devices)
    .values({
      orgId: org!.id,
      siteId: site!.id,
      agentId: `rt-agent-${randomUUID()}`,
      hostname,
      osType: 'windows',
      osVersion: '10.0.19045',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      status: 'online',
    })
    .returning({ id: devices.id }));
  return { orgId: org!.id, deviceId: device!.id, hostname };
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

    // A second tool is its own rule and its own alert. The org switches the
    // AnyDesk rule off (its own tool); a later AnyDesk appearance stays quiet.
    const anyDesk = { name: 'AnyDesk', category: 'remoteAccess' as const, status: 'active' };
    await raiseRemoteToolAppearedAlerts({ deviceId, orgId, detectedAt: DETECTED_AT, tools: [anyDesk] });
    rows = await deviceAlerts(deviceId);
    expect(rows).toHaveLength(2);
    const [anyDeskRule] = await orgRule(orgId, 'New remote access tool: AnyDesk');
    expect(anyDeskRule!.id).not.toBe(rule!.id);

    await withSystemDbAccessContext(async () => {
      await db.update(alerts).set({ status: 'resolved', resolvedAt: new Date() }).where(eq(alerts.ruleId, anyDeskRule!.id));
      await db.update(alertRules).set({ isActive: false }).where(eq(alertRules.id, anyDeskRule!.id));
    });
    const off = await raiseRemoteToolAppearedAlerts({ deviceId, orgId, detectedAt: DETECTED_AT, tools: [anyDesk] });
    expect(off.raised).toEqual([]);
    rows = await deviceAlerts(deviceId);
    expect(rows.filter((row) => row.ruleId === anyDeskRule!.id && row.status === 'active')).toHaveLength(0);
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
