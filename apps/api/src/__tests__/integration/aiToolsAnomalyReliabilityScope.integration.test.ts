/**
 * Integration test — W07 (#6777) device-anomaly and reliability triage tools
 * honour the org axis and the site axis, against real Postgres as the
 * unprivileged `breeze_app` role.
 *
 * Tools: manage_device_anomalies, reliability_feedback, and the extra
 * get_fleet_health actions (history / offenders / org_summary).
 *
 * `test_alert_rule` from the brief is not built (its route was retired in
 * #6917), so there is no "zero alert / notification rows" assertion for it.
 *
 * Fixture: partner P with org O1 (sites S1, S2; a device in each, each with an
 * open metric anomaly and a reliability snapshot) and org O2 (a device, an
 * anomaly, a snapshot). Callers:
 *   restricted  org token for O1, allowed site S1 only
 *   orgAll      org token for O1, no site restriction
 *
 * Proven against stored rows: an out-of-site or other-org device is NOT_FOUND
 * and its anomaly / label is NOT changed; naming an anomaly of another device
 * under an in-scope device id changes nothing; the in-scope path DOES write.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

import { withDbAccessContext, type DbAccessContext } from '../../db';
import { alerts, deviceReliability, devices, metricAnomalies, mlFeedbackEvents } from '../../db/schema';
import { registerAnomalyTools } from '../../services/aiToolsAnomalies';
import { registerReliabilityTriageTools, runFleetHealthAction } from '../../services/aiToolsReliabilityTriage';
import { clearPermissionCache } from '../../services/permissions';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const tools = new Map<string, AiTool>();
registerAnomalyTools(tools);
registerReliabilityTriageTools(tools);

type Who = 'restricted' | 'orgAll';

interface Fixture {
  partnerId: string; o1: string; o2: string; userId: string;
  dIn: string; dOut: string; dO2: string;
  anIn: string; anOut: string; anO2: string;
  auth: Record<Who, AuthContext>;
}

function orgAuth(userId: string, partnerId: string, orgId: string, allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId, orgId, scope: 'organization', accessibleOrgIds: [orgId],
    orgCondition: (col: PgColumn) => eq(col, orgId),
    canAccessOrg: (id: string) => id === orgId,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'anomaly-reliability-scope' },
  } as unknown as AuthContext;
}

const db = () => getTestDb();

async function seedDevice(orgId: string, siteId: string): Promise<string> {
  const [row] = await db().insert(devices).values({
    orgId, siteId, agentId: `anom-${randomUUID()}`, hostname: `anom-${randomUUID().slice(0, 8)}`,
    osType: 'windows', osVersion: '11', architecture: 'amd64', agentVersion: '1.0.0', status: 'online',
  }).returning({ id: devices.id });
  return row!.id;
}

async function seedAnomaly(orgId: string, deviceId: string): Promise<string> {
  const now = new Date();
  const [row] = await db().insert(metricAnomalies).values({
    orgId, deviceId, metricType: 'cpu', metricName: 'cpu_percent', anomalyType: 'spike', status: 'open',
    windowStart: new Date(now.getTime() - 300_000), windowEnd: now, observedValue: 99, score: 0.9, confidence: 0.9,
  }).returning({ id: metricAnomalies.id });
  return row!.id;
}

async function seedSnapshot(orgId: string, deviceId: string): Promise<void> {
  await db().insert(deviceReliability).values({
    deviceId, orgId, reliabilityScore: 55, uptimeScore: 50, crashScore: 50, hangScore: 50, serviceFailureScore: 50, hardwareErrorScore: 50,
    uptime7d: 90, uptime30d: 90, uptime90d: 90, trendDirection: 'stable',
  });
}

async function seedFixture(): Promise<Fixture> {
  const p = await createPartner();
  const o1 = await createOrganization({ partnerId: p.id });
  const o2 = await createOrganization({ partnerId: p.id });
  const s1 = await createSite({ orgId: o1.id, name: 'Anom S1' });
  const s2 = await createSite({ orgId: o1.id, name: 'Anom S2' });
  const s3 = await createSite({ orgId: o2.id, name: 'Anom S3' });
  const user = await createUser({ partnerId: p.id, orgId: o1.id, email: `anom-${randomUUID()}@example.com` });
  const dIn = await seedDevice(o1.id, s1.id);
  const dOut = await seedDevice(o1.id, s2.id);
  const dO2 = await seedDevice(o2.id, s3.id);
  for (const [org, d] of [[o1.id, dIn], [o1.id, dOut], [o2.id, dO2]] as const) await seedSnapshot(org, d);
  return {
    partnerId: p.id, o1: o1.id, o2: o2.id, userId: user.id, dIn, dOut, dO2,
    anIn: await seedAnomaly(o1.id, dIn), anOut: await seedAnomaly(o1.id, dOut), anO2: await seedAnomaly(o2.id, dO2),
    auth: { restricted: orgAuth(user.id, p.id, o1.id, [s1.id]), orgAll: orgAuth(user.id, p.id, o1.id) },
  };
}

const ctxFor = (f: Fixture): DbAccessContext => ({
  scope: 'organization', orgId: f.o1, accessibleOrgIds: [f.o1], accessiblePartnerIds: [], userId: f.userId, currentPartnerId: f.partnerId,
});

async function run(f: Fixture, who: Who, tool: string, input: Record<string, unknown>) {
  const handler = tools.get(tool)!.handler;
  const raw = await withDbAccessContext(ctxFor(f), () => handler(input, f.auth[who]));
  return JSON.parse(raw) as Record<string, any>;
}

async function fleet(f: Fixture, who: Who, input: Record<string, unknown>) {
  const raw = await withDbAccessContext(ctxFor(f), () => runFleetHealthAction(input, f.auth[who]));
  return JSON.parse(raw as string) as Record<string, any>;
}

const anomalyStatus = async (id: string) => (await db().select().from(metricAnomalies).where(eq(metricAnomalies.id, id)))[0]!.status;
const deviceLabels = async (deviceId: string) =>
  db().select().from(mlFeedbackEvents).where(and(eq(mlFeedbackEvents.sourceType, 'device'), eq(mlFeedbackEvents.sourceId, deviceId)));

describe('manage_device_anomalies — org and site axes', () => {
  let f: Fixture;
  beforeEach(async () => { await clearPermissionCache(); f = await seedFixture(); });
  const anomalies = (who: Who, input: Record<string, unknown>) => run(f, who, 'manage_device_anomalies', input);

  runDb('list: an out-of-site or other-org device is NOT_FOUND; the in-site device lists only its own anomaly', async () => {
    expect(await anomalies('restricted', { action: 'list', deviceId: f.dOut })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await anomalies('orgAll', { action: 'list', deviceId: f.dO2 })).toMatchObject({ code: 'NOT_FOUND' });
    const res = await anomalies('restricted', { action: 'list', deviceId: f.dIn });
    expect(res.anomalies.map((a: { id: string }) => a.id)).toEqual([f.anIn]);
  });

  runDb('dismiss / resolve / promote on an out-of-site or other-org device: NOT_FOUND, status unchanged, no alert raised', async () => {
    for (const action of ['dismiss', 'resolve', 'promote']) {
      expect(await anomalies('restricted', { action, deviceId: f.dOut, anomalyId: f.anOut }), action).toMatchObject({ code: 'NOT_FOUND' });
      expect(await anomalies('orgAll', { action, deviceId: f.dO2, anomalyId: f.anO2 }), action).toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(await anomalyStatus(f.anOut)).toBe('open');
    expect(await anomalyStatus(f.anO2)).toBe('open');
    const raised = await db().select().from(alerts).where(eq(alerts.deviceId, f.dOut));
    expect(raised).toHaveLength(0);
  });

  runDb('an anomaly id of another device under an in-scope device id changes nothing', async () => {
    expect(await anomalies('restricted', { action: 'dismiss', deviceId: f.dIn, anomalyId: f.anOut })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await anomalyStatus(f.anOut)).toBe('open');
  });

  runDb('control: the in-scope device IS dismissed / resolved; the unrestricted caller reaches the other site', async () => {
    expect(await anomalies('restricted', { action: 'dismiss', deviceId: f.dIn, anomalyId: f.anIn })).toMatchObject({ anomaly: { status: 'dismissed' } });
    expect(await anomalyStatus(f.anIn)).toBe('dismissed');
    expect(await anomalies('orgAll', { action: 'resolve', deviceId: f.dOut, anomalyId: f.anOut })).toMatchObject({ anomaly: { status: 'resolved' } });
    expect(await anomalyStatus(f.anOut)).toBe('resolved');
  });
});

describe('reliability_feedback and get_fleet_health actions — org and site axes', () => {
  let f: Fixture;
  beforeEach(async () => { await clearPermissionCache(); f = await seedFixture(); });
  const label = (who: Who, input: Record<string, unknown>) => run(f, who, 'reliability_feedback', input);

  runDb('an out-of-site or other-org device cannot be labelled: NOT_FOUND and no row is written', async () => {
    expect(await label('restricted', { deviceId: f.dOut, outcome: 'replaced' })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await label('orgAll', { deviceId: f.dO2, outcome: 'false_alarm' })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await deviceLabels(f.dOut)).toHaveLength(0);
    expect(await deviceLabels(f.dO2)).toHaveLength(0);
  });

  runDb('control: the in-scope device IS labelled, and the unrestricted caller can label the other site', async () => {
    expect(await label('restricted', { deviceId: f.dIn, outcome: 'failure_confirmed' })).toMatchObject({ success: true });
    const rows = await deviceLabels(f.dIn);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventType).toBe('device.failure_confirmed');
    expect(await label('orgAll', { deviceId: f.dOut, outcome: 'replaced' })).toMatchObject({ success: true });
    expect(await deviceLabels(f.dOut)).toHaveLength(1);
  });

  runDb('history / offenders on an out-of-site or other-org device are NOT_FOUND; the in-scope device answers', async () => {
    for (const action of ['history', 'offenders']) {
      expect(await fleet(f, 'restricted', { action, deviceId: f.dOut }), action).toMatchObject({ code: 'NOT_FOUND' });
      expect(await fleet(f, 'orgAll', { action, deviceId: f.dO2 }), action).toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(await fleet(f, 'restricted', { action: 'history', deviceId: f.dIn })).toMatchObject({ deviceId: f.dIn, days: 90 });
    expect(await fleet(f, 'orgAll', { action: 'offenders', deviceId: f.dOut })).toMatchObject({ deviceId: f.dOut });
  });

  runDb('org_summary of another org is ACCESS_DENIED; a restricted caller\'s summary covers only its site', async () => {
    expect(await fleet(f, 'orgAll', { action: 'org_summary', orgId: f.o2 })).toMatchObject({ code: 'ACCESS_DENIED' });
    const restricted = await fleet(f, 'restricted', { action: 'org_summary', orgId: f.o1 });
    expect(restricted.worstDevices.map((d: { deviceId: string }) => d.deviceId)).toEqual([f.dIn]);
    const all = await fleet(f, 'orgAll', { action: 'org_summary', orgId: f.o1 });
    expect(all.worstDevices.map((d: { deviceId: string }) => d.deviceId).sort()).toEqual([f.dIn, f.dOut].sort());
  });
});
