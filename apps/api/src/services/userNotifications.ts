import { sql } from 'drizzle-orm';
import { db } from '../db';
import { userNotifications } from '../db/schema';
import { getEventBus } from './eventBus';

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
    // The partial unique index is on (user_id, dedupe_key) WHERE dedupe_key IS
    // NOT NULL, so a null key never collides and every redelivery with a key is
    // a no-op rather than a duplicate row in someone's bell.
    .onConflictDoNothing()
    .returning({ id: userNotifications.id });

  const created = rows[0]?.id ?? null;
  if (!created) return null;

  // Best-effort live nudge. The row is already committed and the bell polls
  // every 30s, so a failure here costs latency, not the notification — but it
  // must never fail the caller, which is usually mid-way through something more
  // important (creating an intent, dispatching an alert).
  //
  // The payload is deliberately CONTENT-FREE: the WS transport fans out per
  // ORG, so the id is all that crosses it and the client refetches through
  // RLS-protected routes. A filter bug therefore leaks an opaque uuid, not
  // somebody's approval request.
  try {
    await getEventBus().publishUserEvent(
      'notification.created',
      input.orgId,
      input.userId,
      { notificationId: created },
      'user-notifications',
    );
  } catch (err) {
    console.error(
      `[userNotifications] live notify failed for notification ${created} (user=${input.userId} org=${input.orgId}); ` +
        'the row is committed and will appear on the next poll:',
      err instanceof Error ? err.message : err,
    );
  }

  return created;
}

/**
 * Bulk variant for fan-out (e.g. every four-eyes approver on one intent).
 * Each row is independent: one duplicate key or one failed live nudge must not
 * cost the others their notification.
 */
export async function createNotifications(
  inputs: CreateNotificationInput[],
): Promise<string[]> {
  const created: string[] = [];
  for (const input of inputs) {
    try {
      const id = await createNotification(input);
      if (id) created.push(id);
    } catch (err) {
      console.error(
        `[userNotifications] failed to notify user ${input.userId} (org=${input.orgId}, type=${input.type}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return created;
}

/** Count unread notifications for one user. Used by the sidebar badge. */
export async function countUnread(userId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userNotifications)
    .where(sql`${userNotifications.userId} = ${userId} AND ${userNotifications.read} = false`);
  return rows[0]?.count ?? 0;
}
