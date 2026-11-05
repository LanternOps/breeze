/**
 * The single dispatch seam for the vendor update command (#11065).
 *
 * The only caller of the queue for `oem_update_run`
 * (`oemUpdateExposure.contract.test.ts`). The Run Now route (W04) and the
 * scheduler (W07) both come through here, so a run reaches a device only when
 * every lock is open at send time: the env flag, the manifest gates, the kill
 * switches and the minimum agent version. The claim rechecks what can change
 * while a row waits (`revalidation.ts`).
 *
 * The caller authorizes the actor and supplies `expectedOrgId`; the device is
 * read under system scope, so that org check is what keeps a moved or foreign
 * device out. Runs on its own transaction and pushes to the socket after commit,
 * because a fast agent can answer before an open transaction would be visible.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  agentSupportsOemUpdates,
  OEM_LANES,
  oemUpdateRunPayloadSchema,
  type OemCategory,
  type OemLane,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  deviceCommands,
  deviceHardware,
  deviceOemUpdateStatus,
  deviceRecoveryKeys,
  devices,
  organizations,
} from '../../db/schema';
import { CommandTypes } from '../commandTypes';
import { dispatchDeviceCommand, type DispatchDeviceCommandResult } from '../dispatchDeviceCommand';
import { isUnassignedPoolOrgType } from '../unassignedPool/orgType';
import { resolveApplicability } from './applicability';
import { laneDisabledByKillSwitch, oemUpdatesEnabled } from './flags';
import {
  getLaneManifest,
  isLaneOpen,
  openCategoriesForLane,
  payloadToolFor,
  SHIPPED_OEM_LANES,
} from './toolManifest';

export type OemDispatchInput = {
  deviceId: string;
  /** The org the decision was made under. A device that has moved since gets nothing. */
  expectedOrgId: string;
  trigger: 'scheduled' | 'on_demand';
  requestedCategories: OemCategory[];
  blockedUpdateIds: string[];
  /** False skips bios and firmware: they need a reboot Breeze controls (spec 4.5). */
  rebootControlled: boolean;
  /** The agent refuses to start after this, and the row stops being deliverable. */
  notAfter: Date;
  occurrenceKey: string | null;
  actorUserId: string | null;
};

export type OemDispatchRefusal =
  | 'flag_off'
  | 'lane_closed'
  | 'kill_switch'
  | 'agent_too_old'
  | 'not_applicable'
  | 'not_supported'
  | 'ephemeral'
  | 'parked'
  | 'offline'
  | 'run_in_flight'
  | 'no_open_categories'
  /** Unknown id, or a device no longer in `expectedOrgId`. */
  | 'device_not_found'
  | 'decommissioned'
  | 'trust_denied'
  /** Queued, then terminalised by the socket push's own claim-time eligibility. */
  | 'cancelled_at_claim';

export type OemDispatchResult =
  | { ok: true; commandId: string; categories: OemCategory[] }
  | { ok: false; refusal: OemDispatchRefusal };

/** A BIOS or firmware run that has not shown the device came back within this raises an alert. */
export const OEM_RETURN_DEADLINE_MS = 24 * 60 * 60 * 1000;

const FLASH_CATEGORIES: ReadonlySet<OemCategory> = new Set(['bios', 'firmware']);
const MAX_ESCROWED_PROTECTORS = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** BitLocker reports a protector id as a braced uppercase GUID; the wire contract is a uuid. */
function protectorUuid(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw.trim().replace(/^\{/, '').replace(/\}$/, '').toLowerCase();
  return UUID.test(value) ? value : null;
}

/** Sticky until the tool version or the model changes: each is a new question (spec 4.3). */
function stillNotSupported(
  status: { applicability: string; notSupportedToolVersion: string | null; notSupportedModel: string | null } | undefined,
  lane: OemLane,
  model: string | null,
): boolean {
  if (status?.applicability !== 'not_supported') return false;
  const currentTool = getLaneManifest(lane).tool?.version ?? null;
  return status.notSupportedToolVersion === currentTool && status.notSupportedModel === model;
}

