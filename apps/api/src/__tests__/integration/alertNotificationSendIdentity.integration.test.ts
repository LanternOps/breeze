/**
 * Real-Postgres integration coverage for the wave-3.5c (#4085) alert
 * notification send-identity contract: a send is uniquely identified by
 * (alert_id, channel_id, escalation_step) — migration
 * `2026-09-11-f-alert-notifications-send-identity.sql`.
 *
 * `alert_notifications` carries no `org_id` column — tenancy is transitive
 * via `alert_id` — but it IS RLS-protected (FORCE ROW LEVEL SECURITY with
 * EXISTS-join policies over `alerts.org_id`, migration
 * `2026-05-30-fk-child-tables-rls.sql`; registered as an alert-join table in
 * `rls-coverage.integration.test.ts`). "No org_id column" is not "no RLS" —
 * this file has no forge case because the identity migration under test adds
 * a column + unique index, not a tenancy shape, not because the table is
 * unprotected. Seeding below uses the superuser test client, which bypasses
 * those join policies entirely (same as every other seed helper in this dir).
 *
 * Both cases here replay the migration file BY PATH against seeded data,
 * mirroring `alertRuleOwnershipMigration.integration.test.ts`. Renaming that
 * migration file would need every such reference swept (autoMigrate.test.ts
 * asserts these paths resolve) — noted per the task brief, not touched here.
 *
 * Sensitivity ("proven red first") for each case is a paired negative control
 * that literally reverts the migration's effect (drops the unique index /
 * skips the dedupe) and shows the opposite outcome, then restores state —
 * ALWAYS in a `finally`, so a failing assertion mid-test can never leave the
 * shared unique index dropped for the rest of the run — by replaying the
 * migration again, never by editing the shipped .sql file.
 *
 * Run (private containers — see eventDispatchQueue.integration.test.ts's
 * header for the exact docker recipe; same rig serves both files):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/alertNotificationSendIdentity.integration.test.ts
 */
import './setup';

import { randomUUID } from 'crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { alertNotifications, alerts, devices, notificationChannels } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-09-11-f-alert-notifications-send-identity.sql',
);

function migrationText(): string {
  return readFileSync(MIGRATION_FILE, 'utf8');
}

async function runMigration(): Promise<void> {
  await getTestDb().execute(sql.raw(migrationText()));
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  const cause = (raised as { cause?: { code?: string } })?.cause;
  expect(cause?.code ?? (raised as { code?: string })?.code).toBe(code);
}

/**
 * Seeds partner -> org -> site -> device -> alert -> notification channel,
 * the FK chain `alert_notifications` hangs off. Uses the superuser test
 * client — seeding bypasses the table's alert-join RLS policies by design
 * (see the file header).
 */
async function seedAlertAndChannel() {
  const db = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner!.id });
  const site = await createSite({ orgId: org!.id });

  const [device] = await db
    .insert(devices)
    .values({
      orgId: org!.id,
      siteId: site!.id,
      agentId: `agent-send-identity-${randomUUID()}`,
      hostname: 'send-identity-host',
      osType: 'windows',
      osVersion: '11',
      architecture: 'x64',
      agentVersion: '1.0.0',
    })
    .returning({ id: devices.id });

  const [alert] = await db
    .insert(alerts)
    .values({
      deviceId: device!.id,
      orgId: org!.id,
      severity: 'high',
      title: 'Send-identity fixture alert',
    })
    .returning({ id: alerts.id });

  const [channel] = await db
    .insert(notificationChannels)
    .values({
      orgId: org!.id,
      name: 'Send-identity fixture channel',
      type: 'email',
      config: {},
    })
    .returning({ id: notificationChannels.id });

  return { alert: alert!, channel: channel! };
}

async function rowsFor(alertId: string, channelId: string) {
  return getTestDb()
    .select()
    .from(alertNotifications)
    .where(and(eq(alertNotifications.alertId, alertId), eq(alertNotifications.channelId, channelId)));
}

