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
import { nanoid } from 'nanoid';
import { Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import { getBullMQConnection, getRedis } from '../services/redis';
import { getEmailService } from '../services/email';
import { getPasswordResetEligibility } from '../services/passwordResetEligibility';
import { advanceUserEpochs } from '../services/authLifecycle';
import { recordFailedLogin } from '../services/anomalyMetrics';
import { createAuditLog } from '../services/auditService';
import { ANONYMOUS_ACTOR_ID } from '../services/auditEvents';
import { captureException } from '../services/sentry';
import { AUTH_EMAIL_QUEUE, type AuthEmailJob } from '../services/authEmailQueue';

const { db, withSystemDbAccessContext } = dbModule;

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
  await emailService.sendPasswordReset({ to: eligibility.email, resetUrl });

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
}

/**
 * SR2-21 (email-first registration) fills this in — the "you already have an
 * account" / "verify your new account" notice. Nothing enqueues a `registration`
 * job in this PR, so this is a logged no-op for now (kept present so the switch
 * in handleAuthEmailJob is exhaustive from day one). Task 9 replaces the body.
 */
async function handleRegistrationVerification(_tokenHash: string): Promise<void> {
  console.warn('[auth-email] registration verification job received but not yet implemented (Task 9)');
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
