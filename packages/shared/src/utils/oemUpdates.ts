import { semverCompare } from './semverCompare';

/**
 * OEM vendor-update command (Dell, Surface, HP, Lenovo): the vocabulary and the agent version gate,
 * shared by the API and the web console so they cannot drift. The wire shapes live in
 * validators/oemUpdates.ts. The agent's Go types will mirror these JSON shapes in a later wave.
 */

/**
 * First agent release that ships the OEM update command. Set when the contract was added; move it
 * if that release slips.
 */
export const OEM_UPDATE_MIN_AGENT_VERSION = '0.127.0';

/**
 * Whether an agent version can run the OEM update command. Fails CLOSED: an empty, missing, `dev`
 * or otherwise unparseable version is unsupported. A prerelease of the minimum counts as the minimum.
 */
export function agentSupportsOemUpdates(agentVersion: string | null | undefined): boolean {
  if (typeof agentVersion !== 'string') return false;
  const cmp = semverCompare(agentVersion.trim(), OEM_UPDATE_MIN_AGENT_VERSION);
  return cmp !== null && cmp >= 0;
}

/**
 * First agent release that handles `oem_update_release` (hand a vendor tool's own update schedule
 * back). Set when the contract was added; move it if that release slips.
 */
export const OEM_UPDATE_RELEASE_MIN_AGENT_VERSION = '0.127.0';

/** Whether an agent can run `oem_update_release`. Fails CLOSED, like `agentSupportsOemUpdates`. */
export function agentSupportsOemUpdateRelease(agentVersion: string | null | undefined): boolean {
  if (typeof agentVersion !== 'string') return false;
  const cmp = semverCompare(agentVersion.trim(), OEM_UPDATE_RELEASE_MIN_AGENT_VERSION);
  return cmp !== null && cmp >= 0;
}

/**
 * First agent release that honours `deadlineAction: 'hold'` on `schedule_reboot`. An older agent
 * ignores the key and would force the reboot at the deadline. Set when the contract was added; move
 * it if that release slips.
 */
export const OEM_REBOOT_HOLD_MIN_AGENT_VERSION = '0.127.0';

/** Whether an agent honours the reboot hold. Fails CLOSED. */
export function agentSupportsOemRebootHold(agentVersion: string | null | undefined): boolean {
  if (typeof agentVersion !== 'string') return false;
  const cmp = semverCompare(agentVersion.trim(), OEM_REBOOT_HOLD_MIN_AGENT_VERSION);
  return cmp !== null && cmp >= 0;
}

export const OEM_LANES = ['dell', 'surface', 'hp', 'lenovo'] as const;
export type OemLane = (typeof OEM_LANES)[number];

/**
 * Lanes whose vendor tool cannot honour a policy's blocked update IDs (#12265). Dell: DCU's
 * `-localblockedswb` is valid only on `/configure`, and blocking a release that way makes DCU
 * offer a different package for the same component, so the agent refuses any Dell run that
 * carries a blocked ID (`blocked_ids_unsupported`). The policy validator rejects a blocklist for
 * these lanes, and the scheduler sends no run for one already stored.
 */
export const OEM_LANES_WITHOUT_BLOCKED_UPDATE_IDS: readonly OemLane[] = Object.freeze(['dell']);

export function oemLaneHonoursBlockedUpdateIds(lane: OemLane): boolean {
  return !OEM_LANES_WITHOUT_BLOCKED_UPDATE_IDS.includes(lane);
}

/** What a device shows for vendor updates, in the order the fleet tab lists them. */
export const OEM_DISPLAY_STATES = [
  'up_to_date',
  'overdue',
  'failing',
  'not_supported',
  'not_managed',
  'waiting_for_reboot',
  'reboot_overdue',
] as const;
export type OemDisplayState = (typeof OEM_DISPLAY_STATES)[number];

export const OEM_CATEGORIES = ['bios', 'firmware', 'driver', 'application'] as const;
export type OemCategory = (typeof OEM_CATEGORIES)[number];

export const OEM_OUTCOMES = [
  'success',
  'success_reboot_required',
  'no_updates',
  'partial',
  'failed',
  'not_supported',
  'tool_unavailable',
  'blocked_on_battery',
  'blocked_reboot_pending',
  'blocked_no_recovery_key',
  'retry_later',
  'interrupted',
] as const;
export type OemOutcome = (typeof OEM_OUTCOMES)[number];

/**
 * Why the dispatch seam refused a run. Shared so the console's copy for each one is
 * checked against this list. All of them are 409s except `device_not_found` (404) and
 * `trust_denied` (403).
 */
export const OEM_DISPATCH_REFUSALS = [
  'flag_off',
  'lane_closed',
  'kill_switch',
  'agent_too_old',
  'not_applicable',
  'not_supported',
  'ephemeral',
  'parked',
  'offline',
  'run_in_flight',
  'no_open_categories',
  /** Unknown id, or a device no longer in the expected org. */
  'device_not_found',
  'decommissioned',
  'trust_denied',
  /** Queued, then terminalised by the socket push's own claim-time eligibility. */
  'cancelled_at_claim',
] as const;
export type OemDispatchRefusal = (typeof OEM_DISPATCH_REFUSALS)[number];

/**
 * Lanes `oem_observe` can read (observe-first amendment, #11065). Dell has no stage entry: its
 * lab wave stands, so there is nothing to observe there.
 */
export const OEM_OBSERVE_LANES = ['surface', 'hp', 'lenovo'] as const;
export type OemObserveLane = (typeof OEM_OBSERVE_LANES)[number];

/**
 * First agent release that ships the read-only `oem_observe` handler. Its own minimum, so an older
 * agent never receives the type (it would only reject it as unknown). Set to the release after the
 * one in rc when the contract was added; move it if that release slips.
 */
export const OEM_OBSERVE_MIN_AGENT_VERSION = '0.131.0';

/** Whether an agent can run `oem_observe`. Fails CLOSED, like `agentSupportsOemUpdates`. */
export function agentSupportsOemObserve(agentVersion: string | null | undefined): boolean {
  if (typeof agentVersion !== 'string') return false;
  const cmp = semverCompare(agentVersion.trim(), OEM_OBSERVE_MIN_AGENT_VERSION);
  return cmp !== null && cmp >= 0;
}

/**
 * Why the observe seam refused. Its own list rather than more members of
 * `OEM_DISPATCH_REFUSALS`, whose console copy is user-facing: observe is an internal canary
 * instrument, and only our own operators reach it.
 */
export const OEM_OBSERVE_REFUSALS = [
  'device_not_found',
  'flag_off',
  'not_canary',
  'ephemeral',
  'parked',
  'decommissioned',
  'not_applicable',
  'kill_switch',
  'agent_too_old',
  'no_policy',
  'offline',
  'recent_observation',
  'trust_denied',
  'cancelled_at_claim',
] as const;
export type OemObserveRefusal = (typeof OEM_OBSERVE_REFUSALS)[number];
