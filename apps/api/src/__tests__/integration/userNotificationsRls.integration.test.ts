/**
 * user_notifications RLS — the USER axis, behaviourally.
 *
 * WHAT THIS GUARDS. Until 2026-09-04 this table's four policies were org-only:
 * `USING (breeze_has_org_access(org_id))` with no user predicate at all
 * (0001-baseline.sql:16121, 16982, 17843, 18704). Cross-user isolation inside a
 * single organization rested entirely on the route layer remembering
 * `eq(userNotifications.userId, auth.user.id)`. Every route did carry it, so
 * nothing leaked — but that is app-layer-only tenancy, which the repo's RLS
 * contract forbids, and wave 2 (#3823) starts writing approval action labels and
 * risk summaries into this table.
 *
 * The RLS-coverage contract can only prove the policy MENTIONS
 * breeze_current_user_id. Two same-org users reading each other is a behavioural
 * property, so it has to be proven here against real Postgres as `breeze_app`.
 *
 * Prerequisites: docker compose -f docker-compose.test.yml up -d
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { userNotifications } from '../../db/schema';
import { createNotification } from '../../services/userNotifications';
import { createOrganization, createPartner, createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** Drizzle wraps the driver error; the SQLSTATE is on `.cause`. */
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

interface Fixture {
  orgAId: string;
  orgBId: string;
  userAId: string;
  userPeerId: string;
  ctxUserA: DbAccessContext;
  ctxUserPeer: DbAccessContext;
}

async function seed(): Promise<Fixture> {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  // Two users in the SAME org — the pair the old policy could not tell apart.
  const userA = await createUser({ partnerId: partner.id, orgId: orgA.id });
  const userPeer = await createUser({ partnerId: partner.id, orgId: orgA.id });

  const ctx = (userId: string, orgId: string): DbAccessContext => ({
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId,
  });

  return {
    orgAId: orgA.id,
    orgBId: orgB.id,
    userAId: userA.id,
    userPeerId: userPeer.id,
    ctxUserA: ctx(userA.id, orgA.id),
    ctxUserPeer: ctx(userPeer.id, orgA.id),
  };
}

/** Insert as the system path does — both real producers fan out to other users. */
async function seedNotification(
  userId: string,
  orgId: string | null,
  title: string,
  dedupeKey?: string,
): Promise<string> {
  const rows = await withSystemDbAccessContext(() =>
    db
      .insert(userNotifications)
      .values({ userId, orgId, type: 'approval', title, dedupeKey: dedupeKey ?? null })
      .returning({ id: userNotifications.id }),
  );
  return rows[0]!.id;
}

