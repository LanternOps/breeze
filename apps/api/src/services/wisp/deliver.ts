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
 */
import { createNotification } from '../userNotifications';
import { inSystemContext } from './grantAuthority';

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
};

/** `created: false` when the dedupe key already exists for the user. */
export async function deliverInApp(d: InAppDelivery): Promise<{ created: boolean }> {
  const id = await inSystemContext(() => createNotification({
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
    },
  }));
  return { created: id !== null };
}
