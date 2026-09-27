/**
 * Auth Email Worker — SR2-22 / SR2-21.
 *
 * `/auth/forgot-password` (and, from SR2-21, `/auth/register-partner`) enqueue
 * an opaque job and return a fixed generic body so the REQUEST path does zero
 * existence-dependent work — the wall-clock latency of a lookup / epoch advance
 * / email send is an account-enumeration oracle. This worker performs all of
 * that conditional work OUT OF BAND, where the requester cannot observe it.
 *
 * DB context: the worker runs OUTSIDE any request, so there is no ambient
 * AsyncLocalStorage DB context and no outer transaction. `users` is FORCE-RLS,
 * so a contextless read/UPDATE would be filtered to 0 rows — which would look
 * like "no such user" and silently break password reset for EVERYONE.
 * `getPasswordResetEligibility` establishes its own system context internally;
 * the epoch-advance UPDATE is wrapped here in `withSystemDbAccessContext`. We do
 * NOT call `runOutsideDbContext` first (unlike request-path helpers) because
 * there is no context to exit — mirrors every other jobs/*.ts worker.
 */

import { createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import { users } from '../db/schema';
import { getBullMQConnection, getRedis } from '../services/redis';
import { getEmailService } from '../services/email';
import { peekPendingRegistration } from '../services/pendingRegistration';
import { getPasswordResetEligibility } from '../services/passwordResetEligibility';
import { advanceUserEpochs } from '../services/authLifecycle';
import { recordFailedLogin } from '../services/anomalyMetrics';
import { createAuditLog } from '../services/auditService';
import { ANONYMOUS_ACTOR_ID } from '../services/auditEvents';
import { captureException } from '../services/sentry';
import { AUTH_EMAIL_QUEUE, type AuthEmailJob } from '../services/authEmailQueue';
import { attachWorkerObservability } from './workerObservability';

const { db, withSystemDbAccessContext } = dbModule;

// Bounds how often ONE account can have its reset link regenerated,
// independent of how many distinct client addresses the requests arrive
// from. Deliberately short relative to the 1-hour reset-token TTL — a
// legitimate user who wants another link soon just waits out the window
// rather than being locked out of recovery.
const PASSWORD_RESET_COOLDOWN_SECONDS = 5 * 60;

function passwordResetCooldownKey(userId: string): string {
  return `reset-cooldown:${userId}`;
}

// Compare-and-delete (ioredis `eval` — a Redis server-side Lua script, not
// JavaScript eval; the token comes in as ARGV, never interpolated into the
// script). Releasing the cooldown claim on a failed send must only remove
// the key if it still holds THIS attempt's token — a bare DEL would also
// delete a newer claim that a concurrent/retried job had already installed
// after this key's TTL happened to lapse, reopening the double-send window
// the claim exists to close.
const DELETE_IF_TOKEN_MATCHES_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

async function releasePasswordResetCooldown(
  redis: ReturnType<typeof getRedis>,
  userId: string,
  claimToken: string,
): Promise<void> {
  if (!redis) return;
  try {
    await redis.eval(DELETE_IF_TOKEN_MATCHES_LUA, 1, passwordResetCooldownKey(userId), claimToken);
  } catch (err) {
    // Best-effort: if the release itself fails, the claim simply outlives
    // its TTL and the account is throttled for up to the cooldown window —
    // safe-direction failure, never a reason to swallow the original error
    // that triggered the release.
    console.error('[auth-email] failed to release password-reset cooldown claim:', err);
  }
}

/**
 * Exported for unit test — the Worker below is a thin wrapper. Never throws for
 * an "account does not exist" outcome: that is a normal, expected result, not a
 * job failure (a retry storm on unknown addresses would be its own side channel
 * in the queue metrics).
 */
export async function handleAuthEmailJob(job: AuthEmailJob): Promise<void> {
  switch (job.kind) {
    case 'password-reset':
      return handlePasswordReset(job.email);
    case 'registration':
      return handleRegistrationVerification(job.tokenHash);
  }
}

async function handlePasswordReset(email: string): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();
  const redis = getRedis();

  // getPasswordResetEligibility establishes its own system DB context, so the
  // FORCE-RLS `users` read here is not filtered to 0 rows despite running
  // outside a request.
  const eligibility = await getPasswordResetEligibility(normalizedEmail);

  if (!eligibility.allowed) {
    if (eligibility.reason === 'unknown_user') {
      // Expected. Not an error, not a retry. Log at warn for volume tracking
      // only — never audit an address that has no account.
      console.warn('[auth-email] password reset requested for a non-existent account');
      return;
    }
    // Known user, blocked by policy (SSO required / tenant inactive / disabled).
    await createAuditLog({
      orgId: null,
      actorType: 'system',
      actorId: ANONYMOUS_ACTOR_ID,
      action: 'user.password.reset.requested',
      resourceType: 'user',
      resourceId: eligibility.userId,
      details: { reason: eligibility.reason, ...(eligibility.detail ? { detail: eligibility.detail } : {}) },
      result: 'denied',
    });
    // #719 residual 2: inactive-tenant reset attempts feed the anomaly metric
    // so a spike is alertable. sso_required / user_disabled are intentional
    // policy states and must NOT inflate that signal.
    if (eligibility.reason === 'tenant_inactive') recordFailedLogin('reset_tenant_inactive');
    return;
  }

  if (!eligibility.userId || !eligibility.email || !redis) {
    // Fail CLOSED: an unreadable user id or a Redis outage means we cannot
    // create a single-use, generation-bound artifact. Do NOT send a link we
    // cannot bind. Throwing lets BullMQ retry (Redis may come back).
    throw new Error('[auth-email] password-reset preconditions unavailable (redis/user)');
  }

  // Per-user cooldown, keyed on the account rather than the requesting
  // client. The only limiter on the request path (`forgot:<client>`) is keyed
  // on IP/`/64`, so a requester controlling several source addresses can
  // still drive unlimited accepted requests for one target — mail-flooding
  // their inbox and superseding their legitimate reset link every time a new
  // one lands. Claim the cooldown atomically (SET NX EX) BEFORE minting a new
  // generation: a request that loses the claim is a normal, expected outcome
  // (some other accepted request for this user already won the window), not
  // an error or a retry — it simply does no further work, keeping the
  // requester-visible response identical either way (the request path never
  // observes this worker at all).
  // Unique per-attempt token, not a constant sentinel: the release below is a
  // compare-and-delete keyed on this value, so a stale/duplicate release can
  // never remove a DIFFERENT attempt's claim (see `releasePasswordResetCooldown`).
  const claimToken = nanoid(21);
  const cooldownClaimed = await redis.set(
    passwordResetCooldownKey(eligibility.userId),
    claimToken,
    'EX',
    PASSWORD_RESET_COOLDOWN_SECONDS,
    'NX',
  );
  if (cooldownClaimed !== 'OK') {
    console.warn('[auth-email] password reset for this account is within cooldown; skipping mail/epoch advance');
    return;
  }

  try {
    const resetToken = nanoid(48);
    const tokenHash = createHash('sha256').update(resetToken).digest('hex');

    // SR2-08 envelope, unchanged from the old in-request path — advance the
    // generation and bind the token to it plus the exact normalized address.
    // Only the newest generation redeems (routes/auth/password.ts checks it).
    const gen = await withSystemDbAccessContext(() =>
      db.transaction(async (tx) => advanceUserEpochs(tx, eligibility.userId!, { passwordReset: true }))
    );
    await redis.setex(
      `reset:${tokenHash}`,
      3600,
      JSON.stringify({
        userId: eligibility.userId,
        passwordResetEpoch: gen.passwordResetEpoch,
        email: normalizedEmail,
      })
    );

    const appBaseUrl = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/$/, '');
    const resetUrl = `${appBaseUrl}/reset-password?token=${encodeURIComponent(resetToken)}`;

    const emailService = getEmailService();
    if (!emailService) {
      // Observable + retryable without changing the (already-sent) public
      // response. The reset artifact is already bound in Redis; a retry will
      // re-send once mail is configured, and the older generation is superseded.
      const err = new Error('[auth-email] email service not configured; password reset not sent');
      captureException(err);
      throw err;
    }
    await emailService.sendPasswordReset({ to: eligibility.email, resetUrl, purpose: 'auth.password_reset' });

    await createAuditLog({
      orgId: null,
      actorType: 'system',
      actorId: ANONYMOUS_ACTOR_ID,
      action: 'user.password.reset.requested',
      resourceType: 'user',
      resourceId: eligibility.userId,
      details: {},
      result: 'success',
    });
  } catch (err) {
    // A failure anywhere after the claim — most importantly a send failure —
    // must not leave the cooldown held: BullMQ's retry would hit the still-
    // claimed key, lose the NX race, and return silently (no mail, no error,
    // no further retry — a swallowed job). Release (compare-and-delete, this
    // attempt's token only) THEN re-throw so the retry actually runs.
    await releasePasswordResetCooldown(redis, eligibility.userId, claimToken);
    throw err;
  }
}

