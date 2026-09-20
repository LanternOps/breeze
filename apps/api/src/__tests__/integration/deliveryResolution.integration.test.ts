/**
 * W05b spec gate: the dispatcher and the resolver (and, from Task 13, the
 * preview endpoint) agree for the org-row, partner-row, default-row and
 * inbox-only cases against real Postgres with the breeze_app role's RLS.
 *
 * Fixture: partner P with an enabled partner-wide channel; org O under P with
 * an enabled org channel, one site, one device at that site.
 */
import './setup';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  alertRules, alertTemplates, alerts, devices, escalationPolicies, monitorDefinitions, notificationChannels, notificationRoutingRules, organizationUsers, partnerUsers, sites,
} from '../../db/schema';
import { getNotificationQueue, processAlertNotifications, shutdownNotificationDispatcher } from '../../services/notificationDispatcher';
import { resolveDelivery } from '../../services/delivery/resolveDelivery';
import { Hono } from 'hono';
import type { AuthContext } from '../../middleware/auth';
import type { ResolveDeliveryInput } from '../../services/delivery/resolveDelivery';
import { describeDelivery, type DeliveryPreview } from '../../services/delivery/describeDelivery';
vi.mock('../../middleware/auth', async importOriginal => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return { ...actual,
    requireMfa: () => async (_c: any, next: any) => next(),
    requireScope: () => async (_c: any, next: any) => next(),
    requirePermission: () => async (_c: any, next: any) => next(),
  };
});
import { deliveryRoutes } from '../../routes/alerts/delivery';
import { deliveryRailsRoutes } from '../../routes/alerts/deliveryRails';
import { channelsRoutes } from '../../routes/alerts/channels';
import { routingRoutes } from '../../routes/alerts/routing';
import { policiesRoutes } from '../../routes/alerts/policies';
import { createOrganization, createPartner, createUser } from './db-utils';
import { listEscalationUsers } from '../../services/delivery/escalationExecution';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const SYSTEM_CTX: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null };
const sys = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

const created = { legacyRules: [] as string[], templates: [] as string[], alerts: [] as string[], rules: [] as string[], policies: [] as string[], channels: [] as string[], monitors: [] as string[], devices: [] as string[], sites: [] as string[] };

afterAll(async () => { await shutdownNotificationDispatcher(); });
afterEach(async () => {
  await sys(async () => {
    if (created.alerts.length) await db.delete(alerts).where(inArray(alerts.id, created.alerts));
    for (const id of created.legacyRules) await db.delete(alertRules).where(eq(alertRules.id, id));
    for (const id of created.templates) await db.delete(alertTemplates).where(eq(alertTemplates.id, id));
    for (const id of created.rules) await db.delete(notificationRoutingRules).where(eq(notificationRoutingRules.id, id));
    for (const id of created.monitors) await db.delete(monitorDefinitions).where(eq(monitorDefinitions.id, id));
    for (const id of created.policies) await db.delete(escalationPolicies).where(eq(escalationPolicies.id, id));
    for (const id of created.channels) await db.delete(notificationChannels).where(eq(notificationChannels.id, id));
    for (const id of created.devices) await db.delete(devices).where(eq(devices.id, id));
    for (const id of created.sites) await db.delete(sites).where(eq(sites.id, id));
  });
  for (const k of Object.keys(created) as Array<keyof typeof created>) created[k].length = 0;
});

export interface DeliveryFixture { partnerId: string; orgId: string; siteId: string; deviceId: string; partnerChannel: string; orgChannel: string }

export async function seedFixture(): Promise<DeliveryFixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const [site] = await sys(() => db.insert(sites).values({ orgId: org.id, name: 'HQ' }).returning());
  created.sites.push(site!.id);
  const [device] = await sys(() => db.insert(devices).values({
    orgId: org.id, siteId: site!.id, agentId: `agent-${site!.id.slice(0, 18)}`, hostname: 'delivery-gate',
    osType: 'windows', osVersion: '10.0', architecture: 'x64', agentVersion: '1.0.0',
  }).returning());
  created.devices.push(device!.id);
  const [pc] = await sys(() => db.insert(notificationChannels).values({ orgId: null, partnerId: partner.id, name: 'Partner NOC', type: 'slack', config: { webhookUrl: 'https://hooks.slack.example/p' }, enabled: true }).returning());
  const [oc] = await sys(() => db.insert(notificationChannels).values({ orgId: org.id, partnerId: null, name: 'Org email', type: 'slack', config: { webhookUrl: 'https://hooks.slack.example/o' }, enabled: true }).returning());
  created.channels.push(pc!.id, oc!.id);
  return { partnerId: partner.id, orgId: org.id, siteId: site!.id, deviceId: device!.id, partnerChannel: pc!.id, orgChannel: oc!.id };
}

