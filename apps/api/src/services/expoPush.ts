import { db } from '../db';
import { mobileDevices } from '../db/schema/mobile';
import { and, eq } from 'drizzle-orm';
import { sendApnsNotification } from './apns';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const MAX_LABEL_LEN = 60;
// Approval pushes are time-critical: a stale prompt is worthless once the
// requester has moved on, so we cap the store-and-forward window at 60s across
// every provider (Expo ttl + APNs apns-expiration).
export const APPROVAL_PUSH_TTL_SECONDS = 60;
// W07 (#3901). An assignment stays useful for a working day; an SLA breach
// stops being actionable much sooner.
const TICKET_ASSIGNED_TTL_SECONDS = 86_400;
const TICKET_SLA_TTL_SECONDS = 14_400;

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

/**
 * W06 (#3900) — the daily "you have unlogged sessions" nudge. W06 ships the
 * PAYLOAD ONLY: the scheduler, quiet hours, the dedupe write and the mobile
 * listener are W07's. Nothing in this wave calls it.
 *
 * Reserved `push_notifications.event_type` for that future dispatch. The column
 * is varchar(100) with no enum, so reserving the string here is what stops two
 * waves picking different spellings.
 */
export const TIME_SUGGESTIONS_PUSH_EVENT_TYPE = 'time_suggestions_daily';

/**
 * 12 hours. A nudge, not an alert: a phone that was off all evening should not
 * surface yesterday's prompt at breakfast, by which time the technician has a
 * new day's work and the count is stale.
 */
export const TIME_SUGGESTION_PUSH_TTL_SECONDS = 12 * 60 * 60;

/**
 * Feeds `user_notifications.dedupe_key`, which carries a partial-unique index
 * on (user_id, dedupe_key). Must be a pure function of (userId, date) so two
 * processes computing it independently collide in the database rather than
 * double-notifying (F16).
 */
export function timeSuggestionsDedupeKey(userId: string, date: string): string {
  return `time.unlogged:${userId}:${date}`;
}

/**
 * Lock-screen safe BY CONSTRUCTION: a pure function of (count, date), so no
 * device hostname, org name, ticket number or customer string can reach a
 * locked screen. Widening the argument list is how that guarantee gets lost —
 * the "no leak" test in expoPush.test.ts pins it.
 */
export function buildTimeSuggestionPush(args: {
  count: number;
  date: string;
}): Pick<ExpoPushMessage, 'title' | 'body' | 'data' | 'sound' | 'priority' | 'channelId' | 'ttl'> {
  return {
    title: `${args.count} unlogged session${args.count === 1 ? '' : 's'} today`,
    body: 'Tap to review and log your remote sessions.',
    data: { type: 'time_suggestions', date: args.date },
    sound: 'default',
    // 'normal', not 'high': this is a nudge. An approval interrupts; a
    // timesheet reminder waits for the next natural unlock.
    priority: 'normal',
    channelId: 'timesheet',
    ttl: TIME_SUGGESTION_PUSH_TTL_SECONDS,
  };
}

export interface DispatchApprovalPushArgs {
  approvalId: string;
  actionLabel: string;
  requestingClientLabel: string;
}

/**
 * A fully-built, provider-agnostic push (W07, #3901). `buildApprovalPush` and
 * `buildTicketPush` produce these; `dispatchPushToTokens` consumes them.
 */
export interface PushSpec {
  title: string;
  body: string;
  data: Record<string, unknown>;
  ttl: number;
  channelId: string;
  collapseId?: string;
  threadId?: string;
  category?: string;
  /** Expo relay only; APNs always sounds. */
  sound?: 'default' | null;
  priority?: 'default' | 'normal' | 'high';
}

export interface DispatchPushResult {
  /** Total tokens the user has registered (all providers). */
  tokensFound: number;
  /** Tokens the provider accepted for delivery. */
  dispatched: number;
  /** Tokens that failed (rejected ticket, dead token, or transport error). */
  errors: number;
}

export type DispatchApprovalPushResult = DispatchPushResult;

/**
 * Lock-screen-safe ticket push (spec D11): internal number + org name only.
 * The subject NEVER appears — it loads after authenticated navigation.
 * No badge: the badge count is owned by the approval path.
 */
