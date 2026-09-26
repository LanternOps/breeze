import './setup';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { withDbAccessContext } from '../../db';
import { alerts, devices, organizationUsers } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { searchRoutes } from '../../routes/search';
import { mobileRoutes } from '../../routes/mobile';
import { alertRoutes } from '../../routes/alerts';
import { deviceRoutes } from '../../routes/devices';
import { reportRoutes } from '../../routes/reports';
import { alertInSiteScope, filterAlertsBySiteScope } from '../../routes/tickets/siteScope';
import type { AiTool } from '../../services/aiTools';
import { registerAlertTools } from '../../services/aiToolsAlerts';
import { registerFleetTools } from '../../services/aiToolsFleet';
import { clearPermissionCache } from '../../services/permissions';
import { generateAlertSummaryReport, generateExecutiveSummaryReport } from '../../services/reportGenerationService';
import type { OrgReportExecutionAuthority } from '../../services/siteScope';
import { createIntegrationTestClient, createSite } from './db-utils';
import { getTestDb } from './setup';

/**
 * T1 (PR #7117 review): a site-owned topology policy alert (M3-D6) is
 * authorized by its TOPOLOGY site on every read/ack path — never by its
 * origin device's current site. Fixture, for a user restricted to site A:
 *   hiddenOwned  — owned by site B, origin device in A   → must be invisible
 *   visibleOwned — owned by site A, origin device in B   → must be visible
 *   plainA / plainB — ordinary device alerts in A / B    → A visible, B not
 * Real JWT, custom role, breeze_app (RLS on), no mocks.
 */
const app = new Hono()
  .route('/search', searchRoutes)
  .route('/mobile', mobileRoutes)
  .route('/alerts', alertRoutes)
  .route('/devices', deviceRoutes)
  .route('/reports', reportRoutes);

const GRANTS = [
  { resource: 'alerts', action: 'read' },
  { resource: 'alerts', action: 'acknowledge' },
  { resource: 'alerts', action: 'write' },
  { resource: 'devices', action: 'read' },
  { resource: 'reports', action: 'read' },
  { resource: 'reports', action: 'export' },
];

async function fixture() {
  const client = await createIntegrationTestClient(app, { scope: 'organization', rolePermissions: GRANTS });
  const { organization: org, site: siteA, user } = client.env;
  const siteB = await createSite({ orgId: org.id });
  const seed = getTestDb();
  const [devA, devB] = await seed.insert(devices).values([siteA.id, siteB.id].map((siteId, i) => ({
    orgId: org.id, siteId, agentId: crypto.randomUUID(), hostname: `ownership-${i ? 'b' : 'a'}`,
    osType: 'linux' as const, osVersion: '1', architecture: 'amd64', agentVersion: '1',
  }))).returning();
  const base = { orgId: org.id, severity: 'critical' as const, status: 'active' as const };
  // Two hidden site-B alerts originate on devA, so a device-derived gate
  // miscounts (3) where the ownership gate counts 2.
  const [hiddenOwned, visibleOwned, plainA, plainB] = await seed.insert(alerts).values([
    { ...base, deviceId: devA!.id, topologySiteId: siteB.id, topologySourceKey: `topology:${'b'.repeat(64)}`, title: 'zzown hidden owned' },
    { ...base, deviceId: devB!.id, topologySiteId: siteA.id, topologySourceKey: `topology:${'a'.repeat(64)}`, title: 'zzown visible owned' },
    { ...base, deviceId: devA!.id, title: 'zzown plain a' },
    { ...base, deviceId: devB!.id, title: 'zzown plain b' },
  ]).returning();
  await seed.insert(alerts).values({ ...base, deviceId: devA!.id, topologySiteId: siteB.id, topologySourceKey: `topology:${'c'.repeat(64)}`, title: 'zzown hidden owned two' });
  await seed.update(organizationUsers).set({ siteIds: [siteA.id] }).where(eq(organizationUsers.userId, user.id));
  await clearPermissionCache(user.id);
  const expected = [visibleOwned!.id, plainA!.id].sort();
  const auth = {
    principal: { kind: 'user_session' }, token: null,
    user: { id: user.id, email: user.email, name: 'Restricted', isPlatformAdmin: false },
    scope: 'organization', orgId: org.id, partnerId: client.env.partner.id, accessibleOrgIds: [org.id],
    orgCondition: (column: never) => eq(column, org.id),
    canAccessOrg: (candidate: string) => candidate === org.id,
    allowedSiteIds: [siteA.id],
    canAccessSite: (siteId: string | null) => siteId === siteA.id,
  } as unknown as AuthContext;
  const inOrg = <T>(fn: () => Promise<T>) => withDbAccessContext(
    { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id], currentPartnerId: client.env.partner.id }, fn);
  const authority: OrgReportExecutionAuthority = {
    principalKind: 'user', scope: { version: 1, kind: 'restricted', orgId: org.id, siteIds: [siteA.id] },
    principalUserId: user.id, capturedAt: new Date(), fingerprint: 'a'.repeat(64),
  };
  return { client, org, siteA, siteB, devA: devA!, devB: devB!, hiddenOwned: hiddenOwned!, visibleOwned: visibleOwned!, plainA: plainA!, plainB: plainB!, expected, auth, inOrg, authority };
}

