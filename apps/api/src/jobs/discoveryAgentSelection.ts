/**
 * Which agent runs a discovery scan (#7969).
 *
 * Two paths, both resolved at dispatch time from the live profile row (so a
 * re-dispatch or a pin edited while a job is queued uses the current choice):
 *
 * - **Pinned** (`discovery_profiles.pinned_device_id`): only that device may run
 *   the scan. If it is offline, moved site/org, parked or gone, the job fails
 *   with a message naming it — never a silent fallback to another device, which
 *   would scan from a network the operator explicitly ruled out.
 * - **Unpinned**: every online, non-ephemeral, non-parked device in the
 *   profile's site is a candidate. Candidates with a known interface address
 *   inside one of the profile's target subnets rank first; ties break on the
 *   device id so the same site always picks the same agent.
 *
 * Callers run these inside a system DB context (worker phase 1).
 */
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { devices, deviceNetwork } from '../db/schema';
import { notParkedDeviceCondition } from '../services/unassignedPool/selectorPredicate';
import { cidrContains } from '../services/topology/ipAddress';

/** Upper bound on site candidates considered per dispatch. */
export const MAX_DISCOVERY_AGENT_CANDIDATES = 500;

export type DiscoveryAgentCandidate = {
  deviceId: string;
  agentId: string;
  /** Display name or hostname, for logs and job error messages. */
  label: string;
  /** Known interface addresses (device_network), any family. */
  addresses: string[];
};

export type RankedDiscoveryAgentCandidate = DiscoveryAgentCandidate & {
  /** True when one of `addresses` falls inside one of the profile's subnets. */
  subnetMatch: boolean;
};

function deviceLabel(row: { displayName: string | null; hostname: string | null; deviceId: string }): string {
  return row.displayName?.trim() || row.hostname?.trim() || row.deviceId;
}

/**
 * Order candidates: subnet-overlapping agents first, then device id ascending.
 * Pure; profile targets that do not parse (or a bare IP, treated as a host
 * prefix by `cidrContains`) never throw.
 */
export function rankDiscoveryAgentCandidates(
  candidates: readonly DiscoveryAgentCandidate[],
  subnets: readonly string[],
): RankedDiscoveryAgentCandidate[] {
  const targets = subnets.map((s) => s.trim()).filter(Boolean);
  return candidates
    .map((candidate) => ({
      ...candidate,
      subnetMatch: candidate.addresses.some((address) =>
        targets.some((target) => cidrContains(target, address)),
      ),
    }))
    .sort((a, b) => {
      if (a.subnetMatch !== b.subnetMatch) return a.subnetMatch ? -1 : 1;
      return a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0;
    });
}

/**
 * Online agents in the site, with their known interface addresses.
 *
 * Quick Support exclusion: ephemeral devices live in the hidden per-partner
 * 'quick_support' org and are a stranger's personal machine borrowed for one
 * session. That org stays inside technicians' accessibleOrgIds for RLS
 * reasons, so a bare "any online device here" pick could conscript a home PC
 * into network-scanning the stranger's own LAN.
 */
export async function loadSiteDiscoveryAgentCandidates(
  orgId: string,
  siteId: string,
): Promise<DiscoveryAgentCandidate[]> {
  const rows = await db
    .select({
      deviceId: devices.id,
      agentId: devices.agentId,
      hostname: devices.hostname,
      displayName: devices.displayName,
    })
    .from(devices)
    .where(
      and(
        eq(devices.orgId, orgId),
        eq(devices.isEphemeral, false),
        notParkedDeviceCondition(),
        eq(devices.siteId, siteId),
        eq(devices.status, 'online'),
        isNotNull(devices.agentId),
      ),
    )
    .orderBy(asc(devices.id))
    .limit(MAX_DISCOVERY_AGENT_CANDIDATES);

  const withAgent = rows.filter((row): row is typeof row & { agentId: string } => Boolean(row.agentId));
  if (withAgent.length === 0) return [];

  const addressRows = await db
    .select({ deviceId: deviceNetwork.deviceId, ipAddress: deviceNetwork.ipAddress })
    .from(deviceNetwork)
    .where(and(inArray(deviceNetwork.deviceId, withAgent.map((row) => row.deviceId)), isNotNull(deviceNetwork.ipAddress)));

  const addressesByDevice = new Map<string, string[]>();
  for (const row of addressRows) {
    if (!row.ipAddress) continue;
    const list = addressesByDevice.get(row.deviceId) ?? [];
    list.push(row.ipAddress);
    addressesByDevice.set(row.deviceId, list);
  }

  return withAgent.map((row) => ({
    deviceId: row.deviceId,
    agentId: row.agentId,
    label: deviceLabel(row),
    addresses: addressesByDevice.get(row.deviceId) ?? [],
  }));
}

export type PinnedDiscoveryAgentResolution =
  | { ok: true; agentId: string; label: string }
  /** `agentId` is set when the pinned device is known, so the failed job records it. */
  | { ok: false; agentId: string | null; message: string };

const NO_FALLBACK = 'the scan was not run from any other agent';

export function pinnedAgentNotConnectedMessage(label: string): string {
  return `Pinned scan agent "${label}" is not connected; ${NO_FALLBACK}. Bring it online or change the profile's scan agent.`;
}

/** Resolve a profile's pinned device to an agent that may run this scan now. */
export async function resolvePinnedDiscoveryAgent(
  pinnedDeviceId: string,
  orgId: string,
  siteId: string,
): Promise<PinnedDiscoveryAgentResolution> {
  const [device] = await db
    .select({
      deviceId: devices.id,
      agentId: devices.agentId,
      hostname: devices.hostname,
      displayName: devices.displayName,
      orgId: devices.orgId,
      siteId: devices.siteId,
      status: devices.status,
      isEphemeral: devices.isEphemeral,
    })
    .from(devices)
    // A device parked in its partner's holding org never runs a scan (the
    // command would carry SNMP credentials): it resolves as not found.
    .where(and(eq(devices.id, pinnedDeviceId), notParkedDeviceCondition()))
    .limit(1);

  if (!device || device.isEphemeral || !device.agentId) {
    return {
      ok: false,
      agentId: null,
      message: `Pinned scan agent is no longer available; ${NO_FALLBACK}. Choose another scan agent on the profile.`,
    };
  }

  const label = deviceLabel(device);
  if (device.orgId !== orgId) {
    // Defence in depth: the composite FK and the org-move detach keep this
    // unreachable, and the agent id of another org's device is not recorded.
    return {
      ok: false,
      agentId: null,
      message: `Pinned scan agent belongs to a different organization; ${NO_FALLBACK}.`,
    };
  }
  if (device.siteId !== siteId) {
    return {
      ok: false,
      agentId: device.agentId,
      message: `Pinned scan agent "${label}" is no longer in this profile's site; ${NO_FALLBACK}. Choose another scan agent on the profile.`,
    };
  }
  if (device.status !== 'online') {
    return {
      ok: false,
      agentId: device.agentId,
      message: `Pinned scan agent "${label}" is offline; ${NO_FALLBACK}. Bring it online or change the profile's scan agent.`,
    };
  }

  return { ok: true, agentId: device.agentId, label };
}
