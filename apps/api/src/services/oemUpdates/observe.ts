/**
 * The single dispatch seam for `oem_observe` (observe-first amendment, #11065).
 *
 * Observe is the read-only step a best-guess vendor lane (Surface, HP, Lenovo)
 * takes before its write path opens: the agent reports the machine's identity,
 * power, BitLocker binding, vendor tooling and pending vendor updates, and
 * writes, installs, flashes and reboots nothing. It is an internal canary
 * instrument, not a user-facing mode: it reaches a device only for a partner in
 * `BREEZE_VENDOR_CANARY_PARTNER_IDS` whose lane is at stage `observe` or `act`
 * (`vendorCanary.ts`), and only under an enabled `oem_updates` policy that
 * enables the lane.
 *
 * Checks, first failure refuses (amendment 1.3; the canary partner is checked
 * before the device facts, and the stage once the lane is known):
 *   device and org -> master flag and allowlist -> canary partner -> ephemeral,
 *   parked, decommissioned -> observe applicability -> lane or pair kill
 *   switch -> stage -> agent version -> policy opt-in -> online -> nothing in
 *   the last 24 h or in flight.
 * Observe does not consult the manifest gates: it installs nothing, so there is
 * nothing for a gate to protect. Claim-time recheck: `revalidation.ts`.
 *
 * Its results stay isolated: `applyOemObserveResult` validates the stored
 * result and scrubs one that fails the contract, and writes nothing else. The
 * status row, reboot accounting and update-type ownership never see observe.
 */
import { and, desc, eq, gt, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  agentSupportsOemObserve,
  oemObservePayloadSchema,
  oemObserveResultSchema,
  type OemObserveLane,
  type OemObserveRefusal,
  type OemObserveResult,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { deviceCommands, deviceHardware, devices, organizations } from '../../db/schema';
import { CommandTypes } from '../commandTypes';
import { dispatchDeviceCommand, type DispatchDeviceCommandResult } from '../dispatchDeviceCommand';
import { assertDeviceExecuteAllowed } from '../partnerTrust.commands';
import { isUnassignedPoolOrgType } from '../unassignedPool/orgType';
import { notParkedDeviceCondition } from '../unassignedPool/selectorPredicate';
import { isVendorCanaryPartner, vendorCanaryPartnerIds, vendorPairDisabled, vendorStage } from '../vendorCanary';
import { resolveObserveApplicability } from './applicability';
import { escrowedProtectorIds } from './escrowedProtectors';
import { laneDisabledByKillSwitch, oemUpdatesEnabled } from './flags';
import { resolveOemUpdatesLinkForDevice, type ResolvedOemUpdatesLink } from './resolver';

export type { OemObserveRefusal };

/**
 * How long a queued observation stays deliverable. Short on purpose: the claim
 * recheck cannot re-resolve the policy, so this bounds how stale the opt-in an
 * observation is delivered under can be. The sweep tries again a day later.
 */
export const OEM_OBSERVE_DELIVER_WITHIN_MS = 10 * 60 * 1000;
/**
 * One completed observation per device per day at most, whoever asks. One that
 * failed, expired or was cancelled does not count: a person may retry at once.
 */
export const OEM_OBSERVE_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The sweep observes each opted-in canary device about once a week... */
export const OEM_OBSERVE_SWEEP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** ...and retries one whose last attempt did not complete after a day, not every tick. */
export const OEM_OBSERVE_SWEEP_RETRY_MS = 24 * 60 * 60 * 1000;
/** Devices the sweep dispatches to per tick. A canary is one tenant. */
export const OEM_OBSERVE_SWEEP_LIMIT = 50;

export type ObserveDeviceFacts = {
  id: string;
  orgId: string;
  partnerId: string | null;
  orgType: string | null;
  status: string;
  agentVersion: string | null;
  osType: string;
  isVirtual: boolean;
  isEphemeral: boolean;
  deviceRole: string;
  manufacturer: string | null;
  model: string | null;
};

export type ObserveDecision = { ok: true; lane: OemObserveLane } | { ok: false; refusal: OemObserveRefusal };

/** The checks that need no query: everything up to the policy opt-in. */
export function decideObserve(device: ObserveDeviceFacts | null, expectedOrgId: string): ObserveDecision {
  if (!device || device.orgId !== expectedOrgId) return { ok: false, refusal: 'device_not_found' };
  if (!device.partnerId || !oemUpdatesEnabled(device.partnerId)) return { ok: false, refusal: 'flag_off' };
  if (!isVendorCanaryPartner(device.partnerId)) return { ok: false, refusal: 'not_canary' };
  if (device.isEphemeral) return { ok: false, refusal: 'ephemeral' };
  if (isUnassignedPoolOrgType(device.orgType)) return { ok: false, refusal: 'parked' };
  if (device.status === 'decommissioned') return { ok: false, refusal: 'decommissioned' };

  const applicability = resolveObserveApplicability({
    osType: device.osType,
    isVirtual: device.isVirtual,
    deviceRole: device.deviceRole,
    manufacturer: device.manufacturer,
    model: device.model,
  });
  if (applicability.state !== 'applicable') return { ok: false, refusal: 'not_applicable' };
  const { lane } = applicability;

  if (laneDisabledByKillSwitch(lane) || vendorPairDisabled('oem_updates', lane)) return { ok: false, refusal: 'kill_switch' };
  if (vendorStage('oem_updates', lane, device.partnerId) === 'off') return { ok: false, refusal: 'not_canary' };
  if (!agentSupportsOemObserve(device.agentVersion)) return { ok: false, refusal: 'agent_too_old' };
  return { ok: true, lane };
}

/**
 * The opt-in: an enabled policy that enables this lane. Categories are not
 * required: every gate is closed at observe, so the link write refuses a new
 * `true` category, and requiring one would make observe unreachable. A blob that
 * no longer parses counts as no policy.
 */
export function observeLinkAllows(link: ResolvedOemUpdatesLink | null, lane: OemObserveLane): boolean {
  if (!link || link.invalidStoredSettings) return false;
  return link.settings.enabled === true && link.settings.vendors[lane]?.enabled === true;
}

/** The partner trust check a caller makes before asking for an observation. */
export function assertOemObserveAllowedForActor(deviceId: string, userId: string): Promise<void> {
  return assertDeviceExecuteAllowed(deviceId, CommandTypes.OEM_OBSERVE, userId);
}

/** Selects observation rows for a read. A condition, not the type: it cannot be handed to a queue. */
export function oemObserveCommandFilter(): SQL {
  return eq(deviceCommands.type, CommandTypes.OEM_OBSERVE);
}

/**
 * The lane Run Now observes instead of running: the device's observe lane when
 * its partner is a canary at stage `observe` for it, else null (a normal run).
 * Only a routing choice; the seam re-checks everything. Off the caller's
 * context, like the seam, so it holds no request connection.
 */
export async function observeLaneForRunNow(deviceId: string): Promise<OemObserveLane | null> {
  if (vendorCanaryPartnerIds().length === 0) return null;
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({
        partnerId: organizations.partnerId,
        osType: devices.osType,
        isVirtual: devices.isVirtual,
        deviceRole: devices.deviceRole,
        manufacturer: deviceHardware.manufacturer,
        model: deviceHardware.model,
      })
      .from(devices)
      .innerJoin(organizations, eq(organizations.id, devices.orgId))
      .leftJoin(deviceHardware, eq(deviceHardware.deviceId, devices.id))
      .where(eq(devices.id, deviceId))
      .limit(1);
    if (!row) return null;
    const applicability = resolveObserveApplicability({ ...row, manufacturer: row.manufacturer ?? null, model: row.model ?? null });
    if (applicability.state !== 'applicable') return null;
    return vendorStage('oem_updates', applicability.lane, row.partnerId) === 'observe' ? applicability.lane : null;
  }));
}