const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id).filter(Boolean).sort();

describe('site-owned topology alerts follow their topology site on every path (T1)', () => {
  it('global search and mobile inbox/search/summary/by-id/ack', async () => {
    const f = await fixture();
    const search = await (await f.client.get('/search?q=zzown')).json();
    expect(ids(search.results.filter((r: { type: string }) => r.type === 'alerts'))).toEqual(f.expected);

    const inbox = await (await f.client.get(`/mobile/alerts/inbox?orgId=${f.org.id}`)).json();
    expect(ids(inbox.data)).toEqual(f.expected);

    const mobileSearch = await (await f.client.get('/mobile/search?q=zzown')).json();
    expect(ids(mobileSearch.results.filter((r: { kind: string }) => r.kind === 'alert'))).toEqual(f.expected);

    const summary = await (await f.client.get(`/mobile/summary?orgId=${f.org.id}`)).json();
    expect(summary.alerts.total).toBe(2);

    expect((await f.client.post(`/mobile/alerts/${f.hiddenOwned.id}/acknowledge`)).status).toBe(404);
    expect((await f.client.post(`/mobile/alerts/${f.visibleOwned.id}/acknowledge`)).status).toBe(200);

    const deviceList = await (await f.client.get(`/mobile/devices?orgId=${f.org.id}`)).json();
    const listedA = deviceList.data.find((d: { id: string }) => d.id === f.devA.id);
    // Only plainA is devA's in-scope open alert; hiddenOwned is owned by site B.
    expect(listedA.openAlertCount).toBe(1);
  });

  it('alert correlation by-id, device alert tab and tab counts', async () => {
    const f = await fixture();
    expect((await f.client.get(`/alerts/${f.hiddenOwned.id}/correlations`)).status).toBe(404);
    expect((await f.client.get(`/alerts/${f.visibleOwned.id}/correlations`)).status).toBe(200);

    const tab = await (await f.client.get(`/devices/${f.devA.id}/alerts`)).json();
    expect(ids(tab.data)).toEqual([f.plainA.id]);
    const counts = await (await f.client.get(`/devices/${f.devA.id}/tab-counts`)).json();
    expect(counts.data.alerts).toBe(1);
  });

  it('report data summary and report generation', async () => {
    const f = await fixture();
    const summary = await (await f.client.get(`/reports/data/alerts-summary?orgId=${f.org.id}`)).json();
    expect(summary.total).toBe(2);
    const report = await f.inOrg(() => generateAlertSummaryReport(f.org.id, {}, f.authority));
    expect(report.rows.map((r: { title: string }) => r.title).sort()).toEqual(['zzown plain a', 'zzown visible owned']);
    const exec = await f.inOrg(() => generateExecutiveSummaryReport(f.org.id, {}, f.authority));
    expect((exec as { summary: { alerts: { total: number } } }).summary.alerts.total).toBe(2);
  });

  it('shared by-id and batch gates, and AI alert/report tools', async () => {
    const f = await fixture();
    expect(await f.inOrg(() => alertInSiteScope(f.auth, f.hiddenOwned))).toBe(false);
    expect(await f.inOrg(() => alertInSiteScope(f.auth, f.visibleOwned))).toBe(true);
    const all = [f.hiddenOwned, f.visibleOwned, f.plainA, f.plainB];
    expect(ids(await f.inOrg(() => filterAlertsBySiteScope(f.auth, all)))).toEqual(f.expected);

    const tools = new Map<string, AiTool>();
    registerAlertTools(tools);
    registerFleetTools(tools);
    const call = async (name: string, input: Record<string, unknown>) => JSON.parse(await f.inOrg(() => tools.get(name)!.handler(input, f.auth)) as string);
    const listed = await call('manage_alerts', { action: 'list', limit: 50 });
    expect(ids(listed.alerts)).toEqual(f.expected);
    const rulesSummary = await call('manage_alert_rules', { action: 'alert_summary' });
    expect(Number(rulesSummary.summary.total)).toBe(2);
    const reportSummary = await call('generate_report', { action: 'data', reportType: 'alert_summary' });
    expect(Number(reportSummary.data.total)).toBe(2);
  });
});
