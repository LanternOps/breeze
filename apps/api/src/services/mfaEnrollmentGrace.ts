import { sql } from 'drizzle-orm';
import * as dbModule from '../db';

/**
 * #5306 — the enrolment grace window for role-forced MFA.
 *
 * `roles.force_mfa` used to bite the instant it was set: the next request 428'd
 * the user into /auth/mfa/setup, and the only relief was the global
 * MFA_FORCE_FOR_PARTNER_ADMIN kill switch (all users at once, or none). This
 * module turns that into a per-user notification period that ENDS in exactly
 * today's enforcement.
 *
 * Three properties the design leans on, in order of importance:
 *
 * 1. **The grant is durable and NONRENEWABLE.** The deadline is persisted, and
 *    the grant statement matches only `mfa_enrollment_deadline IS NULL`, so no
 *    code path can reopen or extend a window: not a re-login, not a role change,
 *    not the kill switch being toggled off and back on, and — deliberately — not
 *    an admin factor reset. A user who lost their authenticator and was reset
 *    still faces the immediate re-enrollment contract of
 *    `POST /users/:id/mfa/reset`, because their (past) deadline is still there.
 * 2. **A grant is only ever made to an account that has NEVER held a factor.**
 *    `mfa_epoch = 1` means no MFA mutation has ever been applied to the row
 *    (every enroll/disable/reset advances it), which is the conservative reading
 *    of "no factor yet": if in doubt we do not grant, and the caller enforces as
 *    it does today.
 * 3. **Partners may shorten, never lengthen.** The effective deadline is
 *    `min(persisted deadline, grantedAt + security.mfaEnrollmentGraceDays)`, so
 *    lowering the partner setting brings existing windows in (possibly to
 *    already-expired), while raising it only affects grants made afterwards.
 *
 * All timestamps come from the DATABASE clock — the grant, the deadline and the
 * "is it expired" comparison are one statement's `now()` — so a skewed API host
 * can neither extend nor prematurely end a window.
 *
 * "Enforcement" here means the live enrollment gate (authMiddleware's 428 and
 * the login/control-gate policy result). It does not retroactively revoke
 * credentials, API keys or sessions minted during the window; those keep their
 * own lifecycles.
 *
 * NOT wired into partner REGISTRATION on purpose. `/auth/verify-email`'s
 * auto-login mint keeps forcing enrollment for a brand-new partner admin
 * (RMM-QA-164 / SR2-21: `registerPartnerMfaPolicy.integration.test.ts` asserts
 * the mint carries `mfa: false` for that account). Signup is the moment MFA is
 * cheapest to set up and the upgrade-surprise this window exists to fix does not
 * apply there. A window is still granted if that owner abandons setup and comes
 * back through /auth/login later — first-seen is first-seen — but they will have
 * been shown the enrollment screen once, up front.
 */

/** Conservative default window: two weeks from first sighting. */
export const MFA_ENROLLMENT_GRACE_DAYS_DEFAULT = 14;
/** Upper bound a partner may configure. A longer "temporary" exception is a policy change, not a grace period. */
export const MFA_ENROLLMENT_GRACE_DAYS_MAX = 30;

export interface MfaGraceSettings {
  /** Partner (or partner-inherited) `security.mfaEnrollmentGraceDays`. */
  mfaEnrollmentGraceDays?: number;
}

/**
 * Clamp the configured window into [0, MAX], falling back to the default for
 * anything missing or not a finite number. 0 is legal and means "no window" —
 * the grant is made with `deadline = now()`, i.e. enforcement from that moment,
 * which keeps the record of when the user first came under the force.
 */
export function resolveMfaGraceDays(settings: MfaGraceSettings | undefined): number {
  const raw = settings?.mfaEnrollmentGraceDays;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return MFA_ENROLLMENT_GRACE_DAYS_DEFAULT;
  const days = Math.floor(raw);
  if (days < 0) return 0;
  if (days > MFA_ENROLLMENT_GRACE_DAYS_MAX) return MFA_ENROLLMENT_GRACE_DAYS_MAX;
  return days;
}

