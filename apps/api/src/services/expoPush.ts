import { db } from '../db';
import { mobileDevices } from '../db/schema/mobile';
import { and, eq } from 'drizzle-orm';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
  priority?: 'default' | 'normal' | 'high';
  channelId?: string;
  ttl?: number;
}

export interface ExpoPushTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export async function sendExpoPush(
  messages: ExpoPushMessage[]
): Promise<ExpoPushTicket[]> {
  if (messages.length === 0) return [];
  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate',
    },
    body: JSON.stringify(messages),
  });
  if (!res.ok) {
    throw new Error(`Expo push failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { data: ExpoPushTicket[] };
  return json.data;
}

// Fetch every active push token registered to a user (across both columns).
export async function getUserPushTokens(userId: string): Promise<string[]> {
  const rows = await db
    .select({
      fcm: mobileDevices.fcmToken,
      apns: mobileDevices.apnsToken,
    })
    .from(mobileDevices)
    .where(and(eq(mobileDevices.userId, userId), eq(mobileDevices.notificationsEnabled, true)));
  return rows
    .flatMap((r) => [r.fcm, r.apns])
    .filter((t): t is string => !!t && t.startsWith('ExponentPushToken'));
}

// Build the lock-screen payload for an approval. Per the design brief:
// only the action verb + client label, never arguments. Full details
// require unlock.
export function buildApprovalPush(args: {
  approvalId: string;
  actionLabel: string;
  requestingClientLabel: string;
}): Pick<ExpoPushMessage, 'title' | 'body' | 'data' | 'sound' | 'priority' | 'channelId' | 'ttl'> {
  return {
    title: 'Approval requested',
    body: `${args.requestingClientLabel}: ${args.actionLabel}`,
    data: { type: 'approval', approvalId: args.approvalId },
    sound: 'default',
    priority: 'high',
    channelId: 'approvals',
    ttl: 60,
  };
}