describe('alert_notifications send identity (wave 3.5c, #4085)', () => {
  it('the unique index is real: a second insert of the same (alert, channel, step) triple is a no-op under onConflictDoNothing', async () => {
    const db = getTestDb();
    const { alert, channel } = await seedAlertAndChannel();

    const [first] = await db
      .insert(alertNotifications)
      .values({ alertId: alert.id, channelId: channel.id, escalationStep: 0, status: 'sent' })
      .onConflictDoNothing()
      .returning({ id: alertNotifications.id });
    expect(first).toBeTruthy();

    const secondAttempt = await db
      .insert(alertNotifications)
      .values({ alertId: alert.id, channelId: channel.id, escalationStep: 0, status: 'pending' })
      .onConflictDoNothing()
      .returning({ id: alertNotifications.id });
    expect(secondAttempt).toHaveLength(0);

    const rows = await rowsFor(alert.id, channel.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('sent');

    // [sensitivity control] Without the unique index (the pre-migration
    // world) this exact statement would NOT be a no-op. Prove it by
    // literally reverting the fix — dropping the index the migration adds —
    // and re-attempting the identical insert. The revert + assertion are in
    // a try/finally: if the assertion below ever throws, the shared unique
    // index must still come back for every later test/file in this run
    // rather than staying dropped.
    await db.execute(sql.raw('DROP INDEX IF EXISTS alert_notifications_send_identity_uq'));
    try {
      const thirdAttempt = await db
        .insert(alertNotifications)
        .values({ alertId: alert.id, channelId: channel.id, escalationStep: 0, status: 'pending' })
        .onConflictDoNothing()
        .returning({ id: alertNotifications.id });
      expect(thirdAttempt).toHaveLength(1); // no unique arbiter left -> inserts freely
    } finally {
      // Replay the migration so the index (and, incidentally, the dedupe
      // over the duplicate this control just created) comes back for any
      // later test/file. Covered in depth by the next test.
      await runMigration();
    }
  });

  it("replaying the migration's dedupe renumbers the pending duplicate negative and KEEPS both rows, preserving the sent row at step 0", async () => {
    const db = getTestDb();
    const { alert, channel } = await seedAlertAndChannel();

    // Seed the pre-identity "dirty" shape: two rows sharing the identity
    // triple. Only possible with the unique index temporarily out of the
    // way — real production duplicates predate the index (BullMQ retries
    // inserting fresh rows). Everything from here through the final
    // assertion runs in a try/finally: on ANY failure, the index must still
    // come back (and the probe index below must never survive), or a later
    // test/file sharing this database sees a dropped unique index.
    await db.execute(sql.raw('DROP INDEX IF EXISTS alert_notifications_send_identity_uq'));
    try {
      const [sentRow] = await db
        .insert(alertNotifications)
        .values({ alertId: alert.id, channelId: channel.id, escalationStep: 0, status: 'sent', sentAt: new Date() })
        .returning({ id: alertNotifications.id });
      const [pendingRow] = await db
        .insert(alertNotifications)
        .values({ alertId: alert.id, channelId: channel.id, escalationStep: 0, status: 'pending' })
        .returning({ id: alertNotifications.id });

      // [sensitivity control] Without the dedupe step, building the identity
      // index directly over this dirty data fails outright — that failure IS
      // the bug this migration's DO block exists to fix.
      await expectSqlState(
        () =>
          db.execute(
            sql.raw(
              'CREATE UNIQUE INDEX alert_notifications_send_identity_uq_probe ON alert_notifications (alert_id, channel_id, escalation_step)',
            ),
          ),
        '23505', // unique_violation: "could not create unique index ... Key is duplicated"
      );

      // Replay the FULL migration file: ADD COLUMN is a no-op (already
      // applied by globalSetup), the DO-block dedupe renumbers the loser,
      // and CREATE UNIQUE INDEX IF NOT EXISTS rebuilds the real index this
      // test (and possibly the previous one) dropped.
      await runMigration();

      const rows = await rowsFor(alert.id, channel.id);
      // Renumbered, never deleted — the amended contract (loser-renumbering,
      // not a DELETE) that the task brief calls out explicitly.
      expect(rows).toHaveLength(2);

      const sentAfter = rows.find((r) => r.id === sentRow!.id);
      const pendingAfter = rows.find((r) => r.id === pendingRow!.id);
      expect(sentAfter?.status).toBe('sent');
      expect(sentAfter?.escalationStep).toBe(0);
      expect(pendingAfter?.status).toBe('pending');
      expect(pendingAfter?.escalationStep).toBeLessThan(0);

      // The real index is back: a third row at the LIVE step 0 collides
      // again, exactly like the previous test's positive case.
      const thirdAttempt = await db
        .insert(alertNotifications)
        .values({ alertId: alert.id, channelId: channel.id, escalationStep: 0, status: 'pending' })
        .onConflictDoNothing()
        .returning({ id: alertNotifications.id });
      expect(thirdAttempt).toHaveLength(0);
    } finally {
      // Belt-and-braces: if the probe index above somehow SUCCEEDED (a real
      // dedupe regression), it must not survive as a second, silently
      // enforcing uniqueness constraint on the same triple. Then always
      // restore the real index + dedupe, regardless of where this test
      // stopped.
      await db.execute(sql.raw('DROP INDEX IF EXISTS alert_notifications_send_identity_uq_probe'));
      await runMigration();
    }
  });
});
