import { and, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db';
import {
  auditLogs,
  deviceCommands,
  deviceIpHistory,
  deviceNetwork,
  devices,
} from '../db/schema';
import { CommandTypes } from './commandQueue';
import { claimPendingCommandForDelivery, releaseClaimedCommandDelivery } from './commandDispatch';
import { isAgentConnected, sendCommandToAgent } from '../routes/agentWs';

export type WakeFailureCode =
  | 'TARGET_NOT_FOUND'
  | 'NO_MACS'
  | 'NO_SUBNET'
  | 'IPV6_ONLY'
  | 'NO_RELAY'
  | 'RELAY_OVERRIDE_INVALID'
  | 'WS_SEND_FAILED';

export interface WakeSuccess {
  ok: true;
  commandId: string;
  wakeAttemptId: string;
  targetDeviceId: string;
  targetHostname: string;
  relayDeviceId: string;
  relayHostname: string;
  network: string;
  broadcast: string;
  /** 'agent' = mask came from the agent's report; 'fallback_24' = mask was null and we defaulted to /24. */
  maskSource: 'agent' | 'fallback_24';
  macs: string[];
}

export interface WakeFailure {
  ok: false;
  code: WakeFailureCode;
  message: string;
}

export type WakeResult = WakeSuccess | WakeFailure;

type MaskSource = 'agent' | 'fallback_24';

interface TargetSubnet {
  ip: string;
  mask: string;
  network: string;
  broadcast: string;
  maskSource: MaskSource;
}

interface RelayCandidate {
  deviceId: string;
  agentId: string;
  hostname: string;
  network: string;
  lastSeen: Date;
}

const WOL_UDP_PORTS = [7, 9] as const;
const FALLBACK_MASK_24 = '255.255.255.0';

// IPv4 dotted-quad → 32-bit unsigned int (big-endian). Returns null if malformed.
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const octet = Number(p);
    if (octet < 0 || octet > 255) return null;
    n = (n * 256) + octet;
  }
  return n >>> 0;
}

export function intToIpv4(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

// Compute the directed subnet broadcast address from an IPv4 + mask.
// Returns null if either input is invalid.
export function computeBroadcast(ip: string, mask: string): { network: string; broadcast: string } | null {
  const ipN = ipv4ToInt(ip);
  const maskN = ipv4ToInt(mask);
  if (ipN === null || maskN === null) return null;
  const networkN = (ipN & maskN) >>> 0;
  const broadcastN = (networkN | (~maskN >>> 0)) >>> 0;
  return { network: intToIpv4(networkN), broadcast: intToIpv4(broadcastN) };
}

/**
 * True if `ip` is in the IPv4 link-local APIPA range (169.254.0.0/16). These
 * are never a real LAN — they're the fallback Windows assigns when DHCP
 * fails on an interface. A relay search against an APIPA /24 will never
 * find a peer (everyone with APIPA picks a different random pair). They
 * must be excluded from target-subnet candidates or dispatchWake will
 * intermittently return NO_RELAY when a host has any APIPA-bound NIC
 * (Bluetooth PAN, virtual switches with no DHCP, etc.) — even when the
 * host's real Ethernet is sitting on a populated 10.x or 192.168.x.
 */
export function isApipaIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  // 169.254.0.0/16 — 0xa9fe0000 ... 0xa9feffff
  return n >= 0xa9fe0000 && n <= 0xa9feffff;
}

async function resolveTargetMacs(targetDeviceId: string): Promise<string[]> {
  // Prefer device_network (live inventory), fall back to device_ip_history (historical).
  const fromNetwork = await db
    .select({ mac: deviceNetwork.macAddress, isPrimary: deviceNetwork.isPrimary, updatedAt: deviceNetwork.updatedAt })
    .from(deviceNetwork)
    .where(and(eq(deviceNetwork.deviceId, targetDeviceId), isNotNull(deviceNetwork.macAddress)));

  const seen = new Set<string>();
  const macs: string[] = [];
  // Sort primary first, then newest.
  const sorted = [...fromNetwork].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });
  for (const row of sorted) {
    if (row.mac && !seen.has(row.mac.toLowerCase())) {
      seen.add(row.mac.toLowerCase());
      macs.push(row.mac);
    }
  }
  if (macs.length > 0) return macs;

  const fromHistory = await db
    .select({ mac: deviceIpHistory.macAddress, lastSeen: deviceIpHistory.lastSeen })
    .from(deviceIpHistory)
    .where(and(eq(deviceIpHistory.deviceId, targetDeviceId), isNotNull(deviceIpHistory.macAddress)))
    .orderBy(desc(deviceIpHistory.lastSeen))
    .limit(20);
  for (const row of fromHistory) {
    if (row.mac && !seen.has(row.mac.toLowerCase())) {
      seen.add(row.mac.toLowerCase());
      macs.push(row.mac);
    }
  }
  return macs;
}

