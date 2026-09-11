import { semverCompare } from '@breeze/shared';

/**
 * How a device's reported agent version relates to the org's effective
 * agent-version pin (or, when unpinned, the globally promoted version).
 * 'unknown' covers every case where the comparison can't be made in good
 * faith — missing device version (network/manual rows, never heartbeat'd),
 * missing effective version (never synced), or an unparseable string on
 * either side — and the caller renders the plain dash for it, same as today
 * (issue #5285).
 */
export type AgentVersionRelation = 'equal' | 'ahead' | 'behind' | 'unknown';

/**
 * Classify `deviceVersion` against `effectiveVersion` using semver
 * comparison (never plain string equality — a device on "0.110.0" and a pin
 * of "0.110.0-dev" are the same release). Reuses the same `semverCompare`
 * the Sidebar "what's new" banner already keys its version check off of.
 */
export function getAgentVersionRelation(
  deviceVersion: string | null | undefined,
  effectiveVersion: string | null | undefined,
): AgentVersionRelation {
  if (!deviceVersion || !effectiveVersion) return 'unknown';
  const cmp = semverCompare(deviceVersion, effectiveVersion);
  if (cmp === null) return 'unknown';
  if (cmp === 0) return 'equal';
  return cmp > 0 ? 'ahead' : 'behind';
}
