import './setup';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { withDbAccessContext } from '../../db';
import { alerts, devices } from '../../db/schema';
import { generateAlertSummaryReport, generateExecutiveSummaryReport } from '../../services/reportGenerationService';
import type { OrgReportExecutionAuthority } from '../../services/siteScope';
import { createIntegrationTestClient } from './db-utils';
import { getTestDb } from './setup';

/**
 * #9562 — a saved report's rolling `dateRange` preset (what every template and
 * the portal's self-service definitions store) bounds the alert figures,
 * against real Postgres under breeze_app (RLS on). Before the fix the
 * generators read only explicit start/end, so a "last 30 days" Executive
 * Summary counted every alert the org ever had.
 */
const app = new Hono();
const DAY = 24 * 60 * 60 * 1000;

async function fixture() {
  const client = await createIntegrationTestClient(app, { scope: 'organization' });
  const { organization: org, site, user } = client.env;
  const seed = getTestDb();
  const [device] = await seed.insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: crypto.randomUUID(), hostname: 'window-1',
    osType: 'linux' as const, osVersion: '1', architecture: 'amd64', agentVersion: '1',
  }).returning();
  const now = Date.now();
  const at = (daysAgo: number) => new Date(now - daysAgo * DAY);
  const base = { orgId: org.id, deviceId: device!.id };
  await seed.insert(alerts).values([
    // Outside a 30-day window: resolved, so an all-time count would also
    // inflate the resolution rate.
    { ...base, severity: 'critical' as const, status: 'resolved' as const, title: 'old resolved', triggeredAt: at(45), resolvedAt: at(44) },
    { ...base, severity: 'high' as const, status: 'resolved' as const, title: 'old resolved two', triggeredAt: at(60), resolvedAt: at(59) },
    // Inside 30 days, outside 7.
    { ...base, severity: 'high' as const, status: 'resolved' as const, title: 'mid resolved', triggeredAt: at(10), resolvedAt: at(9) },
    // Inside 7 days.
    { ...base, severity: 'critical' as const, status: 'active' as const, title: 'recent active', triggeredAt: at(2) },
  ]);
  const inOrg = <T>(fn: () => Promise<T>) => withDbAccessContext(
    { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id], currentPartnerId: client.env.partner.id }, fn);
  const authority: OrgReportExecutionAuthority = {
    principalKind: 'user', scope: { version: 1, kind: 'unrestricted', orgId: org.id },
    principalUserId: user.id, capturedAt: new Date(), fingerprint: 'f'.repeat(64),
  };
  return { org, inOrg, authority };
}

type ExecAlerts = { total: number; critical: number; high: number; resolved: number; resolutionRate: number };
const execAlerts = (result: unknown) => (result as { summary: { alerts: ExecAlerts } }).summary.alerts;

describe('report date-range presets bound alert figures (#9562)', () => {
  it('Executive Summary: last_30_days excludes alerts triggered before the window, in counts AND resolution rate', async () => {
    const f = await fixture();

    const windowed = execAlerts(await f.inOrg(() =>
      generateExecutiveSummaryReport(f.org.id, { dateRange: { preset: 'last_30_days' } }, f.authority)));
    expect(windowed).toEqual({ total: 2, critical: 1, high: 1, resolved: 1, resolutionRate: 50 });

    const weekly = execAlerts(await f.inOrg(() =>
      generateExecutiveSummaryReport(f.org.id, { dateRange: { preset: 'last_7_days' } }, f.authority)));
    expect(weekly).toEqual({ total: 1, critical: 1, high: 0, resolved: 0, resolutionRate: 0 });

    // No window configured: all time, as before.
    const allTime = execAlerts(await f.inOrg(() => generateExecutiveSummaryReport(f.org.id, {}, f.authority)));
    expect(allTime.total).toBe(4);
  });

  it('Alert Summary: last_7_days returns only alerts inside the window', async () => {
    const f = await fixture();
    const report = await f.inOrg(() =>
      generateAlertSummaryReport(f.org.id, { dateRange: { preset: 'last_7_days' } }, f.authority));
    expect(report.rows.map((r: { title: string }) => r.title)).toEqual(['recent active']);
    expect(report.summary).toEqual({ critical: 1 });
  });
});