/**
 * Build ALL plausible target subnets for a device, ordered by preference.
 *
 * A laptop typically has multiple active IPv4 rows at once — real LAN
 * (Ethernet/Wi-Fi), virtual switches (Hyper-V vEthernet, Docker), and
 * APIPA fallbacks on whichever NICs have no DHCP lease. Picking ONE row
 * arbitrarily (the previous behavior of LIMIT 1) caused intermittent
 * NO_RELAY: agent inventory inserts every interface at the same
 * timestamp, so the `ORDER BY last_seen DESC LIMIT 1` tie-break was
 * Postgres's planner choice — often a vSwitch or an APIPA address that
 * has no peers anywhere.
 *
 * Returns the full ordered candidate set so the caller can iterate via
 * `selectRelay` until it finds a subnet that has online peers. Order:
 *   1. Agent-reported mask candidates (last_seen DESC).
 *   2. Mask-null candidates, /24 fallback (last_seen DESC).
 * APIPA (169.254.0.0/16) is excluded — a /24 in that range never has
 * peers because every host with APIPA picks a different random pair.
 */
async function resolveTargetSubnetCandidates(
  targetDeviceId: string,
): Promise<{ candidates: TargetSubnet[]; sawIpv6: boolean }> {
  const rows = await db
    .select({
      ip: deviceIpHistory.ipAddress,
      mask: deviceIpHistory.subnetMask,
      lastSeen: deviceIpHistory.lastSeen,
    })
    .from(deviceIpHistory)
    .where(and(
      eq(deviceIpHistory.deviceId, targetDeviceId),
      eq(deviceIpHistory.ipType, 'ipv4'),
    ))
    .orderBy(desc(deviceIpHistory.lastSeen));

  const withMask: TargetSubnet[] = [];
  const withoutMask: TargetSubnet[] = [];
  const seenNetworks = new Set<string>();

  for (const row of rows) {
    if (!row.ip || isApipaIpv4(row.ip)) continue;
    const mask = row.mask || FALLBACK_MASK_24;
    const computed = computeBroadcast(row.ip, mask);
    if (!computed) continue;
    // Dedupe by computed network — two interfaces in the same /24 (e.g.
    // dual-homed NIC) would otherwise duplicate the work.
    if (seenNetworks.has(computed.network)) continue;
    seenNetworks.add(computed.network);
    const candidate: TargetSubnet = {
      ip: row.ip,
      mask,
      ...computed,
      maskSource: row.mask ? 'agent' : 'fallback_24',
    };
    if (row.mask) withMask.push(candidate);
    else withoutMask.push(candidate);
  }

  const candidates = [...withMask, ...withoutMask];
  if (candidates.length > 0) {
    return { candidates, sawIpv6: false };
  }

  const ipv6 = await db
    .select({ id: deviceIpHistory.id })
    .from(deviceIpHistory)
    .where(and(eq(deviceIpHistory.deviceId, targetDeviceId), eq(deviceIpHistory.ipType, 'ipv6')))
    .limit(1);
  return { candidates: [], sawIpv6: ipv6.length > 0 };
}

