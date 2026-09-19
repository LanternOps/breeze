/**
 * #5306 — the MFA enrolment grace window, against real Postgres.
 *
 * The grant is the security-critical half of this feature and it lives entirely
 * in SQL (a conditional single-statement UPDATE, `now()` from the DB clock,
 * `mfa_epoch` as the "never held a factor" gate). Mocked-db unit tests cannot
 * prove any of that, so the properties below are asserted against the real
 * table through the real resolver:
 *
 *   I-1 first evaluation GRANTS: required=false, pendingEnrollment ~14 days out,
 *       and both bookkeeping columns are persisted.
 *   I-2 the grant is STABLE and NONRENEWABLE: a second evaluation returns the
 *       same deadline and does not re-stamp granted_at.
 *   I-3 a partner may SHORTEN an in-flight window (graceDays -> 0 expires it)
 *       but never lengthen it (graceDays -> 30 keeps the granted deadline).
 *   I-4 an account that has EVER held a factor (mfa_epoch > 1, e.g. after an
 *       admin MFA reset) gets no window at all — required=true, deadline NULL.
 *   I-5 a user holding a live passkey is required during the window (which is
 *       what keeps self-disable / last-passkey removal refused mid-window).
 *   I-6 an elapsed deadline enforces exactly as before the feature.
 *   I-7 the kill switch being OFF opens no window and writes nothing.
 *   I-8 the migration is idempotent (replay is a no-op).
 *   I-9 two CONCURRENT first evaluations grant exactly one window (the loser of
 *       the conditional UPDATE defers to the winner instead of re-granting).
 *
 * Run:
 *   pnpm test-stack up   # worktree root
 *   pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/mfaEnrollmentGrace.integration.test.ts
 */
import './setup';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { partners, roles, users, userPasskeys } from '../../db/schema';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { getEffectiveMfaPolicy } from '../../services/mfaPolicy';
import { evaluateMfaEnrollmentGrace } from '../../services/mfaEnrollmentGrace';
import { assignUserToPartner, createPartner, createRole, createUser } from './db-utils';
import { getTestDb } from './setup';
import { replayMigration } from './replayMigration';

const MIGRATION = '2026-10-16-170100-mfa-enrollment-grace.sql';
const DAY_MS = 86_400_000;

const originalKillSwitch = process.env.MFA_FORCE_FOR_PARTNER_ADMIN;

beforeEach(() => {
  // The role force is what the window postpones, so every case here needs the
  // kill switch ON (I-7 turns it off deliberately).
  process.env.MFA_FORCE_FOR_PARTNER_ADMIN = 'true';
});

afterAll(() => {
  if (originalKillSwitch === undefined) delete process.env.MFA_FORCE_FOR_PARTNER_ADMIN;
  else process.env.MFA_FORCE_FOR_PARTNER_ADMIN = originalKillSwitch;
});

