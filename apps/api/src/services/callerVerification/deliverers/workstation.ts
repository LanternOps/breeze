/**
 * Workstation-tier delivery for caller verification (#6354 W02).
 *
 * Two halves, matching the W01 ports:
 *
 *  - `prepareWorkstationVerification` runs INSIDE `start`'s transaction
 *    (`ports.prepare`). It re-checks the technician-selected device and OS
 *    username against live helper readiness and partner trust, then persists
 *    the `caller_verify` device command and links it to the verification —
 *    all on the caller's transaction, so a rolled-back start leaves neither.
 *    It never sends anything.
 *
 *  - `deliverWorkstation` runs AFTER commit from the publisher
 *    (`ports.deliver`). Short system read → claim → transport with no DB
 *    context held → (release). It only ever pushes the pre-created command
 *    id, so a publisher retry can never mint a second prompt. An agent that
 *    is only reachable by HTTP polling claims the same row on its next
 *    heartbeat, before `deliverBy` (= the verification's expiry).
 */
import { randomInt } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { db, assertInTransaction, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { deviceCommands, devices, organizations } from '../../../db/schema';
import { callerVerifications as v } from '../../../db/schema/callerVerification';
import { callerVerificationEnabled } from '../../../config/env';
import { assertDeviceExecuteAllowed, TrustDeniedError } from '../../partnerTrust.commands';
import { isParkedDevice } from '../../unassignedPool/deliveryEligibility';
import { claimPendingCommandForDelivery, releaseClaimedCommandDelivery } from '../../commandDispatch';
import { dispatchCommandToAgent } from '../../agentCommandRelay';
import { captureException } from '../../sentry';
import { CallerVerificationValidationError as Invalid } from '../errors';
import type { CallerVerificationActionScope, VerificationRow } from '../types';
import { workstationReadiness } from '../workstationCapabilities';
import {
  CALLER_VERIFY_COMMAND,
  WORKSTATION_TIMEOUT_MAX_MS,
  WORKSTATION_TIMEOUT_MIN_MS,
  workstationCommandSchema,
  type WorkstationCommand,
} from '../workstationProtocol';

/** English action phrase for the card ("… wants to <action> for <target>"). */
export function workstationActionLabel(scope: CallerVerificationActionScope): string {
  return scope === 'reset_password' ? 'reset the password'
    : scope === 'disable_user' ? 'disable the account'
      : 'confirm a support request';
}

function shuffledChoices(match: string, decoys: string[]): [string, string, string] {
  const values = [match, ...decoys];
  for (let i = values.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [values[i], values[j]] = [values[j]!, values[i]!];
  }
  return values as [string, string, string];
}

export async function prepareWorkstationVerification(row: VerificationRow): Promise<void> {
  assertInTransaction('callerVerification.prepareWorkstation');
  if (!row.workstationDeviceRef || !row.osUsername) {
    throw new Invalid('device_required', 'Workstation requires device and username');
  }
  // Under the caller's (org-scoped) transaction: a device this context cannot
  // see, or one that moved org or went offline, is simply not found.
  const [device] = await db.select({ id: devices.id }).from(devices)
    .where(and(eq(devices.id, row.workstationDeviceRef), eq(devices.orgId, row.orgId), eq(devices.status, 'online')))
    .limit(1);
  if (!device) throw new Invalid('not_found', 'Device not found');
  // The selected device+user must be reporting a ready helper right now,
  // whether it was suggested or picked by hand. The agent re-checks again.
  const readiness = await workstationReadiness(row.orgId, [device.id]);
  if (!readiness) throw new Invalid('readiness_unavailable', 'Helper readiness cannot be checked right now');
  if (!readiness.get(device.id)?.includes(row.osUsername)) {
    throw new Invalid('helper_outdated', 'No compatible console helper for that user');
  }
  try {
    await assertDeviceExecuteAllowed(device.id, CALLER_VERIFY_COMMAND, row.initiatedByUserId);
  } catch (err) {
    if (err instanceof TrustDeniedError) throw new Invalid('trust_denied', 'Partner trust does not allow this command');
    throw err;
  }
  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, row.orgId)).limit(1);
  if (!org) throw new Invalid('not_found', 'Organization not found');

  const choices = shuffledChoices(row.matchValue, row.decoyValues);
  const lifetimeMs = row.expiresAt.getTime() - row.createdAt.getTime();
  const parsed = workstationCommandSchema.safeParse({
    verificationId: row.id,
    username: row.osUsername,
    technicianName: row.technicianLabel.trim().slice(0, 255),
    orgName: org.name.trim().slice(0, 255),
    actionLabel: workstationActionLabel(row.actionScope),
    targetLabel: (row.targetLabel ?? row.osUsername).slice(0, 320),
    reverseCode: row.reverseCode,
    choices,
    timeoutMs: Math.max(WORKSTATION_TIMEOUT_MIN_MS, Math.min(WORKSTATION_TIMEOUT_MAX_MS, lifetimeMs)),
  });
  // A label the card cannot carry (empty technician name, over-long username)
  // is a request error, not a 500.
  if (!parsed.success) throw new Invalid('invalid_request', 'Workstation challenge cannot be built from this request');
  const payload: WorkstationCommand = parsed.data;

  // Inserted directly on the caller's transaction. Not through queueCommand:
  // that module statically reaches the socket registry, which would drag
  // socket-local dispatch into the global publisher worker's closure. The
  // checks it would add are made explicitly here: partner trust (above), the
  // parked-device refusal (below), and created_by is the initiating
  // technician, a real users row by construction.
  if (await isParkedDevice(db, device.id)) throw new Invalid('not_found', 'Device not found');
  const [command] = await db.insert(deviceCommands).values({
    deviceId: device.id,
    type: CALLER_VERIFY_COMMAND,
    targetRole: 'agent',
    status: 'pending',
    payload,
    createdBy: row.initiatedByUserId,
    submittedOrgId: row.orgId,
    deliverBy: row.expiresAt,
  }).returning({ id: deviceCommands.id });
  if (!command) throw new Error('caller verification command insert returned no row');
  const linked = await db.update(v).set({ agentCommandId: command.id, challengeChoices: choices })
    .where(and(eq(v.id, row.id), eq(v.orgId, row.orgId), eq(v.status, 'pending')))
    .returning({ id: v.id });
  if (linked.length !== 1) throw new Error('caller verification command link failed');
}

