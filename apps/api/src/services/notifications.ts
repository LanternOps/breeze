import { createHash } from 'crypto';
import { db } from '../db';
import { alerts, mobileDevices, organizationUsers, pushNotifications, users } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { getEventBus } from './eventBus';
import { isApnsConfigured, sendApnsNotification } from './apns';
import { isFcmConfigured, sendFcmNotification } from './fcm';
// Moved to its own module in W07 (#3901) so non-Firebase callers can use it.
// Re-exported here so every existing importer keeps working.
import { isInQuietHours, type QuietHoursConfig } from './quietHours';

export { isInQuietHours, type QuietHoursConfig };

export interface PushPayload {
  title: string;
  body: string;
  data: Record<string, string>;
  alertId: string | null;
  eventType: string;
}

type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
type MobileDevice = typeof mobileDevices.$inferSelect;

interface PushSendResult {
  messageId: string;
  status: 'sent' | 'stubbed';
}

export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  const devices = await db
    .select()
    .from(mobileDevices)
    .where(and(eq(mobileDevices.userId, userId), eq(mobileDevices.notificationsEnabled, true)));

  const severity = payload.data?.severity as AlertSeverity | undefined;

  for (const device of devices) {
    if (device.quietHours && isInQuietHours(device.quietHours as QuietHoursConfig)) {
      continue;
    }

    if (device.alertSeverities.length > 0) {
      if (!severity || !device.alertSeverities.includes(severity)) {
        continue;
      }
    }

    await sendPushToDevice(device, payload);
  }
}

export async function sendPushToDevice(device: MobileDevice, payload: PushPayload): Promise<void> {
  const [record] = await db
    .insert(pushNotifications)
    .values({
      mobileDeviceId: device.id,
      userId: device.userId,
      title: payload.title,
      body: payload.body,
      data: payload.data,
      platform: device.platform,
      status: 'pending',
      alertId: payload.alertId,
      eventType: payload.eventType
    })
    .returning();

  const notificationId = record?.id;
  if (!notificationId) {
    throw new Error('Failed to record push notification');
  }

  try {
    let result: PushSendResult;

    if (device.platform === 'android') {
      if (!device.fcmToken) {
        throw new Error('Missing FCM token');
      }
      result = await sendFCM(device.fcmToken, payload);
    } else {
      if (!device.apnsToken) {
        throw new Error('Missing APNS token');
      }
      result = await sendAPNS(device.apnsToken, payload);
    }

    await db
      .update(pushNotifications)
      .set({
        status: result.status,
        messageId: result.messageId,
        sentAt: new Date()
      })
      .where(eq(pushNotifications.id, notificationId));
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown push notification error';
    await db
      .update(pushNotifications)
      .set({
        status: 'failed',
        errorMessage
      })
      .where(eq(pushNotifications.id, notificationId));
  }
}

export async function sendFCM(token: string, payload: PushPayload): Promise<PushSendResult> {
  // No credentials configured → keep the historical no-op stub so alert pushes
  // degrade gracefully in dev/self-hosted deployments without Firebase set up.
  // Mirrors sendAPNS's isApnsConfigured() check above.
  if (!isFcmConfigured()) {
    const tokenFingerprint = createHash('sha256').update(token).digest('hex').slice(0, 12);
    console.warn('[Notifications] FCM not configured; push stubbed.', {
      tokenFingerprint,
      title: payload.title,
    });
    return { messageId: `fcm-stub-${Date.now()}`, status: 'stubbed' };
  }

  const data: Record<string, unknown> = { ...payload.data };
  if (payload.alertId) data.alertId = payload.alertId;
  if (payload.eventType) data.eventType = payload.eventType;

  const res = await sendFcmNotification(token, { title: payload.title, body: payload.body, data });
  if (res.ok) {
    return { messageId: res.messageId ?? `fcm-${Date.now()}`, status: 'sent' };
  }

  // Dead token: purge it so we stop targeting it, then surface the failure —
  // mirrors sendAPNS's unregistered-token handling below.
  if (res.unregistered) {
    try {
      await db.update(mobileDevices).set({ fcmToken: null }).where(eq(mobileDevices.fcmToken, token));
    } catch (err) {
      console.error('[Notifications] failed to purge unregistered FCM token', err);
    }
  }

  throw new Error(`FCM delivery failed${res.reason ? ` (${res.reason})` : ''}`);
}

