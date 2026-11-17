import './setup';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { alerts, devices, sites } from '../../db/schema';
import { generateExecutiveSummaryReport } from '../../services/reportGenerationService';
import { siteScopeFingerprint, type OrgReportExecutionAuthority } from '../../services/siteScope';
import type { ExecutiveSummary } from '@breeze/shared';
import { createIntegrationTestClient, createOrganization, createSite } from './db-utils';
import { getTestDb } from './setup';

/**
 * #12045 — the Executive Summary's device figures reconcile and its headline
 * is windowed, against real Postgres under breeze_app (RLS on). Before the fix
 * the generator counted only `online` and `offline`, so a device in any other
 * status was in the total but in neither bucket, and the headline was the
 * share online at the instant of generation.
 */
const app = new Hono();
const DAY = 24 * 60 * 60 * 1000;

async function fixture() {
  const client = await createIntegrationTestClient(app, { scope: 'organization' });
  const { organization: org, site, user } = client.env;
  const seed = getTestDb();
  const now = Date.now();
  const ago = (days: number) => new Date(now - days * DAY);
  const device = (hostname: string, status: typeof devices.$inferInsert.status, lastSeenAt: Date | null) => ({
    orgId: org.id, siteId: site.id, agentId: crypto.randomUUID(), hostname,
    osType: 'windows' as const, osVersion: '11', architecture: 'amd64', agentVersion: '1',
    status, lastSeenAt,
  });
  const inserted = await seed.insert(devices).values([
    device('online-1', 'online', ago(0)),
    device('online-stale-ts', 'online', null), // online counts as seen even with no timestamp
    device('offline-recent', 'offline', ago(2)), // switched off yesterday: seen in window
    device('offline-old', 'offline', ago(20)), // not seen in 7 days
    device('maint-1', 'maintenance', ago(1)),
    device('pending-1', 'pending', null), // never reported
    device('retired', 'decommissioned', ago(1)), // not managed: excluded entirely
  ]).returning();
  const byHost = new Map(inserted.map((d) => [d.hostname, d.id]));
  await seed.insert(alerts).values([
    { orgId: org.id, deviceId: byHost.get('online-1')!, severity: 'high' as const, status: 'active' as const, title: 'high recent', triggeredAt: ago(1) },
    { orgId: org.id, deviceId: byHost.get('maint-1')!, severity: 'critical' as const, status: 'resolved' as const, title: 'critical older', triggeredAt: ago(3), resolvedAt: ago(2) },
    { orgId: org.id, deviceId: byHost.get('online-1')!, severity: 'medium' as const, status: 'active' as const, title: 'medium not named', triggeredAt: ago(1) },
    { orgId: org.id, deviceId: byHost.get('online-1')!, severity: 'critical' as const, status: 'active' as const, title: 'critical outside window', triggeredAt: ago(40) },
  ]);
  const inOrg = <T>(fn: () => Promise<T>) => withDbAccessContext(
    { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id], currentPartnerId: client.env.partner.id }, fn);
  const authority: OrgReportExecutionAuthority = {
    principalKind: 'user', scope: { version: 1, kind: 'unrestricted', orgId: org.id },
    principalUserId: user.id, capturedAt: new Date(), fingerprint: 'f'.repeat(64),
  };
  return { org, site, user, seed, inOrg, authority, partnerId: client.env.partner.id };
}