const system = <T>(fn: () => Promise<T>, label: string) =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

export async function deliverWorkstation(verificationId: string): Promise<void> {
  // New prompts are not pushed while the feature is off; the pending row then
  // expires through the publisher. Results already issued are still applied.
  if (!callerVerificationEnabled()) return;
  const [row] = await system(() => db.select({
    id: v.id, commandId: deviceCommands.id, payload: deviceCommands.payload, agentId: devices.agentId,
  }).from(v)
    .innerJoin(deviceCommands, and(
      eq(deviceCommands.id, v.agentCommandId),
      eq(deviceCommands.type, CALLER_VERIFY_COMMAND),
      eq(deviceCommands.status, 'pending'),
    ))
    .innerJoin(devices, and(eq(devices.id, deviceCommands.deviceId), eq(devices.orgId, v.orgId)))
    .where(and(eq(v.id, verificationId), eq(v.method, 'workstation'), eq(v.status, 'pending'), gt(v.expiresAt, new Date())))
    .limit(1), 'callerVerification.deliverWorkstation.load');
  if (!row) return; // no longer pending, expired, cancelled or moved: nothing to push
  if (!row.agentId) {
    // Prepare accepted an online device; an agentless one here is a data fault.
    console.error('[callerVerification] workstation device has no agent id; leaving the command for expiry', { verificationId });
    captureException(new Error('caller verification workstation device has no agent id'), undefined, { verificationId });
    return;
  }
  const payload = workstationCommandSchema.parse(row.payload);

  // Same claim-time eligibility the heartbeat claim applies; only a claimed
  // row is pushed. held / not_claimable stay pending for the heartbeat;
  // cancelled is terminal and reconciliation settles the verification.
  const claim = await system(() => claimPendingCommandForDelivery(row.commandId), 'callerVerification.deliverWorkstation.claim');
  if (claim.status !== 'claimed') return;

  const outcome = await dispatchCommandToAgent(row.agentId, { id: row.commandId, type: CALLER_VERIFY_COMMAND, payload });
  if (outcome.status === 'sent' || outcome.status === 'indeterminate') {
    // Indeterminate: the frame may have reached the agent. Releasing it could
    // show a second prompt; the result or the expiry settles it instead.
    return;
  }
  await system(() => releaseClaimedCommandDelivery(row.commandId, claim.executedAt), 'callerVerification.deliverWorkstation.release');
  if (outcome.status === 'infrastructure_error') throw new Error(`caller_verify dispatch failed: ${outcome.message}`);
  if (outcome.status === 'owner_mismatch') {
    console.warn('[callerVerification] workstation dispatch owner mismatch; released for heartbeat delivery', { verificationId });
  }
  // offline / expired / owner_mismatch: a polling agent claims it on its next heartbeat.
}
