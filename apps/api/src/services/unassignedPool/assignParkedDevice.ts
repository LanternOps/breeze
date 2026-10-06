/**
 * Parked-device assignment: moves a device out of its partner's holding org
 * into a real customer org and site, exactly once.
 *
 * One system-context transaction per device. Inside it, in this order:
 *   1. the per-partner holding-area advisory lock;
 *   2. the device row FOR UPDATE, re-verified as parked in THIS partner's
 *      holding org and still assignable (not decommissioned, quarantined,
 *      removal-draining or past its parking window);
 *   3. the destination org FOR SHARE — same partner, a real customer org,
 *      active or trial, not deleted — and a site of that org;
 *   4. the destination identity check (hostname within org + site);
 *   5. an unlocked licensed-capacity preview (refuse before spending a grant);
 *   6. the step-up grant (single: consumed here; bulk: consumed once for the
 *      batch before the first transaction, actor assurance re-locked here);
 *   7. the shared org-move engine, via 'pool_assignment';
 *   8. licensed-capacity admission under the partner row lock (assignment is
 *      when capacity is consumed; last, so that lock is held only to commit);
 *   9. the `assigned` ledger row.
 * Any refusal throws inside the transaction, so nothing is written.
 *
 * Only full partner admins (canManagePartnerWidePolicies) and system scope
 * may assign; the check is repeated here, not only in the route.
 */
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import type { AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies } from '../partnerWideAccess';
import {
  DevicePoolMembershipRefusedError,
  moveDeviceOrgInTransaction,
  OrgVanishedDuringMoveError,
  type MoveDeviceOrgResult,
} from '../deviceOrgMove/moveDeviceOrgInTransaction';
import { TicketMoveCurrencyBlockedError } from '../ticketMoveCurrencyGuard';
import { PamDeviceMoveBlockedError } from '../pamDeviceMoveGuard';
import { TicketServiceError } from '../ticketService';
import { isTransientLockError, pgErrorNode } from '../../utils/pgErrors';
import {
  admitPartnerDeviceCapacity,
  PartnerDeviceCapacityError,
  previewPartnerDeviceCapacity,
  type PartnerDeviceCapacityResult,
} from '../partnerDeviceCapacity';
import { lockActorAssurance } from '../stepUpActorAssurance';
import { consumeStepUpGrant, type StepUpGrantBinding } from '../mfaStepUpGrant';
import { isDeviceUninstallDraining } from '../deviceUninstallDrain';
import { requestDeviceGroupReevaluation } from '../../jobs/deviceGroupJobs';
import { invalidateOrgDeviceCount } from '../agentOrgRateLimit';
import { getRedis } from '../redis';
import { disconnectAgent } from '../../routes/agentWs';
import { raiseDeviceIdentityCollisionAlert } from '../deviceIdentityCollisionAlert';
import { writeAuditEvent, type RequestLike } from '../auditEvents';
import { schedulePeripheralPolicyDevice } from '../../jobs/peripheralJobs';
import { expireDiagnosticApprovalsForMovedDevice } from '../diagnosticAccess/deviceMove';
import { captureException } from '../sentry';
import { isUnassignedPoolOrgType } from './orgType';
import { isParkedDeviceExpired } from './limits';
import {
  findIdentityCollisions,
  lockDeviceForAssignment,
  lockLiveUserSession,
  lockPartnerHoldingArea,
  lockTargetOrg,
  siteBelongsToOrg,
  type AssignTx,
  type IdentityCollision,
} from './assignParkedDeviceSteps';
import { devicePoolAssignmentEvents } from '../../db/schema';
import type { DevicePoolAssignmentMethod } from '../../db/schema/devicePoolAssignmentEvents';

export type ParkedAssignRefusalCode =
  | 'PARTNER_WIDE_WRITE_DENIED'
  | 'DEVICE_NOT_FOUND'
  | 'DEVICE_NOT_PARKED'
  | 'DEVICE_NOT_ASSIGNABLE'
  | 'DEVICE_PARKING_EXPIRED'
  | 'TARGET_ORG_INVALID'
  | 'TARGET_SITE_INVALID'
  | 'DEVICE_IDENTITY_COLLISION'
  | 'PARTNER_DEVICE_LIMIT_REACHED'
  | 'STEP_UP_REQUIRED'
  // Refusals raised by the shared move engine after the grant was spent.
  | 'POOL_MEMBERSHIP_REFUSED'
  | 'TICKET_MOVE_CURRENCY_BLOCKED'
  | 'PAM_DEVICE_MOVE_BLOCKED'
  | 'DELIVERABLE_TICKET_PINNED'
  // Lost a lock race (a bounded lock wait timed out, or a deadlock victim):
  // nothing was written; retrying shortly succeeds.
  | 'ASSIGNMENT_BUSY'
  | 'ASSIGNMENT_FAILED';

