/**
 * Automatic agreement-request reminders on a real database (#9075 W4a, OD8 B).
 *
 *  - the selector joins the partner's cadence columns and returns ONLY open,
 *    unexpired, unrevoked, under-cap, link-live requests whose interval has
 *    elapsed since the later of sent_at and last_reminded_at;
 *  - the automatic path re-sends the SAME credential, bumps the counter once
 *    per cadence step (a second run at the same instant sends nothing), stops
 *    at the cap, and skips a row another transaction holds (SKIP LOCKED).
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { createOrganization, createPartner, createUser } from './db-utils';
import { insertRecipient, insertRequest, rows, seedPublishedTemplate, sys } from './agreementRequestsFixtures';
import { selectDueAutoReminderIds } from '../../jobs/agreementRequestAutoReminder';
import {
  autoRemindAgreementRequest,
  createAgreementRequest,
  sendAgreementRequest,
} from '../../services/agreementRequestLifecycle';
import type { AuthContext } from '../../middleware/auth';

vi.mock('../../services/agreementEvents', () => ({
  emitAgreementEvent: vi.fn(),
  emitAgreementEventForOrg: vi.fn(),
}));

const runDb = it.runIf(!!process.env.DATABASE_URL);
const DAY = 24 * 60 * 60 * 1000;

async function seed(cadence: { intervalDays: number | null; maxReminders: number }) {
  return sys(async () => {
    const partner = await createPartner();
    await db.execute(sql`
      UPDATE partners
         SET agreement_reminder_interval_days = ${cadence.intervalDays},
             agreement_max_reminders = ${cadence.maxReminders}
       WHERE id = ${partner.id}::uuid`);
    const org = await createOrganization({ partnerId: partner.id });
    const tv = await seedPublishedTemplate(partner.id);
    return { partner, org, tv };
  });
}

/** Force a request into a shape relative to `now`. */
async function shape(id: string, now: Date, s: {
  status?: string; sentDaysAgo?: number; lastRemindedDaysAgo?: number | null; reminderCount?: number;
  expiresInDays?: number; revoked?: boolean;
}) {
  const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  await sys(() => db.execute(sql`
    UPDATE agreement_requests
       SET status = ${s.status ?? 'sent'},
           sent_at = ${ago(s.sentDaysAgo ?? 4)}::timestamptz,
           last_reminded_at = ${s.lastRemindedDaysAgo == null ? null : ago(s.lastRemindedDaysAgo)}::timestamptz,
           reminder_count = ${s.reminderCount ?? 0},
           expires_at = ${new Date(now.getTime() + (s.expiresInDays ?? 10) * DAY).toISOString()}::timestamptz,
           public_link_revoked_at = ${s.revoked ? ago(1) : null}::timestamptz
     WHERE id = ${id}::uuid`));
}

async function reminderState(id: string) {
  return sys(async () => rows(await db.execute(sql`
    SELECT reminder_count, last_reminded_at, accept_token_jti
      FROM agreement_requests WHERE id = ${id}::uuid`))[0]!);
}

describe('selectDueAutoReminderIds', () => {
  runDb('returns only due, open, unexpired, unrevoked, under-cap requests of partners with reminders on', async () => {
    const now = new Date();
    const on = await seed({ intervalDays: 3, maxReminders: 2 });
    const off = await seed({ intervalDays: null, maxReminders: 2 });
    const mk = async (o: typeof on, s: Parameters<typeof shape>[2]) => {
      const id = await insertRequest(o.org.id, o.tv);
      await shape(id, now, s);
      return id;
    };

    const due = await mk(on, { sentDaysAgo: 4 });
    const dueViewed = await mk(on, { status: 'viewed', sentDaysAgo: 3 });             // boundary: exactly 3 days
    const dueAfterReminder = await mk(on, { sentDaysAgo: 10, lastRemindedDaysAgo: 3, reminderCount: 1 });
    const tooSoon = await mk(on, { sentDaysAgo: 2 });
    const recentlyReminded = await mk(on, { sentDaysAgo: 10, lastRemindedDaysAgo: 1, reminderCount: 1 });
    const capped = await mk(on, { sentDaysAgo: 10, lastRemindedDaysAgo: 5, reminderCount: 2 });
    const expiredUnreaped = await mk(on, { sentDaysAgo: 4, expiresInDays: -0.01 });
    const revoked = await mk(on, { sentDaysAgo: 4, revoked: true });
    const signed = await mk(on, { status: 'signed', sentDaysAgo: 4 });
    const voided = await mk(on, { status: 'voided', sentDaysAgo: 4 });
    const partnerOff = await mk(off, { sentDaysAgo: 10 });

    const suspended = await seed({ intervalDays: 3, maxReminders: 2 });
    const suspendedOrgReq = await mk(suspended, { sentDaysAgo: 4 });
    await sys(() => db.execute(sql`UPDATE organizations SET status = 'suspended' WHERE id = ${suspended.org.id}::uuid`));

    const selected = new Set(await sys(() => selectDueAutoReminderIds(now, 10_000)));
    expect(selected.has(due)).toBe(true);
    expect(selected.has(dueViewed)).toBe(true);
    expect(selected.has(dueAfterReminder)).toBe(true);
    for (const id of [tooSoon, recentlyReminded, capped, expiredUnreaped, revoked, signed, voided, partnerOff, suspendedOrgReq]) {
      expect(selected.has(id)).toBe(false);
    }
  });
});