async function seedRule(values: Partial<typeof notificationRoutingRules.$inferInsert> & { channelIds: string[] }) {
  const [row] = await sys(() => db.insert(notificationRoutingRules).values({ name: 'r', priority: 10, conditions: {}, enabled: true, orgId: null, partnerId: null, ...values }).returning());
  created.rules.push(row!.id);
  return row!;
}

async function seedAlert(f: DeliveryFixture, severity: 'critical' | 'high' | 'medium' | 'low', monitorId: string | null = null) {
  const [alert] = await sys(() => db.insert(alerts).values({ orgId: f.orgId, deviceId: f.deviceId, severity, status: 'active', title: 'gate', message: 'gate', monitorId }).returning());
  created.alerts.push(alert!.id);
  return alert!.id;
}

function orgCtx(f: DeliveryFixture): DbAccessContext {
  return { scope: 'organization', orgId: f.orgId, accessibleOrgIds: [f.orgId],
    accessiblePartnerIds: [], currentPartnerId: f.partnerId, userId: null };
}

async function dispatch(alertId: string) {
  return sys(() => processAlertNotifications({ type: 'process-alert', alertId }));
}

async function capturedDispatch(alertId: string) {
  const bulk = vi.spyOn(getNotificationQueue(), 'addBulk').mockResolvedValue([]);
  const single = vi.spyOn(getNotificationQueue(), 'add').mockResolvedValue({ getState: async () => 'waiting' } as never);
  try {
    const result = await dispatch(alertId);
    return { ...result, channelIds: bulk.mock.calls.flatMap(([jobs]) => jobs.map(job => job.data.channelId)) };
  } finally { bulk.mockRestore(); single.mockRestore(); }
}

