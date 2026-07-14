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
 */
export async function enqueuePasswordResetRequest(email: string): Promise<void> {
  await getAuthEmailQueue().add('password-reset', { kind: 'password-reset', email });
}

export async function enqueueRegistrationVerification(tokenHash: string): Promise<void> {
  await getAuthEmailQueue().add('registration', { kind: 'registration', tokenHash });
}