function refusalForEnqueueCode(code: Extract<DispatchDeviceCommandResult, { ok: false }>['code']): OemDispatchRefusal {
  switch (code) {
    case 'device_not_found':
      return 'device_not_found';
    case 'device_offline':
      return 'offline';
    case 'device_decommissioned':
      return 'decommissioned';
    case 'device_pending_assignment':
      return 'parked';
    case 'trust_denied':
      return 'trust_denied';
    case 'backup_helper_update_required':
      // A backup-only refusal; this type cannot reach it. Refuse rather than assume.
      return 'not_applicable';
  }
}

type Prepared =
  | { ok: false; refusal: OemDispatchRefusal }
  | { ok: true; commandId: string; categories: OemCategory[]; dispatched: Extract<DispatchDeviceCommandResult, { ok: true }> };

async function prepareRun(input: OemDispatchInput): Promise<Prepared> {
  const [device] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      partnerId: organizations.partnerId,
      orgType: organizations.type,
      status: devices.status,
      agentVersion: devices.agentVersion,
      osType: devices.osType,
      isVirtual: devices.isVirtual,
      isEphemeral: devices.isEphemeral,
      deviceRole: devices.deviceRole,
      manufacturer: deviceHardware.manufacturer,
      model: deviceHardware.model,
      biosVersion: deviceHardware.biosVersion,
    })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .leftJoin(deviceHardware, eq(deviceHardware.deviceId, devices.id))
    .where(eq(devices.id, input.deviceId))
    .limit(1);

  if (!device || device.orgId !== input.expectedOrgId) return { ok: false, refusal: 'device_not_found' };
  if (!oemUpdatesEnabled(device.partnerId)) return { ok: false, refusal: 'flag_off' };
  if (device.isEphemeral) return { ok: false, refusal: 'ephemeral' };
  if (isUnassignedPoolOrgType(device.orgType)) return { ok: false, refusal: 'parked' };
  if (device.status === 'decommissioned') return { ok: false, refusal: 'decommissioned' };

  const applicability = resolveApplicability({
    osType: device.osType,
    isVirtual: device.isVirtual,
    deviceRole: device.deviceRole,
    manufacturer: device.manufacturer ?? null,
    model: device.model ?? null,
    // Run Now works with or without a policy, and the scheduler has already
    // resolved its link: only the shipped lanes narrow here.
    enabledLanes: OEM_LANES,
    shippedLanes: SHIPPED_OEM_LANES,
  });
  if (applicability.state !== 'applicable') return { ok: false, refusal: 'not_applicable' };
  const { lane } = applicability;

  if (laneDisabledByKillSwitch(lane)) return { ok: false, refusal: 'kill_switch' };
  const gateScope = { deviceId: device.id };
  if (!isLaneOpen(lane, gateScope)) return { ok: false, refusal: 'lane_closed' };
  if (!agentSupportsOemUpdates(device.agentVersion)) return { ok: false, refusal: 'agent_too_old' };

  const [status] = await db
    .select({
      applicability: deviceOemUpdateStatus.applicability,
      notSupportedToolVersion: deviceOemUpdateStatus.notSupportedToolVersion,
      notSupportedModel: deviceOemUpdateStatus.notSupportedModel,
    })
    .from(deviceOemUpdateStatus)
    .where(eq(deviceOemUpdateStatus.deviceId, device.id))
    .limit(1);
  if (stillNotSupported(status, lane, device.model ?? null)) return { ok: false, refusal: 'not_supported' };

  const open = new Set(openCategoriesForLane(lane, gateScope));
  const categories = [...new Set(input.requestedCategories)].filter((category) =>
    open.has(category) && (input.rebootControlled || !FLASH_CATEGORIES.has(category)));
  if (categories.length === 0) return { ok: false, refusal: 'no_open_categories' };

  // The seam's own policy is `reject`. It is overridden only to carry a deadline
  // on the row, so online is checked here: maintenance mode does not count, the
  // same definition of online the enqueue seam uses.
  if (device.status !== 'online') return { ok: false, refusal: 'offline' };

  const deliverWithinMs = input.notAfter.getTime() - Date.now();
  if (deliverWithinMs <= 0) {
    throw new RangeError(`oem_update_run dispatch with notAfter in the past (${input.notAfter.toISOString()})`);
  }

  // One run per device. There is no unique index to lean on, since device_commands
  // holds every type, so two dispatches serialize on the device for this transaction.
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`oem_update_run:${device.id}`}, 0))`);
  const inFlight = await db
    .select({ commandId: deviceCommands.id })
    .from(deviceCommands)
    .where(and(
      eq(deviceCommands.deviceId, device.id),
      eq(deviceCommands.type, CommandTypes.OEM_UPDATE_RUN),
      inArray(deviceCommands.status, ['pending', 'sent']),
    ))
    .limit(1);
  if (inFlight.length > 0) return { ok: false, refusal: 'run_in_flight' };

  // Ids only. The key material stays in the vault, and the agent uses these to
  // confirm a recovery key for the volume's current protector is already escrowed.
  const keys = await db
    .select({ protectorId: deviceRecoveryKeys.protectorId })
    .from(deviceRecoveryKeys)
    .where(and(
      eq(deviceRecoveryKeys.deviceId, device.id),
      eq(deviceRecoveryKeys.status, 'active'),
      eq(deviceRecoveryKeys.keyType, 'bitlocker_recovery_password'),
    ))
    .limit(MAX_ESCROWED_PROTECTORS);

  const payload = oemUpdateRunPayloadSchema.parse({
    lane,
    trigger: input.trigger,
    occurrenceKey: input.occurrenceKey,
    categories,
    blockedUpdateIds: input.blockedUpdateIds,
    rebootControlled: input.rebootControlled,
    notAfter: input.notAfter.toISOString(),
    escrowedProtectorIds: keys.flatMap(({ protectorId }) => protectorUuid(protectorId) ?? []),
    tool: payloadToolFor(getLaneManifest(lane)),
  });

  const dispatched = await dispatchDeviceCommand({
    deviceId: device.id,
    type: CommandTypes.OEM_UPDATE_RUN,
    payload,
    ...(input.actorUserId ? { userId: input.actorUserId } : {}),
    expectedOrgId: input.expectedOrgId,
    offlinePolicy: { kind: 'queue', deliverWithinMs },
    deferDelivery: true,
  });
  if (!dispatched.ok) return { ok: false, refusal: refusalForEnqueueCode(dispatched.code) };

  // A BIOS or firmware run arms the not-returned monitor. A driver-only run leaves
  // an armed monitor from an earlier flash alone.
  const now = new Date();
  const armed = categories.some((category) => FLASH_CATEGORIES.has(category))
    ? {
        biosVersionBefore: device.biosVersion ?? null,
        runStartedAt: now,
        returnDeadlineAt: new Date(now.getTime() + OEM_RETURN_DEADLINE_MS),
        notReturnedAlertedAt: null,
      }
    : {};
  const run = {
    lane,
    applicability: 'applicable' as const,
    reason: null,
    lastAttemptAt: now,
    lastCommandId: dispatched.command.id,
    updatedAt: now,
    // A scheduled run opens its occurrence with no outcome yet: last month's success
    // must not read as this month's. Run Now belongs to no occurrence and leaves both.
    ...(input.occurrenceKey ? { occurrenceKey: input.occurrenceKey, lastOutcome: null, lastErrorCode: null } : {}),
    ...armed,
  };
  await db
    .insert(deviceOemUpdateStatus)
    .values({ deviceId: device.id, orgId: device.orgId, ...run })
    .onConflictDoUpdate({ target: deviceOemUpdateStatus.deviceId, set: run });

  return { ok: true, commandId: dispatched.command.id, categories, dispatched };
}

export async function dispatchOemUpdateRun(input: OemDispatchInput): Promise<OemDispatchResult> {
  // Off the caller's context: the row commits, and only then is it pushed.
  const prepared = await runOutsideDbContext(() => withSystemDbAccessContext(() => prepareRun(input)));
  if (!prepared.ok) return prepared;

  const { commandId, categories, dispatched } = prepared;
  if (dispatched.deliver) {
    const delivered = await dispatched.deliver();
    if (delivered.ok && delivered.delivery === 'cancelled') return { ok: false, refusal: 'cancelled_at_claim' };
  }
  return { ok: true, commandId, categories };
}
