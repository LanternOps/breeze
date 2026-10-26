/**
 * Wisp W05 — the ONE in-app delivery site under `services/wisp/` (w00 A18).
 *
 * Every Wisp notice — concern nudges, the once-per-window budget notice, the
 * orphaned-watches notice, the incident fan-out — goes through
 * `deliverInApp`. Nothing else under `services/wisp/` calls
 * `createNotification` directly (pinned by deliver.test.ts; W06 keeps the same
 * contract test when its `notifyUser` takes over push/digest and calls this
 * for the in-app row).
 *
 * The metadata keys (`wispThreadId`, `concernId`, `grantId`, `intentId`,
 * `deepLink`) are what W06's web bell fallback (`buildHref`) reads — keep the
 * spelling.
 *
 * W02a (#10212): a caller that passes `post` (only `notifyUser`: brief, nudge,
 * digest) gets the thread post written in the SAME system-context callback
 * as the notification, so both commit or neither does, before any push. The
 * other notices (budget, orphaned watches, assessment digest) pass no post and
 * never become posts.
 */
import type { BriefSection } from '@breeze/shared';
import { createNotification } from '../userNotifications';
import { inSystemContext } from './grantAuthority';
import { recordThreadPost, type ThreadPostInput } from './threadPosts';

/** The post to record beside the notification; its dedupe key and notification link come from the delivery. */
export type ThreadPostDraft = Omit<ThreadPostInput, 'notificationId' | 'dedupeKey'>;

export type InAppDelivery = {
  userId: string;
  /** The org the notice is about; null for partner-level notices (see CreateNotificationInput.orgId). */
  orgId: string | null;
  title: string;
  body: string | null;
  /** Relative same-origin path (a CHECK on user_notifications enforces it). */
  link: string;
  /** Unique per (user, key): a redelivery with the same key writes nothing. */
  dedupeKey: string;
  priority?: 'normal' | 'high';
  concernId?: string | null;
  approvalIntentId?: string | null;
  threadId?: string | null;
  grantId?: string | null;
  deepLink?: string | null;
  /** W06 morning brief (w00 A28): its sections, stored as `metadata.brief` for the home to render. */
  brief?: BriefSection[] | null;
  /**
   * W02a: also record this delivery as a thread post (keyed by `dedupeKey`,
   * linked to the notification when this call created it). Omitted by every
   * notice that is not a brief, nudge or digest.
   */
  post?: ThreadPostDraft;
};

/**
 * `created: false, id: null` when the dedupe key already exists for the user.
 * With `post`, a failure to record it rejects the whole callback, so the
 * notification rolls back with it and the caller's retry redelivers both.
 */
export async function deliverInApp(d: InAppDelivery): Promise<{ created: boolean; id: string | null }> {
  return inSystemContext(async () => {
    const id = await createNotification({
      userId: d.userId,
      orgId: d.orgId,
      type: 'ai',
      title: d.title,
      message: d.body,
      link: d.link,
      priority: d.priority ?? 'normal',
      dedupeKey: d.dedupeKey,
      metadata: {
        wispThreadId: d.threadId ?? null,
        concernId: d.concernId ?? null,
        grantId: d.grantId ?? null,
        intentId: d.approvalIntentId ?? null,
        deepLink: d.deepLink ?? null,
        ...(d.brief ? { brief: d.brief } : {}),
      },
    });
    if (d.post) await recordThreadPost({ ...d.post, dedupeKey: d.dedupeKey, notificationId: id });
    return { created: id !== null, id };
  });
}