describe('delivery resolution gate — dispatcher ⇄ resolver', () => {
  runDb('org-row: an org routing rule wins for a matching severity', async () => {
    const f = await seedFixture();
    const rule = await seedRule({ orgId: f.orgId, name: 'Org criticals', conditions: { severities: ['critical'] }, channelIds: [f.orgChannel] });
    const resolved = await sys(() => resolveDelivery({ orgId: f.orgId, severity: 'critical', siteId: f.siteId }));
    expect(resolved).toMatchObject({ source: 'routing_rule', routingRuleId: rule.id, channelIds: [f.orgChannel] });
    expect((await capturedDispatch(await seedAlert(f, 'critical'))).queued).toBe(resolved.channelIds.length);
  });

  runDb('partner-row: a partner-wide rule wins when no org rule matches; monitorKinds is honoured', async () => {
    const f = await seedFixture();
    const [monitor] = await sys(() => db.insert(monitorDefinitions).values({ orgId: f.orgId, partnerId: null, name: 'Disk full', kind: 'disk', condition: { operator: 'gt', value: 90 }, severity: 'high', deliveryMode: 'inherit' }).returning());
    created.monitors.push(monitor!.id);
    const rule = await seedRule({ partnerId: f.partnerId, name: 'Disk to NOC', conditions: { monitorKinds: ['disk'] }, channelIds: [f.partnerChannel] });
    const resolved = await sys(() => resolveDelivery({ orgId: f.orgId, severity: 'high', monitorId: monitor!.id, siteId: f.siteId }));
    expect(resolved).toMatchObject({ source: 'routing_rule', routingRuleId: rule.id, channelIds: [f.partnerChannel] });
    expect((await capturedDispatch(await seedAlert(f, 'high', monitor!.id))).queued).toBe(1);
  });

  runDb('default-row: the org Everything else row shadows the partner one; both channels fan out', async () => {
    const f = await seedFixture();
    await seedRule({ partnerId: f.partnerId, name: 'Everything else', priority: 1000000, channelIds: [f.partnerChannel], isDefault: true });
    const orgDefault = await seedRule({ orgId: f.orgId, name: 'Everything else', priority: 1000000, channelIds: [f.orgChannel, f.partnerChannel], isDefault: true });
    const resolved = await sys(() => resolveDelivery({ orgId: f.orgId, severity: 'low', siteId: f.siteId }));
    expect(resolved).toMatchObject({ source: 'default_row', routingRuleId: orgDefault.id });
    expect([...resolved.channelIds].sort()).toEqual([f.orgChannel, f.partnerChannel].sort());
    expect((await capturedDispatch(await seedAlert(f, 'low'))).queued).toBe(2);
  });

  runDb('inbox-only: monitor deliveryMode none sends nothing; an emptied Everything else row sends nothing; no row at all sends nothing', async () => {
    const f = await seedFixture();
    const [policy] = await sys(() => db.insert(escalationPolicies).values({ orgId: f.orgId, partnerId: null, name: 'On-call', steps: [{ delayMinutes: 5, channelIds: [f.orgChannel] }] }).returning());
    created.policies.push(policy!.id);
    const [monitor] = await sys(() => db.insert(monitorDefinitions).values({ orgId: f.orgId, partnerId: null, name: 'Quiet', kind: 'cpu', condition: { operator: 'gt', value: 90 }, severity: 'high', deliveryMode: 'none', escalationPolicyId: policy!.id }).returning());
    created.monitors.push(monitor!.id);
    await seedRule({ partnerId: f.partnerId, name: 'Everything else', priority: 1000000, channelIds: [f.partnerChannel], isDefault: true });

    const none = await sys(() => resolveDelivery({ orgId: f.orgId, severity: 'high', monitorId: monitor!.id, siteId: f.siteId }));
    expect(none).toEqual({ skippedChannelIds: [], channelIds: [], escalationPolicyId: null, source: 'monitor_none' });
    expect((await capturedDispatch(await seedAlert(f, 'high', monitor!.id))).queued).toBe(0);

    const orgDefault = await seedRule({ orgId: f.orgId, name: 'Everything else', priority: 1000000, channelIds: [], isDefault: true });
    const emptied = await sys(() => resolveDelivery({ orgId: f.orgId, severity: 'medium', siteId: f.siteId }));
    expect(emptied).toMatchObject({ source: 'default_row', routingRuleId: orgDefault.id, channelIds: [] });
    expect((await capturedDispatch(await seedAlert(f, 'medium'))).queued).toBe(0);

    await sys(() => db.delete(notificationRoutingRules).where(inArray(notificationRoutingRules.id, created.rules)));
    created.rules.length = 0;
    const nothing = await sys(() => resolveDelivery({ orgId: f.orgId, severity: 'medium', siteId: f.siteId }));
    expect(nothing).toEqual({ skippedChannelIds: [], channelIds: [], escalationPolicyId: null, source: 'none' });
    expect((await capturedDispatch(await seedAlert(f, 'medium'))).queued).toBe(0); // the fallback used to send to BOTH channels here
  });
  runDb('ordinary org reads and system dispatch select the same eligible IDs with an explicit owner predicate', async () => {
    const f = await seedFixture();
    const foreign = await seedFixture();
    const missing = '99999999-9999-4999-8999-999999999999';
    await sys(() => db.update(notificationChannels).set({ enabled: false })
      .where(inArray(notificationChannels.id, [f.orgChannel, foreign.orgChannel])));
    await seedRule({ orgId: f.orgId, channelIds: [f.partnerChannel, f.orgChannel, foreign.orgChannel, missing] });
    const facts = { orgId: f.orgId, severity: 'high' as const, siteId: f.siteId };
    const previewDecision = await withDbAccessContext(orgCtx(f), async () => {
      const role = await db.execute(sql`select current_user as role`);
      expect(role[0]?.role).toBe('breeze_app');
      return resolveDelivery(facts);
    });
    const dispatchDecision = await withSystemDbAccessContext(() => resolveDelivery(facts));
    expect(previewDecision).toEqual(dispatchDecision);
    expect(previewDecision.channelIds).toEqual([f.partnerChannel]);
    expect(previewDecision.skippedChannelIds).toEqual([
      { id: f.orgChannel, reason: 'disabled' },
      { id: foreign.orgChannel, reason: 'unavailable' },
      { id: missing, reason: 'unavailable' },
    ]);
    const sent = await capturedDispatch(await seedAlert(f, 'high'));
    expect(sent.channelIds).toEqual(previewDecision.channelIds);
  });

  runDb('org reads inherit partner rails without acquiring any partner insert permission (42501)', async () => {
    const f = await seedFixture();
    const attempts: Array<() => Promise<unknown>> = [
      () => db.insert(notificationChannels).values({ orgId: null, partnerId: f.partnerId,
        name: 'Forbidden', type: 'slack', config: {}, enabled: true }).returning(),
      () => db.insert(notificationRoutingRules).values({ orgId: null, partnerId: f.partnerId,
        name: 'Forbidden', priority: 10, conditions: {}, channelIds: [], enabled: true }).returning(),
      () => db.insert(escalationPolicies).values({ orgId: null, partnerId: f.partnerId,
        name: 'Forbidden', steps: [] }).returning(),
    ];
    for (const attempt of attempts) {
      await expect(withDbAccessContext(orgCtx(f), attempt))
        .rejects.toMatchObject({ cause: { code: '42501' } });
    }
  });

});

