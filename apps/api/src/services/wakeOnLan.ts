import { and, desc, eq, gte, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { openOrJoinWakeAttempt, recordWakeRefusal, applyWakeRelayResult } from './wakeAttempts';
import {
  auditLogs,
  deviceCommands,
  deviceWakeAttempts,
  deviceIpHistory,
  deviceNetwork,
  devices,
} from '../db/schema';
import { CommandTypes } from './commandQueue';
import { claimPendingCommandForDelivery, releaseClaimedCommandDelivery } from './commandDispatch';
import { cancelledCommandError } from './commandCancelMessage';
import { isAgentConnected, sendCommandToAgent } from '../routes/agentWs';
import { isParkedDevice, PARKED_DEVICE_COMMAND_REFUSAL_MESSAGE } from './unassignedPool/deliveryEligibility';
import { markRequestAuditWritten } from './auditRequestTracking';
import { captureException } from './sentry';

export type WakeFailureCode =
  | 'TARGET_NOT_FOUND'
  | 'TARGET_ONLINE'
  | 'NO_MACS'
  | 'NO_SUBNET'
  | 'IPV6_ONLY'
  | 'NO_RELAY'
  | 'RELAY_OVERRIDE_INVALID'
  | 'WS_SEND_FAILED'
  /**
   * The push's claim-time eligibility check (the same one the heartbeat claim
   * runs) refused and cancelled the wake command; it will not be sent.
   */
  | 'COMMAND_CANCELLED'
  /** Target or relay is parked in a holding org: lifecycle removal only. */
  | 'DEVICE_PENDING_ASSIGNMENT';

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

export interface WakePrepared extends WakeSuccess {
  /**
   * Sends the committed command to the relay. Call it after the caller's
   * transaction commits, with no ambient DB context: a relay result that
   * arrives before the commit finds no command row and is dropped.
   */
  deliver: () => Promise<WakeResult>;
}

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

// Two default 60-second agent heartbeats.
const TARGET_ONLINE_FRESHNESS_MS = 120_000;
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

/** Mirrors the agent's six-byte parseMAC formats, excluding non-unicast and zero addresses. */
export function isWakeableMac(mac: string): boolean {
  // Go strings.TrimSpace uses Unicode White_Space (unlike JavaScript trim's BOM handling).
  const value = mac.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
  if (!/^(?:[0-9a-f]{2}([:-])(?:[0-9a-f]{2}\1){4}[0-9a-f]{2}|[0-9a-f]{4}(?:\.[0-9a-f]{4}){2})$/i.test(value)) return false;
  const hex = value.replace(/[:.-]/g, '');
  return hex !== '000000000000' && (parseInt(hex.slice(0, 2), 16) & 1) === 0;
}

async function resolveTargetMacs(targetDeviceId: string, orgId: string): Promise<string[]> {
  const now = Date.now();
  const latestSighting = new Date(now + 5 * 60 * 1000);
  // Live inventory takes precedence over recent historical interfaces.
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
    if (row.mac && isWakeableMac(row.mac) && !seen.has(row.mac.toLowerCase())) {
      seen.add(row.mac.toLowerCase());
      macs.push(row.mac);
    }
  }

  const historyMac = sql<string>`lower(${deviceIpHistory.macAddress})`;
  const newestHistory = sql<Date>`max(${deviceIpHistory.lastSeen})`.mapWith(deviceIpHistory.lastSeen);
  const fromHistory = await db
    .select({ mac: sql<string>`min(${deviceIpHistory.macAddress})`, lastSeen: newestHistory })
    .from(deviceIpHistory)
    .where(and(
      eq(deviceIpHistory.deviceId, targetDeviceId),
      isNotNull(deviceIpHistory.macAddress),
      gte(deviceIpHistory.lastSeen, new Date(now - 30 * 24 * 60 * 60 * 1000)),
      lte(deviceIpHistory.lastSeen, latestSighting),
    ))
    .groupBy(historyMac)
    .orderBy(desc(newestHistory))
    .limit(32);

  // Validate before candidate deduplication and the final eight-MAC cap. The
  // query's limit runs first, so 32 newer invalid MACs could crowd out a valid
  // one; it bounds the rival lookup below, and history is only the fallback.
  const candidates = new Map<string, typeof fromHistory[number]>();
  for (const row of fromHistory) {
    if (!row.mac || !isWakeableMac(row.mac)) continue;
    const key = row.mac.toLowerCase();
    if (!seen.has(key) && !candidates.has(key)) candidates.set(key, row);
  }
  const newestRival = new Map<string, number>();
  if (candidates.size > 0) {
    const keys = [...candidates.keys()];
    // One indexed union query for both sources, scoped by denormalized org_id.
    const networkMac = sql<string>`lower(${deviceNetwork.macAddress})`;
    const rivals = await db
      .select({ mac: networkMac, lastSeen: sql<Date>`max(${deviceNetwork.updatedAt})`.mapWith(deviceNetwork.updatedAt) })
      .from(deviceNetwork)
      .where(and(eq(deviceNetwork.orgId, orgId), ne(deviceNetwork.deviceId, targetDeviceId), inArray(networkMac, keys), lte(deviceNetwork.updatedAt, latestSighting)))
      .groupBy(networkMac)
      .unionAll(db
        .select({ mac: historyMac, lastSeen: sql<Date>`max(${deviceIpHistory.lastSeen})`.mapWith(deviceIpHistory.lastSeen) })
        .from(deviceIpHistory)
        .where(and(eq(deviceIpHistory.orgId, orgId), ne(deviceIpHistory.deviceId, targetDeviceId), inArray(historyMac, keys), lte(deviceIpHistory.lastSeen, latestSighting)))
        .groupBy(historyMac));
    for (const row of rivals) {
      newestRival.set(row.mac, Math.max(newestRival.get(row.mac) ?? -Infinity, row.lastSeen.getTime()));
    }
  }
  for (const [key, row] of candidates) {
    if (macs.length >= 8) break;
    if ((newestRival.get(key) ?? -Infinity) <= row.lastSeen.getTime()) {
      macs.push(row.mac!);
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
): Promise<WakePrepared | WakeFailure> {
  const [target] = await db
    .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId, hostname: devices.hostname, status: devices.status, lastSeenAt: devices.lastSeenAt })
    .from(devices)
    .where(eq(devices.id, targetDeviceId))
    .limit(1);
  if (!target) {
    return { ok: false, code: 'TARGET_NOT_FOUND', message: 'Target device not found.' };
  }
  if (target.status === 'online' && target.lastSeenAt !== null
    && target.lastSeenAt.getTime() >= Date.now() - TARGET_ONLINE_FRESHNESS_MS) {
    return { ok: false, code: 'TARGET_ONLINE', message: 'Target device is already online.' };
  }
  if (await isParkedDevice(db, target.id)) {
    return { ok: false, code: 'DEVICE_PENDING_ASSIGNMENT', message: PARKED_DEVICE_COMMAND_REFUSAL_MESSAGE };
  }

  const refuse = async (failure: WakeFailure): Promise<WakeFailure> => {
    await recordWakeRefusal({ deviceId: target.id, orgId: target.orgId, requestedBy: userId, bulkId: options.bulkId, code: failure.code });
    return failure;
  };

  const macs = await resolveTargetMacs(target.id, target.orgId);
  if (macs.length === 0) {
    return refuse({ ok: false, code: 'NO_MACS', message: 'Target has no recorded MAC address. The agent must check in at least once before Wake-on-LAN is available.' });
  }

  const { candidates, sawIpv6 } = await resolveTargetSubnetCandidates(target.id);
  if (candidates.length === 0) {
    return refuse({
      ok: false,
      code: sawIpv6 ? 'IPV6_ONLY' : 'NO_SUBNET',
      message: sawIpv6
        ? 'Target has only IPv6 history. Wake-on-LAN requires an IPv4 record with subnet mask.'
        : 'Target has no usable IPv4 record (APIPA-only addresses don\'t count) — agent must check in at least once on a real LAN.',
    });
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
      return refuse({ ok: false, code: 'RELAY_OVERRIDE_INVALID', message: 'Override relay must be a different online device at the target\'s site with a live agent connection.' });
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
    return refuse({
      ok: false,
      code: 'NO_RELAY',
      message: `No online peer agent at the target's site has a recorded IPv4 on any of the ${candidates.length} candidate subnet(s) for this target.`,
    });
  }

  // The row is addressed to the relay, so the relay is the device that
  // receives a command. A relay shares the target's site, so this only fires
  // if that invariant ever changes — kept so the write is gated either way.
  if (await isParkedDevice(db, relay.deviceId)) {
    return { ok: false, code: 'DEVICE_PENDING_ASSIGNMENT', message: PARKED_DEVICE_COMMAND_REFUSAL_MESSAGE };
  }

  const { attemptId: wakeAttemptId, joined } = await openOrJoinWakeAttempt({
    deviceId: target.id, orgId: target.orgId, relayDeviceId: relay.deviceId,
    relayHostname: relay.hostname, requestedBy: userId, bulkId: options.bulkId,
    macs, broadcast: subnet.broadcast,
  });
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

  // Throwing rolls the attempt back with the caller's transaction.
  if (!command) throw new Error('Failed to record wake command');

  if (!joined) {
    await db.update(deviceWakeAttempts).set({ deviceCommandId: command.id })
      .where(eq(deviceWakeAttempts.id, wakeAttemptId));
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
  markRequestAuditWritten();

  const success: WakeSuccess = {
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
  const deliver = async (): Promise<WakeResult> => {
    let claimed: Awaited<ReturnType<typeof claimPendingCommandForDelivery>>;
    try {
      claimed = await claimPendingCommandForDelivery(command.id);
    } catch (error) {
      // The claim did not complete, so the committed command is still pending
      // and the relay can pick it up at its next check-in. The attempt stays
      // open for the sweep to resolve.
      console.error('[wakeOnLan] wake claim failed after commit', { commandId: command.id, wakeAttemptId, error });
      captureException(error);
      return { ok: false, code: 'WS_SEND_FAILED', message: 'The wake command is queued but could not be sent right away. The relay may still send it at its next check-in.' };
    }
    if (claimed.status === 'cancelled') {
      if (!joined) await withSystemDbAccessContext(() => applyWakeRelayResult(wakeAttemptId, false));
      return { ok: false, code: 'COMMAND_CANCELLED', message: cancelledCommandError(claimed.reason) };
    }
    if (claimed.status !== 'claimed') {
      if (!joined) await withSystemDbAccessContext(() => applyWakeRelayResult(wakeAttemptId, false));
      return { ok: false, code: 'WS_SEND_FAILED', message: 'Failed to claim wake command for dispatch.' };
    }

    // #8318 §6.4: to the relay's agent_id read IN the claim, not the one the
    // relay selection read before it (a reattach or re-enroll may have
    // committed since).
    const sent = sendCommandToAgent(claimed.agentId, {
      id: command.id,
      type: CommandTypes.WAKE_ON_LAN,
      payload,
    });

    if (!sent) {
      if (!joined) await withSystemDbAccessContext(() => applyWakeRelayResult(wakeAttemptId, false));
      await releaseClaimedCommandDelivery(command.id, claimed.executedAt);
      return { ok: false, code: 'WS_SEND_FAILED', message: 'Relay agent went offline before the command could be sent. Try again.' };
    }

    return success;
  };
  return { ...success, deliver };
}