const REFUSAL_MESSAGES: Record<ParkedAssignRefusalCode, string> = {
  PARTNER_WIDE_WRITE_DENIED: 'Assigning parked devices requires full partner org access',
  DEVICE_NOT_FOUND: 'Parked device not found',
  DEVICE_NOT_PARKED: 'This device is not waiting for assignment',
  DEVICE_NOT_ASSIGNABLE: 'This device is being removed and cannot be assigned',
  DEVICE_PARKING_EXPIRED: 'This device waited too long for assignment and has expired',
  TARGET_ORG_INVALID: 'Target organization cannot receive devices',
  TARGET_SITE_INVALID: 'Target site not found in the target organization',
  DEVICE_IDENTITY_COLLISION: 'A device with this hostname already exists at the target site',
  PARTNER_DEVICE_LIMIT_REACHED: 'Licensed device limit reached',
  STEP_UP_REQUIRED: 'Step-up required',
  POOL_MEMBERSHIP_REFUSED: 'This device cannot be moved this way',
  TICKET_MOVE_CURRENCY_BLOCKED: 'Tickets on this device bill in a different currency than the target organization',
  PAM_DEVICE_MOVE_BLOCKED: 'This device carries privileged-access history and cannot change organization',
  DELIVERABLE_TICKET_PINNED: 'A ticket on this device is pinned to a service deliverable',
  ASSIGNMENT_BUSY: 'Another change to this partner\'s devices is in progress. Try again in a moment',
  ASSIGNMENT_FAILED: 'Failed to assign device',
};

export interface ParkedAssignmentItem {
  deviceId: string;
  targetOrgId: string;
  targetSiteId: string;
  acceptIdentityCollision?: boolean;
}

export interface ParkedAssignmentActor {
  auth: AuthContext;
  /** The partner whose holding org is assigned from: the caller's own, or the explicit one a system caller named. */
  partnerId: string;
  /** The caller's site allowlist (undefined/null = unrestricted); the destination site must be in it. */
  allowedSiteIds: AuthContext['allowedSiteIds'];
}

export type ParkedAssignmentResult =
  | { ok: true; deviceId: string; targetOrgId: string; targetSiteId: string; ledgerEventId: string }
  | { ok: false; deviceId: string; code: ParkedAssignRefusalCode; message: string; collidingDeviceIds?: string[] };

/** Test seams; production callers never pass them. */
export interface AssignParkedDeviceHooks {
  afterDeviceLock?: (deviceId: string) => Promise<void>;
  afterLedgerInsert?: (deviceId: string) => Promise<void>;
}

class ParkedAssignmentRefusedError extends Error {
  constructor(
    readonly code: ParkedAssignRefusalCode,
    readonly collidingDeviceIds?: string[],
  ) {
    super(REFUSAL_MESSAGES[code]);
    this.name = 'ParkedAssignmentRefusedError';
  }
}

type StepUpMode =
  | { kind: 'consume'; grantId: string; binding: StepUpGrantBinding }
  | { kind: 'actor_only'; grantId: string; binding: StepUpGrantBinding }
  | { kind: 'none' };

interface Committed {
  item: ParkedAssignmentItem;
  agentId: string;
  hostname: string;
  holdingOrgId: string;
  ledgerEventId: string;
  collisions: IdentityCollision[];
  move: MoveDeviceOrgResult;
}

const ASSIGNABLE_TARGET_STATUSES = new Set(['active', 'trial']);
const NON_ASSIGNABLE_TARGET_TYPES = new Set(['unassigned_pool', 'quick_support']);

/**
 * The `assigned` ledger row, written inside the assignment transaction so it
 * exists iff the move committed. Reached only from the two exported entry
 * points below, both gated on canManagePartnerWidePolicies.
 */
