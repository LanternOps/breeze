/**
 * PAM outcome notices (#8928).
 *
 * When an end user hands an elevation request to IT (Approve on a `pending`
 * request in the on-device dialog), the agent tracks it and waits. The server
 * tells that agent how it ended when a technician denies it or it expires, by
 * queueing a fire-and-forget `pam_request_notify` command. The agent shows the
 * toast only for a request it is tracking; anything else is acknowledged
 * silently.
 *
 * The enqueue must NEVER roll back the deny or expiry that triggered it. It
 * runs inside a savepoint on the caller's transaction, and every failure is
 * reported as `'skipped'`. Without the savepoint a failed statement would
 * poison the caller's transaction and the deny would be lost. The expected
 * refusal (a parked device, from `insertQueuedCommandInTransaction`) is logged
 * at info; anything else (a missing column after a failed migration, an RLS
 * refusal, a timeout) is a real fault and goes to console.error and Sentry,
 * because no caller looks at the return value.
 *
 * Import rule: this module is imported by `jobs/pamJobs.ts` (a worker), so it
 * may reach only leaf modules — `commandQueueInsert`, never `commandQueue`
 * (see the header of `commandQueueInsert.ts`).
 */
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { devices } from '../db/schema';
import { insertQueuedCommandInTransaction } from './commandQueueInsert';
import type { CommandQueueTx } from './commandQueue';
import { CommandTypes } from './commandTypes';
import { captureException } from './sentry';
import { ParkedDeviceCommandRefusedError } from './unassignedPool/deliveryEligibility';
import { pgErrorCode } from '../utils/pgErrors';

export type PamRequestNotifyOutcome = 'denied' | 'expired';

/** The longest deny reason shown to the end user, in code points (Go runes). */
export const PAM_USER_REASON_MAX = 500;

/**
 * Delivery window. Equal to the agent's tracker TTL (`pamTrackedRequestTTL`);
 * a notice about an older request is noise, so the row expires unclaimed.
 */
export const PAM_REQUEST_NOTIFY_DELIVER_MS = 60 * 60 * 1000;

/** Shown when an approval is refused because the program hash could not be verified. */
export const PAM_USER_REASON_UNVERIFIED = 'The program could not be verified.';

// C0 controls except \n (0x0A), plus DEL. Tabs become spaces first, and \r\n
// becomes \n, so neither joins two words together.
// eslint-disable-next-line no-control-regex
const STRIP_CONTROLS = /[\u0000-\u0009\u000B-\u001F\u007F]/g;

/**
 * Sanitize the technician's deny reason for the end-user toast. Only the
 * payload copy is sanitized; the stored `denial_reason` is untouched.
 * Returns undefined when nothing is left to show.
 */
export function sanitizePamUserReason(reason: string | null | undefined): string | undefined {
  if (typeof reason !== 'string') return undefined;
  const cleaned = reason
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, ' ')
    .replace(STRIP_CONTROLS, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned === '') return undefined;
  const points = Array.from(cleaned);
  if (points.length <= PAM_USER_REASON_MAX) return cleaned;
  return `${points.slice(0, PAM_USER_REASON_MAX - 1).join('')}…`;
}

export async function enqueuePamRequestNotify(
  tx: CommandQueueTx,
  req: { id: string; deviceId: string },
  outcome: PamRequestNotifyOutcome,
  reason?: string | null,
): Promise<'queued' | 'unsupported' | 'skipped'> {
  try {
    return await tx.transaction(async (sp) => {
      const [device] = await sp
        .select({
          orgId: devices.orgId,
          pamUserNotifyProtocolVersion: devices.pamUserNotifyProtocolVersion,
        })
        .from(devices)
        .where(eq(devices.id, req.deviceId))
        .limit(1);
      if (!device) {
        // The caller decided this request under a context that should see its
        // device. Zero rows is a context bug (or a device deleted mid-decision),
        // not an old agent, so it is logged apart from the capability check.
        console.warn(
          `[pamRequestNotify] device row not visible for ${outcome} notice (elevation ${req.id}, device ${req.deviceId}); not queued`,
        );
        return 'unsupported' as const;
      }
      if (device.pamUserNotifyProtocolVersion !== 1) return 'unsupported' as const;

      const userReason = outcome === 'denied' ? sanitizePamUserReason(reason) : undefined;
      await insertQueuedCommandInTransaction(sp, {
        id: randomUUID(),
        deviceId: req.deviceId,
        type: CommandTypes.PAM_REQUEST_NOTIFY,
        payload: {
          requestId: req.id,
          outcome,
          ...(userReason !== undefined ? { reason: userReason } : {}),
        },
        createdBy: null,
        deliverBy: new Date(Date.now() + PAM_REQUEST_NOTIFY_DELIVER_MS),
        submittedOrgId: device.orgId,
      });
      return 'queued' as const;
    });
  } catch (err) {
    if (err instanceof ParkedDeviceCommandRefusedError) {
      console.info(
        `[pamRequestNotify] ${outcome} notice for elevation ${req.id} not queued: device ${req.deviceId} is parked; the decision still commits`,
      );
      return 'skipped';
    }
    const code = pgErrorCode(err) ?? undefined;
    console.error(
      `[pamRequestNotify] ${outcome} notice for elevation ${req.id} (device ${req.deviceId}) failed to enqueue` +
        `${code ? ` [pg ${code}]` : ''}; the decision still commits:`,
      err,
    );
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      errorId: 'pam_request_notify_enqueue_failed',
      requestId: req.id,
      deviceId: req.deviceId,
      outcome,
      ...(code ? { pg_code: code } : {}),
    });
    return 'skipped';
  }
}