async function selectRelay(
  siteId: string,
  targetDeviceId: string,
  targetNetwork: string,
): Promise<RelayCandidate | null> {
  // Candidates: online devices at the same site, excluding the target itself,
  // each with their most-recent active IPv4 history entry. Drizzle doesn't
  // give us a clean SQL DISTINCT ON, so we fetch and dedupe in-memory.
  // We do NOT filter by subnet_mask here — when it's null we fall back to
  // /24 to match resolveTargetSubnet's behavior (see [FOLLOWUP] task for the
  // agent-side fix that will populate it).
  const rows = await db
    .select({
      deviceId: devices.id,
      agentId: devices.agentId,
      hostname: devices.hostname,
      ip: deviceIpHistory.ipAddress,
      mask: deviceIpHistory.subnetMask,
      lastSeen: deviceIpHistory.lastSeen,
    })
    .from(devices)
    .innerJoin(deviceIpHistory, eq(deviceIpHistory.deviceId, devices.id))
    .where(and(
      eq(devices.siteId, siteId),
      eq(devices.status, 'online'),
      ne(devices.id, targetDeviceId),
      eq(deviceIpHistory.ipType, 'ipv4'),
      eq(deviceIpHistory.isActive, true),
    ))
    .orderBy(desc(deviceIpHistory.lastSeen));

  // Keep only the newest entry per device.
  const newestByDevice = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    if (!newestByDevice.has(row.deviceId)) newestByDevice.set(row.deviceId, row);
  }

  let best: RelayCandidate | null = null;
  for (const row of newestByDevice.values()) {
    if (!row.ip) continue;
    const computed = computeBroadcast(row.ip, row.mask || FALLBACK_MASK_24);
    if (!computed || computed.network !== targetNetwork) continue;
    if (!isAgentConnected(row.agentId)) continue;
    if (!best || row.lastSeen.getTime() > best.lastSeen.getTime()) {
      best = {
        deviceId: row.deviceId,
        agentId: row.agentId,
        hostname: row.hostname,
        network: computed.network,
        lastSeen: row.lastSeen,
      };
    }
  }
  return best;
}

interface DispatchWakeOptions {
  /** Force a specific relay (must be online, same site, same subnet). For troubleshooting. */
  relayDeviceIdOverride?: string;
  /** IP address of the request (for the audit row). */
  ipAddress?: string;
  /** User-Agent of the request (for the audit row). */
  userAgent?: string;
  /** Correlation id when invoked from a bulk endpoint. Stamped onto the audit row's
   *  details so ops can group N per-device wake audit entries to a single bulk click.
   *  Undefined for single-device wake (audit row carries no bulkId field). */
  bulkId?: string;
}

