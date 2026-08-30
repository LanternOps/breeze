/**
 * W07 (#3901): push fan-out helpers for ticket events.
 *
 * Everything here is called by ticketNotifyWorker INSIDE
 * withSystemDbAccessContext, which bypasses RLS. That context is DISCOVERY
 * ONLY. Every recipient is re-authorised (spec D5): same partner as the event,
 * active, holds tickets:read, and can access the ticket's org. Network I/O
 * (dispatchPushToTokens) is NOT done here — the worker sends after the context
 * exits (#1105).
 */
import { and, asc, eq } from 'drizzle-orm';
import { resolveTicketPushPrefs, type TicketPushPreferences } from '@breeze/shared';
import { db } from '../db';
import { mobileDevices, ticketPushPreferences, users } from '../db/schema';
import { isApnsConfigured } from './apns';
import { checkNotificationThrottle } from './notificationThrottle';
import { canAccessOrg, getUserPermissions, hasPermission, PERMISSIONS } from './permissions';
import { isInQuietHours, type QuietHoursConfig } from './quietHours';
import { captureException } from './sentry';
import type { PushSpec, TaggedPushToken } from './expoPush';

export interface PushJob {
  tokens: TaggedPushToken[];
  spec: PushSpec;
}

export interface RecipientCandidate {
  userId: string;
  partnerId: string;
  status: string;
  email: string | null;
}

/**
 * Hard blast-radius cap on the partner-wide ('any') SLA fan-out. A partner with
 * thousands of opted-in techs must not turn one breach into thousands of pushes
 * inside a single job.
 */
export const ANY_SUBSCRIBER_CAP = 500;
const THROTTLE_CHANNEL = 'mobile-ticket';
const THROTTLE_MAX = 20;
const THROTTLE_WINDOW_S = 300;

let warnedApnsUnconfigured = false;
export function __resetApnsWarnForTests(): void {
  warnedApnsUnconfigured = false;
}

/**
 * Unexecuted builder so the compiled SQL can be asserted (ticketPush.sql.test.ts).
 * `eq(users.partnerId, partnerId)` IS the tenant boundary — the worker runs with
 * RLS bypassed, so nothing below this line stops a cross-partner subscriber.
 */
export function anySlaSubscribersQuery(partnerId: string, cap: number = ANY_SUBSCRIBER_CAP) {
  return db
    .select({
      userId: users.id,
      partnerId: users.partnerId,
      status: users.status,
      email: users.email,
    })
    .from(ticketPushPreferences)
    .innerJoin(users, eq(users.id, ticketPushPreferences.userId))
    .where(
      and(
        eq(ticketPushPreferences.slaScope, 'any'),
        eq(users.partnerId, partnerId),
        eq(users.status, 'active')
      )
    )
    .orderBy(asc(users.id))
    .limit(cap + 1); // +1 so truncation is observable
}

/**
 * `cap` is a parameter, not a constant read, ONLY so the real-DB truncation test
 * can prove the behaviour with a handful of users instead of 505 (seeding 505
 * users with roles and permission grants blows a 30s integration timeout). The
 * worker never passes it — production is always ANY_SUBSCRIBER_CAP.
 */
export async function listAnySlaSubscribers(
  partnerId: string,
  cap: number = ANY_SUBSCRIBER_CAP
): Promise<{ users: RecipientCandidate[]; truncated: boolean }> {
  const rows = (await anySlaSubscribersQuery(partnerId, cap)) as RecipientCandidate[];
  const truncated = rows.length > cap;
  if (truncated) {
    console.warn(
      `[TicketPush] 'any' SLA subscribers exceed cap partner=${partnerId} cap=${cap}; first ${cap} by user id`
    );
  }
  return { users: rows.slice(0, cap), truncated };
}