async function insertAssignedLedgerRow(
  tx: AssignTx,
  input: {
    partnerId: string;
    deviceId: string;
    deviceAgentId: string;
    fromOrgId: string;
    toOrgId: string;
    assignmentMethod: DevicePoolAssignmentMethod;
    assignedByUserId: string;
    stepUpGrantRef: string | null;
    parkedAt: Date;
    parkedDurationSeconds: number;
  },
): Promise<string> {
  const [row] = await tx
    .insert(devicePoolAssignmentEvents)
    .values({ ...input, eventType: 'assigned' })
    .returning({ id: devicePoolAssignmentEvents.id });
  if (!row) throw new Error('assigned ledger row was not written');
  return row.id;
}

function refusal(deviceId: string, code: ParkedAssignRefusalCode, collidingDeviceIds?: string[]): ParkedAssignmentResult {
  return {
    ok: false,
    deviceId,
    code,
    message: REFUSAL_MESSAGES[code],
    ...(collidingDeviceIds ? { collidingDeviceIds } : {}),
  };
}

async function assignInTransaction(
  tx: AssignTx,
  ctx: {
    actor: ParkedAssignmentActor;
    item: ParkedAssignmentItem;
    method: DevicePoolAssignmentMethod;
    stepUp: StepUpMode;
    hooks?: AssignParkedDeviceHooks;
  },
): Promise<Committed> {
  const { actor, item, stepUp, hooks } = ctx;

  await lockPartnerHoldingArea(tx, actor.partnerId);

  const device = await lockDeviceForAssignment(tx, item.deviceId);
  if (!device || device.orgPartnerId !== actor.partnerId) {
    throw new ParkedAssignmentRefusedError('DEVICE_NOT_FOUND');
  }
  if (!isUnassignedPoolOrgType(device.orgType)) {
    throw new ParkedAssignmentRefusedError('DEVICE_NOT_PARKED');
  }
  if (device.status === 'decommissioned' || device.status === 'quarantined') {
    throw new ParkedAssignmentRefusedError('DEVICE_NOT_ASSIGNABLE');
  }
  if (await isDeviceUninstallDraining(device.id)) {
    throw new ParkedAssignmentRefusedError('DEVICE_NOT_ASSIGNABLE');
  }
  const now = Date.now();
  const parkedMs = now - device.createdAt.getTime();
  if (isParkedDeviceExpired(device.createdAt, now)) {
    throw new ParkedAssignmentRefusedError('DEVICE_PARKING_EXPIRED');
  }
  await hooks?.afterDeviceLock?.(device.id);

  const target = await lockTargetOrg(tx, item.targetOrgId);
  if (
    !target
    || target.partnerId !== actor.partnerId
    || NON_ASSIGNABLE_TARGET_TYPES.has(target.type)
    || !ASSIGNABLE_TARGET_STATUSES.has(target.status)
    || target.deletedAt !== null
  ) {
    throw new ParkedAssignmentRefusedError('TARGET_ORG_INVALID');
  }
  if (!(await siteBelongsToOrg(tx, item.targetSiteId, target.id))) {
    throw new ParkedAssignmentRefusedError('TARGET_SITE_INVALID');
  }
  // A site-restricted caller may assign only into a site they hold.
  if (Array.isArray(actor.allowedSiteIds) && !actor.allowedSiteIds.includes(item.targetSiteId)) {
    throw new ParkedAssignmentRefusedError('TARGET_SITE_INVALID');
  }

  const collisions = await findIdentityCollisions(tx, {
    hostname: device.hostname,
    orgId: target.id,
    siteId: item.targetSiteId,
  });
  if (collisions.length > 0 && item.acceptIdentityCollision !== true) {
    throw new ParkedAssignmentRefusedError('DEVICE_IDENTITY_COLLISION', collisions.map((c) => c.id));
  }

  // Early, unlocked capacity read: a partner already at its cap is refused
  // before a step-up grant is spent. The locked admission comes after the move.
  await admitOrRefuse(() => previewPartnerDeviceCapacity(tx, { orgId: target.id, expectedPartnerId: actor.partnerId }));

  if (stepUp.kind !== 'none') {
    // The actor's auth state AND the signed-in session the grant was minted in
    // are both locked and re-checked in every transaction, so revoking the
    // session (or a factor change) stops the remaining items of a batch.
    const assured = await lockActorAssurance(tx, actor.auth, stepUp.binding)
      && await lockLiveUserSession(tx, { userId: actor.auth.user.id, sid: stepUp.binding.sid });
    if (!assured || (stepUp.kind === 'consume' && !(await consumeStepUpGrant(stepUp.grantId, stepUp.binding)))) {
      throw new ParkedAssignmentRefusedError('STEP_UP_REQUIRED');
    }
  }

  const move = await moveDeviceOrgInTransaction(tx, {
    deviceId: device.id,
    sourceOrgId: device.orgId,
    targetOrgId: target.id,
    targetSiteId: item.targetSiteId,
    targetOrgName: target.name,
    deviceLinkGroupId: device.linkGroupId,
    acceptCurrencyMismatch: false,
    actor: { userId: actor.auth.user.id, allowedSiteIds: actor.allowedSiteIds },
    // The grant was already handled above, under the holding-area lock.
    stepUp: null,
    via: 'pool_assignment',
  });

  // Assignment is the moment the device starts consuming licensed capacity.
  // Admitted LAST, after the move: the partner row lock this takes (FOR
  // UPDATE, shared with every enrollment and provisioning path of the
  // partner) is then held only through the ledger insert and commit, not
  // through the move engine. The moved device is left out of the count, so
  // the question is still "may one more device be added". Concurrent
  // assignments are serialised earlier by the holding-area lock.
  await admitOrRefuse(() => admitPartnerDeviceCapacity(tx, {
    orgId: target.id,
    expectedPartnerId: actor.partnerId,
    excludeDeviceId: device.id,
  }));

  const ledgerEventId = await insertAssignedLedgerRow(tx, {
    partnerId: actor.partnerId,
    deviceId: device.id,
    deviceAgentId: device.agentId,
    fromOrgId: device.orgId,
    toOrgId: target.id,
    assignmentMethod: ctx.method,
    assignedByUserId: actor.auth.user.id,
    stepUpGrantRef: stepUp.kind === 'none' ? null : stepUp.grantId,
    parkedAt: device.createdAt,
    parkedDurationSeconds: Math.max(0, Math.floor(parkedMs / 1000)),
  });
  await hooks?.afterLedgerInsert?.(device.id);

  return {
    item,
    agentId: device.agentId,
    hostname: device.hostname,
    holdingOrgId: device.orgId,
    ledgerEventId,
    collisions,
    move,
  };
}

