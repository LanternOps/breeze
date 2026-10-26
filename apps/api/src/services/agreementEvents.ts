import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizations } from '../db/schema/orgs';
import { getBullMQConnection } from './redis';
import { captureException } from './sentry';

// `agreement-events` is an intentionally-unconsumed RESERVED bus (same pattern
// as `quote-events` / `invoice-events`): emitAgreementEvent publishes lifecycle
// events (#9075 W3b, spec §5) but nothing reads them yet. A future webhook /
// automation consumer wires a Worker against this queue; until then jobs simply
// expire per the retention below.
export const AGREEMENT_EVENTS_QUEUE = 'agreement-events';

export const AGREEMENT_EVENT_TYPES = [
  'agreement.sent',
  'agreement.viewed',
  'agreement.signed',
  'agreement.declined',
  'agreement.voided',
  'agreement.expired',
] as const;

export type AgreementEventType = (typeof AGREEMENT_EVENT_TYPES)[number];

export interface AgreementEvent {
  type: AgreementEventType;
  requestId: string;
  orgId: string;
  partnerId: string;
  /** For signed: who produced it. A consumer must be able to tell an
   *  MSP-recorded signature from a customer one without re-reading the row. */
  origin?: 'customer' | 'on_behalf';
  /** The tech who acted (send / void / record-signed). Null/absent for customer + system events. */
  actorUserId?: string | null;
}

let queue: Queue | null = null;

function getAgreementEventsQueue(): Queue {
  if (!queue) {
    queue = new Queue(AGREEMENT_EVENTS_QUEUE, { connection: getBullMQConnection() });
  }
  return queue;
}

// Fire-and-forget by design (quoteEvents.ts pattern): a Redis outage must never
// fail the customer-facing response or staff mutation that emitted the event.
export async function emitAgreementEvent(event: AgreementEvent): Promise<void> {
  try {
    await getAgreementEventsQueue().add(event.type, event, {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });
  } catch (err) {
    console.error('[AgreementEvents] failed to enqueue', event.type, `requestId=${event.requestId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * For the staff routes, which hold an org id but not the partner id: resolves
 * the owning partner in a short system context of its own (post-commit — never
 * inside the caller's transaction), then emits. Never rejects.
 */
export async function emitAgreementEventForOrg(
  event: Omit<AgreementEvent, 'partnerId'>,
): Promise<void> {
  try {
    const partnerId = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const [org] = await db
        .select({ partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, event.orgId))
        .limit(1);
      return org?.partnerId ?? null;
    }));
    if (!partnerId) return;
    await emitAgreementEvent({ ...event, partnerId });
  } catch (err) {
    console.error('[AgreementEvents] partner lookup failed', event.type, `requestId=${event.requestId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}