describe('user_notifications RLS — user axis', () => {
  runDb('a user reads their own notification', async () => {
    const fx = await seed();
    const id = await seedNotification(fx.userAId, fx.orgAId, 'own row');

    const rows = await withDbAccessContext(fx.ctxUserA, () =>
      db.select().from(userNotifications).where(eq(userNotifications.id, id)));

    expect(rows).toHaveLength(1);
  });

  runDb('THE GUARD: a same-org peer cannot read, update or delete it', async () => {
    // This is the property the old org-only policy did not have. Under it, every
    // assertion below returned/affected 1 row.
    const fx = await seed();
    const id = await seedNotification(fx.userAId, fx.orgAId, 'private to A');

    const read = await withDbAccessContext(fx.ctxUserPeer, () =>
      db.select().from(userNotifications).where(eq(userNotifications.id, id)));
    expect(read).toHaveLength(0);

    const updated = await withDbAccessContext(fx.ctxUserPeer, () =>
      db
        .update(userNotifications)
        .set({ read: true })
        .where(eq(userNotifications.id, id))
        .returning({ id: userNotifications.id }));
    expect(updated).toHaveLength(0);

    const deleted = await withDbAccessContext(fx.ctxUserPeer, () =>
      db
        .delete(userNotifications)
        .where(eq(userNotifications.id, id))
        .returning({ id: userNotifications.id }));
    expect(deleted).toHaveLength(0);

    // And the row is genuinely still there — the peer's statements were filtered,
    // not silently applied.
    const survivor = await withSystemDbAccessContext(() =>
      db.select().from(userNotifications).where(eq(userNotifications.id, id)));
    expect(survivor).toHaveLength(1);
    expect(survivor[0]!.read).toBe(false);
  });

  runDb('a user cannot forge a notification addressed to someone else', async () => {
    const fx = await seed();

    await expectSqlState(
      () => withDbAccessContext(fx.ctxUserA, () =>
        db.insert(userNotifications).values({
          userId: fx.userPeerId,
          orgId: fx.orgAId,
          type: 'approval',
          title: 'forged',
        })),
      '42501',
    );
  });

  runDb('an org the user cannot access hides the row even when addressed to them', async () => {
    // The org conjunct still applies: a notification stamped with an org this
    // session cannot reach stays invisible.
    const fx = await seed();
    const id = await seedNotification(fx.userAId, fx.orgBId, 'other org');

    const rows = await withDbAccessContext(fx.ctxUserA, () =>
      db.select().from(userNotifications).where(eq(userNotifications.id, id)));

    expect(rows).toHaveLength(0);
  });

  runDb('a NULL-org notification is visible to its own recipient', async () => {
    // breeze_has_org_access(NULL) is FALSE outside system scope, so without the
    // explicit `org_id IS NULL` branch this row would be invisible to the person
    // it was written for — which is exactly what sendInAppNotificationToUsers
    // would produce today (`orgId: payload.orgId || null`).
    const fx = await seed();
    const id = await seedNotification(fx.userAId, null, 'no org');

    const mine = await withDbAccessContext(fx.ctxUserA, () =>
      db.select().from(userNotifications).where(eq(userNotifications.id, id)));
    expect(mine).toHaveLength(1);

    // Still not the peer's, though.
    const peers = await withDbAccessContext(fx.ctxUserPeer, () =>
      db.select().from(userNotifications).where(eq(userNotifications.id, id)));
    expect(peers).toHaveLength(0);
  });

  runDb('the system path may still fan rows out to other users', async () => {
    // Both real producers (inAppSender, ticketNotifyWorker) insert rows for OTHER
    // users under a system context. If the system branch ever regressed, every
    // alert and ticket notification in the product would stop being written.
    const fx = await seed();
    const id = await seedNotification(fx.userPeerId, fx.orgAId, 'fanned out');

    const rows = await withSystemDbAccessContext(() =>
      db.select().from(userNotifications).where(eq(userNotifications.id, id)));
    expect(rows).toHaveLength(1);
  });

  runDb('dedupe_key is unique per user and does not constrain NULLs', async () => {
    const fx = await seed();
    const key = `intent-approval:${fx.orgAId}:dup`;
    await seedNotification(fx.userAId, fx.orgAId, 'first', key);

    // Same user + same key: refused, which is what makes outbox redelivery safe.
    await expectSqlState(
      () => seedNotification(fx.userAId, fx.orgAId, 'second', key),
      '23505',
    );

    // A DIFFERENT user may hold the same key — a four-eyes fan-out gives every
    // approver a row for the same intent.
    await expect(seedNotification(fx.userPeerId, fx.orgAId, 'peer copy', key))
      .resolves.toBeTruthy();

    // NULL keys are unconstrained: every pre-wave-2 producer writes NULL.
    await seedNotification(fx.userAId, fx.orgAId, 'null key 1');
    await expect(seedNotification(fx.userAId, fx.orgAId, 'null key 2'))
      .resolves.toBeTruthy();
  });

  runDb('createNotification dedupes through the real partial index', async () => {
    // `user_notifications_user_dedupe_key_uq` is PARTIAL (WHERE dedupe_key IS
    // NOT NULL, migration 2026-09-04). Postgres only accepts a partial index
    // as an ON CONFLICT arbiter when the statement carries the matching
    // predicate — an onConflictDoNothing target WITHOUT the `where` clause
    // fails EVERY insert at plan time with 42P10. No mocked unit test can see
    // that, so this exercises the REAL createNotification against real
    // Postgres: first insert lands, the duplicate is swallowed to null, and
    // exactly one row exists.
    const fx = await seed();
    const key = `intent-approval:${fx.orgAId}:real-producer`;
    const input = {
      userId: fx.userAId,
      orgId: fx.orgAId,
      type: 'approval' as const,
      title: 'via createNotification',
      dedupeKey: key,
    };

    const first = await withSystemDbAccessContext(() => createNotification(input));
    expect(typeof first).toBe('string');

    const second = await withSystemDbAccessContext(() => createNotification(input));
    expect(second).toBeNull();

    const rows = await withSystemDbAccessContext(() =>
      db.select().from(userNotifications).where(and(
        eq(userNotifications.userId, fx.userAId),
        eq(userNotifications.dedupeKey, key),
      )));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first);
  });

  runDb('nesting does not escalate: system wrapper inside an org context stays org-scoped', async () => {
    // withDbAccessContext is a PASSTHROUGH when an ambient context already
    // exists (db/index.ts ~440): a withSystemDbAccessContext opened inside a
    // request-scoped context keeps the requester's RLS context. This pins that
    // the user-axis hardening cannot be accidentally escalated past — the
    // nested "system" wrapper still cannot write a notification addressed to
    // someone else.
    const fx = await seed();

    await expectSqlState(
      () => withDbAccessContext(fx.ctxUserA, () =>
        withSystemDbAccessContext(() =>
          db.insert(userNotifications).values({
            userId: fx.userPeerId,
            orgId: fx.orgAId,
            type: 'approval',
            title: 'escalation attempt',
          }))),
      '42501',
    );
  });

  runDb('breeze_app cannot bypass RLS on this table', async () => {
    const fx = await seed();
    const rows = await withDbAccessContext(fx.ctxUserA, () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
    const row = (rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0]!;
    expect(row.who).toBe('breeze_app');
    expect(row.rolbypassrls).toBe(false);
  });

  runDb('the policy is FOR ALL and names breeze_current_user_id', async () => {
    const rows = await withSystemDbAccessContext(() =>
      db.execute(sql`
        SELECT policyname, cmd, COALESCE(qual, '') AS qual, COALESCE(with_check, '') AS with_check
        FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'user_notifications'
      `));
    const policies = rows as unknown as Array<{
      policyname: string; cmd: string; qual: string; with_check: string;
    }>;

    // The four org-only policies must be gone, not merely supplemented — leaving
    // one behind would re-open the cross-user read as a permissive OR.
    expect(policies.map((p) => p.policyname)).toEqual(['user_notifications_user_isolation']);
    const only = policies[0]!;
    expect(only.cmd).toBe('ALL');
    for (const clause of [only.qual, only.with_check]) {
      expect(clause).toContain('breeze_current_user_id');
      expect(clause).toContain('breeze_has_org_access');
    }
  });

  runDb('an existing org-scoped read still works for its owner', async () => {
    // Regression guard for the alert/ticket surface: rows written by the system
    // path with a concrete org must remain readable by their recipient.
    const fx = await seed();
    await seedNotification(fx.userAId, fx.orgAId, 'alert-shaped');

    const rows = await withDbAccessContext(fx.ctxUserA, () =>
      db
        .select()
        .from(userNotifications)
        .where(and(
          eq(userNotifications.userId, fx.userAId),
          eq(userNotifications.orgId, fx.orgAId),
        )));

    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