// These calls intentionally execute the production raw SQL through postgres.js.
// System scope makes the membership predicates (including the foreign-partner
// exclusion) do the work, rather than letting RLS hide the negative fixtures.
describe('listEscalationUsers — real SQL membership eligibility', () => {
  runDb('partner-wide owner includes all active partner staff regardless of selected orgs', async () => {
    const f = await seedFixture();
    const otherOrg = await createOrganization({ partnerId: f.partnerId });
    const foreignPartner = await createPartner();
    await createUser({ partnerId: f.partnerId, orgId: f.orgId,
      name: 'Org member', email: 'member@delivery.example.com', withMembership: true });
    const siteLimited = await createUser({ partnerId: f.partnerId, orgId: f.orgId,
      name: 'Site limited', email: 'site@delivery.example.com', withMembership: true });
    await createUser({ partnerId: f.partnerId,
      name: 'Disabled', email: 'disabled@delivery.example.com', status: 'disabled', withMembership: true });
    const all = await createUser({ partnerId: f.partnerId,
      name: 'Partner all', email: 'all@delivery.example.com', withMembership: true });
    const included = await createUser({ partnerId: f.partnerId,
      name: 'Partner selected included', email: 'included@delivery.example.com', withMembership: true });
    const excluded = await createUser({ partnerId: f.partnerId,
      name: 'Partner selected excluded', email: 'excluded@delivery.example.com', withMembership: true });
    await createUser({ partnerId: foreignPartner.id,
      name: 'Foreign partner', email: 'foreign@delivery.example.com', withMembership: true });

    await withSystemDbAccessContext(async () => {
      await db.update(organizationUsers).set({ siteIds: [f.siteId] })
        .where(eq(organizationUsers.userId, siteLimited.id));
      await db.update(partnerUsers).set({ orgAccess: 'selected', orgIds: [f.orgId] })
        .where(eq(partnerUsers.userId, included.id));
      await db.update(partnerUsers).set({ orgAccess: 'selected', orgIds: [otherOrg.id] })
        .where(eq(partnerUsers.userId, excluded.id));
    });

    const listed = await withSystemDbAccessContext(async () => {
      const role = await db.execute(sql`select current_user as role`);
      expect(role[0]?.role).toBe('breeze_app');
      return listEscalationUsers({ orgId: null, partnerId: f.partnerId }, db);
    });
    expect(listed.map(user => user.id).sort()).toEqual([all.id, included.id, excluded.id].sort());
  });

  runDb.each([true, false])('includePartnerUsers=%s', async (includePartnerUsers) => {
    const f = await seedFixture();
    const otherOrg = await createOrganization({ partnerId: f.partnerId });
    const foreignPartner = await createPartner();
    const member = await createUser({ partnerId: f.partnerId, orgId: f.orgId,
      name: 'Org member', email: 'member@delivery.example.com', withMembership: true });
    const siteLimited = await createUser({ partnerId: f.partnerId, orgId: f.orgId,
      name: 'Site limited', email: 'site@delivery.example.com', withMembership: true });
    const disabled = await createUser({ partnerId: f.partnerId, orgId: f.orgId,
      name: 'Disabled', email: 'disabled@delivery.example.com', status: 'disabled', withMembership: true });
    const all = await createUser({ partnerId: f.partnerId,
      name: 'Partner all', email: 'all@delivery.example.com', withMembership: true });
    const included = await createUser({ partnerId: f.partnerId,
      name: 'Partner selected included', email: 'included@delivery.example.com', withMembership: true });
    const excluded = await createUser({ partnerId: f.partnerId,
      name: 'Partner selected excluded', email: 'excluded@delivery.example.com', withMembership: true });
    const foreign = await createUser({ partnerId: foreignPartner.id,
      name: 'Foreign partner', email: 'foreign@delivery.example.com', withMembership: true });

    await withSystemDbAccessContext(async () => {
      await db.update(organizationUsers).set({ siteIds: [f.siteId] })
        .where(eq(organizationUsers.userId, siteLimited.id));
      await db.update(partnerUsers).set({ orgAccess: 'selected', orgIds: [f.orgId] })
        .where(eq(partnerUsers.userId, included.id));
      await db.update(partnerUsers).set({ orgAccess: 'selected', orgIds: [otherOrg.id] })
        .where(eq(partnerUsers.userId, excluded.id));
    });

    const listed = await withSystemDbAccessContext(async () => {
      const role = await db.execute(sql`select current_user as role`);
      expect(role[0]?.role).toBe('breeze_app');
      return listEscalationUsers({ orgId: f.orgId, partnerId: null }, db, { includePartnerUsers });
    });
    const ids = listed.map(user => user.id);
    expect(ids).toContain(member.id);
    expect(ids).not.toContain(siteLimited.id);
    expect(ids).not.toContain(disabled.id);
    expect(ids).not.toContain(excluded.id);
    expect(ids).not.toContain(foreign.id);
    expect(listed).toEqual((includePartnerUsers ? [member, all, included] : [member])
      .map(({ id, name }) => ({ id, name })));
  });
});

