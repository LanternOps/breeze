import { sql } from 'drizzle-orm';
import { db } from '../db';
import { userNotifications } from '../db/schema';
import { getEventBus } from './eventBus';
import { captureException } from './sentry';

type NotificationType = typeof userNotifications.$inferInsert['type'];
type NotificationPriority = typeof userNotifications.$inferInsert['priority'];

export interface CreateNotificationInput {
  userId: string;
  /**
   * REQUIRED, and not merely for tenancy bookkeeping. `user_notifications` RLS
   * reads `org_id IS NULL OR breeze_has_org_access(org_id)`, and
   * `breeze_has_org_access(NULL)` is FALSE outside system scope — so while a
   * null-org row IS visible to its recipient under the wave-2 policy, it is
   * invisible to any session that has narrowed to a specific org, which is what
   * the web client does on every request (fetchWithAuth injects orgId).
   * Passing the org the notification is ABOUT keeps it visible where the user
   * will actually be looking.
   */
  orgId: string;
  type: NotificationType;
  title: string;
  message?: string | null;
  /** Must be a relative same-origin path — enforced by a CHECK constraint. */
  link?: string | null;
  priority?: NotificationPriority;
  metadata?: Record<string, unknown> | null;
  /**
   * Idempotency key, unique per (user, key). Supply one from any producer that
   * can redeliver — the outbox publisher marks rows published on ENQUEUE rather
   * than on completion, and BullMQ retries on top of that, so without a key one
   * intent can notify the same approver several times.
   */
  dedupeKey?: string | null;
}

/**
 * The single way to create an in-app notification.
 *
 * Deliberately NOT built on `sendInAppNotificationToUsers`
 * (services/notificationSenders/inAppSender.ts): that helper is dead code, its
 * signature is alert-shaped (alertId/alertName/severity are required and the
 * link defaults to `/alerts/...`), and it writes `orgId: payload.orgId || null`
 * — which under this table's RLS produces a row its own recipient may not see.
 *
 * CALLER MUST SUPPLY A DB CONTEXT. Writing a notification for someone other
 * than the current user requires a system context, because the policy's user
 * branch checks `user_id = breeze_current_user_id()`. Every real producer
 * (alert fan-out, ticket assignment, approval fan-out) is notifying OTHER
 * people and therefore runs under `withSystemDbAccessContext`.
 *
 * Caveat: `withSystemDbAccessContext` is a PASSTHROUGH when an ambient context
 * already exists (db/index.ts ~440 — nested withDbAccessContext keeps the
 * outer store). A caller already inside a request context must wrap the whole
 * thing in `runOutsideDbContext` first, or the "system" write runs under the
 * requester's RLS context and the cross-user insert fails with 42501.
 *
 * Returns the new row's id, or null when the dedupe key already existed.
 */
export async function createNotification(
  input: CreateNotificationInput,
): Promise<string | null> {
  const rows = await db
    .insert(userNotifications)
    .values({
      userId: input.userId,
      orgId: input.orgId,
      type: input.type,
      title: input.title,
      message: input.message ?? null,
      link: input.link ?? null,
      priority: input.priority ?? 'normal',
      metadata: input.metadata ?? null,
      dedupeKey: input.dedupeKey ?? null,
    })
    // TARGETED at the dedupe index specifically. An untargeted
    // onConflictDoNothing would silently swallow a conflict on ANY unique index
    // this table gains later, turning a future constraint violation into
    // notifications that vanish with no log at all.
    //
    // The `where` predicate is REQUIRED, not decoration: the target index
    // (`user_notifications_user_dedupe_key_uq`, migration 2026-09-04) is
    // PARTIAL — `WHERE dedupe_key IS NOT NULL` — and Postgres only infers a
    // partial index as the conflict arbiter when the statement carries the
    // matching predicate. Drop it and EVERY insert fails at plan time with
    // 42P10 ("there is no unique or exclusion constraint matching the ON
    // CONFLICT specification"); no mocked unit test sees that — only the
    // real-DB dedupe test in userNotificationsRls.integration.test.ts does.
    .onConflictDoNothing({
      target: [userNotifications.userId, userNotifications.dedupeKey],
      where: sql`${userNotifications.dedupeKey} is not null`,
    })
    .returning({ id: userNotifications.id });

  const created = rows[0]?.id ?? null;
  if (!created) return null;

  // Best-effort live nudge, deliberately NOT awaited.
  //
  // The event bus publishes on getRedisConnection(), which is configured
  // `maxRetriesPerRequest: null` for BullMQ's sake (services/redis.ts:206). With
  // ioredis's default offline queue, a publish during a Redis outage NEVER
  // RESOLVES AND NEVER REJECTS — it sits queued until reconnect. Awaiting it
  // therefore could not be made safe by a try/catch: the four-eyes fan-out loop
  // awaits this once per approver, so a single stalled publish would block every
  // remaining approver AND the push dispatch behind it — defeating the entire
  // point of writing the in-app row first — and would hang the caller's request.
  //
  // Note the nudge fires PRE-COMMIT: both real producers call
  // createNotification inside withSystemDbAccessContext, whose wrapping
  // transaction only commits after the callback resolves — so a client that
  // refetches instantly could still miss the row. That window is covered
  // twice over: the client debounces the refetch by 750ms, and the bell polls
  // every 30s regardless. The nudge is pure latency either way. Fire it,
  // guard the rejection path, and move on.
  //
  // The payload is CONTENT-FREE: the WS transport fans out per ORG, so the id is
  // all that crosses it and the client refetches through RLS-protected routes. A
  // filter bug therefore leaks an opaque uuid, not somebody's approval request.
  void getEventBus()
    .publishUserEvent(
      'notification.created',
      input.orgId,
      input.userId,
      { notificationId: created },
      'user-notifications',
    )
    .catch((err: unknown) => {
      captureException(err instanceof Error ? err : new Error(String(err)));
      console.error(
        `[userNotifications] live notify failed for notification ${created} ` +
          `(user=${input.userId} org=${input.orgId}); the row is committed and ` +
          'will appear on the next poll:',
        err instanceof Error ? err.message : err,
      );
    });

  return created;
}
