/**
 * ticket_push_preferences RLS — user axis, behaviourally (W07, #3901).
 * The coverage contract only proves the policy MENTIONS breeze_current_user_id;
 * this file proves one user cannot read/insert/update another's row as
 * breeze_app, that the system context sees everything (the notify worker reads
 * this table inside withSystemDbAccessContext), and that deleting a user
 * cascades the row.
 *
 * Prerequisites: docker compose -f docker-compose.test.yml up -d
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { ticketPushPreferences, users } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try { await fn(); } catch (err) { raised = err; }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  const cause = (raised as { cause?: { code?: string } })?.cause;
  expect(cause?.code ?? (raised as { code?: string })?.code).toBe(code);
}

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const userA = await createUser({ partnerId: partner.id, orgId: org.id });
  const userB = await createUser({ partnerId: partner.id, orgId: org.id });
  const ctx = (userId: string): DbAccessContext => ({
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [partner.id],
    userId,
  });
  return { partner, org, userA, userB, ctxA: ctx(userA.id), ctxB: ctx(userB.id) };
}

describe('ticket_push_preferences RLS — user axis', () => {
  runDb('a user can upsert and read their own row', async () => {
    const fx = await seed();
    await withDbAccessContext(fx.ctxA, () =>
      db.insert(ticketPushPreferences).values({ userId: fx.userA.id, slaScope: 'any' }));
    const rows = await withDbAccessContext(fx.ctxA, () =>
      db.select().from(ticketPushPreferences).where(eq(ticketPushPreferences.userId, fx.userA.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slaScope).toBe('any');
  });

  runDb('THE GUARD: a same-partner peer cannot read, update or forge the row', async () => {
    const fx = await seed();
    await withSystemDbAccessContext(() =>
      db.insert(ticketPushPreferences).values({ userId: fx.userA.id, assignedEnabled: false }));

    const read = await withDbAccessContext(fx.ctxB, () =>
      db.select().from(ticketPushPreferences).where(eq(ticketPushPreferences.userId, fx.userA.id)));
    expect(read).toHaveLength(0);

    const updated = await withDbAccessContext(fx.ctxB, () =>
      db.update(ticketPushPreferences).set({ slaScope: 'off' })
        .where(eq(ticketPushPreferences.userId, fx.userA.id)).returning({ userId: ticketPushPreferences.userId }));
    expect(updated).toHaveLength(0);

    // Forging a row for someone else fails WITH CHECK → 42501.
    await expectSqlState(
      () => withDbAccessContext(fx.ctxB, () =>
        db.insert(ticketPushPreferences).values({ userId: fx.userA.id, slaScope: 'any' })
          .onConflictDoUpdate({ target: ticketPushPreferences.userId, set: { slaScope: 'any' } })),
      '42501'
    );

    const still = await withSystemDbAccessContext(() =>
      db.select().from(ticketPushPreferences).where(eq(ticketPushPreferences.userId, fx.userA.id)));
    expect(still[0]!.assignedEnabled).toBe(false);
  });

  runDb('system context sees every row (worker discovery path)', async () => {
    const fx = await seed();
    await withDbAccessContext(fx.ctxA, () =>
      db.insert(ticketPushPreferences).values({ userId: fx.userA.id, slaScope: 'any' }));
    await withDbAccessContext(fx.ctxB, () =>
      db.insert(ticketPushPreferences).values({ userId: fx.userB.id, slaScope: 'any' }));
    const rows = await withSystemDbAccessContext(() =>
      db.select({ userId: ticketPushPreferences.userId }).from(ticketPushPreferences)
        .where(eq(ticketPushPreferences.slaScope, 'any')));
    const ids = rows.map((r) => r.userId);
    expect(ids).toEqual(expect.arrayContaining([fx.userA.id, fx.userB.id]));
  });

  runDb('deleting the user cascades the preference row', async () => {
    const fx = await seed();
    await withSystemDbAccessContext(() =>
      db.insert(ticketPushPreferences).values({ userId: fx.userB.id }));
    await withSystemDbAccessContext(() => db.delete(users).where(eq(users.id, fx.userB.id)));
    const rows = await withSystemDbAccessContext(() =>
      db.select().from(ticketPushPreferences).where(eq(ticketPushPreferences.userId, fx.userB.id)));
    expect(rows).toHaveLength(0);
  });
});
