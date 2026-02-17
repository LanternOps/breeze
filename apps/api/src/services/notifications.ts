import admin from 'firebase-admin';
import { db } from '../db';
import { alerts, mobileDevices, organizationUsers, pushNotifications, users } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { getEventBus } from './eventBus';

export interface PushPayload {
  title: string;
  body: string;
  data: Record<string, string>;
  alertId: string | null;
  eventType: string;
}

export interface QuietHoursConfig {
  start: string;
  end: string;
  timezone?: string;
  enabled?: boolean;
}

type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
type MobileDevice = typeof mobileDevices.$inferSelect;

interface PushSendResult {
  messageId: string;
  status: 'sent' | 'stubbed';
}

let firebaseApp: admin.app.App | null = null;

export function initFirebase(): admin.app.App {
  if (firebaseApp) {
    return firebaseApp;
  }

  const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!rawServiceAccount) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  }

  let serviceAccount: admin.ServiceAccount;
  try {
    const parsed = JSON.parse(rawServiceAccount) as { privateKey?: string; private_key?: string };
    if (parsed.private_key && !parsed.privateKey) {
      parsed.privateKey = parsed.private_key;
    }
    serviceAccount = parsed as admin.ServiceAccount;
  } catch (err) {
    const decoded = Buffer.from(rawServiceAccount, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as { privateKey?: string; private_key?: string };
    if (parsed.private_key && !parsed.privateKey) {
      parsed.privateKey = parsed.private_key;
    }
    serviceAccount = parsed as admin.ServiceAccount;
  }

  if (typeof serviceAccount.privateKey === 'string') {
    serviceAccount.privateKey = serviceAccount.privateKey.replace(/\\n/g, '\n');
  }

  firebaseApp = admin.apps.length
    ? admin.app()
    : admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });

  return firebaseApp;
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
  initFirebase();

  const data: Record<string, string> = {
    ...payload.data
  };

  if (payload.alertId) {
    data.alertId = payload.alertId;
  }
  if (payload.eventType) {
    data.eventType = payload.eventType;
  }

  const messageId = await admin.messaging().send({
    token,
    notification: {
      title: payload.title,
      body: payload.body
    },
    data
  });

  return { messageId, status: 'sent' };
}

export async function sendAPNS(token: string, payload: PushPayload): Promise<PushSendResult> {
  console.warn('[Notifications] APNS sending is not implemented yet.', { token, title: payload.title });
  return { messageId: `apns-stub-${Date.now()}`, status: 'stubbed' };
}

export function isInQuietHours(quietHours?: QuietHoursConfig | null): boolean {
  if (!quietHours || quietHours.enabled === false) {
    return false;
  }

  const startMinutes = parseMinutes(quietHours.start);
  const endMinutes = parseMinutes(quietHours.end);

  if (startMinutes === null || endMinutes === null) {
    return false;
  }

  const nowMinutes = getMinutesInTimezone(new Date(), quietHours.timezone);

  if (startMinutes === endMinutes) {
    return true;
  }

  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }

  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
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

function parseMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return null;
  }

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes;
}

function getMinutesInTimezone(date: Date, timezone?: string): number {
  if (!timezone) {
    return date.getHours() * 60 + date.getMinutes();
  }

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit'
    }).formatToParts(date);

    const hour = Number(parts.find(part => part.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find(part => part.type === 'minute')?.value ?? '0');

    return hour * 60 + minute;
  } catch (err) {
    return date.getHours() * 60 + date.getMinutes();
  }
}