/** A partner admin whose ROLE forces MFA and who has never held a factor. */
async function seedForcedPartnerAdmin(options: { graceDays?: number } = {}) {
  const partner = await createPartner();
  if (options.graceDays !== undefined) {
    await getTestDb()
      .update(partners)
      .set({ settings: { security: { mfaEnrollmentGraceDays: options.graceDays } } })
      .where(eq(partners.id, partner.id));
  }
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await getTestDb().update(roles).set({ forceMfa: true }).where(eq(roles.id, role.id));
  const user = await createUser({
    partnerId: partner.id,
    email: `grace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    status: 'active',
  });
  await assignUserToPartner(user.id, partner.id, role.id, 'all');
  return { partner, role, user };
}

function evaluate(userId: string, partnerId: string) {
  return getEffectiveMfaPolicy({ scope: 'partner', userId, orgId: null, partnerId });
}

async function readGraceColumns(userId: string) {
  const [row] = await getTestDb()
    .select({
      deadline: users.mfaEnrollmentDeadline,
      grantedAt: users.mfaEnrollmentGraceGrantedAt,
      mfaEpoch: users.mfaEpoch,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new Error(`user ${userId} not found`);
  return row;
}

describe('MFA enrolment grace window (#5306)', () => {
  it('I-1: the first evaluation grants a 14-day window instead of requiring MFA', async () => {
    const { partner, user } = await seedForcedPartnerAdmin();

    const before = await readGraceColumns(user.id);
    expect(before.deadline).toBeNull();

    const policy = await evaluate(user.id, partner.id);

    expect(policy.required).toBe(false);
    expect(policy.source.roleForceMfa).toBe(true);
    expect(policy.source.graceWindow).toBe('active');
    expect(policy.pendingEnrollment).not.toBeNull();

    const after = await readGraceColumns(user.id);
    expect(after.deadline).toBeInstanceOf(Date);
    expect(after.grantedAt).toBeInstanceOf(Date);
    // Default window is 14 days; allow a minute of clock slack either side.
    const spanDays = (after.deadline!.getTime() - after.grantedAt!.getTime()) / DAY_MS;
    expect(spanDays).toBeGreaterThan(13.99);
    expect(spanDays).toBeLessThan(14.01);
    expect(policy.pendingEnrollment!.deadline).toBe(after.deadline!.toISOString());
  });

  it('I-2: the grant is stable and nonrenewable across evaluations', async () => {
    const { partner, user } = await seedForcedPartnerAdmin();

    const first = await evaluate(user.id, partner.id);
    const firstColumns = await readGraceColumns(user.id);
    await new Promise((r) => setTimeout(r, 50));
    const second = await evaluate(user.id, partner.id);
    const secondColumns = await readGraceColumns(user.id);

    expect(second.pendingEnrollment).toEqual(first.pendingEnrollment);
    expect(secondColumns.deadline!.getTime()).toBe(firstColumns.deadline!.getTime());
    expect(secondColumns.grantedAt!.getTime()).toBe(firstColumns.grantedAt!.getTime());
  });

  it('I-3: a partner can shorten an in-flight window to zero but cannot lengthen it', async () => {
    const { partner, user } = await seedForcedPartnerAdmin();
    const granted = await evaluate(user.id, partner.id);
    expect(granted.required).toBe(false);
    const grantedDeadline = granted.pendingEnrollment!.deadline;

    // Shorten: 0 days from the grant time is already in the past.
    await getTestDb()
      .update(partners)
      .set({ settings: { security: { mfaEnrollmentGraceDays: 0 } } })
      .where(eq(partners.id, partner.id));
    const shortened = await evaluate(user.id, partner.id);
    expect(shortened.required).toBe(true);
    expect(shortened.source.graceWindow).toBe('expired');
    expect(shortened.pendingEnrollment).toBeNull();

    // Lengthen: the persisted deadline wins — the window never grows.
    await getTestDb()
      .update(partners)
      .set({ settings: { security: { mfaEnrollmentGraceDays: 30 } } })
      .where(eq(partners.id, partner.id));
    const lengthened = await evaluate(user.id, partner.id);
    expect(lengthened.pendingEnrollment?.deadline).toBe(grantedDeadline);
    // ...and the stored grant is untouched by either settings change.
    const columns = await readGraceColumns(user.id);
    expect(columns.deadline!.toISOString()).toBe(grantedDeadline);
  });

  it('I-4: an account that has ever held a factor (post-reset, mfa_epoch > 1) gets no window', async () => {
    const { partner, user } = await seedForcedPartnerAdmin();
    // What POST /users/:id/mfa/reset leaves behind: no factor, but a bumped
    // mfa_epoch. That user must re-enrol immediately, not get a fresh 14 days.
    await getTestDb().update(users).set({ mfaEpoch: 2 }).where(eq(users.id, user.id));

    const policy = await evaluate(user.id, partner.id);

    expect(policy.required).toBe(true);
    expect(policy.pendingEnrollment).toBeNull();
    expect(policy.source.graceWindow).toBe('none');
    expect((await readGraceColumns(user.id)).deadline).toBeNull();
  });

  it('I-5: a user who already holds a live passkey is required during the window', async () => {
    const { partner, user } = await seedForcedPartnerAdmin();
    await getTestDb().insert(userPasskeys).values({
      userId: user.id,
      credentialId: `cred-grace-${user.id}`,
      publicKey: 'dGVzdC1wdWJsaWMta2V5',
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
      name: 'key',
      disabledAt: null,
    });

    const policy = await evaluate(user.id, partner.id);

    expect(policy.required).toBe(true);
    expect(policy.pendingEnrollment).toBeNull();
    expect((await readGraceColumns(user.id)).deadline).toBeNull();
  });

  it('I-6: once the deadline has elapsed, enforcement is exactly as before the feature', async () => {
    const { partner, user } = await seedForcedPartnerAdmin();
    await evaluate(user.id, partner.id);
    await getTestDb()
      .update(users)
      .set({
        mfaEnrollmentDeadline: new Date(Date.now() - DAY_MS),
        mfaEnrollmentGraceGrantedAt: new Date(Date.now() - 15 * DAY_MS),
      })
      .where(eq(users.id, user.id));

    const policy = await evaluate(user.id, partner.id);

    expect(policy.required).toBe(true);
    expect(policy.source.graceWindow).toBe('expired');
    expect(policy.pendingEnrollment).toBeNull();
  });

  it('I-7: with the kill switch off no window is opened and nothing is written', async () => {
    process.env.MFA_FORCE_FOR_PARTNER_ADMIN = 'false';
    const { partner, user } = await seedForcedPartnerAdmin();

    const policy = await evaluate(user.id, partner.id);

    expect(policy.required).toBe(false);
    expect(policy.source.killSwitchOff).toBe(true);
    expect(policy.pendingEnrollment).toBeNull();
    expect(policy.source.graceWindow).toBe('none');
    expect((await readGraceColumns(user.id)).deadline).toBeNull();
  });

  it('I-9: two concurrent first evaluations grant exactly one window', async () => {
    const { partner, user } = await seedForcedPartnerAdmin();

    // Both calls race the same conditional UPDATE. The loser sees zero affected
    // rows and must defer to the winner's persisted grant — if it instead
    // granted again (or returned "no window"), two logins landing together
    // would either move the deadline or lock the user out.
    const evaluateGrace = () => runOutsideDbContext(() => withSystemDbAccessContext(
      () => evaluateMfaEnrollmentGrace(user.id, 14),
    ));
    const [a, b] = await Promise.all([evaluateGrace(), evaluateGrace()]);

    expect(a.deadline).not.toBeNull();
    expect(b.deadline).not.toBeNull();
    expect(a.deadline!.toISOString()).toBe(b.deadline!.toISOString());
    expect(a.expired).toBe(false);
    expect(b.expired).toBe(false);
    const columns = await readGraceColumns(user.id);
    expect(columns.deadline!.toISOString()).toBe(a.deadline!.toISOString());
  });

  it('I-8: the migration is idempotent — replaying it changes nothing', async () => {
    const { partner, user } = await seedForcedPartnerAdmin();
    const granted = await evaluate(user.id, partner.id);

    await replayMigration(MIGRATION);

    const columns = await readGraceColumns(user.id);
    expect(columns.deadline!.toISOString()).toBe(granted.pendingEnrollment!.deadline);
    const columnRows = (await getTestDb().execute<{ count: number }>(sql`
      SELECT count(*)::int AS count
        FROM information_schema.columns
       WHERE table_name = 'users'
         AND column_name IN ('mfa_enrollment_deadline', 'mfa_enrollment_grace_granted_at',
                             'mfa_enrollment_notice_sent_at', 'mfa_enrollment_reminded_at')
    `)) as { count: number }[];
    expect(columnRows[0]?.count).toBe(4);
  });
});