async function admitOrRefuse(check: () => Promise<PartnerDeviceCapacityResult>): Promise<void> {
  let admission: PartnerDeviceCapacityResult;
  try {
    admission = await check();
  } catch (err) {
    if (err instanceof PartnerDeviceCapacityError) throw new ParkedAssignmentRefusedError('TARGET_ORG_INVALID');
    throw err;
  }
  if (!admission.allowed) throw new ParkedAssignmentRefusedError('PARTNER_DEVICE_LIMIT_REACHED');
}

/**
 * The move engine's own refusals, as assignment refusals. They roll the
 * transaction back like any other refusal; they are answers, not failures.
 */
function engineRefusal(err: unknown): ParkedAssignmentRefusedError | null {
  if (err instanceof DevicePoolMembershipRefusedError) return new ParkedAssignmentRefusedError('POOL_MEMBERSHIP_REFUSED');
  if (err instanceof OrgVanishedDuringMoveError) {
    return new ParkedAssignmentRefusedError(err.which === 'target' ? 'TARGET_ORG_INVALID' : 'DEVICE_NOT_FOUND');
  }
  if (err instanceof TicketMoveCurrencyBlockedError) return new ParkedAssignmentRefusedError('TICKET_MOVE_CURRENCY_BLOCKED');
  if (err instanceof PamDeviceMoveBlockedError) return new ParkedAssignmentRefusedError('PAM_DEVICE_MOVE_BLOCKED');
  if (err instanceof TicketServiceError && err.code === 'DELIVERABLE_TICKET_PINNED') {
    return new ParkedAssignmentRefusedError('DELIVERABLE_TICKET_PINNED');
  }
  // The partner row lock (capacity admission) and the device lifecycle locks
  // are taken with a bounded lock_timeout; losing that wait, or being chosen
  // as a deadlock victim, rolled everything back and is worth a retry.
  if (isTransientLockError(err)) return new ParkedAssignmentRefusedError('ASSIGNMENT_BUSY');
  const pgNode = pgErrorNode(err);
  // eslint-disable-next-line breeze/no-direct-sqlstate -- Driver node already unwrapped by pgErrorNode.
  if (pgNode?.code === '23514' && pgNode.constraint_name === 'devices_pam_history_move_guard') {
    return new ParkedAssignmentRefusedError('PAM_DEVICE_MOVE_BLOCKED');
  }
  return null;
}

