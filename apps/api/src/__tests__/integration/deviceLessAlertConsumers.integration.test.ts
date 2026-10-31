import './setup';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  alerts, alertNotifications, automations, automationRuns, aiAgentRuns, devices,
  notificationChannels, notificationChannelConfigs, organizationUsers, partnerServicePrincipals,
} from '../../db/schema';
import { alertRoutes } from '../../routes/alerts';
import { partnerAlertRoutes } from '../../routes/partnerApi/alerts';
import { partnerAlertFeedEnvelopeSchema } from '../../routes/partnerApi/schemas';
import { partnerApiAuthMiddleware } from '../../middleware/partnerApiAuth';
import { createSourcedAlert } from '../../services/alertService';
import { processSendNotification } from '../../services/notificationDispatcher';
import { __testOnly as automationWorker } from '../../jobs/automationWorker';
import { enqueueVerdictRunForAlert } from '../../services/aiAgents/alertVerdictSubscriber';
import { enqueueAlertCorrelation } from '../../jobs/alertCorrelation';
import { deleteDeviceCascade } from '../../services/deviceDeletion';
import { issuePartnerServicePrincipalKey } from '../../services/partnerServicePrincipalKeys';
import { buildAlertWebhookProjections } from '../../services/webhookPayload/alertEnrichment';
import { clearPermissionCache } from '../../services/permissions';
import type { BreezeEvent } from '../../services/eventBus';
import { createIntegrationTestClient, userEpochs } from './db-utils';
import { getTestDb } from './setup';

// Keep all consumer reads, writes, auth and RLS real. Only outbound delivery,
// event fan-out and AI queue admission are observed at their side-effect boundary.
const { publish, sendWebhook, admitVerdict, recordSkip } = vi.hoisted(() => ({
  publish: vi.fn<typeof import('../../services/eventBus').publishEvent>().mockResolvedValue('event-id'),
  sendWebhook: vi.fn().mockResolvedValue({ success: true }),
  admitVerdict: vi.fn(),
  recordSkip: vi.fn(),
}));
vi.mock('../../services/eventBus', async (original) => ({
  ...await original<typeof import('../../services/eventBus')>(), publishEvent: publish,
}));
vi.mock('../../services/notificationSenders', async (original) => ({
  ...await original<typeof import('../../services/notificationSenders')>(), sendWebhookNotification: sendWebhook,
}));
vi.mock('../../services/aiAgents/runService', async (original) => ({
  ...await original<typeof import('../../services/aiAgents/runService')>(), createAndEnqueueAgentRun: admitVerdict,
}));
vi.mock('../../services/aiAgents/skipVisibility', async (original) => ({
  ...await original<typeof import('../../services/aiAgents/skipVisibility')>(), recordAgentRunSkip: recordSkip,
}));
vi.mock('../../config/env', async (original) => ({
  ...await original<typeof import('../../config/env')>(), AI_AGENTS_ENABLED: true,
  PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
}));