export async function dispatchWake(
  targetDeviceId: string,
  userId: string,
  options: DispatchWakeOptions = {},
): Promise<WakeResult> {
  const [target] = await db
    .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId, hostname: devices.hostname })
    .from(devices)
    .where(eq(devices.id, targetDeviceId))
    .limit(1);
  if (!target) {
    return { ok: false, code: 'TARGET_NOT_FOUND', message: 'Target device not found.' };
  }

  const macs = await resolveTargetMacs(target.id);
  if (macs.length === 0) {
    return { ok: false, code: 'NO_MACS', message: 'Target has no recorded MAC address. The agent must check in at least once before Wake-on-LAN is available.' };
  }

  const { candidates, sawIpv6 } = await resolveTargetSubnetCandidates(target.id);
  if (candidates.length === 0) {
    return {
      ok: false,
      code: sawIpv6 ? 'IPV6_ONLY' : 'NO_SUBNET',
      message: sawIpv6
        ? 'Target has only IPv6 history. Wake-on-LAN requires an IPv4 record with subnet mask.'
        : 'Target has no usable IPv4 record (APIPA-only addresses don\'t count) — agent must check in at least once on a real LAN.',
    };
  }

  let relay: RelayCandidate | null = null;
  let subnet: TargetSubnet | null = null;

  if (options.relayDeviceIdOverride) {
    const [override] = await db
      .select({
        id: devices.id,
        agentId: devices.agentId,
        hostname: devices.hostname,
        siteId: devices.siteId,
        status: devices.status,
      })
      .from(devices)
      .where(eq(devices.id, options.relayDeviceIdOverride))
      .limit(1);
    if (!override || override.siteId !== target.siteId || override.status !== 'online' || override.id === target.id || !isAgentConnected(override.agentId)) {
      return { ok: false, code: 'RELAY_OVERRIDE_INVALID', message: 'Override relay must be a different online device at the target\'s site with a live agent connection.' };
    }
    // Override: use the first candidate subnet (best-guess broadcast).
    // Operator opted into this path — they're picking the relay, not the
    // network. If their override sits on a different subnet than the
    // chosen broadcast, the packet still goes out but won't reach the
    // target. Documented as a troubleshooting tool, not a normal path.
    subnet = candidates[0]!;
    relay = {
      deviceId: override.id,
      agentId: override.agentId,
      hostname: override.hostname,
      network: subnet.network,
      lastSeen: new Date(),
    };
  } else {
    // Try each candidate subnet in priority order. First match wins.
    // This matters when a laptop has both a real LAN interface and a
    // Hyper-V/Docker virtual switch — the virtual switch has no peer
    // agents, so we must keep looking instead of bailing on the first
    // failed match. Pre-fix, an arbitrary LIMIT 1 row pick produced
    // intermittent NO_RELAY for any target with multiple active IPv4
    // rows.
    for (const candidate of candidates) {
      const found = await selectRelay(target.siteId, target.id, candidate.network);
      if (found) {
        relay = found;
        subnet = candidate;
        break;
      }
    }
  }

  if (!relay || !subnet) {
    return {
      ok: false,
      code: 'NO_RELAY',
      message: `No online peer agent at the target's site has a recorded IPv4 on any of the ${candidates.length} candidate subnet(s) for this target.`,
    };
  }

  const wakeAttemptId = randomUUID();
  const payload = {
    targetDeviceId: target.id,
    targetHostname: target.hostname,
    macs,
    network: subnet.network,
    broadcast: subnet.broadcast,
    ports: WOL_UDP_PORTS,
    wakeAttemptId,
  };

  // Row is addressed to the RELAY so the agentWs result handler matches by
  // (commandId, relay.deviceId, targetRole='agent').
  const [command] = await db
    .insert(deviceCommands)
    .values({
      deviceId: relay.deviceId,
      type: CommandTypes.WAKE_ON_LAN,
      payload,
      status: 'pending',
      createdBy: userId,
    })
    .returning({ id: deviceCommands.id });

  if (!command) {
    return { ok: false, code: 'WS_SEND_FAILED', message: 'Failed to record wake command.' };
  }

  // Audit row points at the TARGET (the device the user is acting on) and
  // records the relay used as context.
  await db.insert(auditLogs).values({
    orgId: target.orgId,
    actorType: 'user',
    actorId: userId,
    action: 'device.wake_on_lan',
    resourceType: 'device',
    resourceId: target.id,
    resourceName: target.hostname,
    details: {
      commandId: command.id,
      wakeAttemptId,
      targetDeviceId: target.id,
      relayDeviceId: relay.deviceId,
      relayHostname: relay.hostname,
      network: subnet.network,
      broadcast: subnet.broadcast,
      mask: subnet.mask,
      maskSource: subnet.maskSource,
      macs,
      relayOverride: Boolean(options.relayDeviceIdOverride),
      ...(options.bulkId ? { bulkId: options.bulkId } : {}),
    },
    ipAddress: options.ipAddress,
    userAgent: options.userAgent,
    result: 'success',
  });

  const claimed = await claimPendingCommandForDelivery(command.id);
  if (!claimed) {
    return { ok: false, code: 'WS_SEND_FAILED', message: 'Failed to claim wake command for dispatch.' };
  }

  const sent = sendCommandToAgent(relay.agentId, {
    id: command.id,
    type: CommandTypes.WAKE_ON_LAN,
    payload,
  });

  if (!sent) {
    await releaseClaimedCommandDelivery(command.id, claimed.executedAt);
    return { ok: false, code: 'WS_SEND_FAILED', message: 'Relay agent went offline before the command could be sent. Try again.' };
  }

  return {
    ok: true,
    commandId: command.id,
    wakeAttemptId,
    targetDeviceId: target.id,
    targetHostname: target.hostname,
    relayDeviceId: relay.deviceId,
    relayHostname: relay.hostname,
    network: subnet.network,
    broadcast: subnet.broadcast,
    maskSource: subnet.maskSource,
    macs,
  };
}