async function runOne(
  ctx: Parameters<typeof assignInTransaction>[1],
): Promise<Committed> {
  try {
    return await runOutsideDbContext(() =>
      withSystemDbAccessContext(() => db.transaction((tx) => assignInTransaction(tx, ctx))),
    );
  } catch (err) {
    throw engineRefusal(err) ?? err;
  }
}

/**
 * Runs one post-commit effect; a throw or a rejected promise is logged and
 * reported, never propagated.
 */
function safely(deviceId: string, label: string, effect: () => unknown): void {
  const report = (err: unknown) => {
    console.error(`[parkedAssignment] post-commit ${label} failed for ${deviceId}:`, err);
    captureException(err);
  };
  try {
    const result = effect();
    if (result instanceof Promise) result.catch(report);
  } catch (err) {
    report(err);
  }
}

/**
 * Post-commit effects. Never throws: the assignment has already committed, so
 * no effect here may turn it into a reported failure. Each effect is isolated;
 * the audit event goes first.
 */
function afterCommit(
  committed: Committed,
  actor: ParkedAssignmentActor,
  method: DevicePoolAssignmentMethod,
  stepUpUsed: boolean,
  audit: RequestLike,
): void {
  const { item } = committed;
  const collidingDeviceIds = committed.collisions.map((c) => c.id);

  safely(item.deviceId, 'audit', () => {
    const { customFieldRehome } = committed.move;
    writeAuditEvent(audit, {
      orgId: item.targetOrgId,
      action: 'device.parked.assigned',
      resourceType: 'device',
      resourceId: item.deviceId,
      resourceName: committed.hostname,
      actorId: actor.auth.user.id,
      actorEmail: actor.auth.user.email,
      details: {
        partnerId: actor.partnerId,
        fromOrgId: committed.holdingOrgId,
        toOrgId: item.targetOrgId,
        targetSiteId: item.targetSiteId,
        method,
        possessionConfirmed: true,
        stepUp: stepUpUsed ? 'grant' : 'disabled_2fa',
        ledgerEventId: committed.ledgerEventId,
        ...(collidingDeviceIds.length > 0 ? { identityCollisionAccepted: true, collidingDeviceIds } : {}),
        ...(customFieldRehome.rehomed > 0 || customFieldRehome.dropped > 0 ? { customFieldValues: customFieldRehome } : {}),
      },
    });
  });
  safely(item.deviceId, 'group re-evaluation', () => {
    return requestDeviceGroupReevaluation({
      deviceId: item.deviceId,
      orgId: item.targetOrgId,
      eventType: 'device.updated',
      reason: 'parked_device_assigned',
    });
  });
  safely(item.deviceId, 'device-count cache invalidation', () => {
    const redis = getRedis();
    return Promise.all([
      invalidateOrgDeviceCount(redis, committed.holdingOrgId),
      invalidateOrgDeviceCount(redis, item.targetOrgId),
    ]);
  });
  safely(item.deviceId, 'diagnostic approval expiry', () => {
    void expireDiagnosticApprovalsForMovedDevice(item.deviceId).catch((error) => {
      console.error(`[parkedAssignment] failed to expire diagnostic access approvals for ${item.deviceId}:`, error);
    });
  });
  safely(item.deviceId, 'peripheral reconciliation', () => {
    void schedulePeripheralPolicyDevice(item.deviceId, 'device_org_changed').catch((error) => {
      console.error(`[parkedAssignment] failed to schedule peripheral reconciliation for ${item.deviceId}:`, error);
    });
  });
  // The agent reconnects and authenticates as an ordinary device of its new org.
  safely(item.deviceId, 'agent disconnect', () => {
    disconnectAgent(committed.agentId, 4040, 'device assigned to an organization, reconnecting');
  });

  if (collidingDeviceIds.length > 0) {
    const existing = committed.collisions.find((c) => c.status === 'online') ?? committed.collisions[0]!;
    // Its own fresh system context, never a caller's: alert creation does
    // Redis/BullMQ work that must not run inside any open transaction.
    safely(item.deviceId, 'identity-collision alert', () => {
      runOutsideDbContext(() => withSystemDbAccessContext(() => raiseDeviceIdentityCollisionAlert({
        orgId: item.targetOrgId,
        siteId: item.targetSiteId,
        hostname: committed.hostname,
        newDeviceId: item.deviceId,
        existingDeviceId: existing.id,
        collidingDeviceIds,
      }))).catch((err) => {
        console.error(`[parkedAssignment] failed to raise identity-collision alert for ${item.deviceId}:`, err);
      });
    });
  }
}

