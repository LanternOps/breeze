/**
 * wisp_nudge_preferences / wisp_partner_nudge_settings RLS — behavioural
 * proof (Wisp W06a #9912). The coverage contract only proves the policies
 * MENTION breeze_current_user_id / breeze_has_partner_access; this file proves,
 * as breeze_app, that a user writes only their own row inside their own
 * partner, that same-partner members may READ it (additive SELECT-only
 * branch) but never write it, that another partner sees nothing, and that the
 * CHECKs and the composite FK hold.
 *
 * Prerequisites: pnpm test-stack up
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { users, wispNudgePreferences, wispPartnerNudgeSettings } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try { await fn(); } catch (err) { raised = err; }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  const cause = (raised as { cause?: { code?: string } })?.cause;
  expect(cause?.code ?? (raised as { code?: string })?.code).toBe(code);
}

const partnerCtx = (partnerId: string, orgId: string, userId: string): DbAccessContext => ({
  scope: 'partner',
  orgId: null,
  accessibleOrgIds: [orgId],
  accessiblePartnerIds: [partnerId],
  userId,
});

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const userA = await createUser({ partnerId: partner.id, orgId: org.id });
  const userB = await createUser({ partnerId: partner.id, orgId: org.id });
  const partner2 = await createPartner();
  const org2 = await createOrganization({ partnerId: partner2.id });
  const userC = await createUser({ partnerId: partner2.id, orgId: org2.id });
  return {
    partner, org, userA, userB, partner2, org2, userC,
    ctxA: partnerCtx(partner.id, org.id, userA.id),
    ctxB: partnerCtx(partner.id, org.id, userB.id),
    ctxC: partnerCtx(partner2.id, org2.id, userC.id),
  };
}

const selectPrefs = (userId: string) =>
  db.select().from(wispNudgePreferences).where(eq(wispNudgePreferences.userId, userId));

describe('wisp_nudge_preferences RLS — user axis inside a partner', () => {
  runDb('a user upserts and reads their own row; a same-partner peer reads it but cannot update it', async () => {
    const fx = await seed();
    await withDbAccessContext(fx.ctxA, () =>
      db.insert(wispNudgePreferences).values({ userId: fx.userA.id, partnerId: fx.partner.id, quietOverride: 'urgent_only' })
        .onConflictDoUpdate({ target: wispNudgePreferences.userId, set: { quietOverride: 'urgent_only' } }));
    const own = await withDbAccessContext(fx.ctxA, () => selectPrefs(fx.userA.id));
    expect(own).toHaveLength(1);
    expect(own[0]!.quietOverride).toBe('urgent_only');
    // Column defaults (w00 A28/A29).
    expect(own[0]!.channels).toEqual({ inApp: true, push: true });
    expect(own[0]!.digestCadenceMinutes).toBe(240);
    expect(own[0]!.briefTimeLocal).toBe('08:00');
    expect(own[0]!.proactivity).toBe('normal');

    const peerRead = await withDbAccessContext(fx.ctxB, () => selectPrefs(fx.userA.id));
    expect(peerRead).toHaveLength(1);

    const peerUpdate = await withDbAccessContext(fx.ctxB, () =>
      db.update(wispNudgePreferences).set({ quietOverride: 'never' })
        .where(eq(wispNudgePreferences.userId, fx.userA.id)).returning({ userId: wispNudgePreferences.userId }));
    expect(peerUpdate).toHaveLength(0);

    const peerDelete = await withDbAccessContext(fx.ctxB, () =>
      db.delete(wispNudgePreferences).where(eq(wispNudgePreferences.userId, fx.userA.id))
        .returning({ userId: wispNudgePreferences.userId }));
    expect(peerDelete).toHaveLength(0);

    const still = await withSystemDbAccessContext(() => selectPrefs(fx.userA.id));
    expect(still[0]!.quietOverride).toBe('urgent_only');
  });

  runDb('a same-partner peer forging a row for another user is 42501', async () => {
    const fx = await seed();
    await expectSqlState(
      () => withDbAccessContext(fx.ctxB, () =>
        db.insert(wispNudgePreferences).values({ userId: fx.userA.id, partnerId: fx.partner.id })),
      '42501',
    );
  });

  runDb('cross-partner: another partner reads 0 rows and its forge is 42501', async () => {
    const fx = await seed();
    await withSystemDbAccessContext(() =>
      db.insert(wispNudgePreferences).values({ userId: fx.userA.id, partnerId: fx.partner.id }));
    const read = await withDbAccessContext(fx.ctxC, () => selectPrefs(fx.userA.id));
    expect(read).toHaveLength(0);
    await expectSqlState(
      () => withDbAccessContext(fx.ctxC, () =>
        db.insert(wispNudgePreferences).values({ userId: fx.userA.id, partnerId: fx.partner.id })
          .onConflictDoUpdate({ target: wispNudgePreferences.userId, set: { proactivity: 'chatty' } })),
      '42501',
    );
    // A user writing their OWN user id under a partner they cannot reach also fails.
    await expectSqlState(
      () => withDbAccessContext(fx.ctxC, () =>
        db.insert(wispNudgePreferences).values({ userId: fx.userC.id, partnerId: fx.partner.id })),
      '42501',
    );
  });

  runDb('quiet_override outside the CHECK is 23514', async () => {
    const fx = await seed();
    await expectSqlState(
      () => withSystemDbAccessContext(() =>
        db.insert(wispNudgePreferences).values({ userId: fx.userA.id, partnerId: fx.partner.id, quietOverride: 'always' as never })),
      '23514',
    );
  });

  runDb('digest_cadence_minutes 10 is 23514; 15 and 1440 are accepted', async () => {
    const fx = await seed();
    await expectSqlState(
      () => withSystemDbAccessContext(() =>
        db.insert(wispNudgePreferences).values({ userId: fx.userA.id, partnerId: fx.partner.id, digestCadenceMinutes: 10 })),
      '23514',
    );
    await withSystemDbAccessContext(() =>
      db.insert(wispNudgePreferences).values({ userId: fx.userA.id, partnerId: fx.partner.id, digestCadenceMinutes: 15 }));
    await withSystemDbAccessContext(() =>
      db.insert(wispNudgePreferences).values({ userId: fx.userB.id, partnerId: fx.partner.id, digestCadenceMinutes: 1440 }));
  });

  runDb("brief_time_local '25:00' and proactivity 'loud' are 23514; NULL brief time (off) is accepted", async () => {
    const fx = await seed();
    await expectSqlState(
      () => withSystemDbAccessContext(() =>
        db.insert(wispNudgePreferences).values({ userId: fx.userA.id, partnerId: fx.partner.id, briefTimeLocal: '25:00' })),
      '23514',
    );
    await expectSqlState(
      () => withSystemDbAccessContext(() =>
        db.insert(wispNudgePreferences).values({ userId: fx.userA.id, partnerId: fx.partner.id, proactivity: 'loud' as never })),
      '23514',
    );
    await withSystemDbAccessContext(() =>
      db.insert(wispNudgePreferences).values({ userId: fx.userA.id, partnerId: fx.partner.id, briefTimeLocal: null }));
    const [row] = await withSystemDbAccessContext(() => selectPrefs(fx.userA.id));
    expect(row!.briefTimeLocal).toBeNull();
  });

  runDb('composite FK rejects a user_id whose partner differs from partner_id (23503)', async () => {
    const fx = await seed();
    await expectSqlState(
      () => withSystemDbAccessContext(() =>
        db.insert(wispNudgePreferences).values({ userId: fx.userA.id, partnerId: fx.partner2.id })),
      '23503',
    );
  });

  runDb('deleting the user cascades the preference row', async () => {
    const fx = await seed();
    await withSystemDbAccessContext(() =>
      db.insert(wispNudgePreferences).values({ userId: fx.userB.id, partnerId: fx.partner.id }));
    await withSystemDbAccessContext(() => db.delete(users).where(eq(users.id, fx.userB.id)));
    const rows = await withSystemDbAccessContext(() => selectPrefs(fx.userB.id));
    expect(rows).toHaveLength(0);
  });
});

describe('wisp_partner_nudge_settings RLS — partner axis', () => {
  runDb('a partner context upserts its row; another partner reads 0 rows and cannot forge', async () => {
    const fx = await seed();
    await withDbAccessContext(fx.ctxA, () =>
      db.insert(wispPartnerNudgeSettings).values({ partnerId: fx.partner.id, urgentCapableSeverities: ['high'], updatedByUserId: fx.userA.id })
        .onConflictDoUpdate({ target: wispPartnerNudgeSettings.partnerId, set: { urgentCapableSeverities: ['high'] } }));
    const own = await withDbAccessContext(fx.ctxB, () =>
      db.select().from(wispPartnerNudgeSettings).where(eq(wispPartnerNudgeSettings.partnerId, fx.partner.id)));
    expect(own).toHaveLength(1);
    expect(own[0]!.urgentCapableSeverities).toEqual(['high']);

    const other = await withDbAccessContext(fx.ctxC, () =>
      db.select().from(wispPartnerNudgeSettings).where(eq(wispPartnerNudgeSettings.partnerId, fx.partner.id)));
    expect(other).toHaveLength(0);
    await expectSqlState(
      () => withDbAccessContext(fx.ctxC, () =>
        db.insert(wispPartnerNudgeSettings).values({ partnerId: fx.partner.id, urgentCapableSeverities: ['info'] })
          .onConflictDoUpdate({ target: wispPartnerNudgeSettings.partnerId, set: { urgentCapableSeverities: ['info'] } })),
      '42501',
    );
  });

  runDb("an unknown severity ('critical') is 23514", async () => {
    const fx = await seed();
    await expectSqlState(
      () => withSystemDbAccessContext(() =>
        db.insert(wispPartnerNudgeSettings).values({ partnerId: fx.partner.id, urgentCapableSeverities: ['critical' as never] })),
      '23514',
    );
  });
});
