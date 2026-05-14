import { db } from '../db';
import { mobileDevices } from '../db/schema/mobile';
import { and, eq } from 'drizzle-orm';
import { captureException } from './sentry';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const MAX_LABEL_LEN = 60;

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
  const tickets = json.data;
  await handleTicketErrors(messages, tickets);
  return tickets;
}

// Codes that mean "this push token will never deliver again." Per Expo
// docs these are all terminal: the token is bad, the cert/credentials
// are wrong, or the device unregistered. In all cases we clear the
// token row so subsequent pushes don't keep hitting the same dead end.
const TERMINAL_TOKEN_ERROR_CODES = new Set([
  'DeviceNotRegistered',
  'InvalidCredentials',
  'MismatchSenderId',
]);

// Codes that signal a config bug — not user-recoverable but worth paging
// ops because every approval push will silently fail until the cert/key
// is rotated.
const ALARMABLE_ERROR_CODES = new Set([
  'InvalidCredentials',
  'MismatchSenderId',
  'MessageTooBig',
]);

async function handleTicketErrors(
  messages: ExpoPushMessage[],
  tickets: ExpoPushTicket[]
): Promise<void> {
  const deadTokens: string[] = [];
  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i];
    if (!ticket || ticket.status !== 'error') continue;
    const token = messages[i]?.to;
    const code =
      typeof ticket.details === 'object' && ticket.details
        ? (ticket.details as { error?: string }).error
        : undefined;
    console.error('[expoPush] ticket error', {
      token,
      message: ticket.message,
      code,
    });
    if (ALARMABLE_ERROR_CODES.has(code ?? '')) {
      captureException(
        new Error(`Expo push terminal error: ${code ?? 'unknown'} — ${ticket.message ?? ''}`),
      );
    }
    if (code && TERMINAL_TOKEN_ERROR_CODES.has(code) && token) {
      deadTokens.push(token);
    }
  }
  if (deadTokens.length === 0) return;
  // Clear each token in its own try block so one DB failure doesn't
  // abandon the rest.
  for (const token of deadTokens) {
    try {
      await db
        .update(mobileDevices)
        .set({ apnsToken: null })
        .where(eq(mobileDevices.apnsToken, token));
      await db
        .update(mobileDevices)
        .set({ fcmToken: null })
        .where(eq(mobileDevices.fcmToken, token));
    } catch (err) {
      captureException(err);
      console.error('[expoPush] failed to clear dead token', { token, err });
    }
  }
}

// Single SELECT merging fcm + apns columns; filters non-Expo, inactive,
// and lifecycle-blocked rows. A blocked device must never receive a push
// even if its tokens hadn't been cleared by the block handler — defense
// in depth in case a token was cached and reattached afterwards.
export async function getUserPushTokens(userId: string): Promise<string[]> {
  const rows = await db
    .select({
      fcm: mobileDevices.fcmToken,
      apns: mobileDevices.apnsToken,
    })
    .from(mobileDevices)
    .where(
      and(
        eq(mobileDevices.userId, userId),
        eq(mobileDevices.notificationsEnabled, true),
        eq(mobileDevices.status, 'active')
      )
    );
  return rows
    .flatMap((r) => [r.fcm, r.apns])
    .filter((t): t is string => !!t && t.startsWith('ExponentPushToken'));
}

// Lock-screen-safe: action verb + client label only. Args require unlock.
export function buildApprovalPush(args: {
  approvalId: string;
  actionLabel: string;
  requestingClientLabel: string;
}): Pick<ExpoPushMessage, 'title' | 'body' | 'data' | 'sound' | 'priority' | 'channelId' | 'ttl'> {
  const client = args.requestingClientLabel.slice(0, MAX_LABEL_LEN);
  const action = args.actionLabel.slice(0, MAX_LABEL_LEN);
  return {
    title: 'Approval requested',
    body: `${client}: ${action}`,
    data: { type: 'approval', approvalId: args.approvalId },
    sound: 'default',
    priority: 'high',
    channelId: 'approvals',
    ttl: 60,
  };
}