function toResult(committed: Committed): ParkedAssignmentResult {
  return {
    ok: true,
    deviceId: committed.item.deviceId,
    targetOrgId: committed.item.targetOrgId,
    targetSiteId: committed.item.targetSiteId,
    ledgerEventId: committed.ledgerEventId,
  };
}

/**
 * Assign one parked device. `stepUp` is the caller's validated binding (null
 * when two-factor authentication is off on this deployment); the grant is
 * consumed inside the transaction. Refusals are returned; unexpected errors
 * propagate.
 */
export async function assignParkedDevice(
  input: {
    actor: ParkedAssignmentActor;
    item: ParkedAssignmentItem;
    stepUp: { grantId: string; binding: StepUpGrantBinding } | null;
    audit: RequestLike;
  },
  options: { hooks?: AssignParkedDeviceHooks } = {},
): Promise<ParkedAssignmentResult> {
  const { actor, item } = input;
  if (!canManagePartnerWidePolicies(actor.auth)) return refusal(item.deviceId, 'PARTNER_WIDE_WRITE_DENIED');
  const stepUp: StepUpMode = input.stepUp ? { kind: 'consume', ...input.stepUp } : { kind: 'none' };
  let committed: Committed;
  try {
    committed = await runOne({ actor, item, method: 'manual', stepUp, hooks: options.hooks });
  } catch (err) {
    if (err instanceof ParkedAssignmentRefusedError) return refusal(item.deviceId, err.code, err.collidingDeviceIds);
    throw err;
  }
  afterCommit(committed, actor, 'manual', input.stepUp !== null, input.audit);
  return toResult(committed);
}

/**
 * Assign a batch. One step-up grant covers exactly this batch and is consumed
 * once, before the first device; each device then runs in its own independent
 * transaction (re-locking the actor's assurance), so one refusal never undoes
 * another device's assignment. Results are per item, in request order.
 */
export async function assignParkedDevicesBulk(
  input: {
    actor: ParkedAssignmentActor;
    items: ParkedAssignmentItem[];
    stepUp: { grantId: string; binding: StepUpGrantBinding } | null;
    audit: RequestLike;
  },
  options: { hooks?: AssignParkedDeviceHooks } = {},
): Promise<{ ok: true; results: ParkedAssignmentResult[] } | { ok: false; code: 'PARTNER_WIDE_WRITE_DENIED' | 'STEP_UP_REQUIRED' }> {
  const { actor } = input;
  if (!canManagePartnerWidePolicies(actor.auth)) return { ok: false, code: 'PARTNER_WIDE_WRITE_DENIED' };
  if (input.stepUp && !(await consumeStepUpGrant(input.stepUp.grantId, input.stepUp.binding))) {
    return { ok: false, code: 'STEP_UP_REQUIRED' };
  }
  const stepUp: StepUpMode = input.stepUp ? { kind: 'actor_only', ...input.stepUp } : { kind: 'none' };

  const results: ParkedAssignmentResult[] = [];
  for (const item of input.items) {
    let committed: Committed;
    try {
      committed = await runOne({ actor, item, method: 'bulk', stepUp, hooks: options.hooks });
    } catch (err) {
      if (err instanceof ParkedAssignmentRefusedError) {
        results.push(refusal(item.deviceId, err.code, err.collidingDeviceIds));
        continue;
      }
      console.error(`[parkedAssignment] bulk item ${item.deviceId} failed:`, err);
      captureException(err);
      results.push(refusal(item.deviceId, 'ASSIGNMENT_FAILED'));
      continue;
    }
    // Outside the try: the device has moved, whatever post-commit work does.
    results.push(toResult(committed));
    afterCommit(committed, actor, 'bulk', input.stepUp !== null, input.audit);
  }
  return { ok: true, results };
}