export async function sendAPNS(token: string, payload: PushPayload): Promise<PushSendResult> {
  // No credentials configured → keep the historical no-op stub so alert pushes
  // degrade gracefully in dev/self-hosted deployments without APNs keys.
  if (!isApnsConfigured()) {
    const tokenFingerprint = createHash('sha256').update(token).digest('hex').slice(0, 12);
    console.warn('[Notifications] APNS not configured; push stubbed.', {
      tokenFingerprint,
      title: payload.title,
    });
    return { messageId: `apns-stub-${Date.now()}`, status: 'stubbed' };
  }

  // Mirror sendFCM: fold alertId/eventType into the data payload so the mobile
  // app can deep-link. The native sender never throws — translate a delivery
  // failure into a thrown error so sendPushToDevice records status 'failed',
  // exactly as an FCM send rejection would.
  const data: Record<string, unknown> = { ...payload.data };
  if (payload.alertId) data.alertId = payload.alertId;
  if (payload.eventType) data.eventType = payload.eventType;

  const res = await sendApnsNotification(token, {
    title: payload.title,
    body: payload.body,
    data,
  });

  if (res.ok) {
    return { messageId: `apns-${Date.now()}`, status: 'sent' };
  }

  // Dead token: purge it so we stop targeting it, then surface the failure.
  if (res.unregistered) {
    try {
      await db.update(mobileDevices).set({ apnsToken: null }).where(eq(mobileDevices.apnsToken, token));
    } catch (err) {
      console.error('[Notifications] failed to purge unregistered APNS token', err);
    }
  }

  throw new Error(`APNS delivery failed (status ${res.status}${res.reason ? `, ${res.reason}` : ''})`);
}


export function subscribeToAlertEvents(): () => void {
  const bus = getEventBus();

  return bus.subscribe('alert.triggered', async event => {
    const eventPayload = event.payload as {
      alertId?: string;
      severity?: AlertSeverity;
      title?: string;
      message?: string;
      data?: Record<string, string>;
    };

    const alertId = eventPayload.alertId;
    if (!alertId) {
      console.warn('[Notifications] alert.triggered missing alertId');
      return;
    }

    const [alert] = await db
      .select({
        id: alerts.id,
        title: alerts.title,
        message: alerts.message,
        severity: alerts.severity
      })
      .from(alerts)
      .where(eq(alerts.id, alertId))
      .limit(1);

    const severity = eventPayload.severity || alert?.severity;
    const payload: PushPayload = {
      title: eventPayload.title || alert?.title || 'Alert Triggered',
      body: eventPayload.message || alert?.message || 'An alert was triggered.',
      data: {
        ...(eventPayload.data || {}),
        alertId,
        severity: severity || 'info'
      },
      alertId,
      eventType: event.type
    };

    const targetUsers = await getUsersForAlert(event.orgId, severity);
    await Promise.all(
      targetUsers.map(userId => sendPushToUser(userId, payload))
    );
  });
}

export async function getUsersForAlert(orgId: string, severity?: AlertSeverity): Promise<string[]> {
  const rows = await db
    .select({ userId: organizationUsers.userId })
    .from(organizationUsers)
    .innerJoin(users, eq(organizationUsers.userId, users.id))
    .where(and(eq(organizationUsers.orgId, orgId), eq(users.status, 'active')));

  if (!severity) {
    return rows.map(row => row.userId);
  }

  return rows.map(row => row.userId);
}


