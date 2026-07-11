import { db } from '../db';
import { mobileDevices } from '../db/schema/mobile';
import { and, eq } from 'drizzle-orm';
import { sendApnsNotification } from './apns';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const MAX_LABEL_LEN = 60;
// Approval pushes are time-critical: a stale prompt is worthless once the
// requester has moved on, so we cap the store-and-forward window at 60s across
// every provider (Expo ttl + APNs apns-expiration).
const APPROVAL_PUSH_TTL_SECONDS = 60;

/**
 * Expo push tokens are bearer-like device addresses: anyone holding one can
 * POST unsolicited notifications to that device via the unauthenticated Expo
 * push API. Never log them in full. We keep only a short trailing suffix so a
 * leaked log line still allows correlation with the DB row but is not a usable
 * push address on its own. SR-004.
 */
export function redactPushToken(token: string | undefined): string {
  if (!token) return '<none>';
  if (token.length <= 4) return '****';
  return `…${token.slice(-4)}`;
}

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
      token: redactPushToken(token),
      message: ticket.message,
      code,
    });
    if (code === 'DeviceNotRegistered' && token) {
      deadTokens.push(token);
    }
  }
  if (deadTokens.length === 0) return;
  try {
    for (const token of deadTokens) {
      await db
        .update(mobileDevices)
        .set({ apnsToken: null })
        .where(eq(mobileDevices.apnsToken, token));
      await db
        .update(mobileDevices)
        .set({ fcmToken: null })
        .where(eq(mobileDevices.fcmToken, token));
    }
  } catch (err) {
    console.error('[expoPush] failed to clear dead tokens', err);
  }
}

/** The delivery channel a push token must be routed through. */
export type PushProvider = 'expo' | 'apns' | 'fcm';

/**
 * A push token tagged with the platform + delivery provider it belongs to.
 * We have no `provider` column, so we infer it: an `ExponentPushToken[...]`
 * prefix means the device is still on the Expo relay; otherwise a raw token in
 * an ios row is a native APNs device token, and in an android row a native FCM
 * token. This lets the dispatcher fan a single approval out across all three.
 */
export interface TaggedPushToken {
  token: string;
  platform: 'ios' | 'android';
  provider: PushProvider;
}

function inferProvider(token: string, platform: 'ios' | 'android'): PushProvider {
  if (token.startsWith('ExponentPushToken')) return 'expo';
  return platform === 'ios' ? 'apns' : 'fcm';
}

// Single SELECT merging fcm + apns columns; filters inactive and
// lifecycle-blocked rows. A blocked device must never receive a push even if
// its tokens hadn't been cleared by the block handler — defense in depth in
// case a token was cached and reattached afterwards. Unlike the previous
// implementation, native (non-Expo) tokens are NO LONGER dropped: each token
// is tagged with its provider so the dispatcher can route it correctly.
export async function getUserPushTokens(userId: string): Promise<TaggedPushToken[]> {
  const rows = await db
    .select({
      fcm: mobileDevices.fcmToken,
      apns: mobileDevices.apnsToken,
      platform: mobileDevices.platform,
    })
    .from(mobileDevices)
    .where(
      and(
        eq(mobileDevices.userId, userId),
        eq(mobileDevices.notificationsEnabled, true),
        eq(mobileDevices.status, 'active')
      )
    );

  const tagged: TaggedPushToken[] = [];
  for (const row of rows) {
    for (const token of [row.fcm, row.apns]) {
      if (!token) continue;
      tagged.push({ token, platform: row.platform, provider: inferProvider(token, row.platform) });
    }
  }
  return tagged;
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
    ttl: APPROVAL_PUSH_TTL_SECONDS,
  };
}

export interface DispatchApprovalPushArgs {
  approvalId: string;
  actionLabel: string;
  requestingClientLabel: string;
}

export interface DispatchApprovalPushResult {
  /** Total tokens the user has registered (all providers). */
  tokensFound: number;
  /** Tokens the provider accepted for delivery. */
  dispatched: number;
  /** Tokens that failed (rejected ticket, dead token, or transport error). */
  errors: number;
}

