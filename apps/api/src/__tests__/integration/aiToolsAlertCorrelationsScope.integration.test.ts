/**
 * Integration test — W07 (#6777) alert-correlation tools honour the org axis
 * and the site axis, against real Postgres as the unprivileged `breeze_app`
 * role.
 *
 * Tools: get_alert_correlations, manage_alert_correlations.
 *
 * Fixture: partner P with org O1 (sites S1, S2; a device and an alert in each)
 * and org O2 (one device, one alert). Persisted groups:
 *   gMixed  O1, members aIn (S1) + aOut (S2)
 *   gOut    O1, member aOut (S2) only
 *   gO2     O2, member aO2
 * Callers:
 *   restricted  org token for O1, allowed site S1 only
 *   orgAll      org token for O1, no site restriction
 *
 * Proven against stored rows:
 *   ack / resolve    a group in another org is NOT_FOUND and no alert changes; a
 *                    site-restricted caller cannot ack/resolve a group whose
 *                    alerts are all out of site (NOT_FOUND, nothing changes) and
 *                    on a mixed group changes only its in-site alert.
 *   feedback         a restricted caller cannot label a group with no visible
 *                    member, cannot cite an out-of-site alert, and a label on a
 *                    visible group IS written (control).
 *   reads            a restricted caller sees one alert of the mixed group,
 *                    never the all-out-of-site group, never another org's.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

import { withDbAccessContext, type DbAccessContext } from '../../db';
import { alertCorrelationGroups, alertCorrelationMembers, alerts, devices, mlFeedbackEvents } from '../../db/schema';
import { registerAlertCorrelationTools } from '../../services/aiToolsAlertCorrelations';
import { clearPermissionCache } from '../../services/permissions';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const tools = new Map<string, AiTool>();
registerAlertCorrelationTools(tools);

type Who = 'restricted' | 'orgAll';

interface Fixture {
  partnerId: string; o1: string; o2: string; userId: string;
  aIn: string; aOut: string; aO2: string;
  gMixed: string; gOut: string; gO2: string;
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
    aiOrigin: { kind: 'ai_assistant', sessionId: 'alert-corr-scope' },
  } as unknown as AuthContext;
}

const db = () => getTestDb();

async function seedDevice(orgId: string, siteId: string): Promise<string> {
  const [row] = await db().insert(devices).values({
    orgId, siteId, agentId: `corr-${randomUUID()}`, hostname: `corr-${randomUUID().slice(0, 8)}`,
    osType: 'windows', osVersion: '11', architecture: 'amd64', agentVersion: '1.0.0', status: 'online',
  }).returning({ id: devices.id });
  return row!.id;
}

async function seedAlert(orgId: string, deviceId: string, title: string): Promise<string> {
  const [row] = await db().insert(alerts).values({ orgId, deviceId, severity: 'high', title, status: 'active' }).returning({ id: alerts.id });
  return row!.id;
}

async function seedGroup(orgId: string, key: string, alertIds: string[]): Promise<string> {
  const now = new Date();
  const [g] = await db().insert(alertCorrelationGroups).values({
    orgId, groupKey: `${key}-${randomUUID().slice(0, 8)}`, rootAlertId: alertIds[0]!, status: 'open',
    memberCount: alertIds.length, firstSeenAt: now, lastSeenAt: now,
  }).returning({ id: alertCorrelationGroups.id });
  for (const [i, alertId] of alertIds.entries()) {
    await db().insert(alertCorrelationMembers).values({ orgId, groupId: g!.id, alertId, role: i === 0 ? 'root' : 'related' });
  }
  return g!.id;
}

async function seedFixture(): Promise<Fixture> {
  const p = await createPartner();
  const o1 = await createOrganization({ partnerId: p.id });
  const o2 = await createOrganization({ partnerId: p.id });
  const s1 = await createSite({ orgId: o1.id, name: 'Corr S1' });
  const s2 = await createSite({ orgId: o1.id, name: 'Corr S2' });
  const s3 = await createSite({ orgId: o2.id, name: 'Corr S3' });
  const user = await createUser({ partnerId: p.id, orgId: o1.id, email: `corr-${randomUUID()}@example.com` });
  const dIn = await seedDevice(o1.id, s1.id);
  const dOut = await seedDevice(o1.id, s2.id);
  const dO2 = await seedDevice(o2.id, s3.id);
  const aIn = await seedAlert(o1.id, dIn, 'in-site alert');
  const aOut = await seedAlert(o1.id, dOut, 'out-of-site alert');
  const aO2 = await seedAlert(o2.id, dO2, 'org two alert');
  return {
    partnerId: p.id, o1: o1.id, o2: o2.id, userId: user.id, aIn, aOut, aO2,
    gMixed: await seedGroup(o1.id, 'mixed', [aIn, aOut]),
    gOut: await seedGroup(o1.id, 'out', [aOut]),
    gO2: await seedGroup(o2.id, 'o2', [aO2]),
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

const alertStatus = async (id: string) => (await db().select().from(alerts).where(eq(alerts.id, id)))[0]!.status;
const correlationLabels = async (groupId: string) =>
  db().select().from(mlFeedbackEvents).where(and(eq(mlFeedbackEvents.sourceType, 'correlation'), eq(mlFeedbackEvents.sourceId, groupId)));

describe('manage_alert_correlations — ack / resolve', () => {
  let f: Fixture;
  beforeEach(async () => { await clearPermissionCache(); f = await seedFixture(); });
  const write = (who: Who, input: Record<string, unknown>) => run(f, who, 'manage_alert_correlations', input);

  runDb("another org's group is NOT_FOUND for ack and resolve, and its alert is untouched", async () => {
    expect(await write('orgAll', { action: 'acknowledge_group', groupId: f.gO2 })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await write('orgAll', { action: 'resolve_group', groupId: f.gO2 })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await alertStatus(f.aO2)).toBe('active');
  });

  runDb('a site-restricted caller cannot ack or resolve a group whose alerts are all out of site: NOT_FOUND, nothing changes', async () => {
    expect(await write('restricted', { action: 'acknowledge_group', groupId: f.gOut })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await write('restricted', { action: 'resolve_group', groupId: f.gOut })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await alertStatus(f.aOut)).toBe('active');
    const [group] = await db().select().from(alertCorrelationGroups).where(eq(alertCorrelationGroups.id, f.gOut));
    expect(group!.status).toBe('open');
  });

  runDb('on a mixed group a restricted caller changes only the in-site alert', async () => {
    const res = await write('restricted', { action: 'acknowledge_group', groupId: f.gMixed });
    expect(res).toMatchObject({ updated: 1, action: 'acknowledge_group' });
    expect(await alertStatus(f.aIn)).toBe('acknowledged');
    expect(await alertStatus(f.aOut)).toBe('active');
  });

  runDb('control: the unrestricted caller reaches the out-of-site group and changes its alert', async () => {
    expect(await write('orgAll', { action: 'resolve_group', groupId: f.gOut })).toMatchObject({ updated: 1 });
    expect(await alertStatus(f.aOut)).toBe('resolved');
    const [group] = await db().select().from(alertCorrelationGroups).where(eq(alertCorrelationGroups.id, f.gOut));
    expect(group!.status).toBe('resolved');
  });

  runDb('acknowledge_related on an out-of-site alert is NOT_FOUND for a restricted caller', async () => {
    expect(await write('restricted', { action: 'acknowledge_related', alertId: f.aOut })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await alertStatus(f.aOut)).toBe('active');
    expect(await write('orgAll', { action: 'acknowledge_related', alertId: f.aOut })).toMatchObject({ updated: 1 });
  });
});

describe('manage_alert_correlations — feedback', () => {
  let f: Fixture;
  beforeEach(async () => { await clearPermissionCache(); f = await seedFixture(); });
  const write = (who: Who, input: Record<string, unknown>) => run(f, who, 'manage_alert_correlations', input);

  runDb('another org\'s group, and a group with no visible member, cannot be labelled: no row is written', async () => {
    expect(await write('orgAll', { action: 'feedback', groupId: f.gO2, outcome: 'split' })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await write('restricted', { action: 'feedback', groupId: f.gOut, outcome: 'dismissed' })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await write('restricted', { action: 'rca_feedback', groupId: f.gOut, outcome: 'helpful' })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await correlationLabels(f.gO2)).toHaveLength(0);
    expect(await correlationLabels(f.gOut)).toHaveLength(0);
  });

  runDb('a restricted caller cannot cite an out-of-site alert or merge into an invisible group', async () => {
    expect(await write('restricted', { action: 'feedback', groupId: f.gMixed, outcome: 'split', alertIds: [f.aOut] })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await write('restricted', { action: 'feedback', groupId: f.gMixed, outcome: 'merged', targetGroupId: f.gOut })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await correlationLabels(f.gMixed)).toHaveLength(0);
  });

  runDb('control: a label on a visible group IS written, citing a visible alert', async () => {
    const res = await write('restricted', { action: 'feedback', groupId: f.gMixed, outcome: 'split', alertIds: [f.aIn] });
    expect(res).toMatchObject({ success: true });
    const rows = await correlationLabels(f.gMixed);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventType).toBe('correlation.split');
  });

  runDb('control: the unrestricted caller can label the all-out-of-site group', async () => {
    expect(await write('orgAll', { action: 'feedback', groupId: f.gOut, outcome: 'dismissed' })).toMatchObject({ success: true });
    expect(await correlationLabels(f.gOut)).toHaveLength(1);
  });
});

describe('get_alert_correlations — reads honour org and site', () => {
  let f: Fixture;
  beforeEach(async () => { await clearPermissionCache(); f = await seedFixture(); });
  const read = (who: Who, input: Record<string, unknown>) => run(f, who, 'get_alert_correlations', input);

  runDb('groups: a restricted caller sees one alert of the mixed group, no all-out-of-site group, no other org', async () => {
    const res = await read('restricted', { action: 'groups', limit: 50 });
    const ids = res.groups.map((g: { id: string }) => g.id);
    expect(ids).toContain(f.gMixed);
    expect(ids).not.toContain(f.gOut);
    expect(ids).not.toContain(f.gO2);
    const mixed = res.groups.find((g: { id: string }) => g.id === f.gMixed);
    expect(mixed.alerts.map((a: { id: string }) => a.id)).toEqual([f.aIn]);
  });

  runDb('control: the unrestricted org caller sees both groups of its org and both alerts of the mixed one', async () => {
    const res = await read('orgAll', { action: 'groups', limit: 50 });
    const ids = res.groups.map((g: { id: string }) => g.id);
    expect(ids).toEqual(expect.arrayContaining([f.gMixed, f.gOut]));
    expect(ids).not.toContain(f.gO2);
    expect(res.groups.find((g: { id: string }) => g.id === f.gMixed).alerts).toHaveLength(2);
  });

  runDb('get / explain on a group with no visible member are NOT_FOUND, whatever the RCA flag says', async () => {
    expect(await read('restricted', { action: 'get', groupId: f.gOut })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await read('restricted', { action: 'explain', groupId: f.gOut })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await read('orgAll', { action: 'get', groupId: f.gO2 })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await read('orgAll', { action: 'explain', groupId: f.gO2 })).toMatchObject({ code: 'NOT_FOUND' });
  });

  runDb('get on a partly visible group withholds the AI verdict from the restricted caller only', async () => {
    const restricted = await read('restricted', { action: 'get', groupId: f.gMixed });
    expect(restricted.group.alerts).toHaveLength(1);
    expect(restricted.group.aiVerdictWithheld).toBe(true);
    const all = await read('orgAll', { action: 'get', groupId: f.gMixed });
    expect(all.group.alerts).toHaveLength(2);
    expect(all.group.aiVerdictWithheld).toBeUndefined();
  });

  runDb('by_alert on an out-of-site or other-org alert is NOT_FOUND for the restricted caller', async () => {
    expect(await read('restricted', { action: 'by_alert', alertId: f.aOut })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await read('orgAll', { action: 'by_alert', alertId: f.aO2 })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await read('restricted', { action: 'by_alert', alertId: f.aIn })).toMatchObject({ alert: { id: f.aIn } });
  });
});
