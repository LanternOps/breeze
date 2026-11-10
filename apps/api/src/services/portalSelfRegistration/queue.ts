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
import { PORTAL_SELF_REGISTRATION_QUEUE, type PortalSelfRegistrationJobData } from './types';

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
  try {
    await getQueue().add(PORTAL_SELF_REGISTRATION_JOB, data, PORTAL_SELF_REGISTRATION_JOB_OPTIONS);
    return true;
  } catch (err) {
    console.error('[portal-self-registration] enqueue failed', { error: err instanceof Error ? err.name : 'unknown' });
    return false;
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