/**
 * Purges a single dead native-APNs token, mirroring handleTicketErrors' Expo
 * cleanup. Best-effort: a failed cleanup must never surface to the caller.
 */
async function purgeApnsToken(token: string): Promise<void> {
  try {
    await db.update(mobileDevices).set({ apnsToken: null }).where(eq(mobileDevices.apnsToken, token));
  } catch (err) {
    console.error('[push] failed to purge unregistered apns token', {
      token: redactPushToken(token),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Fans a single approval notification out across pre-resolved, provider-tagged
 * tokens. Split from dispatchApprovalPush so callers that must resolve tokens
 * inside a specific DB access context (agent/AI paths) can do the read there
 * and perform the network sends here, AFTER the context closes — never holding
 * a DB transaction open across the push round-trip (#1105).
 *
 * Best-effort: never throws; returns per-provider dispatch/error counts.
 */
export async function dispatchApprovalPushToTokens(
  tokens: TaggedPushToken[],
  args: DispatchApprovalPushArgs
): Promise<DispatchApprovalPushResult> {
  const result: DispatchApprovalPushResult = {
    tokensFound: tokens.length,
    dispatched: 0,
    errors: 0,
  };
  if (tokens.length === 0) return result;

  const payload = buildApprovalPush(args);

  // Expo relay tokens — one batched POST, existing dead-token handling.
  const expoTokens = tokens.filter((t) => t.provider === 'expo');
  if (expoTokens.length > 0) {
    try {
      const tickets = await sendExpoPush(expoTokens.map((t) => ({ to: t.token, ...payload })));
      for (const ticket of tickets) {
        if (ticket.status === 'ok') result.dispatched++;
        else result.errors++;
      }
    } catch (err) {
      console.error('[push] expo approval dispatch failed', err);
      result.errors += expoTokens.length;
    }
  }

  // Native APNs tokens — one HTTP/2 request each; purge on unregistered.
  const apnsTokens = tokens.filter((t) => t.provider === 'apns');
  for (const t of apnsTokens) {
    // sendApnsNotification never throws, but stay defensive so one bad token
    // can't abort the rest of the fan-out.
    try {
      const res = await sendApnsNotification(t.token, {
        title: payload.title,
        body: payload.body,
        data: payload.data,
        ttl: APPROVAL_PUSH_TTL_SECONDS,
      });
      if (res.ok) {
        result.dispatched++;
      } else {
        result.errors++;
        if (res.unregistered) await purgeApnsToken(t.token);
      }
    } catch (err) {
      console.error('[push] apns approval dispatch failed', {
        token: redactPushToken(t.token),
        error: err instanceof Error ? err.message : String(err),
      });
      result.errors++;
    }
  }

  // Native FCM (Android) approval delivery is out of scope for the current iOS
  // submission. The existing firebase path (notifications.sendFCM) speaks a
  // different PushPayload shape and requires FIREBASE_SERVICE_ACCOUNT init, so
  // wiring it here is non-trivial — we deliberately skip rather than
  // half-implement. These tokens are still counted in tokensFound.
  const fcmTokens = tokens.filter((t) => t.provider === 'fcm');
  if (fcmTokens.length > 0) {
    console.info(
      `[push] android approval push not wired to FCM yet — ${fcmTokens.length} token(s) skipped`
    );
  }

  return result;
}

/**
 * Resolves a user's registered push tokens and dispatches an approval
 * notification to all of them. Convenience wrapper over
 * dispatchApprovalPushToTokens for call sites that are NOT inside a long-lived
 * DB access context (dev/seed + test-approval routes). Best-effort: never
 * throws.
 */
export async function dispatchApprovalPush(
  userId: string,
  args: DispatchApprovalPushArgs
): Promise<DispatchApprovalPushResult> {
  let tokens: TaggedPushToken[];
  try {
    tokens = await getUserPushTokens(userId);
  } catch (err) {
    console.error('[push] failed to resolve push tokens', err);
    return { tokensFound: 0, dispatched: 0, errors: 0 };
  }
  return dispatchApprovalPushToTokens(tokens, args);
}
