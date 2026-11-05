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

export const OEM_LANES = ['dell', 'surface', 'hp', 'lenovo'] as const;
export type OemLane = (typeof OEM_LANES)[number];

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
