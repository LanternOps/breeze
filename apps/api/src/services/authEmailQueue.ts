import type { Queue } from 'bullmq';
import { createInstrumentedQueue } from './bullmqQueue';

/**
 * SR2-22 / SR2-21: the enumeration-safe seam for authentication email.
 *
 * `/auth/forgot-password` and `/auth/register-partner` must do NO conditional
 * work in the request — no user-existence lookup, no epoch advance, no email
 * send — or their wall-clock latency tells an attacker whether the submitted
 * address has an account. Both endpoints therefore enqueue one opaque job and
 * return a fixed generic body. All the conditional work happens HERE, in a
 * worker the requester cannot observe.
 *
 * The queue is built through createInstrumentedQueue so the #1105 held-DB-
 * context tripwire fires if a future caller enqueues from inside a held
 * transaction.
 */
export const AUTH_EMAIL_QUEUE = 'auth-email';

export type AuthEmailJob =
  | { kind: 'password-reset'; email: string }
  // Populated by SR2-21 (email-first registration). The job carries only the
  // SHA-256 hash of the pending-registration token — never the raw token, never
  // the password hash, never the email; the worker reads the Redis record.
  | { kind: 'registration'; tokenHash: string };

let queue: Queue<AuthEmailJob> | null = null;

export function getAuthEmailQueue(): Queue<AuthEmailJob> {
  if (!queue) {
    queue = createInstrumentedQueue<AuthEmailJob>(AUTH_EMAIL_QUEUE, {
      defaultJobOptions: {
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
      },
    });
  }
  return queue;
}

/**
 * Deliberately NOT deduped by jobId: each request must be able to supersede the
 * previous generation (advancing password_reset_epoch invalidates the older
 * token). Also: a jobId derived from the email would be a Redis key an attacker
 * with Redis read access could probe for existence — and BullMQ job ids must
 * not contain `:` anyway.
 *
 * Unlike the registration job (which carries only a token hash), the worker
 * genuinely needs the raw email here to look up the account by
 * `users.email` (there is no hash-keyed lookup path — see
 * getPasswordResetEligibility). So the payload can't be minimized the way
 * registration's is. Instead, override the queue's default retention
 * (removeOnComplete: {count:200} / removeOnFail: {count:500}, sized for the
 * PII-free registration job) so this PII-bearing job doesn't linger in
 * Redis's completed/failed job history: remove immediately on success, keep
 * only a small bounded tail on failure for debugging (mirrors
 * notificationDispatcher.ts's per-job override pattern).
 */
export async function enqueuePasswordResetRequest(email: string): Promise<void> {
  await getAuthEmailQueue().add('password-reset', { kind: 'password-reset', email }, {
    removeOnComplete: true,
    removeOnFail: { count: 100 },
  });
}

export async function enqueueRegistrationVerification(tokenHash: string): Promise<void> {
  await getAuthEmailQueue().add('registration', { kind: 'registration', tokenHash });
}
