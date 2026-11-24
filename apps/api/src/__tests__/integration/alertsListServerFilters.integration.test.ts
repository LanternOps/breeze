/**
 * #12324 — GET /alerts applies every Alerts-page filter in the query, before
 * the page limit, so `pagination.total` and the page describe the filtered set.
 *
 * The bug: the page fetched the newest 50 alerts across every org and then
 * filtered by device in the browser. In the All-organizations view, newer
 * alerts from unrelated orgs pushed a device's current alert out of that
 * window. These tests seed more than one page of newer noise in one org and
 * the target device's alerts, older, in another.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { alertRoutes } from '../../routes/alerts';
import { aiAgents, aiAgentRuns, aiAlertVerdicts, alerts, devices, organizationUsers, partnerUsers, users } from '../../db/schema';
import { clearPermissionCache } from '../../services/permissions';
import { createIntegrationTestClient, createOrganization, createSite } from './db-utils';
import { getAppDb, getTestDb } from './setup';

// Pass-through, except a filter whose hostname value is TIMEOUT_SENTINEL
// throws the engine's statement-timeout error, so the 422 path runs here
// without a pathological query. Every other case uses the real engine.
const TIMEOUT_SENTINEL = 'force-filter-timeout';
vi.mock('../../services/filterEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/filterEngine')>();
  return {
    ...actual,
    evaluateFilterInOrgs: vi.fn(async (filter: Parameters<typeof actual.evaluateFilterInOrgs>[0], options: Parameters<typeof actual.evaluateFilterInOrgs>[1]) => {
      if (JSON.stringify(filter).includes(TIMEOUT_SENTINEL)) throw new actual.FilterQueryTimeoutError();
      return actual.evaluateFilterInOrgs(filter, options);
    }),
  };
});

const app = new Hono().route('/alerts', alertRoutes);
const runDb = it.runIf(!!process.env.DATABASE_URL);

const HOUR = 60 * 60 * 1000;

function deviceFilterParam(hostname: string): string {
  return encodeURIComponent(JSON.stringify({
    operator: 'AND',
    conditions: [{ field: 'hostname', operator: 'equals', value: hostname }],
  }));
}

async function insertDevice(orgId: string, siteId: string, hostname: string) {
  const [row] = await getTestDb().insert(devices).values({
    orgId, siteId, agentId: randomUUID(), hostname, status: 'online',
    osType: 'linux', osVersion: 'test', architecture: 'x86_64', agentVersion: 'test',
  }).returning({ id: devices.id });
  return row!.id;
}

async function fixture(options: { rolePermissions?: Array<{ resource: string; action: string }> } = {}) {
  const client = await createIntegrationTestClient(app, {
    scope: 'partner',
    ...(options.rolePermissions ? { rolePermissions: options.rolePermissions } : {}),
  });
  const { organization: noisyOrg, site: noisySite, partner } = client.env;
  const targetOrg = await createOrganization({ partnerId: partner.id });
  const targetSite = await createSite({ orgId: targetOrg.id });
  const suffix = randomUUID().slice(0, 8);
  const targetHostname = `target-${suffix}`;

  const noisyDevice = await insertDevice(noisyOrg.id, noisySite.id, `noisy-${suffix}`);
  const targetDevice = await insertDevice(targetOrg.id, targetSite.id, targetHostname);

  // Another partner's device with the SAME hostname: the filter must never
  // reach outside the caller's tenants.
  const foreign = await createIntegrationTestClient(app, { scope: 'partner' });
  const foreignDevice = await insertDevice(foreign.env.organization.id, foreign.env.site.id, targetHostname);

  const now = Date.now();
  const noise = Array.from({ length: 60 }, (_, i) => ({
    orgId: noisyOrg.id, deviceId: noisyDevice, status: 'active' as const,
    severity: 'low' as const, title: `Noise ${i}`, message: 'noise',
    triggeredAt: new Date(now - i * 60 * 1000),
  }));
  const [targetActive, targetResolved] = await getTestDb().insert(alerts).values([
    { orgId: targetOrg.id, deviceId: targetDevice, status: 'active' as const, severity: 'critical' as const,
      title: 'Disk almost full', message: 'C: has 2% free', triggeredAt: new Date(now - 48 * HOUR) },
    { orgId: targetOrg.id, deviceId: targetDevice, status: 'resolved' as const, severity: 'high' as const,
      title: 'Service stopped', message: 'Spooler stopped', triggeredAt: new Date(now - 240 * HOUR) },
  ]).returning({ id: alerts.id });
  await getTestDb().insert(alerts).values(noise);
  const [foreignAlert] = await getTestDb().insert(alerts).values({
    orgId: foreign.env.organization.id, deviceId: foreignDevice, status: 'active', severity: 'critical',
    title: 'Foreign disk almost full', message: 'foreign', triggeredAt: new Date(now - 47 * HOUR),
  }).returning({ id: alerts.id });

  return {
    client, noisyOrg, targetOrg, targetHostname, targetDevice,
    targetActiveId: targetActive!.id, targetResolvedId: targetResolved!.id, foreignAlertId: foreignAlert!.id,
  };
}

type ListBody = { data: Array<{ id: string; deviceId: string | null; severity: string; status: string }>; pagination: { page: number; limit: number; total: number } };

async function list(f: Awaited<ReturnType<typeof fixture>>, query: string): Promise<{ status: number; body: ListBody }> {
  const response = await f.client.get(`/alerts?${query}`);
  return { status: response.status, body: await response.json() as ListBody };
}

describe('GET /alerts server-side filters (#12324)', () => {
  runDb('runs as the unprivileged application role', async () => {
    const roles = await getAppDb().execute(sql`SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(roles[0]).toMatchObject({ role: 'breeze_app', rolsuper: false, rolbypassrls: false });
  });

  runDb('the All-organizations device filter finds a device alert behind a full page of newer noise', async () => {
    const f = await fixture();
    const { status, body } = await list(f, `deviceFilter=${deviceFilterParam(f.targetHostname)}&status=active,acknowledged,resolved,suppressed,dismissed`);
    expect(status).toBe(200);
    expect(body.pagination.total).toBe(2);
    expect(body.data.map((a) => a.id).sort()).toEqual([f.targetActiveId, f.targetResolvedId].sort());
    expect(body.data.map((a) => a.id)).not.toContain(f.foreignAlertId);
  });

  runDb('status and the device filter combine before the limit', async () => {
    const f = await fixture();
    const { body } = await list(f, `deviceFilter=${deviceFilterParam(f.targetHostname)}&status=active`);
    expect(body.pagination.total).toBe(1);
    expect(body.data.map((a) => a.id)).toEqual([f.targetActiveId]);
  });

  runDb('one device filter matches devices in every accessible org, never another partner', async () => {
    const f = await fixture();
    const suffix = f.targetHostname.slice('target-'.length);
    const contains = encodeURIComponent(JSON.stringify({
      operator: 'AND', conditions: [{ field: 'hostname', operator: 'contains', value: suffix }],
    }));
    // Both orgs' devices carry the suffix (60 noise + 2 target alerts, dismissed
    // excluded by default). The other partner's device does too, and stays out.
    const { status, body } = await list(f, `deviceFilter=${contains}&limit=100`);
    expect(status).toBe(200);
    expect(body.pagination.total).toBe(62);
    expect(body.data.map((a) => a.id)).not.toContain(f.foreignAlertId);
  });

  runDb('deviceId and startDate (the device and date-range dropdowns) filter before the limit', async () => {
    const f = await fixture();
    const byDevice = await list(f, `deviceId=${f.targetDevice}`);
    expect(byDevice.body.pagination.total).toBe(2);
    const since = new Date(Date.now() - 72 * HOUR).toISOString();
    const recent = await list(f, `deviceId=${f.targetDevice}&startDate=${encodeURIComponent(since)}`);
    expect(recent.body.data.map((a) => a.id)).toEqual([f.targetActiveId]);
    expect(recent.body.pagination.total).toBe(1);
  });

  runDb('a system-scope caller filters by device within a chosen org', async () => {
    const client = await createIntegrationTestClient(app, { scope: 'system' });
    const { organization: org, site, user } = client.env;
    // A system-scope token is authorized off the live platform-admin flag.
    await getTestDb().update(users).set({ isPlatformAdmin: true }).where(eq(users.id, user.id));
    await clearPermissionCache(user.id);
    const hostname = `system-${randomUUID().slice(0, 8)}`;
    const deviceId = await insertDevice(org.id, site.id, hostname);
    const [alert] = await getTestDb().insert(alerts).values({
      orgId: org.id, deviceId, status: 'active', severity: 'high', title: 'System view', message: 'm',
    }).returning({ id: alerts.id });
    const scoped = await client.get(`/alerts?orgId=${org.id}&deviceFilter=${deviceFilterParam(hostname)}`);
    expect(scoped.status).toBe(200);
    expect(((await scoped.json()) as ListBody).data.map((a) => a.id)).toEqual([alert!.id]);
    // No org chosen: like POST /filters/preview, a system caller's device
    // filter has no org to evaluate in and matches nothing.
    const unscoped = await client.get(`/alerts?deviceFilter=${deviceFilterParam(hostname)}`);
    expect(unscoped.status).toBe(200);
    expect(((await unscoped.json()) as ListBody).pagination.total).toBe(0);
  });

  runDb('a partner limited to selected orgs never matches devices in its other orgs', async () => {
    const f = await fixture();
    // Same partner, but the user may now see only the noisy org.
    await getTestDb().update(partnerUsers).set({ orgAccess: 'selected', orgIds: [f.noisyOrg.id] })
      .where(eq(partnerUsers.userId, f.client.env.user.id));
    await clearPermissionCache(f.client.env.user.id);
    const suffix = f.targetHostname.slice('target-'.length);
    const contains = encodeURIComponent(JSON.stringify({
      operator: 'AND', conditions: [{ field: 'hostname', operator: 'contains', value: suffix }],
    }));
    const { status, body } = await list(f, `deviceFilter=${contains}&limit=100`);
    expect(status).toBe(200);
    expect(body.pagination.total).toBe(60);
    expect(body.data.map((a) => a.id)).not.toContain(f.targetActiveId);
    expect((await f.client.get(`/alerts?orgId=${f.targetOrg.id}&deviceFilter=${contains}`)).status).toBe(403);
  });

  runDb('hideAiNoise and the device filter intersect, in the page and the total', async () => {
    const f = await fixture();
    const [agent] = await getTestDb().insert(aiAgents).values({ orgId: f.targetOrg.id, kind: 'triage', name: 'Noise fixture', createdBy: f.client.env.user.id }).returning();
    const [run] = await getTestDb().insert(aiAgentRuns).values({ agentId: agent!.id, orgId: f.targetOrg.id, profile: 'verdict', triggerKind: 'manual', dedupeKey: randomUUID(), modeAtStart: 'shadow', policySnapshot: { schemaVersion: 1 } as never }).returning();
    await getTestDb().insert(aiAlertVerdicts).values({ orgId: f.targetOrg.id, runId: run!.id, alertId: f.targetResolvedId, classification: 'recurring_pattern', confidence: '0.95', rationale: 'noise' });
    const { body } = await list(f, `deviceFilter=${deviceFilterParam(f.targetHostname)}&hideAiNoise=true`);
    expect(body.data.map((a) => a.id)).toEqual([f.targetActiveId]);
    expect(body.pagination.total).toBe(1);
  });

  runDb('a device filter that hits the statement timeout answers 422 with the preview body', async () => {
    const f = await fixture();
    const response = await f.client.get(`/alerts?deviceFilter=${deviceFilterParam(TIMEOUT_SENTINEL)}`);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'filter_query_timeout' });
  });

  runDb('a device filter matching nothing returns an empty page, not the unfiltered list', async () => {
    const f = await fixture();
    const { status, body } = await list(f, `deviceFilter=${deviceFilterParam(`missing-${randomUUID()}`)}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ data: [], pagination: { total: 0 } });
  });

  runDb('severity accepts several values, and a single value still works', async () => {
    const f = await fixture();
    const many = await list(f, `orgId=${f.targetOrg.id}&severity=critical,high&status=active,resolved`);
    expect(many.status).toBe(200);
    expect(many.body.pagination.total).toBe(2);
    const one = await list(f, `orgId=${f.targetOrg.id}&severity=high&status=active,resolved`);
    expect(one.body.data.map((a) => a.id)).toEqual([f.targetResolvedId]);
    expect((await list(f, 'severity=urgent')).status).toBe(400);
  });

  runDb('search matches title, message and device hostname across organizations, and pages over the matches', async () => {
    const f = await fixture();
    const byTitle = await list(f, 'search=almost%20FULL');
    expect(byTitle.body.data.map((a) => a.id)).toEqual([f.targetActiveId]);
    expect(byTitle.body.pagination.total).toBe(1);
    const byMessage = await list(f, 'search=spooler&status=resolved');
    expect(byMessage.body.data.map((a) => a.id)).toEqual([f.targetResolvedId]);
    const byHostname = await list(f, `search=${f.targetHostname}&status=active,resolved`);
    expect(byHostname.body.pagination.total).toBe(2);
    // LIKE metacharacters are literal: `%` matches only the one "2% free"
    // message, and no seeded text holds `_`.
    expect((await list(f, 'search=%25')).body.data.map((a) => a.id)).toEqual([f.targetActiveId]);
    expect((await list(f, 'search=_')).body.pagination.total).toBe(0);
    // 60 noise rows match "noise": page 2 of 25 holds rows 26-50, total stays 60.
    const paged = await list(f, 'search=noise&limit=25&page=2');
    expect(paged.body.pagination).toEqual({ page: 2, limit: 25, total: 60 });
    expect(paged.body.data).toHaveLength(25);
  });

  runDb('the device filter needs devices:read, and a malformed filter is a 400', async () => {
    const f = await fixture({ rolePermissions: [{ resource: 'alerts', action: 'read' }] });
    const denied = await f.client.get(`/alerts?deviceFilter=${deviceFilterParam(f.targetHostname)}`);
    expect(denied.status).toBe(403);
    // Without the filter the same role still lists alerts.
    expect((await f.client.get('/alerts')).status).toBe(200);

    const admin = await fixture();
    expect((await admin.client.get('/alerts?deviceFilter=not-json')).status).toBe(400);
    const unknownField = encodeURIComponent(JSON.stringify({ operator: 'AND', conditions: [{ field: 'nope', operator: 'equals', value: 'x' }] }));
    expect((await admin.client.get(`/alerts?deviceFilter=${unknownField}`)).status).toBe(400);
  });

  runDb('summary openBySeverity counts active and acknowledged alerts for the page strip', async () => {
    const f = await fixture();
    await getTestDb().insert(alerts).values([
      { orgId: f.targetOrg.id, deviceId: f.targetDevice, status: 'acknowledged' as const, severity: 'critical' as const, title: 'Ack', message: 'm' },
      { orgId: f.targetOrg.id, deviceId: f.targetDevice, status: 'suppressed' as const, severity: 'critical' as const, title: 'Muted', message: 'm' },
    ]);
    const response = await f.client.get(`/alerts/summary?orgId=${f.targetOrg.id}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    // bySeverity keeps its active-only meaning (dashboard KPIs read it).
    expect(body.bySeverity).toEqual({ critical: 1, high: 0, medium: 0, low: 0, info: 0 });
    expect(body.openBySeverity).toEqual({ critical: 2, high: 0, medium: 0, low: 0, info: 0 });
    // All organizations: the 60 low-severity noise alerts are open too.
    const fleet = await (await f.client.get('/alerts/summary')).json();
    expect(fleet.openBySeverity).toEqual({ critical: 2, high: 0, medium: 0, low: 60, info: 0 });
  });

  runDb('a site-restricted reader filtering by device never sees another site', async () => {
    const client = await createIntegrationTestClient(app, { scope: 'organization' });
    const { organization: org, site, user } = client.env;
    const otherSite = await createSite({ orgId: org.id });
    const hostname = `shared-${randomUUID().slice(0, 8)}`;
    const allowedDevice = await insertDevice(org.id, site.id, hostname);
    const hiddenDevice = await insertDevice(org.id, otherSite.id, hostname);
    const [allowedAlert] = await getTestDb().insert(alerts).values([
      { orgId: org.id, deviceId: allowedDevice, status: 'active' as const, severity: 'high' as const, title: 'Allowed', message: 'm' },
      { orgId: org.id, deviceId: hiddenDevice, status: 'active' as const, severity: 'high' as const, title: 'Hidden', message: 'm' },
    ]).returning({ id: alerts.id });
    await getTestDb().update(organizationUsers).set({ siteIds: [site.id] }).where(eq(organizationUsers.userId, user.id));
    await clearPermissionCache(user.id);
    const response = await client.get(`/alerts?deviceFilter=${deviceFilterParam(hostname)}`);
    expect(response.status).toBe(200);
    const body = await response.json() as ListBody;
    expect(body.data.map((a) => a.id)).toEqual([allowedAlert!.id]);
    expect(body.pagination.total).toBe(1);
  });
});