describe('autoRemindAgreementRequest on a real database', () => {
  function partnerCtx(partnerId: string, orgId: string, userId: string): DbAccessContext {
    return {
      scope: 'partner', orgId: null, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId],
      currentPartnerId: partnerId, userId,
    };
  }
  function staffAuth(partnerId: string, orgId: string, userId: string): AuthContext {
    return {
      user: { id: userId }, partnerId,
      canAccessOrg: (id: string) => id === orgId, orgCondition: () => undefined,
    } as unknown as AuthContext;
  }

  async function sentRequest(cadence: { intervalDays: number; maxReminders: number }) {
    const { partner, org, tv } = await seed(cadence);
    const user = await sys(() => createUser({ partnerId: partner.id, orgId: org.id, withMembership: false }));
    const ctx = partnerCtx(partner.id, org.id, user.id);
    const auth = staffAuth(partner.id, org.id, user.id);
    const t0 = new Date();
    const draft = await withDbAccessContext(ctx, () => createAgreementRequest(auth, {
      orgId: org.id, templateId: tv.templateId, recipients: ['jane@example.com'], variableValues: {},
      expiresAt: new Date(t0.getTime() + 60 * DAY),
    }, t0));
    const sent = await withDbAccessContext(ctx, () => sendAgreementRequest(auth, draft.id, t0));
    return { id: draft.id, sent, t0 };
  }

  runDb('one reminder per cadence step, the same credential every time, and none past the cap', async () => {
    const { id, sent, t0 } = await sentRequest({ intervalDays: 2, maxReminders: 2 });
    const before = await reminderState(id);

    // Not yet due one day in.
    const early = await sys(() => autoRemindAgreementRequest(id, new Date(t0.getTime() + DAY)));
    expect(early).toEqual({ reminded: false, reason: 'not_due' });

    // Step 1 at +2 days; a second run at the same instant sends nothing.
    const t2 = new Date(t0.getTime() + 2 * DAY);
    const step1 = await sys(() => autoRemindAgreementRequest(id, t2));
    expect(step1.reminded).toBe(true);
    if (step1.reminded) expect(step1.result.link).toBe(sent.link);
    expect(await sys(() => autoRemindAgreementRequest(id, t2))).toEqual({ reminded: false, reason: 'not_due' });
    const after1 = await reminderState(id);
    expect(after1.reminder_count).toBe(1);
    expect(after1.accept_token_jti).toBe(before.accept_token_jti);
    expect(new Date(after1.last_reminded_at as string).getTime()).toBe(t2.getTime());

    // Step 2 anchors on the last reminder, not on the send.
    expect(await sys(() => autoRemindAgreementRequest(id, new Date(t2.getTime() + DAY)))).toEqual({ reminded: false, reason: 'not_due' });
    const t4 = new Date(t2.getTime() + 2 * DAY);
    expect((await sys(() => autoRemindAgreementRequest(id, t4))).reminded).toBe(true);

    // Cap (2) reached: never again.
    expect(await sys(() => autoRemindAgreementRequest(id, new Date(t4.getTime() + 10 * DAY)))).toEqual({ reminded: false, reason: 'not_due' });
    expect((await reminderState(id)).reminder_count).toBe(2);
  });

  runDb('a row another transaction holds is skipped (SKIP LOCKED), and the counter is untouched', async () => {
    const { id, t0 } = await sentRequest({ intervalDays: 1, maxReminders: 3 });
    const at = new Date(t0.getTime() + 2 * DAY);

    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => { locked = r; });
    const holder = withSystemDbAccessContext(async () => {
      await db.execute(sql`SELECT id FROM agreement_requests WHERE id = ${id}::uuid FOR UPDATE`);
      locked();
      await held;
    });
    await lockTaken;
    try {
      const out = await withSystemDbAccessContext(() => autoRemindAgreementRequest(id, at));
      expect(out).toEqual({ reminded: false, reason: 'locked_or_gone' });
    } finally {
      release();
      await holder;
    }
    expect((await reminderState(id)).reminder_count).toBe(0);
    // Once released, the same step goes out exactly once.
    expect((await sys(() => autoRemindAgreementRequest(id, at))).reminded).toBe(true);
    expect((await reminderState(id)).reminder_count).toBe(1);
  });

  runDb('a request with no recipients surfaces RECIPIENTS_REQUIRED instead of silently counting a reminder', async () => {
    const { org, tv } = await seed({ intervalDays: 1, maxReminders: 3 });
    const now = new Date();
    const id = await insertRequest(org.id, tv, { status: 'sent' });
    await insertRecipient(org.id, id, 'jane@example.com');
    await shape(id, now, { sentDaysAgo: 2 });
    await sys(() => db.execute(sql`DELETE FROM agreement_request_recipients WHERE request_id = ${id}::uuid`));
    await expect(sys(() => autoRemindAgreementRequest(id, now))).rejects.toMatchObject({ status: 422, code: 'RECIPIENTS_REQUIRED' });
    expect((await reminderState(id)).reminder_count).toBe(0);
  });
});
