/**
 * Incident actions for full partner admins (routes/preAssignment.ts):
 *   - the per-partner deploy-key enrollment switch;
 *   - expire every device a given deploy key parked that is still parked.
 * Both run in fresh system contexts bound to ONE partner id the route
 * resolved (the ledger and the holding org are invisible to a request
 * context). Deploy-key revocation itself arrives with deploy keys.
 */
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { devicePoolAssignmentEvents, partners } from '../../db/schema';
import { captureException } from '../sentry';
import { expireParkedDevice } from './parkedExpiry';
import { lockActorAssurance } from '../stepUpActorAssurance';
import { consumeStepUpGrant, type StepUpGrantBinding } from '../mfaStepUpGrant';
import type { AuthContext } from '../../middleware/auth';
import { lockLiveUserSession } from './assignParkedDeviceSteps';

const inSystemContext = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

/**
 * Sets `partners.deploy_key_enrollment_enabled`. Null when the partner does
 * not exist. When `stepUp` is given (turning it ON with two-factor
 * authentication enabled) the actor's assurance and live session are locked
 * and the single-use grant is consumed inside this transaction, after the
 * partner row lock — 'STEP_UP_REQUIRED' when any of that fails, and nothing
 * is written.
 */
export async function setDeployKeyEnrollmentSwitch(input: {
  partnerId: string;
  enabled: boolean;
  stepUp: { grantId: string; binding: StepUpGrantBinding; auth: AuthContext } | null;
}): Promise<{ previous: boolean; enabled: boolean } | 'STEP_UP_REQUIRED' | null> {
  return inSystemContext(() => db.transaction(async (tx) => {
    const [current] = await tx
      .select({ enabled: partners.deployKeyEnrollmentEnabled })
      .from(partners)
      .where(eq(partners.id, input.partnerId))
      .limit(1)
      .for('update');
    if (!current) return null;
    if (input.stepUp) {
      const { grantId, binding, auth } = input.stepUp;
      const assured = await lockActorAssurance(tx, auth, binding)
        && await lockLiveUserSession(tx, { userId: auth.user.id, sid: binding.sid });
      if (!assured || !(await consumeStepUpGrant(grantId, binding))) return 'STEP_UP_REQUIRED';
    }
    await tx
      .update(partners)
      .set({ deployKeyEnrollmentEnabled: input.enabled, updatedAt: new Date() })
      .where(eq(partners.id, input.partnerId));
    return { previous: current.enabled, enabled: input.enabled };
  }));
}

export interface ExpireByKeyResult {
  /** Devices the ledger records as enrolled with this key for this partner. */
  matched: number;
  expired: number;
  /** Already assigned, removed or gone. */
  skipped: number;
  failed: number;
}

/**
 * Expires, one device per transaction, every device whose `enrolled` ledger
 * row names `deployKeyId` under this partner and which is still parked. Each
 * expiry re-checks holding-org membership under the holding-area lock, so a
 * device assigned meanwhile is left alone.
 */
export async function expireDevicesParkedByDeployKey(input: {
  partnerId: string;
  deployKeyId: string;
  actorUserId: string;
}): Promise<ExpireByKeyResult> {
  const rows = await inSystemContext(() => db
    .selectDistinct({ deviceId: devicePoolAssignmentEvents.deviceId })
    .from(devicePoolAssignmentEvents)
    .where(and(
      eq(devicePoolAssignmentEvents.partnerId, input.partnerId),
      eq(devicePoolAssignmentEvents.deployKeyId, input.deployKeyId),
      eq(devicePoolAssignmentEvents.eventType, 'enrolled'),
    )));

  const result: ExpireByKeyResult = { matched: rows.length, expired: 0, skipped: 0, failed: 0 };
  for (const { deviceId } of rows) {
    try {
      const outcome = await expireParkedDevice({
        partnerId: input.partnerId,
        deviceId,
        actorUserId: input.actorUserId,
        reason: 'deploy_key_incident',
        deployKeyId: input.deployKeyId,
      });
      if (outcome.expired) result.expired += 1;
      else result.skipped += 1;
    } catch (err) {
      console.error(`[preAssignment] expiring parked device ${deviceId} for deploy key ${input.deployKeyId} failed:`, err);
      captureException(err);
      result.failed += 1;
    }
  }
  return result;
}
