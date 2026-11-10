/**
 * The self-registration queue (portal registration W6, plan D3): the public
 * submit enqueues and returns its constant 200; the worker decides.
 *
 * PII: jobs carry an address and a name, so they never linger in Redis —
 * removed on completion, and a failed job after a day. Job ids are assigned by
 * BullMQ (never the address; ids must not contain colons). One attempt only:
 * a retry could send a second email.
 */
import { Queue } from 'bullmq';
import { getBullMQConnection } from '../redis';
import { reportSelfRegistrationFailure, safeErrorFields } from './errors';
import { PORTAL_SELF_REGISTRATION_QUEUE, type PortalSelfRegistrationJobData } from './types';

/**
 * The BullMQ connection retries forever while Redis is down, so an unbounded
 * add would hang the public submit. Bounded: a slow or failed enqueue answers
 * the same 200 after at most this long, whatever the address.
 */
export const PORTAL_SELF_REGISTRATION_ENQUEUE_TIMEOUT_MS = 3000;

export const PORTAL_SELF_REGISTRATION_JOB = 'self-register';

export const PORTAL_SELF_REGISTRATION_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: { age: 86_400 },
} as const;

let queue: Queue<PortalSelfRegistrationJobData> | null = null;

function getQueue(): Queue<PortalSelfRegistrationJobData> {
  if (!queue) queue = new Queue<PortalSelfRegistrationJobData>(PORTAL_SELF_REGISTRATION_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

/** False when the job could not be enqueued (logged without PII); the route still answers its uniform 200. */
export async function enqueuePortalSelfRegistration(data: PortalSelfRegistrationJobData): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error('enqueue timed out'), { name: 'EnqueueTimeoutError' })),
        PORTAL_SELF_REGISTRATION_ENQUEUE_TIMEOUT_MS,
      );
    });
    await Promise.race([getQueue().add(PORTAL_SELF_REGISTRATION_JOB, data, PORTAL_SELF_REGISTRATION_JOB_OPTIONS), timeout]);
    return true;
  } catch (err) {
    console.error('[portal-self-registration] enqueue failed', safeErrorFields(err));
    reportSelfRegistrationFailure('enqueue failed', err);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Test/shutdown seam: drop the cached queue. */
export async function closePortalSelfRegistrationQueue(): Promise<void> {
  if (queue) {
    const q = queue;
    queue = null;
    await q.close();
  }
}
