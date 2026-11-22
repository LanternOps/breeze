import { and, eq, notInArray, sql } from 'drizzle-orm';
import { RESOLVED_TERMINAL_STATES, isResolvedTerminalIsolationState } from '@breeze/shared';
import type { db } from '../../db';
import { agentVersions, deviceNetworkIsolations } from '../../db/schema';
import { isolationAgentUpgradeGate } from '../../routes/agents/agentUpdatePolicy';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type UpgradeFloorReader = Pick<Tx, 'select'>;
export type UpgradeFloorRow = { type: string; deviceId: string; payload: unknown };

export const NETWORK_ISOLATION_VERSION_FLOOR = 'network-isolation-version-floor' as const;

/**
 * Fields of an `update` / `update_agent` / `dev_update` payload that cannot choose the binary.
 * Anything else (`downloadUrl`, `checksum`, a URL under any other name, a nested object) may,
 * so its version label proves nothing. An allowlist on purpose: a field added later is treated as
 * choosing the binary until someone says otherwise here. `timeoutSeconds` is stamped onto every
 * agent-role payload by `queueCommand` (the helper-IPC budget).
 */
const VERSION_ONLY_FIELDS: ReadonlySet<string> = new Set(['version', 'component', 'reason', 'preserveAutoUpdate', 'timeoutSeconds']);

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_RELEASES_PER_CHECKSUM = 20;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function atFloor(version: unknown): boolean {
  return isolationAgentUpgradeGate(typeof version === 'string' ? version : '', true).allow;
}

async function hasUnresolvedEpisode(reader: UpgradeFloorReader, deviceId: string): Promise<boolean> {
  const [episode] = await reader.select({ state: deviceNetworkIsolations.state })
    .from(deviceNetworkIsolations)
    .where(and(eq(deviceNetworkIsolations.deviceId, deviceId), notInArray(deviceNetworkIsolations.state, [...RESOLVED_TERMINAL_STATES])))
    .limit(1);
  return !!episode && !isResolvedTerminalIsolationState(episode.state);
}

/**
 * While a device has an unresolved episode, an agent binary below
 * `NETWORK_ISOLATION_MIN_AGENT_VERSION` must not be installed: it could not release its own rules.
 *
 * #10919: the floor is checked against the binary the agent will actually install. A
 * version-only payload is judged by its `version` (the watchdog resolves that version from the
 * release catalog itself), and the signed rollback by its signed `targetVersion`. A payload that
 * names its own download is judged by the release record whose checksum it carries, because the
 * agent installs whatever the location serves that matches that checksum. A download whose
 * checksum matches no agent release cannot prove the floor and is refused. Nothing is read
 * unless the device has an unresolved episode or the version label is below the floor.
 */
export async function isolationUpgradeFloorRefusal(
  reader: UpgradeFloorReader,
  row: UpgradeFloorRow,
): Promise<typeof NETWORK_ISOLATION_VERSION_FLOOR | null> {
  const payload = record(row.payload);
  const versionOnly = row.type === 'agent_rollback_v1'
    || Object.keys(payload).every((key) => VERSION_ONLY_FIELDS.has(key));
  if (versionOnly) {
    if (atFloor(row.type === 'agent_rollback_v1' ? payload.targetVersion : payload.version)) return null;
    return await hasUnresolvedEpisode(reader, row.deviceId) ? NETWORK_ISOLATION_VERSION_FLOOR : null;
  }
  if (!await hasUnresolvedEpisode(reader, row.deviceId)) return null;
  const checksum = typeof payload.checksum === 'string' ? payload.checksum.trim().toLowerCase() : '';
  if (!SHA256_HEX.test(checksum)) return NETWORK_ISOLATION_VERSION_FLOOR;
  // Stored checksums are not normalised, so compare case-insensitively. One row past the cap is
  // read so an unjudged remainder refuses instead of being skipped.
  const releases = await reader.select({ version: agentVersions.version })
    .from(agentVersions)
    .where(and(eq(sql`lower(${agentVersions.checksum})`, checksum), eq(agentVersions.component, 'agent')))
    .limit(MAX_RELEASES_PER_CHECKSUM + 1);
  if (releases.length === 0 || releases.length > MAX_RELEASES_PER_CHECKSUM) return NETWORK_ISOLATION_VERSION_FLOOR;
  return releases.every((release) => atFloor(release.version)) ? null : NETWORK_ISOLATION_VERSION_FLOOR;
}