describe('executive summary fleet figures reconcile (#12045)', () => {
  it('puts every managed device in exactly one status bucket and scores the 7-day window', async () => {
    const f = await fixture();
    const result = await f.inOrg(() =>
      generateExecutiveSummaryReport(f.org.id, { dateRange: { preset: 'last_30_days' } }, f.authority));
    const s = result.summary as ExecutiveSummary;
    const d = s.devices!;

    expect(d.total).toBe(6);
    expect(d.online).toBe(2);
    expect(d.offline).toBe(2);
    expect(d.otherStatuses).toEqual({ maintenance: 1, pending: 1 });
    expect(d.online! + d.offline! + Object.values(d.otherStatuses!).reduce((a, b) => a + b, 0)).toBe(d.total);
    expect(d.healthPercentage).toBe(33);
    expect(d.recentWindowDays).toBe(7);
    // online-1, online-stale-ts, offline-recent, maint-1.
    expect(d.recentlySeen).toBe(4);
    expect(d.recentlySeenPercentage).toBe(67);

    // The window it applied is recorded, ~30 days ending now.
    expect(s.period?.start && s.period?.end).toBeTruthy();
    const span = new Date(s.period!.end!).getTime() - new Date(s.period!.start!).getTime();
    expect(Math.round(span / DAY)).toBe(30);

    // Critical/high alerts in the window are named, critical first, with hostname.
    expect(s.notableAlerts?.map((a) => [a.title, a.severity, a.device])).toEqual([
      ['critical older', 'critical', 'maint-1'],
      ['high recent', 'high', 'online-1'],
    ]);
    expect((s.alerts!.critical ?? 0) + (s.alerts!.high ?? 0)).toBe(s.notableAlerts!.length);
  });

  it('a site-restricted run neither counts nor names another site\'s devices and alerts', async () => {
    const f = await fixture();
    const [otherSite] = await f.seed.insert(sites).values({ orgId: f.org.id, name: 'Other site' }).returning();
    const [hidden] = await f.seed.insert(devices).values({
      orgId: f.org.id, siteId: otherSite!.id, agentId: crypto.randomUUID(), hostname: 'other-site-host',
      osType: 'windows' as const, osVersion: '11', architecture: 'amd64', agentVersion: '1',
      status: 'online' as const, lastSeenAt: new Date(),
    }).returning();
    await f.seed.insert(alerts).values({
      orgId: f.org.id, deviceId: hidden!.id, severity: 'critical' as const, status: 'active' as const,
      title: 'other site secret', triggeredAt: new Date(Date.now() - DAY),
    });

    const unrestricted = (await f.inOrg(() =>
      generateExecutiveSummaryReport(f.org.id, { dateRange: { preset: 'last_30_days' } }, f.authority))).summary as ExecutiveSummary;
    expect(unrestricted.notableAlerts?.map((a) => a.title)).toContain('other site secret');

    const scope = { version: 1 as const, kind: 'restricted' as const, orgId: f.org.id, siteIds: [f.site.id] };
    const restricted: OrgReportExecutionAuthority = {
      principalKind: 'user', scope, principalUserId: f.user.id, capturedAt: new Date(), fingerprint: siteScopeFingerprint(scope),
    };
    const s = (await f.inOrg(() =>
      generateExecutiveSummaryReport(f.org.id, { dateRange: { preset: 'last_30_days' } }, restricted))).summary as ExecutiveSummary;
    expect(s.devices?.total).toBe(6);
    expect(s.notableAlerts?.map((a) => a.title)).toEqual(['critical older', 'high recent']);
    expect(s.notableAlerts?.some((a) => a.device === 'other-site-host')).toBe(false);
    expect((s.alerts!.critical ?? 0) + (s.alerts!.high ?? 0)).toBe(2);
  });

  it('names a notable alert\'s device only when it is in the report\'s org and site, even in system context', async () => {
    const f = await fixture();
    // A site-owned topology alert keeps its origin device id after that device
    // moves; the device may now be in another org, or at another site of this one.
    const otherOrg = await createOrganization({ partnerId: f.partnerId });
    const otherOrgSite = await createSite({ orgId: otherOrg.id });
    const [otherSite] = await f.seed.insert(sites).values({ orgId: f.org.id, name: 'Other site' }).returning();
    const hw = { osType: 'windows' as const, osVersion: '11', architecture: 'amd64', agentVersion: '1', status: 'online' as const, lastSeenAt: new Date() };
    const [movedOrg, movedSite] = await f.seed.insert(devices).values([
      { ...hw, agentId: crypto.randomUUID(), orgId: otherOrg.id, siteId: otherOrgSite.id, hostname: 'other-org-host' },
      { ...hw, agentId: crypto.randomUUID(), orgId: f.org.id, siteId: otherSite!.id, hostname: 'other-site-origin' },
    ]).returning();
    const owned = {
      orgId: f.org.id, ownerKind: 'topology_site' as const, topologySiteId: f.site.id,
      severity: 'critical' as const, status: 'active' as const, triggeredAt: new Date(Date.now() - DAY / 2),
    };
    await f.seed.insert(alerts).values([
      { ...owned, deviceId: movedOrg!.id, topologySourceKey: `topology:${'d'.repeat(64)}`, title: 'origin now in another org' },
      { ...owned, deviceId: movedSite!.id, topologySourceKey: `topology:${'e'.repeat(64)}`, title: 'origin now at another site' },
    ]);
    const deviceOf = (s: ExecutiveSummary, title: string) => s.notableAlerts?.find((a) => a.title === title)?.device;

    // Scheduled runs execute in system context, where RLS hides nothing.
    const sys = (await withSystemDbAccessContext(() =>
      generateExecutiveSummaryReport(f.org.id, { dateRange: { preset: 'last_30_days' } }, f.authority))).summary as ExecutiveSummary;
    expect(sys.notableAlerts?.map((a) => a.title)).toContain('origin now in another org');
    expect(deviceOf(sys, 'origin now in another org')).toBeNull();
    expect(sys.notableAlerts?.some((a) => a.device === 'other-org-host')).toBe(false);
    expect(deviceOf(sys, 'origin now at another site')).toBe('other-site-origin');

    const scope = { version: 1 as const, kind: 'restricted' as const, orgId: f.org.id, siteIds: [f.site.id] };
    const restricted: OrgReportExecutionAuthority = {
      principalKind: 'user', scope, principalUserId: f.user.id, capturedAt: new Date(), fingerprint: siteScopeFingerprint(scope),
    };
    const r = (await withSystemDbAccessContext(() =>
      generateExecutiveSummaryReport(f.org.id, { dateRange: { preset: 'last_30_days' } }, restricted))).summary as ExecutiveSummary;
    // Both alerts are owned by the restricted site, so both are listed; neither origin is named.
    expect(r.notableAlerts?.map((a) => a.title)).toEqual(expect.arrayContaining(['origin now in another org', 'origin now at another site']));
    expect(deviceOf(r, 'origin now in another org')).toBeNull();
    expect(deviceOf(r, 'origin now at another site')).toBeNull();
  });

  it('fills device tokens left in stored alert titles', async () => {
    const f = await fixture();
    const [dev] = await f.seed.select({ id: devices.id }).from(devices)
      .where(eq(devices.hostname, 'online-1')).limit(1);
    await f.seed.insert(alerts).values({
      orgId: f.org.id, deviceId: dev!.id, severity: 'critical' as const, status: 'active' as const,
      title: '{{device}} is low on disk', triggeredAt: new Date(Date.now() - DAY / 4),
    });
    const s = (await f.inOrg(() =>
      generateExecutiveSummaryReport(f.org.id, { dateRange: { preset: 'last_30_days' } }, f.authority))).summary as ExecutiveSummary;
    const titles = s.notableAlerts?.map((a) => a.title) ?? [];
    expect(titles).toContain('online-1 is low on disk');
    expect(titles.some((t) => t.includes('{{'))).toBe(false);
  });
});
