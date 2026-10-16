import { eq, isNotNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { connectionHealthIncidents as chi } from '../../db/schema';
// Namespace import on purpose: tests spy on createNotification to simulate a
// mid-delivery failure.
import * as userNotificationsModule from '../userNotifications';
import { resolveIncidentRecipients } from './recipients';

// Drains the pending_notice outbox (spec §2.1, §4). The store sets the value in
// the same transaction as the state change; this clears it in the same
// transaction as the notices, so a crash on either side retries instead of
// losing or duplicating a notice (createNotification dedupes on the key).
//
// pending_notice is a single slot: a later transition can overwrite a value the
// notifier never delivered (resolved → reopen replaces 'resolved' and the old
// opened_at with it). Every delivery therefore first retires the recorded
// users' notices from earlier episodes by key prefix, sparing only the current
// episode's keys, instead of trusting that the previous value was delivered.

type IncidentRow = typeof chi.$inferSelect;

export function noticeDedupeKeys(incidentId: string, openedAt: Date) {
  const base = `connection-health:${incidentId}:${openedAt.getTime()}`;
  return { opened: base, permanent: `${base}:permanent` };
}

const incidentKeyPrefix = (incidentId: string) => `connection-health:${incidentId}:`;

function noticeText(row: IncidentRow, escalated: boolean) {
  const title = escalated ? `${row.displayName} now needs attention` : `${row.displayName} is not working`;
  const message = row.detail ?? (row.severity === 'permanent'
    ? 'This connection needs to be reconnected or re-authorized.'
    : 'This connection has been failing. Breeze will clear this notice once it recovers.');
  return { title: title.slice(0, 255), message };
}

async function deliverOne(incidentId: string): Promise<void> {
  // Re-read under a row lock: the listing ran in an earlier transaction.
  const [row] = await db.select().from(chi).where(eq(chi.id, incidentId)).for('update');
  if (!row?.pendingNotice) return;

  const keys = noticeDedupeKeys(row.id, row.openedAt ?? row.firstFailedAt);

  if (row.pendingNotice === 'resolved') {
    // Prefix, not the two exact keys: a reopen + re-resolve before delivery
    // leaves the first episode's notices under a key we can no longer derive.
    await userNotificationsModule.markNotificationsReadByDedupeKeyPrefix(
      row.notifiedUserIds, incidentKeyPrefix(row.id), [],
    );
    await db.update(chi).set({ pendingNotice: null, notifiedUserIds: [] }).where(eq(chi.id, row.id));
    return;
  }

  // Non-empty here means an earlier episode was never retired (see top).
  await userNotificationsModule.markNotificationsReadByDedupeKeyPrefix(
    row.notifiedUserIds, incidentKeyPrefix(row.id), [keys.opened, keys.permanent],
  );

  const escalated = row.pendingNotice === 'escalated';
  const { admins, owner } = await resolveIncidentRecipients(row);
  const { title, message } = noticeText(row, escalated);
  const base = {
    orgId: row.orgId,
    type: 'integration' as const,
    title,
    message,
    priority: row.severity === 'permanent' ? 'high' as const : 'normal' as const,
    metadata: { incidentId: row.id, sourceKind: row.sourceKind, condition: row.condition },
    // An escalation sends only the :permanent notice, even when the 'opened'
    // one it overwrote was never delivered; resolve retires both keys.
    dedupeKey: escalated ? keys.permanent : keys.opened,
  };
  for (const userId of admins) {
    await userNotificationsModule.createNotification({ ...base, userId, link: row.fixHref });
  }
  if (owner) {
    await userNotificationsModule.createNotification({ ...base, userId: owner, link: row.ownerFixHref ?? row.fixHref });
  }

  const recipients = owner ? [...admins, owner] : admins;
  if (recipients.length === 0) {
    console.warn(JSON.stringify({
      event: 'connection_health_zero_recipients',
      incidentId: row.id,
      sourceKind: row.sourceKind,
      partnerId: row.partnerId,
    }));
  }
  await db.update(chi).set({
    pendingNotice: null,
    // 'opened' starts an episode, so the stale list is replaced. 'escalated'
    // adds to the episode's recipients. Merged in JS: the row was read FOR
    // UPDATE in this transaction, so no other writer can change it meanwhile.
    notifiedUserIds: escalated ? [...new Set([...row.notifiedUserIds, ...recipients])] : recipients,
  }).where(eq(chi.id, row.id));
}

/** Drain the outbox. Each incident in its own system transaction, so one failure never blocks the rest. */
export async function deliverPendingNotices(
  _now: Date,
  opts: { limit?: number } = {},
): Promise<{ delivered: number; failed: number }> {
  const limit = opts.limit ?? 200;
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(
    () => db.select({ id: chi.id }).from(chi).where(isNotNull(chi.pendingNotice)).limit(limit),
    'connectionHealth.pendingNotices',
  ));
  let delivered = 0;
  let failed = 0;
  for (const { id } of rows) {
    try {
      await runOutsideDbContext(() => withSystemDbAccessContext(() => deliverOne(id), 'connectionHealth.deliver'));
      delivered += 1;
    } catch (err) {
      failed += 1;
      console.error(JSON.stringify({
        event: 'connection_health_notice_failed',
        incidentId: id,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }
  return { delivered, failed };
}
