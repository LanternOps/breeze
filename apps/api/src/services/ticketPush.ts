/**
 * W07 (#3901): push fan-out helpers for ticket events.
 *
 * Recipient DISCOVERY (loadUserCandidate / listAnySlaSubscribers / prefs /
 * isAuthorisedForTicket) is called by ticketNotifyWorker INSIDE
 * withSystemDbAccessContext, which bypasses RLS. That context is DISCOVERY
 * ONLY. Every recipient is re-authorised (spec D5): same partner as the event,
 * holds tickets:read, and can access the ticket's org; account status gates the
 * PUSH (see the worker) — never the in-app row or the email.
 *
 * Push materialisation is deliberately TWO-PHASE so no network round-trip ever
 * happens inside the open fan-out transaction (#1105 class — the shape
 * alertWorker was refactored away from):
 *   1. `admitPush`      — Redis only (D8 APNs-configured + D6 throttle). The
 *                         worker runs it with NO DB context open.
 *   2. `resolvePushJobs` — ONE batched device read (D12 quiet hours), run by
 *                         the worker in its own short system context.
 * The APNs/Expo send itself (dispatchPushToTokens) happens after that context
 * closes too.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
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

/** A recipient the collectors decided SHOULD be pushed, before any transport gate. */
export interface PendingPush {
  userId: string;
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
 * Unexecuted builder so the compiled SQL can be asserted
 * (ticketPush.sql.test.ts). `notifications_enabled` is the ONLY guard for a
 * technician who muted pushes in the app (the opt-out route does not clear
 * tokens), and `status = 'active'` excludes a soft-blocked handset (lost-phone
 * revocation / admin takeover — see db/schema/mobile.ts). Both are
 * security-relevant, so neither may be asserted through a chainable db mock.
 */
export function userPushTargetsQuery(userIds: string[]) {
  return db
    .select({
      userId: mobileDevices.userId,
      fcm: mobileDevices.fcmToken,
      apns: mobileDevices.apnsToken,
      platform: mobileDevices.platform,
      quietHours: mobileDevices.quietHours,
    })
    .from(mobileDevices)
    .where(
      and(
        inArray(mobileDevices.userId, userIds),
        eq(mobileDevices.notificationsEnabled, true),
        eq(mobileDevices.status, 'active')
      )
    );
}

interface DeviceRow {
  userId: string;
  fcm: string | null;
  apns: string | null;
  /** `device_platform` pg enum — must stay narrowed, TaggedPushToken.platform is not `string`. */
  platform: 'ios' | 'android';
  quietHours: unknown;
}

function tagTokens(row: DeviceRow): TaggedPushToken[] {
  const out: TaggedPushToken[] = [];
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
  return out;
}

/**
 * Phase 1 — D8 (APNs configured?) then D6 (throttle). Redis ONLY: this must be
 * safe to call with no DB access context open, which is exactly how the worker
 * calls it. Never throws.
 */
export async function admitPush(pending: PendingPush[]): Promise<PendingPush[]> {
  if (pending.length === 0) return [];
  if (!isApnsConfigured()) {
    if (!warnedApnsUnconfigured) {
      warnedApnsUnconfigured = true;
      console.info('[TicketPush] APNs not configured — ticket pushes skipped (in-app + email unaffected)');
    }
    return [];
  }
  const admitted: PendingPush[] = [];
  for (const p of pending) {
    const throttle = await checkNotificationThrottle(
      THROTTLE_CHANNEL,
      `user:${p.userId}`,
      THROTTLE_MAX,
      THROTTLE_WINDOW_S
    );
    if (!throttle.allowed) {
      console.warn(`[TicketPush] throttled user=${p.userId} count=${throttle.currentCount}`);
      continue;
    }
    admitted.push(p);
  }
  return admitted;
}

/**
 * Phase 2 — token resolution + D12 (quiet hours), in ONE batched query for the
 * whole fan-out. Needs a DB access context (the worker opens a short system one
 * for just this call). A recipient with no deliverable token yields no job.
 */
export async function resolvePushJobs(
  pending: PendingPush[],
  now: Date = new Date()
): Promise<PushJob[]> {
  if (pending.length === 0) return [];
  const userIds = [...new Set(pending.map((p) => p.userId))];
  const rows = (await userPushTargetsQuery(userIds)) as DeviceRow[];

  const byUser = new Map<string, TaggedPushToken[]>();
  for (const row of rows) {
    if (isInQuietHours(row.quietHours as QuietHoursConfig | null, now)) continue;
    const tokens = tagTokens(row);
    if (tokens.length === 0) continue;
    const existing = byUser.get(row.userId);
    if (existing) existing.push(...tokens);
    else byUser.set(row.userId, tokens);
  }

  const jobs: PushJob[] = [];
  for (const p of pending) {
    const tokens = byUser.get(p.userId);
    if (!tokens || tokens.length === 0) continue;
    jobs.push({ tokens, spec: p.spec });
  }
  return jobs;
}