/** What the policy rule needs to know about one user's grace state. */
export interface MfaGraceFacts {
  /** The account already holds a usable factor (mfa_enabled, or a live passkey). */
  hasFactor: boolean;
  /** Effective deadline of the grant, or null when no grant exists or could be made. */
  deadline: Date | null;
  /** True when a grant exists but its effective deadline has passed (DB clock). */
  expired: boolean;
}

interface GraceRow {
  mfa_enabled: boolean;
  mfa_epoch: number;
  passkey_count: number;
  deadline: Date | string | null;
  granted_at: Date | string | null;
  db_now: Date | string;
}

/** postgres.js returns timestamptz as Date; be defensive about string shapes. */
function toDate(value: Date | string | null): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

function effectiveDeadline(deadline: Date, grantedAt: Date | null, graceDays: number): Date {
  if (!grantedAt) return deadline;
  const shortened = new Date(grantedAt.getTime() + graceDays * 86_400_000);
  // min(): a partner lowering the setting pulls an in-flight window in; raising
  // it must never push a granted deadline out.
  return shortened.getTime() < deadline.getTime() ? shortened : deadline;
}

/** Raw, already-fetched per-user facts a read-only caller (e.g. an admin list
 * view) has on hand — no DB access, so no `readGraceFacts` round trip. */
export interface MfaGracePreviewInput {
  /** `mfa_enabled === true` OR a live passkey exists. */
  hasFactor: boolean;
  /** `users.mfa_epoch` — 1 means the account has never held a factor. */
  mfaEpoch: number;
  /** Persisted `users.mfa_enrollment_deadline`, or null if never granted. */
  deadline: Date | null;
  /** Persisted `users.mfa_enrollment_grace_granted_at`, or null. */
  grantedAt: Date | null;
  /** Resolved `security.mfaEnrollmentGraceDays` (already clamped). */
  graceDays: number;
  /** Injectable for tests; defaults to wall-clock `new Date()`. */
  now?: Date;
}

/**
 * Read-only counterpart to `evaluateMfaEnrollmentGrace`, for callers (the
 * Admin → Users list) that must derive display status for MANY users without
 * issuing a grant per row — `evaluateMfaEnrollmentGrace` writes
 * `mfa_enrollment_deadline` exactly once per account, which a GET endpoint
 * must never trigger as a side effect of being viewed.
 *
 * When a grant already exists, this reproduces `evaluateMfaEnrollmentGrace`'s
 * decision exactly (same `effectiveDeadline` math). When no grant exists yet
 * (the account has never hit the live enrollment gate), there is nothing
 * persisted to read — this previews what a grant made right now would look
 * like (`now + graceDays`) purely for display. It is NOT what
 * `evaluateMfaEnrollmentGrace` will necessarily grant (the real grant runs on
 * the DB clock at first login) and this function never writes anything.
 */
export function previewMfaEnrollmentGrace(input: MfaGracePreviewInput): MfaGraceFacts {
  if (input.hasFactor) return { hasFactor: true, deadline: null, expired: false };
  if (input.mfaEpoch !== 1) {
    // Same rule as evaluateMfaEnrollmentGrace: an account that has ever held a
    // factor (enrolled, self-disabled, or admin-reset) gets no window.
    return { hasFactor: false, deadline: null, expired: false };
  }

  const now = input.now ?? new Date();
  if (input.deadline) {
    const effective = effectiveDeadline(input.deadline, input.grantedAt, input.graceDays);
    return { hasFactor: false, deadline: effective, expired: now.getTime() >= effective.getTime() };
  }

  // No grant persisted yet — preview only, not a real deadline.
  const preview = new Date(now.getTime() + input.graceDays * 86_400_000);
  return { hasFactor: false, deadline: preview, expired: false };
}

type Executor = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

/**
 * Every fact the decision needs, plus the DB clock, in one statement. Reused by
 * the race-loss path so a lost grant re-derives ALL of them (factor state
 * included) rather than trusting the pre-race snapshot.
 *
 * Throws when the row is gone: same disposition as userIsMfaProtected — refuse
 * to guess about an account we cannot see rather than silently granting it a
 * window (or silently reporting it factorless).
 */
