import { and, desc, eq } from 'drizzle-orm';
import type { db } from '../db';
import { agentVersions, devices } from '../db/schema';
import { evaluateOsFloor, noteOsFloorHold, type OsFloorHoldReason } from './agentOsFloor';
import { getBinaryEdition } from './binaryEdition';

/**
 * #12169 — the minimum-OS gate on the command paths that install an agent
 * binary: dispatch (commandQueue) and queued-command delivery
 * (commandClaimEligibility). The heartbeat offer is gated in the resolvers
 * (routes/agents/helpers.ts); this covers an operator or AI pushing an exact
 * `update_agent` / `update_watchdog`, and a row queued before the release was
 * promoted. `agent_rollback_v1` installs an older signed artifact and
 * `dev_update` is dev-only, so neither is gated here.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type OsFloorCommandReader = Pick<Tx, 'select'>;
export type OsFloorCommandRow = { type: string; deviceId: string; payload: unknown };

const COMMAND_COMPONENT: Readonly<Record<string, string>> = {
  update: 'agent',
  update_agent: 'agent',
  update_watchdog: 'watchdog',
};

/** The agent_versions component a command installs, or null when it is not gated. */
export function commandOsFloorComponent(type: string): string | null {
  return Object.prototype.hasOwnProperty.call(COMMAND_COMPONENT, type) ? COMMAND_COMPONENT[type]! : null;
}

// Local copy of routes/agents/helpers normalizeAgentArchitecture: importing
// the route helpers here would cycle back through commandQueue.
function normalizeArch(architecture: string | null | undefined): 'amd64' | 'arm64' | null {
  const a = architecture?.trim().toLowerCase();
  if (a === 'amd64' || a === 'x86_64' || a === 'x64') return 'amd64';
  if (a === 'arm64' || a === 'aarch64') return 'arm64';
  return null;
}

/**
 * The hold reason when the build a command would install is above the
 * device's OS floor, else null. The build is the payload's `version` when it
 * names one, otherwise the promoted row (what the watchdog resolves for a
 * version-less update). Reads the device, and only for a Mac the matching
 * agent_versions row. Anything it cannot resolve (unknown device, no row)
 * returns null: missing builds are other gates' business.
 */
export async function agentOsFloorRefusal(
  reader: OsFloorCommandReader,
  row: OsFloorCommandRow,
): Promise<OsFloorHoldReason | null> {
  const component = commandOsFloorComponent(row.type);
  if (!component) return null;

  const [device] = await reader
    .select({ osType: devices.osType, osVersion: devices.osVersion, architecture: devices.architecture })
    .from(devices)
    .where(eq(devices.id, row.deviceId))
    .limit(1);
  // Only darwin rows carry a floor today; skip the release read elsewhere.
  if (!device || device.osType !== 'macos') return null;
  const architecture = normalizeArch(device.architecture);
  if (!architecture) return null;

  const payload =
    row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : {};
  const version = typeof payload.version === 'string' && payload.version.trim() ? payload.version.trim() : null;

  const [release] = await reader
    .select({ minOsVersion: agentVersions.minOsVersion })
    .from(agentVersions)
    .where(
      and(
        eq(agentVersions.platform, device.osType),
        eq(agentVersions.architecture, architecture),
        eq(agentVersions.component, component),
        eq(agentVersions.edition, getBinaryEdition()),
        version ? eq(agentVersions.version, version) : eq(agentVersions.isLatest, true),
      ),
    )
    .orderBy(desc(agentVersions.createdAt))
    .limit(1);
  if (!release) return null;

  const deviceOs = { platform: device.osType, reportedOsVersion: null, storedOsVersion: device.osVersion ?? null };
  const decision = evaluateOsFloor(deviceOs, release.minOsVersion);
  if (decision.kind === 'allow') return null;
  noteOsFloorHold(deviceOs, decision);
  return decision.reason;
}
