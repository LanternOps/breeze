import { sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
// TYPE-ONLY: this module sits in the import closure of the command-insert
// chokepoint (`services/commandQueueInsert.ts`), which must not pull in the
// database client or anything under `routes/`. The reader is always passed in.
import type { db } from '../../db';
import { DRAIN_CLAIM_TYPE_ALLOWLIST } from '../drainClaimAllowlist';

/**
 * Command delivery for devices parked in a partner's holding org.
 *
 * A parked device receives lifecycle removal and nothing else: no command may
 * be enqueued for it, claimed by it, or pushed to it, whichever path writes
 * the row. The only deliverable types are the drain allowlist (the same
 * narrowing a device being removed or offboarded gets), so there is exactly
 * one definition of "what a device we are not managing may still receive".
 *
 * Every enqueue chokepoint and raw `device_commands` insert calls
 * `assertCommandDeliverable` (or `isParkedDevice` where the caller maps the
 * refusal itself), the claim paths cancel parked rows, and
 * `src/__tests__/parkedCommandDelivery.contract.test.ts` fails the build when
 * a new call site is not classified.
 */
export const PARKED_DELIVERABLE_COMMAND_TYPES: readonly string[] = DRAIN_CLAIM_TYPE_ALLOWLIST;

const parkedDeliverable: ReadonlySet<string> = new Set(PARKED_DELIVERABLE_COMMAND_TYPES);

export function isParkedDeliverableCommandType(type: string): boolean {
  return parkedDeliverable.has(type);
}

/** The code a refused enqueue carries (409 body `code`). */
export const PARKED_DEVICE_COMMAND_REFUSAL_CODE = 'DEVICE_PENDING_ASSIGNMENT' as const;

/** `result.reason` on a row the claim paths cancel for a parked device. */
export const PARKED_DEVICE_CANCEL_REASON = 'device_pending_assignment' as const;

/** The human-readable refusal, shared by paths that return a result instead of throwing. */
export const PARKED_DEVICE_COMMAND_REFUSAL_MESSAGE =
  'This device is waiting to be assigned to an organization and can only receive removal commands';

/**
 * Thrown by the enqueue chokepoints. An `HTTPException` so a route that lets
 * it propagate answers 409 with the code through the app's `onError` (which
 * copies `code` off a typed HTTPException); workers catch it and record a
 * skipped/failed outcome rather than retrying.
 */
export class ParkedDeviceCommandRefusedError extends HTTPException {
  readonly code = PARKED_DEVICE_COMMAND_REFUSAL_CODE;

  constructor(
    readonly deviceId: string,
    readonly commandType: string,
  ) {
    super(409, { message: PARKED_DEVICE_COMMAND_REFUSAL_MESSAGE });
    this.name = 'ParkedDeviceCommandRefusedError';
  }

  // A fresh Response every call: a Response body may only be read once.
  override getResponse(): Response {
    return Response.json(
      { error: this.message, message: this.message, code: this.code },
      { status: 409 },
    );
  }
}

/** Anything that can run one SQL statement: the caller's `tx`, or `db`. */
export type DeliveryEligibilityReader = Pick<typeof db, 'execute'>;

/**
 * True when the device's org is a holding org.
 *
 * Asks `public.breeze_device_is_pending_assignment` (SECURITY DEFINER,
 * migration 2026-11-08-170400) on the reader it is given, so the check runs in
 * the same transaction as the insert that follows it AND its answer does not
 * depend on what the caller's context can see: a human request context never
 * sees a holding org, and a plain join there would answer "not parked". The
 * function returns only a boolean; the migration header records why that is
 * acceptable for a caller asking about a device it cannot see. A missing
 * device answers false (callers own the not-found answer).
 */
export async function isParkedDevice(
  reader: DeliveryEligibilityReader,
  deviceId: string,
): Promise<boolean> {
  const rows = (await reader.execute(
    sql`SELECT public.breeze_device_is_pending_assignment(${deviceId}::uuid) AS parked`,
  )) as unknown as Array<{ parked: boolean | null }>;
  return rows[0]?.parked === true;
}

/**
 * Refuse a command for a parked device unless it is a lifecycle-removal type.
 * Call it BEFORE the insert (and before sealing any secret into the payload).
 */
export async function assertCommandDeliverable(
  reader: DeliveryEligibilityReader,
  input: { deviceId: string; commandType: string },
): Promise<void> {
  if (isParkedDeliverableCommandType(input.commandType)) return;
  if (await isParkedDevice(reader, input.deviceId)) {
    throw new ParkedDeviceCommandRefusedError(input.deviceId, input.commandType);
  }
}