async function readGraceFacts(userId: string, exec: Executor): Promise<GraceRow> {
  const read = (await exec.execute(sql`
    SELECT u.mfa_enabled,
           u.mfa_epoch,
           (SELECT count(*)::int FROM user_passkeys k
             WHERE k.user_id = u.id AND k.disabled_at IS NULL) AS passkey_count,
           u.mfa_enrollment_deadline AS deadline,
           u.mfa_enrollment_grace_granted_at AS granted_at,
           now() AS db_now
      FROM users u
     WHERE u.id = ${userId}::uuid
  `)) as GraceRow[];

  const row = read[0];
  if (!row) {
    throw new Error(`[mfa-grace] no users row for ${userId}; refusing to decide a grace window`);
  }
  return row;
}

/**
 * Read (and, exactly once per account, create) the grace grant for `userId`.
 *
 * MUST be called inside an active DB access context — callers are
 * `getEffectiveMfaPolicy` (which already wraps a system context) and the
 * register-partner path (which passes its own open transaction as `exec`, since
 * the user row it is asking about is not committed yet).
 *
 * Deliberately NOT wrapped in try/catch: like the role/membership join it sits
 * beside, a failure here is a hard error. Failing open would hand out a window
 * on a DB blip; failing silently closed would lock out a user the policy was
 * still deciding about.
 */
export async function evaluateMfaEnrollmentGrace(
  userId: string,
  graceDays: number,
  exec: Executor = dbModule.db,
): Promise<MfaGraceFacts> {
  const row = await readGraceFacts(userId, exec);

  if (row.mfa_enabled === true || Number(row.passkey_count ?? 0) > 0) {
    return { hasFactor: true, deadline: null, expired: false };
  }

  let deadline = toDate(row.deadline);
  let grantedAt = toDate(row.granted_at);
  let now = toDate(row.db_now)!;

  if (!deadline) {
    if (Number(row.mfa_epoch) !== 1) {
      // The account has had a factor at some point (enrolled, self-disabled, or
      // admin-reset). No window — enforce exactly as before this feature.
      return { hasFactor: false, deadline: null, expired: false };
    }
    const granted = (await exec.execute(sql`
      UPDATE users
         SET mfa_enrollment_grace_granted_at = now(),
             mfa_enrollment_deadline = now() + make_interval(days => ${graceDays}::int)
       WHERE id = ${userId}::uuid
         AND mfa_enrollment_deadline IS NULL
         AND mfa_epoch = 1
         AND mfa_enabled = false
      RETURNING mfa_enrollment_deadline AS deadline,
                mfa_enrollment_grace_granted_at AS granted_at,
                now() AS db_now
    `)) as GraceRow[];

    if (granted[0]) {
      deadline = toDate(granted[0].deadline);
      grantedAt = toDate(granted[0].granted_at);
      now = toDate(granted[0].db_now)!;
    } else {
      // Zero rows means the row stopped qualifying between the read and the
      // UPDATE: a concurrent request won the grant, or the user enrolled a
      // factor (which advances mfa_epoch). Re-derive EVERY fact — a partial
      // re-read would keep reporting `hasFactor: false` for a user who just
      // enrolled — and honour whatever the winner persisted, never granting a
      // second window. A vanished row throws (readGraceFacts), rather than
      // silently reporting "no window" for a user we can no longer see.
      const reread = await readGraceFacts(userId, exec);
      if (reread.mfa_enabled === true || Number(reread.passkey_count ?? 0) > 0) {
        return { hasFactor: true, deadline: null, expired: false };
      }
      deadline = toDate(reread.deadline);
      grantedAt = toDate(reread.granted_at);
      now = toDate(reread.db_now)!;
      if (!deadline) return { hasFactor: false, deadline: null, expired: false };
    }
  }

  const effective = effectiveDeadline(deadline!, grantedAt, graceDays);
  return { hasFactor: false, deadline: effective, expired: now.getTime() >= effective.getTime() };
}