function requestAsOrg(f: DeliveryFixture, path: string, init?: RequestInit) {
  const auth = { scope: 'organization', orgId: f.orgId, partnerId: f.partnerId,
    canAccessOrg: (id: string) => id === f.orgId, allowedSiteIds: undefined } as AuthContext;
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('auth', auth); await next(); });
  app.route('/alerts', deliveryRoutes);
  app.route('/alerts', deliveryRailsRoutes);
  app.route('/alerts', channelsRoutes);
  app.route('/alerts', routingRoutes);
  app.route('/alerts', policiesRoutes);
  return withDbAccessContext(orgCtx(f), async () => {
    const role = await db.execute(sql`select current_user as role`);
    expect(role[0]?.role).toBe('breeze_app');
    return app.request(path, init);
  });
}

function previewAs(f: DeliveryFixture, facts: ResolveDeliveryInput) {
  const query = new URLSearchParams({ orgId: facts.orgId, severity: facts.severity });
  if (facts.kind) query.set('kind', facts.kind);
  if (facts.monitorId) query.set('monitorId', facts.monitorId);
  if (facts.siteId) query.set('siteId', facts.siteId);
  return requestAsOrg(f, `/alerts/delivery/resolve?${query}`);
}

async function agree(f: DeliveryFixture, facts: ResolveDeliveryInput, expectedChannels: string[], expectedEscalationChannels: string[] = []) {
  const response = await previewAs(f, facts);
  expect(response.status).toBe(200);
  const preview = await response.json() as DeliveryPreview;
  const resolved = await sys(() => resolveDelivery(facts));
  const { display, description, ...decision } = preview;
  expect(decision).toEqual(resolved);
  expect(display.length).toBeGreaterThan(0);
  expect([...decision.channelIds].sort()).toEqual([...expectedChannels].sort());
  expect(description.channels.map(c => c.id).sort()).toEqual([...expectedChannels].sort());
  const bulk = vi.spyOn(getNotificationQueue(), 'addBulk').mockResolvedValue([]);
  const single = vi.spyOn(getNotificationQueue(), 'add').mockResolvedValue({ getState: async () => 'waiting' } as never);
  try {
    const result = await dispatch(await seedAlert(f, facts.severity as 'high', facts.monitorId ?? null));
    const queuedIds = bulk.mock.calls.flatMap(([jobs]) => jobs.map(job => job.data.channelId));
    expect(queuedIds.sort()).toEqual([...expectedChannels].sort());
    const escalationIds = single.mock.calls.map(([, job]) => job.channelId);
    expect(escalationIds.sort()).toEqual([...expectedEscalationChannels].sort());
    expect(result.queued).toBe(expectedChannels.length);
    expect(result.inAppSent).toBe(true);
  } finally { bulk.mockRestore(); single.mockRestore(); }
}