/**
 * SR2-21 (email-first registration). The requester's response was already sent
 * (a fixed generic body); here — where the requester cannot observe the latency
 * — we PEEK the pending record and decide which email to send. The click, not
 * the worker, consumes the record: peek is non-consuming, and we never delete
 * it, so both branches below are indistinguishable to a Redis observer.
 */
async function handleRegistrationVerification(tokenHash: string): Promise<void> {
  const rec = await peekPendingRegistration(tokenHash);
  if (!rec) {
    // Expired by TTL, or the click already consumed it. Nothing to send and no
    // retry (the record is gone). Not an error.
    console.warn('[auth-email] registration verification job: pending record absent (expired/consumed)');
    return;
  }

  const normalizedEmail = rec.email.toLowerCase().trim();

  // FORCE-RLS `users` read from OUTSIDE a request — establish a system DB
  // context or it is filtered to 0 rows and EVERY existing account looks free
  // (which would mail the signup link to an address that already has an owner).
  // No runOutsideDbContext first: there is no ambient context to exit (mirrors
  // the password-reset path and every other jobs/*.ts worker).
  const [existing] = await withSystemDbAccessContext(() =>
    db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1),
  );

  const emailService = getEmailService();
  if (!emailService) {
    // Observable + retryable without changing the (already-sent) public
    // response. The record is still parked (we peeked, not consumed), so a retry
    // once mail is configured re-sends. Throwing lets BullMQ retry.
    const err = new Error('[auth-email] email service not configured; registration email not sent');
    captureException(err);
    throw err;
  }

  if (existing) {
    // Q5 option (b): the address ALREADY has an account. Notify the holder — but
    // send the "someone tried to sign up" NOTICE, never the signup/verification
    // link (that link would dead-end anyway, and mailing it would let an
    // attacker drive a verification flow against someone else's mailbox). Do NOT
    // delete the pending record: letting it expire by TTL keeps the two branches
    // indistinguishable to a Redis observer.
    await emailService.sendSignupAttemptOnExistingAccount({ to: rec.email, name: existing.name });
    return;
  }

  // Free address: send the normal verification link carrying the RAW token (from
  // the Redis value, never the queue job). The user's click consumes the record.
  const appBaseUrl = (
    process.env.DASHBOARD_URL ||
    process.env.PUBLIC_APP_URL ||
    'http://localhost:4321'
  ).replace(/\/$/, '');
  const verificationUrl = `${appBaseUrl}/auth/verify-email?token=${encodeURIComponent(rec.rawToken)}`;
  await emailService.sendVerificationEmail({ to: rec.email, name: rec.name, verificationUrl, purpose: 'auth.email_verification' });
}

let authEmailWorker: Worker | null = null;

export function initializeAuthEmailWorker(): void {
  try {
    authEmailWorker = new Worker(
      AUTH_EMAIL_QUEUE,
      async (job: Job<AuthEmailJob>) => handleAuthEmailJob(job.data),
      {
        connection: getBullMQConnection(),
        concurrency: 5,
      },
    );
  attachWorkerObservability(authEmailWorker, 'authEmailWorker');

    authEmailWorker.on('error', (error) => {
      console.error('[auth-email] Worker error:', error);
      captureException(error);
    });

    authEmailWorker.on('failed', (job, error) => {
      console.error(`[auth-email] Job ${job?.id} failed:`, error);
      captureException(error);
    });

    console.log('[auth-email] Worker initialized');
  } catch (error) {
    console.error('[auth-email] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownAuthEmailWorker(): Promise<void> {
  if (authEmailWorker) {
    await authEmailWorker.close();
    authEmailWorker = null;
  }
}