function refusalForEnqueueCode(code: Extract<DispatchDeviceCommandResult, { ok: false }>['code']): OemObserveRefusal {
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
      return 'not_applicable';
  }
}

type PreparedObserve =
  | { ok: false; refusal: OemObserveRefusal }
  | { ok: true; commandId: string; dispatched: Extract<DispatchDeviceCommandResult, { ok: true }> };

export type OemObserveInput = {
  deviceId: string;
  /** The org the decision was made under. A device that has moved since gets nothing. */
  expectedOrgId: string;
  trigger: 'scheduled' | 'on_demand';
  actorUserId: string | null;
};

async function prepareObserve(input: OemObserveInput): Promise<PreparedObserve> {
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
    })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .leftJoin(deviceHardware, eq(deviceHardware.deviceId, devices.id))
    .where(eq(devices.id, input.deviceId))
    .limit(1);

  const decision = decideObserve((device as ObserveDeviceFacts | undefined) ?? null, input.expectedOrgId);
  if (!decision.ok) return decision;
  const { lane } = decision;

  // Holds for Run Now too: observe never runs on a device outside a policy,
  // although a vendor update run's Run Now can.
  if (!observeLinkAllows(await resolveOemUpdatesLinkForDevice(device!.id), lane)) {
    return { ok: false, refusal: 'no_policy' };
  }
  if (device!.status !== 'online') return { ok: false, refusal: 'offline' };

  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`oem_observe:${device!.id}`}, 0))`);
  const recent = await db
    .select({ id: deviceCommands.id })
    .from(deviceCommands)
    .where(and(
      eq(deviceCommands.deviceId, device!.id),
      oemObserveCommandFilter(),
      or(
        inArray(deviceCommands.status, ['pending', 'sent']),
        and(
          eq(deviceCommands.status, 'completed'),
          gt(deviceCommands.createdAt, new Date(Date.now() - OEM_OBSERVE_MIN_INTERVAL_MS)),
        ),
      ),
    ))
    .limit(1);
  if (recent.length > 0) return { ok: false, refusal: 'recent_observation' };

  const payload = oemObservePayloadSchema.parse({
    lane,
    observeLevel: 'passive',
    escrowedProtectorIds: await escrowedProtectorIds(device!.id),
  });

  const dispatched = await dispatchDeviceCommand({
    deviceId: device!.id,
    type: CommandTypes.OEM_OBSERVE,
    payload,
    ...(input.actorUserId ? { userId: input.actorUserId } : {}),
    expectedOrgId: input.expectedOrgId,
    offlinePolicy: { kind: 'queue', deliverWithinMs: OEM_OBSERVE_DELIVER_WITHIN_MS },
    deferDelivery: true,
  });
  if (!dispatched.ok) return { ok: false, refusal: refusalForEnqueueCode(dispatched.code) };
  return { ok: true, commandId: dispatched.command.id, dispatched };
}

export type OemObserveDispatchResult = { ok: true; commandId: string } | { ok: false; refusal: OemObserveRefusal };

/**
 * Queues one observation. Off the caller's context: the row commits, and only
 * then is it pushed, because a fast agent can answer before an open transaction
 * would be visible.
 */
export async function dispatchOemObserve(input: OemObserveInput): Promise<OemObserveDispatchResult> {
  const prepared = await runOutsideDbContext(() => withSystemDbAccessContext(() => prepareObserve(input)));
  if (!prepared.ok) return prepared;
  if (prepared.dispatched.deliver) {
    const delivered = await prepared.dispatched.deliver();
    if (delivered.ok && delivered.delivery === 'cancelled') return { ok: false, refusal: 'cancelled_at_claim' };
  }
  return { ok: true, commandId: prepared.commandId };
}

/**
 * Where the next sweep page starts. Devices the seam refuses (no policy, an old
 * agent) leave no row behind, so without a cursor a page full of them would be
 * re-read every tick and starve the devices after it. In memory: a restart only
 * starts the rotation over.
 */
let sweepCursor: string | null = null;

export function resetOemObserveSweepCursorForTests(): void {
  sweepCursor = null;
}

/**
 * The weekly sweep: online physical Windows workstations of a canary partner
 * whose maker has an observe lane, with no completed observation in a week and
 * no attempt in a day. Each candidate goes through `dispatchOemObserve`, which
 * applies every check above, so the query only narrows. Pages rotate through the
 * fleet by device id. With the canary list empty, or no canary partner admitted
 * by the master flag and allowlist, it returns before any query.
 */
export async function runOemObserveSweep(now: Date): Promise<{ considered: number; dispatched: number }> {
  const partners = vendorCanaryPartnerIds().filter((partnerId) => oemUpdatesEnabled(partnerId));
  if (partners.length === 0) return { considered: 0, dispatched: 0 };

  const since = new Date(now.getTime() - OEM_OBSERVE_SWEEP_INTERVAL_MS);
  const retryAfter = new Date(now.getTime() - OEM_OBSERVE_SWEEP_RETRY_MS);
  const after = sweepCursor;
  const candidates = await withSystemDbAccessContext(() => db
    .select({ candidate: devices.id, orgId: devices.orgId })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .innerJoin(deviceHardware, eq(deviceHardware.deviceId, devices.id))
    .where(and(
      inArray(organizations.partnerId, partners),
      eq(devices.osType, 'windows'),
      eq(devices.status, 'online'),
      eq(devices.isEphemeral, false),
      eq(devices.isVirtual, false),
      ne(devices.deviceRole, 'server'),
      notParkedDeviceCondition(),
      // A prefilter only; resolveObserveApplicability decides.
      sql`trim(${deviceHardware.manufacturer}) ~* '^(lenovo|hp( inc\\.?)?|hewlett-packard|microsoft corporation)$'`,
      sql`(trim(${deviceHardware.manufacturer}) !~* '^microsoft corporation$' OR trim(${deviceHardware.model}) ~* '^surface\\s')`,
      sql`NOT EXISTS (
        SELECT 1 FROM ${deviceCommands} c
        WHERE c.device_id = ${devices.id}
          AND c.type = ${CommandTypes.OEM_OBSERVE}
          AND (c.created_at > ${retryAfter} OR (c.status = 'completed' AND c.created_at > ${since}))
      )`,
      ...(after ? [gt(devices.id, after)] : []),
    ))
    .orderBy(devices.id)
    .limit(OEM_OBSERVE_SWEEP_LIMIT));
  // A short page reached the end: the next tick starts over.
  sweepCursor = candidates.length < OEM_OBSERVE_SWEEP_LIMIT ? null : candidates.at(-1)!.candidate;

  let dispatched = 0;
  for (const { candidate, orgId } of candidates) {
    const outcome = await dispatchOemObserve({ deviceId: candidate, expectedOrgId: orgId, trigger: 'scheduled', actorUserId: null });
    if (outcome.ok) dispatched++;
  }
  return { considered: candidates.length, dispatched };
}

function parseObservation(stored: unknown): OemObserveResult | null {
  if (!stored || typeof stored !== 'object') return null;
  const { stdout } = stored as { stdout?: unknown };
  if (typeof stdout !== 'string') return null;
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  const parsed = oemObserveResultSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export function isObserveCommandType(type: string): boolean {
  return type === CommandTypes.OEM_OBSERVE;
}

/** The lane a stored observe payload named, or null. */
export function observeLaneOf(payload: unknown): OemObserveLane | null {
  const parsed = oemObservePayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data.lane : null;
}

export type OemObservationVerdict = 'observed' | 'observed_with_errors' | 'platform_unsupported' | 'invalid';

/**
 * A stored observation reduced to what the history shows: lane, verdict and the
 * names (closed lists) of tools and conflicting apps found. Null when nothing
 * readable is stored; the caller shows that as `invalid`.
 */
export function summarizeStoredObservation(stored: unknown): {
  lane: OemObserveLane;
  verdict: OemObservationVerdict;
  tools: string[];
  conflicts: string[];
} | null {
  const observation = parseObservation(stored);
  if (!observation) return null;
  const verdict: OemObservationVerdict = observation.lane === 'hp' && observation.hp.platformCatalog?.status === 404
    ? 'platform_unsupported'
    : observation.errors.length > 0 ? 'observed_with_errors' : 'observed';
  return {
    lane: observation.lane,
    verdict,
    tools: observation.tools.map((tool) => tool.name),
    conflicts: observation.conflicts.map((conflict) => conflict.name),
  };
}

/**
 * Whether the newest completed observation of this device found no HP platform
 * catalog (a 404): a consumer HP that HPIA does not support. Read by the run
 * seam to refuse a vendor update run (`applicability.ts`), never by observe itself,
 * so a later observation can always clear it. Runs on the caller's context.
 */
export async function observedHpPlatformUnsupported(deviceId: string): Promise<boolean> {
  const [row] = await db
    .select({ result: deviceCommands.result })
    .from(deviceCommands)
    .where(and(
      eq(deviceCommands.deviceId, deviceId),
      oemObserveCommandFilter(),
      eq(deviceCommands.status, 'completed'),
    ))
    .orderBy(desc(deviceCommands.createdAt))
    .limit(1);
  const observation = parseObservation(row?.result);
  return observation?.lane === 'hp' && observation.hp.platformCatalog?.status === 404;
}

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The agent's observation, already stored on the command row by the result
 * transport, in the same transaction. The stored result is always rewritten
 * here, so what persists is only what was validated:
 * - a valid observation (for the command's own lane) is stored as its
 *   re-serialized parse: duplicate keys, padding, stderr and error text are gone;
 * - an invalid one is replaced by a rejection marker;
 * - a failed or timed-out envelope keeps its status and, only if it is an
 *   identifier (the agent sends bare codes), its error code.
 * Writes nothing else. Runs on the transport's context, and is not caught: a
 * failed rewrite fails the transaction that stored the raw envelope with it.
 */
export async function applyOemObserveResult(input: {
  commandId: string;
  deviceId: string;
  command: { type: string; deviceId: string; payload: unknown };
  envelopeStatus: string;
  stdout: string;
  error?: string | null;
}): Promise<void> {
  const { commandId, deviceId, command } = input;
  if (command.type !== CommandTypes.OEM_OBSERVE || command.deviceId !== deviceId) return;

  let result: Record<string, unknown>;
  if (input.envelopeStatus !== 'completed') {
    const code = typeof input.error === 'string' && ERROR_CODE.test(input.error) ? input.error : null;
    result = { status: input.envelopeStatus, ...(code ? { error: code } : {}) };
  } else {
    const observation = parseObservation({ stdout: input.stdout });
    const payload = oemObservePayloadSchema.safeParse(command.payload);
    if (observation && payload.success && observation.lane === payload.data.lane) {
      result = { status: 'completed', stdout: JSON.stringify(observation) };
    } else {
      console.warn('[oemUpdates/observe] observation failed the contract; stored result scrubbed', { commandId, deviceId });
      result = { status: 'completed', rejected: 'observation_invalid' };
    }
  }
  await db
    .update(deviceCommands)
    .set({ result })
    .where(and(eq(deviceCommands.id, commandId), eq(deviceCommands.deviceId, deviceId)));
}