describe('full W05b gate — dispatch ⇄ resolver ⇄ GET preview', () => {
  runDb('org-row wins at equal priority and schedules the winning row escalation', async () => {
    const f = await seedFixture();
    const [policy] = await sys(() => db.insert(escalationPolicies).values({ orgId: f.orgId, name: 'On-call',
      steps: [{ delayMinutes: 5, channelIds: [f.orgChannel] }] }).returning());
    created.policies.push(policy!.id);
    await seedRule({ partnerId: f.partnerId, conditions: { severities: ['critical'] }, channelIds: [f.partnerChannel] });
    await seedRule({ orgId: f.orgId, conditions: { severities: ['critical'] }, channelIds: [f.orgChannel], escalationPolicyId: policy!.id });
    await agree(f, { orgId: f.orgId, severity: 'critical', siteId: f.siteId }, [f.orgChannel], [f.orgChannel]);
  });
  runDb('org token inherits a partner row; foreign-partner rows cannot win', async () => {
    const f = await seedFixture();
    const foreign = await createPartner();
    await seedRule({ partnerId: foreign.id, priority: 0, channelIds: [f.orgChannel] });
    await seedRule({ partnerId: f.partnerId, channelIds: [f.partnerChannel] });
    await agree(f, { orgId: f.orgId, severity: 'high', siteId: f.siteId }, [f.partnerChannel]);
  });
  runDb('org default shadows partner default, then partner default covers an org with no override', async () => {
    const f = await seedFixture();
    await seedRule({ partnerId: f.partnerId, isDefault: true, channelIds: [f.partnerChannel] });
    const override = await seedRule({ orgId: f.orgId, isDefault: true, channelIds: [f.orgChannel, f.partnerChannel] });
    await agree(f, { orgId: f.orgId, severity: 'low', siteId: f.siteId }, [f.orgChannel, f.partnerChannel]);
    const deleted = await requestAsOrg(f, `/alerts/routing-rules/${override.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    await agree(f, { orgId: f.orgId, severity: 'low', siteId: f.siteId }, [f.partnerChannel]);
  });
  runDb('removing an org default without a partner default restores inbox-only delivery', async () => {
    const f = await seedFixture();
    const override = await seedRule({ orgId: f.orgId, isDefault: true, channelIds: [f.orgChannel] });
    await agree(f, { orgId: f.orgId, severity: 'low', siteId: f.siteId }, [f.orgChannel]);
    expect((await requestAsOrg(f, `/alerts/routing-rules/${override.id}`, { method: 'DELETE' })).status).toBe(200);
    await agree(f, { orgId: f.orgId, severity: 'low', siteId: f.siteId }, []);
  });
  runDb('an empty default still schedules its independent escalation', async () => {
    const f = await seedFixture();
    const [policy] = await sys(() => db.insert(escalationPolicies).values({ orgId: f.orgId,
      name: 'Escalate without initial channels', steps: [{ delayMinutes: 5, channelIds: [f.partnerChannel] }] }).returning());
    created.policies.push(policy!.id);
    await seedRule({ orgId: f.orgId, isDefault: true, channelIds: [], escalationPolicyId: policy!.id });
    await agree(f, { orgId: f.orgId, severity: 'high', siteId: f.siteId }, [], [f.partnerChannel]);
  });
  runDb('legacy escalation overrides a conflicting row internally; browser preview cannot inject it', async () => {
    const f = await seedFixture();
    const [legacyPolicy, rowPolicy] = await sys(() => db.insert(escalationPolicies).values([
      { orgId: f.orgId, name: 'Legacy escalation', steps: [{ delayMinutes: 5, channelIds: [f.partnerChannel] }] },
      { orgId: f.orgId, name: 'Row escalation', steps: [{ delayMinutes: 5, channelIds: [f.orgChannel] }] },
    ]).returning());
    created.policies.push(legacyPolicy!.id, rowPolicy!.id);
    await seedRule({ orgId: f.orgId, channelIds: [f.orgChannel], escalationPolicyId: rowPolicy!.id });
    const [template] = await sys(() => db.insert(alertTemplates).values({ orgId: f.orgId,
      name: 'Legacy template', conditions: {}, severity: 'high', titleTemplate: 'gate', messageTemplate: 'gate' }).returning());
    created.templates.push(template!.id);
    const [rule] = await sys(() => db.insert(alertRules).values({ orgId: f.orgId, templateId: template!.id,
      name: 'Unmanaged legacy rule', targetType: 'device', targetId: f.deviceId,
      overrideSettings: { escalationPolicyId: legacyPolicy!.id } }).returning());
    created.legacyRules.push(rule!.id);
    const facts = { orgId: f.orgId, severity: 'high' as const, siteId: f.siteId };
    const internalFacts = { ...facts, legacyOverride: { escalationPolicyId: legacyPolicy!.id } };
    const resolved = await sys(() => resolveDelivery(internalFacts));
    expect(resolved).toMatchObject({ source: 'routing_rule', channelIds: [f.orgChannel], escalationPolicyId: legacyPolicy!.id });
    const internalPreview = await withDbAccessContext(orgCtx(f), () => describeDelivery(internalFacts, resolved));
    const { display, description, ...decision } = internalPreview;
    expect(decision).toEqual(resolved);
    expect(description.escalationPolicy).toEqual({ id: legacyPolicy!.id, name: 'Legacy escalation' });
    expect(display).toContain('escalates via Legacy escalation');
    const alertId = await seedAlert(f, 'high');
    await sys(() => db.update(alerts).set({ ruleId: rule!.id }).where(eq(alerts.id, alertId)));
    const bulk = vi.spyOn(getNotificationQueue(), 'addBulk').mockResolvedValue([]);
    const single = vi.spyOn(getNotificationQueue(), 'add').mockResolvedValue({ getState: async () => 'waiting' } as never);
    try {
      expect((await dispatch(alertId)).queued).toBe(1);
      expect(bulk.mock.calls.flatMap(([jobs]) => jobs.map(job => job.data.channelId))).toEqual(resolved.channelIds);
      expect(single.mock.calls.map(([, job]) => job.channelId)).toEqual([f.partnerChannel]);
    } finally { bulk.mockRestore(); single.mockRestore(); }
    // HTTP previews describe current routing; legacy source facts are internal only.
    const preview = await (await previewAs(f, facts)).json() as DeliveryPreview;
    expect(preview.escalationPolicyId).toBe(rowPolicy!.id);
    const injected = await requestAsOrg(f, `/alerts/delivery/resolve?orgId=${f.orgId}&severity=high&legacyOverride=${encodeURIComponent(JSON.stringify(internalFacts.legacyOverride))}`);
    expect(injected.status).toBe(400);
  });
  runDb('all three inbox-only paths agree and none never schedules monitor escalation', async () => {
    const f = await seedFixture();
    await agree(f, { orgId: f.orgId, severity: 'medium', siteId: f.siteId }, []);
    await seedRule({ orgId: f.orgId, isDefault: true, channelIds: [] });
    await agree(f, { orgId: f.orgId, severity: 'medium', siteId: f.siteId }, []);
    const [policy] = await sys(() => db.insert(escalationPolicies).values({ orgId: f.orgId, name: 'Suppressed escalation',
      steps: [{ delayMinutes: 5, channelIds: [f.orgChannel] }] }).returning());
    created.policies.push(policy!.id);
    const [monitor] = await sys(() => db.insert(monitorDefinitions).values({ orgId: f.orgId, name: 'Quiet preview',
      kind: 'cpu', severity: 'high', condition: { operator: 'gt', value: 90 }, deliveryMode: 'none',
      escalationPolicyId: policy!.id }).returning());
    created.monitors.push(monitor!.id);
    await seedRule({ partnerId: f.partnerId, channelIds: [f.partnerChannel] });
    await agree(f, { orgId: f.orgId, severity: 'high', siteId: f.siteId, monitorId: monitor!.id }, []);
  });
  runDb('preview and dispatch agree on disabled and unavailable references and retain escalation', async () => {
    const f = await seedFixture();
    const other = await seedFixture();
    const missing = '99999999-9999-4999-8999-999999999999';
    await sys(() => db.update(notificationChannels).set({ enabled: false }).where(eq(notificationChannels.id, f.orgChannel)));
    const [policy] = await sys(() => db.insert(escalationPolicies).values({ orgId: f.orgId, name: 'Still escalate',
      steps: [{ delayMinutes: 5, channelIds: [f.partnerChannel] }] }).returning());
    created.policies.push(policy!.id);
    await seedRule({ orgId: f.orgId, channelIds: [f.orgChannel, other.orgChannel, missing], escalationPolicyId: policy!.id });
    await agree(f, { orgId: f.orgId, severity: 'high', siteId: f.siteId }, [], [f.partnerChannel]);
    const result = await (await previewAs(f, { orgId: f.orgId, severity: 'high', siteId: f.siteId })).json();
    expect(result.skippedChannelIds).toEqual([
      { id: f.orgChannel, reason: 'disabled' }, { id: other.orgChannel, reason: 'unavailable' }, { id: missing, reason: 'unavailable' },
    ]);
  });
  runDb('foreign and absent channel IDs have identical preview reasons and HTTP shapes; rails reveal neither', async () => {
    const f = await seedFixture();
    const foreign = await seedFixture();
    const missing = '99999999-9999-4999-8999-999999999999';
    const row = await seedRule({ orgId: f.orgId, channelIds: [foreign.orgChannel] });
    const observations = [];
    for (const id of [foreign.orgChannel, missing]) {
      await sys(() => db.update(notificationRoutingRules).set({ channelIds: [id] })
        .where(eq(notificationRoutingRules.id, row.id)));
      const response = await previewAs(f, { orgId: f.orgId, severity: 'high', siteId: f.siteId });
      const body = await response.json() as DeliveryPreview;
      expect(body.skippedChannelIds).toEqual([{ id, reason: 'unavailable' }]);
      // Only the caller's echoed reference differs; no name, owner or existence bit is returned.
      const normalized = { ...body, skippedChannelIds: body.skippedChannelIds.map(item => ({ ...item, id: '<requested>' })) };
      const railsResponse = await requestAsOrg(f, '/alerts/delivery/rails?rail=channels');
      const rails = await railsResponse.json();
      expect([...rails.data, ...rails.inherited].filter((channel: { id: string }) => channel.id === id)).toEqual([]);
      observations.push({ previewStatus: response.status, preview: normalized,
        railsStatus: railsResponse.status, rails });
    }
    expect(observations[0]).toEqual(observations[1]);
    expect(observations[0]?.previewStatus).toBe(200);
    expect(observations[0]?.railsStatus).toBe(200);
    // The existing rails API lists visible choices; it has no ID lookup or skip-reason field.
    // Both references are absent from the same safe list; preview carries the identical reason.
  });

  runDb('org HTTP reads inherit only the safe partner channel DTO, with no config key', async () => {
    const f = await seedFixture();
    const response = await requestAsOrg(f, '/alerts/delivery/rails?rail=channels');
    expect(response.status).toBe(200);
    const rails = await response.json();
    expect(rails.inherited).toEqual([{ id: f.partnerChannel, name: 'Partner NOC',
      type: 'slack', enabled: true, inherited: true }]);
    expect(rails.inherited[0]).not.toHaveProperty('config');
  });

  runDb('org HTTP writes cannot create partner channels, routing rows or escalation policies (403)', async () => {
    const f = await seedFixture();
    const attempts = [
      { path: '/alerts/channels', body: { name: 'Forbidden', type: 'slack', config: {}, ownerScope: 'partner' } },
      { path: '/alerts/routing-rules', body: { name: 'Forbidden', conditions: {}, channelIds: [f.partnerChannel], ownerScope: 'partner' } },
      { path: '/alerts/policies', body: { name: 'Forbidden', steps: [{ delayMinutes: 5, channelIds: [f.partnerChannel] }], ownerScope: 'partner' } },
    ];
    for (const { path, body } of attempts) {
      const response = await requestAsOrg(f, path, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(403);
    }
  });

  runDb('rejects an otherwise readable monitor from a sibling org', async () => {
    const f = await seedFixture();
    const other = await createOrganization({ partnerId: f.partnerId });
    const [monitor] = await sys(() => db.insert(monitorDefinitions).values({ orgId: other.id, name: 'Foreign',
      kind: 'cpu', severity: 'high', condition: {}, deliveryMode: 'channels', deliveryChannelIds: [f.orgChannel] }).returning());
    created.monitors.push(monitor!.id);
    const response = await previewAs(f, { orgId: f.orgId, severity: 'high', monitorId: monitor!.id });
    expect(response.status).toBe(404);
    expect((await previewAs(f, { orgId: other.id, severity: 'high' })).status).toBe(403);
  });
});
