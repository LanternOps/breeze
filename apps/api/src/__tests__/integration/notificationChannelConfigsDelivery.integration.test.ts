/**
 * Delivery to an INHERITED partner-wide channel after #6379.
 *
 * notification_channel_configs hides a partner-wide channel's config from org
 * sessions. The dispatcher must still deliver an org's alert through its MSP's
 * shared channel: the send path runs under system scope, resolves the channel
 * via railOwnershipCondition (org's own OR its partner's partner-wide channel),
 * and LEFT JOINs the config row. This drives the real processSendNotification
 * against real Postgres; only the outbound HTTP (safeFetch) is synthetic, so
 * the destination it reaches can only have come from the config row.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import { alertNotifications, alerts, devices, notificationChannels } from '../../db/schema';
import { writeNotificationChannelConfig } from '../../services/notificationChannelConfig';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const { calls } = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../services/urlSafety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/urlSafety')>();
  return {
    ...actual,
    safeFetch: vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.hostname !== 'example.com') throw new Error('Unexpected synthetic destination');
      calls.push(parsed.pathname);
      return new Response('ok', { status: 200 });
    }),
  };
});

import { processSendNotification, shutdownNotificationDispatcher } from '../../services/notificationDispatcher';
import { closeRedis } from '../../services/redis';

afterAll(async () => {
  await shutdownNotificationDispatcher();
  await closeRedis();
});

async function seedAlert() {
  const db = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const [device] = await db.insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: randomUUID(), hostname: 'inherited-channel-host',
    osType: 'linux', osVersion: 'synthetic', architecture: 'x64', agentVersion: '1.0.0',
  }).returning();
  const [alert] = await db.insert(alerts).values({
    orgId: org.id, deviceId: device!.id, severity: 'high', title: 'Inherited channel delivery',
  }).returning();
  return { partner, org, alert: alert! };
}

describe('dispatcher delivery through an inherited partner-wide channel (#6379)', () => {
  it('sends to the destination stored in notification_channel_configs for a partner-wide channel', async () => {
    const { partner, alert } = await seedAlert();
    // The org owns NO channel; the only candidate is its MSP's partner-wide one.
    const [channel] = await getTestDb().insert(notificationChannels).values({
      orgId: null, partnerId: partner.id, name: 'msp-shared-webhook', type: 'webhook',
    }).returning();
    await withSystemDbAccessContext(() =>
      writeNotificationChannelConfig(channel!.id, { url: 'https://example.com/partner-wide-destination' }));

    calls.length = 0;
    const result = await processSendNotification({ type: 'send', alertId: alert.id, channelId: channel!.id });

    expect(result).toMatchObject({ success: true, channelType: 'webhook' });
    expect(calls).toEqual(['/partner-wide-destination']);
    const [row] = await getTestDb().select({ status: alertNotifications.status })
      .from(alertNotifications).where(eq(alertNotifications.alertId, alert.id));
    expect(row?.status).toBe('sent');
  });

  it('refuses a partner-wide channel whose config row is missing instead of sending to an empty destination', async () => {
    const { partner, alert } = await seedAlert();
    const [channel] = await getTestDb().insert(notificationChannels).values({
      orgId: null, partnerId: partner.id, name: 'msp-no-config', type: 'webhook',
    }).returning();

    calls.length = 0;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await processSendNotification({ type: 'send', alertId: alert.id, channelId: channel!.id });
      expect(result).toMatchObject({ success: false, error: 'Notification channel has no stored configuration' });
    } finally {
      errorSpy.mockRestore();
    }
    expect(calls).toEqual([]);
  });
});