describe('one device-less alert through the consumer contract (real Postgres)', () => {
  it('preserves visibility, delivery and identity while refusing every device-only consumer', async () => {
    const client = await createIntegrationTestClient(new Hono().route('/alerts', alertRoutes), {
      scope: 'organization', rolePermissions: [{ resource: 'alerts', action: 'read' }],
    });
    const { organization: org, site, partner, user } = client.env;
    const admin = getTestDb();
    const [unrelatedDevice] = await admin.insert(devices).values({
      orgId: org.id, siteId: site.id, agentId: randomUUID(), hostname: 'Unrelated endpoint',
      osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1',
    }).returning();
    if (!unrelatedDevice) throw new Error('Device fixture missing');
    const alertId = await withDbAccessContext({
      scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id], accessiblePartnerIds: [], userId: user.id,
    }, () => createSourcedAlert({
      orgId: org.id, deviceId: null, owner: { kind: 'backup_workload', ref: randomUUID() },
      severity: 'high', title: 'Workload backup failed', message: 'Backup failed',
      context: { source: 'backup_provider' }, publisher: 'device-less-consumer-contract',
    }));
    if (!alertId) throw new Error('Sourced alert was not created');
    const [stored] = await admin.select().from(alerts).where(eq(alerts.id, alertId));
    if (!stored) throw new Error('Stored alert missing');
    expect(stored).toMatchObject({ deviceId: null, ownerKind: 'backup_workload', orgId: org.id });
    const published = publish.mock.calls.find(([type]) => type === 'alert.triggered');
    if (!published) throw new Error('Alert event missing');
    const event: BreezeEvent = {
      id: randomUUID(), type: 'alert.triggered', orgId: org.id, source: 'device-less-consumer-contract',
      priority: 'normal', payload: z.record(z.string(), z.unknown()).parse(published[2]), metadata: { timestamp: new Date().toISOString() },
    };

    // Same real JWT and role, first unrestricted, then one-site and empty allowlists.
    const list = await client.get('/alerts');
    expect(list.status).toBe(200);
    expect((await list.json()).data).toEqual([expect.objectContaining({ id: alertId, deviceId: null })]);
    const detail = await client.get(`/alerts/${alertId}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ id: alertId, deviceId: null, device: null });
    for (const siteIds of [[site.id], []]) {
      await admin.update(organizationUsers).set({ siteIds }).where(eq(organizationUsers.userId, user.id));
      await clearPermissionCache(user.id);
      expect((await (await client.get('/alerts')).json()).data).toEqual([]);
      expect((await client.get(`/alerts/${alertId}`)).status).toBe(404);
    }
    await admin.update(organizationUsers).set({ siteIds: null }).where(eq(organizationUsers.userId, user.id));
    await clearPermissionCache(user.id);

    const [channel] = await admin.insert(notificationChannels).values({
      orgId: org.id, name: 'Consumer contract webhook', type: 'webhook', enabled: true,
    }).returning();
    if (!channel) throw new Error('Channel fixture missing');
    await admin.insert(notificationChannelConfigs).values({ channelId: channel.id, config: { url: 'https://example.test/hook' } });
    expect(await processSendNotification({ type: 'send', alertId, channelId: channel.id }))
      .toMatchObject({ success: true, channelType: 'webhook' });
    expect(sendWebhook).toHaveBeenCalledTimes(1);
    expect(sendWebhook).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ alertId, deviceId: null, orgId: org.id }));
    expect(await admin.select({ status: alertNotifications.status }).from(alertNotifications).where(eq(alertNotifications.alertId, alertId)))
      .toEqual([{ status: 'sent' }]);

    // Task 3's accepted W1 decision is a whole-automation skip for alert events.
    for (const owner of [{ orgId: org.id, partnerId: null }, { orgId: null, partnerId: partner.id }]) {
      const [automation] = await admin.insert(automations).values({
        ...owner, name: 'Workload must never fan out', trigger: { type: 'event', eventType: 'alert.triggered' },
        conditions: {}, actions: [{ type: 'reboot', config: {} }],
      }).returning();
      if (!automation) throw new Error('Automation fixture missing');
      expect(await automationWorker.processTriggerEvent({
        type: 'trigger-event', automationId: automation.id, eventId: event.id,
        eventType: event.type, eventTimestamp: event.metadata.timestamp, eventPayload: event.payload,
      })).toEqual({ skipped: 'alert_has_no_device' });
    }
    expect(await admin.select().from(automationRuns)).toEqual([]);

    await enqueueVerdictRunForAlert(org.id, alertId, 'ungrouped');
    expect(recordSkip).toHaveBeenCalledWith(expect.objectContaining({ orgId: org.id, alertId, reason: 'alert_has_no_device' }));
    expect(admitVerdict).not.toHaveBeenCalled();
    expect(await admin.select().from(aiAgentRuns)).toEqual([]);
    const log = vi.spyOn(console, 'info');
    expect(await enqueueAlertCorrelation({ orgId: org.id, deviceId: stored.deviceId })).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reason: 'alert_has_no_device' }));

    await withSystemDbAccessContext(() => db.transaction((tx) => deleteDeviceCascade(tx, unrelatedDevice.id)));
    expect(await admin.select().from(devices).where(eq(devices.id, unrelatedDevice.id))).toEqual([]);
    expect(await admin.select().from(alerts).where(eq(alerts.id, alertId))).toEqual([stored]);
    expect(await admin.select({ status: alertNotifications.status }).from(alertNotifications).where(eq(alertNotifications.alertId, alertId)))
      .toEqual([{ status: 'sent' }]);

    const [principal] = await admin.insert(partnerServicePrincipals).values({
      partnerId: partner.id, name: 'Consumer contract feed', scopes: ['alerts:read'], sourceCidrs: [],
      createdBy: user.id, updatedBy: user.id,
    }).returning();
    if (!principal) throw new Error('Principal fixture missing');
    const epochs = await userEpochs(user.id);
    const { rawKey } = await withSystemDbAccessContext(() => issuePartnerServicePrincipalKey(db, {
      partnerServicePrincipalId: principal.id, partnerId: partner.id, name: 'Consumer contract key',
      actorId: user.id, actorSessionEpochs: epochs,
    }));
    const feed = new Hono().use('*', partnerApiAuthMiddleware).route('/', partnerAlertRoutes);
    const response = await feed.request('/alerts', { headers: { 'X-API-Key': rawKey } });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(partnerAlertFeedEnvelopeSchema.parse(await response.json()).data)
      .toEqual([expect.objectContaining({ id: alertId, deviceId: null, deviceHostname: null })]);
    const projections = await buildAlertWebhookProjections(event);
    for (const projection of [projections.org, projections.partner]) {
      expect(projection).toMatchObject({
        alertId, deviceId: null, deviceHostname: null, siteId: null, orgName: org.name, enrichmentIncomplete: false,
      });
    }
    expect(await admin.select({ id: alerts.id }).from(alerts)).toEqual([{ id: alertId }]);
  });
});