export function buildTicketPush(args: {
  ticketId: string;
  reason: 'assigned' | 'sla_breached';
  target?: 'response' | 'resolution';
  internalNumber: string | null;
  orgName: string;
}): PushSpec {
  const label = (args.internalNumber ?? 'Ticket').slice(0, MAX_LABEL_LEN);
  const org = args.orgName.slice(0, MAX_LABEL_LEN);
  const isSla = args.reason === 'sla_breached';
  const data: Record<string, unknown> = { type: 'ticket', ticketId: args.ticketId, reason: args.reason };
  if (isSla && args.target) data.target = args.target;
  if (args.internalNumber) data.internalNumber = args.internalNumber;
  return {
    title: isSla ? `SLA breached (${args.target ?? 'response'})` : 'Ticket assigned to you',
    body: `${label} \u00b7 ${org}`,
    data,
    ttl: isSla ? TICKET_SLA_TTL_SECONDS : TICKET_ASSIGNED_TTL_SECONDS,
    channelId: 'tickets',
    // KEEP THESE SHORT. APNs rejects an `apns-collapse-id` over 64 BYTES with
    // 400 BadCollapseId, and `ticketId` is a 36-char uuid in production — the
    // original `:sla_breached:` spelling produced 65/67 bytes, so every native
    // SLA push was rejected while the in-app row and email still landed.
    // Longest form today: `ticket:` + 36 + `:sla:resolution` = 58 bytes.
    // buildApnsRequest clamps as a backstop; do not rely on it.
    collapseId: isSla
      ? `ticket:${args.ticketId}:sla:${args.target ?? 'response'}`
      : `ticket:${args.ticketId}:assigned`,
    threadId: `ticket:${args.ticketId}`,
    category: 'BREEZE_TICKET',
    sound: 'default',
    priority: 'high',
  };
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
/**
 * Fans a single push spec out across pre-resolved, provider-tagged tokens.
 * Split from the approval-specific wrapper so callers that must resolve tokens
 * inside a specific DB access context (agent/AI/ticket paths) can do the read
 * there and perform the network sends here, AFTER the context closes — never
 * holding a DB transaction open across the push round-trip (#1105).
 *
 * Best-effort: never throws; returns per-provider dispatch/error counts.
 */
export async function dispatchPushToTokens(
  tokens: TaggedPushToken[],
  spec: PushSpec,
  logLabel = 'push'
): Promise<DispatchPushResult> {
  const result: DispatchPushResult = {
    tokensFound: tokens.length,
    dispatched: 0,
    errors: 0,
  };
  if (tokens.length === 0) return result;

  // Expo relay tokens — one batched POST, existing dead-token handling.
  const expoTokens = tokens.filter((t) => t.provider === 'expo');
  if (expoTokens.length > 0) {
    try {
      const tickets = await sendExpoPush(
        expoTokens.map((t) => ({
          to: t.token,
          title: spec.title,
          body: spec.body,
          data: spec.data,
          sound: spec.sound ?? 'default',
          priority: spec.priority ?? 'high',
          channelId: spec.channelId,
          ttl: spec.ttl,
        }))
      );
      for (const ticket of tickets) {
        if (ticket.status === 'ok') result.dispatched++;
        else result.errors++;
      }
    } catch (err) {
      console.error(`[push] expo ${logLabel} dispatch failed`, err);
      result.errors += expoTokens.length;
    }
  }

  // Native APNs tokens — one HTTP/2 request each; purge on unregistered.
  const apnsTokens = tokens.filter((t) => t.provider === 'apns');
  for (const t of apnsTokens) {
    // sendApnsNotification never throws, but stay defensive so one bad token
    // can't abort the rest of the fan-out.
    try {
      // Optional keys are assigned conditionally so the approval payload stays
      // byte-identical to what shipped before W07.
      const payload: Parameters<typeof sendApnsNotification>[1] = {
        title: spec.title,
        body: spec.body,
        data: spec.data,
        ttl: spec.ttl,
      };
      if (spec.collapseId) payload.collapseId = spec.collapseId;
      if (spec.threadId) payload.threadId = spec.threadId;
      if (spec.category) payload.category = spec.category;
      const res = await sendApnsNotification(t.token, payload);
      if (res.ok) {
        result.dispatched++;
      } else {
        result.errors++;
        if (res.unregistered) await purgeApnsToken(t.token);
      }
    } catch (err) {
      console.error(`[push] apns ${logLabel} dispatch failed`, {
        token: redactPushToken(t.token),
        error: err instanceof Error ? err.message : String(err),
      });
      result.errors++;
    }
  }

  // Native FCM (Android) delivery is out of scope for the current iOS
  // submission. The existing firebase path (notifications.sendFCM) speaks a
  // different PushPayload shape and requires FIREBASE_SERVICE_ACCOUNT init, so
  // wiring it here is non-trivial — we deliberately skip rather than
  // half-implement. These tokens are still counted in tokensFound.
  const fcmTokens = tokens.filter((t) => t.provider === 'fcm');
  if (fcmTokens.length > 0) {
    console.info(
      `[push] android ${logLabel} push not wired to FCM yet — ${fcmTokens.length} token(s) skipped`
    );
  }

  return result;
}

/** Approval-shaped wrapper; unchanged public name, result type and payload. */
export async function dispatchApprovalPushToTokens(
  tokens: TaggedPushToken[],
  args: DispatchApprovalPushArgs
): Promise<DispatchApprovalPushResult> {
  const p = buildApprovalPush(args);
  return dispatchPushToTokens(
    tokens,
    {
      title: p.title!,
      body: p.body!,
      data: (p.data ?? {}) as Record<string, unknown>,
      ttl: p.ttl ?? APPROVAL_PUSH_TTL_SECONDS,
      channelId: p.channelId ?? 'approvals',
      sound: p.sound,
      priority: p.priority,
    },
    'approval'
  );
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