export async function loadUserCandidate(userId: string): Promise<RecipientCandidate | null> {
  const rows = await db
    .select({
      userId: users.id,
      partnerId: users.partnerId,
      status: users.status,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return (rows[0] as RecipientCandidate | undefined) ?? null;
}

export async function loadTicketPushPrefs(userId: string): Promise<TicketPushPreferences> {
  const rows = await db
    .select({
      assignedEnabled: ticketPushPreferences.assignedEnabled,
      slaScope: ticketPushPreferences.slaScope,
    })
    .from(ticketPushPreferences)
    .where(eq(ticketPushPreferences.userId, userId))
    .limit(1);
  return resolveTicketPushPrefs(rows[0] ?? null);
}

/** D5 step 1: cheap partner assertion. A mismatch is a forged/moved user — terminal + reported. */
export function assertSamePartner(
  c: RecipientCandidate,
  eventPartnerId: string | null,
  ctx: { ticketId: string }
): boolean {
  if (eventPartnerId && c.partnerId === eventPartnerId) return true;
  const msg = `[TicketPush] recipient partner mismatch user=${c.userId} userPartner=${c.partnerId} eventPartner=${eventPartnerId} ticket=${ctx.ticketId}`;
  console.warn(msg);
  captureException(new Error(msg));
  return false;
}

/** D5 step 3: permission + org access, resolved through the normal permission service. */
export async function isAuthorisedForTicket(
  userId: string,
  partnerId: string,
  orgId: string
): Promise<boolean> {
  const perms = await getUserPermissions(userId, { partnerId, orgId });
  if (!perms) return false;
  return (
    hasPermission(perms, PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action) &&
    canAccessOrg(perms, orgId)
  );
}

/**
 * Active, notifications-enabled devices, minus those inside quiet hours (D12).
 *
 * Re-selects rather than wrapping getUserPushTokens because that helper does
 * not return quiet_hours; the three-line provider inference is duplicated
 * deliberately rather than exporting a shared helper.
 */
export async function getUserPushTargets(
  userId: string,
  now: Date = new Date()
): Promise<TaggedPushToken[]> {
  const rows = await db
    .select({
      fcm: mobileDevices.fcmToken,
      apns: mobileDevices.apnsToken,
      platform: mobileDevices.platform,
      quietHours: mobileDevices.quietHours,
    })
    .from(mobileDevices)
    .where(
      and(
        eq(mobileDevices.userId, userId),
        eq(mobileDevices.notificationsEnabled, true),
        eq(mobileDevices.status, 'active')
      )
    );

  const out: TaggedPushToken[] = [];
  for (const row of rows) {
    if (isInQuietHours(row.quietHours as QuietHoursConfig | null, now)) continue;
    for (const token of [row.fcm, row.apns]) {
      if (!token) continue;
      out.push({
        token,
        platform: row.platform,
        provider: token.startsWith('ExponentPushToken')
          ? 'expo'
          : row.platform === 'ios'
            ? 'apns'
            : 'fcm',
      });
    }
  }
  return out;
}

/**
 * D8 (APNs configured?) -> D6 (throttle) -> tokens -> D12 (quiet hours).
 * Never throws; null means "nothing to send" and the caller writes the in-app
 * row and email regardless.
 */
export async function collectTicketPush(userId: string, spec: PushSpec): Promise<PushJob | null> {
  if (!isApnsConfigured()) {
    if (!warnedApnsUnconfigured) {
      warnedApnsUnconfigured = true;
      console.info('[TicketPush] APNs not configured — ticket pushes skipped (in-app + email unaffected)');
    }
    return null;
  }
  const throttle = await checkNotificationThrottle(
    THROTTLE_CHANNEL,
    `user:${userId}`,
    THROTTLE_MAX,
    THROTTLE_WINDOW_S
  );
  if (!throttle.allowed) {
    console.warn(`[TicketPush] throttled user=${userId} count=${throttle.currentCount}`);
    return null;
  }
  const tokens = await getUserPushTargets(userId);
  if (tokens.length === 0) return null;
  return { tokens, spec };
}
