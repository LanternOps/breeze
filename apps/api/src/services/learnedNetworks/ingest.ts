import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { sql } from 'drizzle-orm';
import { parseNetworkAttachmentsReport, type NetworkAttachment, type NetworkAttachmentsReport } from '@breeze/shared';
import { learnedNetworksIngestEnabled } from '../../config/env';
import { db } from '../../db';
import { isNonPublicAddress } from '../ipClassifyOfflineData';
import {
  LEARNED_NETWORKS_PER_ORG_MAX, NETWORK_ATTACHMENT_MAX_CAPTURE_SKEW_MS, WAN_ADDRESSES_PER_NETWORK_MAX,
} from './constants';

/**
 * Learned networks W01b (#12369): heartbeat ingest. Spec
 * docs/superpowers/specs/monitoring/2026-11-20-learned-networks-discovery-gate-design.md §8.1; index contract E3.
 *
 * The planner is pure. Only an `apply` plan touches the learned tables, and this module never writes `devices`:
 * the heartbeat folds `deviceFields` into its own `updateOwnDeviceRow` call.
 */

export type AttachmentDeviceState = {
  id: string; orgId: string; isEphemeral: boolean;
  networkAttachmentEpoch: string | null; networkAttachmentSequence: number | null;
  networkAttachmentDigest: string | null;
};

export type AttachmentDeviceFields = {
  networkAttachmentEpoch: string; networkAttachmentSequence: number;
  networkAttachmentDigest: string; networkAttachmentsConfirmedAt: Date;
};

export type IngestIgnoreReason =
  | 'absent' | 'disabled' | 'ephemeral' | 'invalid_report' | 'stale_sequence' | 'capture_time_out_of_bounds';

export type IngestPlan =
  | { kind: 'ignore'; reason: IngestIgnoreReason }
  | { kind: 'confirm'; deviceFields: AttachmentDeviceFields }
  | { kind: 'apply'; deviceFields: AttachmentDeviceFields; report: NetworkAttachmentsReport; wanAddress: string | null };

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * SHA-256 hex of `['v1', complete, wan, rows]`, rows sorted by interface name, gateway address, gateway MAC.
 * `epoch`, `sequence` and `capturedAt` are deliberately left out: only what the device is attached to counts.
 */
export function attachmentDigest(report: NetworkAttachmentsReport, wanAddress: string | null): string {
  const rows = report.attachments
    .map((a) => [a.interfaceName, a.localAddress, a.prefixLength, a.gatewayAddress, a.gatewayMac, a.primary] as const)
    .sort((x, y) => compareText(x[0], y[0]) || compareText(x[3], y[3]) || compareText(x[4] ?? '', y[4] ?? ''));
  return createHash('sha256').update(JSON.stringify(['v1', report.complete, wanAddress, rows])).digest('hex');
}

/**
 * The WAN address is recorded only when the trusted client IP is a public IP and the report has a primary
 * attachment with a gateway MAC (the network the WAN row goes to). Anything else is null, in the digest too.
 */
function normalizeWanAddress(report: NetworkAttachmentsReport, wanAddress: string | null): string | null {
  const ip = wanAddress?.trim() ?? '';
  if (!ip || isIP(ip) === 0 || isNonPublicAddress(ip)) return null;
  return report.attachments.some((a) => a.primary && a.gatewayMac !== null) ? ip : null;
}

/** Pure. No database access; reads only the kill switch. The first reason that applies wins. */
export function planNetworkAttachmentIngest(
  device: AttachmentDeviceState, raw: unknown, wanAddress: string | null, now: Date,
): IngestPlan {
  // An absent field means "no change" (contract C1): the agent attaches each finished report to one beat.
  if (raw === undefined) return { kind: 'ignore', reason: 'absent' };
  if (!learnedNetworksIngestEnabled()) return { kind: 'ignore', reason: 'disabled' };
  if (device.isEphemeral) return { kind: 'ignore', reason: 'ephemeral' };

  const parsed = parseNetworkAttachmentsReport(raw);
  if (!parsed.accepted) return { kind: 'ignore', reason: 'invalid_report' };
  const report = parsed.report;

  if (
    report.epoch === device.networkAttachmentEpoch
    && device.networkAttachmentSequence !== null
    && report.sequence <= device.networkAttachmentSequence
  ) {
    return { kind: 'ignore', reason: 'stale_sequence' };
  }

  if (Math.abs(now.getTime() - Date.parse(report.capturedAt)) > NETWORK_ATTACHMENT_MAX_CAPTURE_SKEW_MS) {
    return { kind: 'ignore', reason: 'capture_time_out_of_bounds' };
  }

  const wan = normalizeWanAddress(report, wanAddress);
  const digest = attachmentDigest(report, wan);
  const deviceFields: AttachmentDeviceFields = {
    networkAttachmentEpoch: report.epoch,
    networkAttachmentSequence: report.sequence,
    networkAttachmentDigest: digest,
    networkAttachmentsConfirmedAt: now,
  };
  if (digest === device.networkAttachmentDigest) return { kind: 'confirm', deviceFields };
  return { kind: 'apply', deviceFields, report, wanAddress: wan };
}

const SKEW_LOG_INTERVAL_MS = 60 * 60_000;
const SKEW_LOG_MAX_DEVICES = 10_000;
const skewLoggedAt = new Map<string, number>();

/**
 * Review focus 5: a report ignored for `capture_time_out_of_bounds` is logged with the device id and the skew,
 * at most once per device per hour, so support can find a device whose clock is wrong. The map is bounded:
 * past its cap the oldest entry goes first (insertion order; an entry is re-inserted when it logs again).
 */
export function noteCaptureTimeSkew(deviceId: string, raw: unknown, now: Date): void {
  const capturedAt = raw && typeof raw === 'object' ? (raw as { capturedAt?: unknown }).capturedAt : undefined;
  const capturedMs = typeof capturedAt === 'string' ? Date.parse(capturedAt) : Number.NaN;
  const last = skewLoggedAt.get(deviceId);
  if (last !== undefined && now.getTime() - last < SKEW_LOG_INTERVAL_MS) return;
  skewLoggedAt.delete(deviceId);
  skewLoggedAt.set(deviceId, now.getTime());
  while (skewLoggedAt.size > SKEW_LOG_MAX_DEVICES) skewLoggedAt.delete(skewLoggedAt.keys().next().value!);
  console.warn('[learnedNetworks] networkAttachmentsV1 capturedAt outside the accepted bound; report ignored', {
    deviceId, skewSeconds: Math.round((capturedMs - now.getTime()) / 1000),
  });
}

/** Test-only: forget which devices were logged. */
export function __resetCaptureTimeSkewLogForTests(): void {
  skewLoggedAt.clear();
}

type FingerprintAttachment = NetworkAttachment & { gatewayMac: string };
type ResolvedGateway = { gatewayId: string; networkId: string; attachment: FingerprintAttachment };

const fingerprintKey = (a: { gatewayMac: string; gatewayAddress: string }) => `${a.gatewayMac} ${a.gatewayAddress}`;

/** Representative of attachments behind one fingerprint: the primary one, else the lowest interface name. */
function preferAttachment(a: FingerprintAttachment, b: FingerprintAttachment): FingerprintAttachment {
  if (a.primary !== b.primary) return a.primary ? a : b;
  return b.interfaceName < a.interfaceName ? b : a;
}

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

/**
 * Writes the membership change for an `apply` plan, on the ambient `db` (the caller's context and savepoint).
 * Writes only learned tables, never `devices`. Lock order: fingerprint advisory locks in ascending
 * (gateway_mac, gateway_address), then membership rows in ascending gateway_id.
 */
export async function applyNetworkAttachmentChange(
  device: { id: string; orgId: string },
  plan: Extract<IngestPlan, { kind: 'apply' }>, now: Date,
): Promise<void> {
  const { report, wanAddress } = plan;
  const at = now.toISOString();

  // 1. One representative attachment per fingerprint.
  const groups = new Map<string, FingerprintAttachment>();
  for (const a of report.attachments) {
    if (a.gatewayMac === null) continue;
    const fa = a as FingerprintAttachment;
    const key = fingerprintKey(fa);
    const held = groups.get(key);
    groups.set(key, held ? preferAttachment(held, fa) : fa);
  }
  const wanted = [...groups.values()].sort((x, y) =>
    compareText(x.gatewayMac, y.gatewayMac) || compareText(x.gatewayAddress, y.gatewayAddress));

  // 2. Existing fingerprints, one read.
  const resolved: ResolvedGateway[] = [];
  const found = new Map<string, { id: string; network_id: string }>();
  if (wanted.length > 0) {
    const keys = sql.join(wanted.map((a) => sql`(${a.gatewayMac}::macaddr, ${a.gatewayAddress}::inet)`), sql`, `);
    const existing = await rows<{ id: string; network_id: string; gateway_mac: string; gateway_address: string }>(sql`
      SELECT id, network_id, gateway_mac::text AS gateway_mac, host(gateway_address) AS gateway_address
        FROM learned_network_gateways
       WHERE org_id = ${device.orgId}::uuid AND (gateway_mac, gateway_address) IN (${keys})`);
    for (const g of existing) found.set(fingerprintKey({ gatewayMac: g.gateway_mac, gatewayAddress: g.gateway_address }), g);
  }

  // 3. Missing fingerprints, ascending: lock, re-read, then create (soft per-org cap).
  for (const a of wanted) {
    let gateway = found.get(fingerprintKey(a));
    if (!gateway) {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
        'learned_network_fingerprint:' || ${device.orgId}::text || ':' || ${a.gatewayMac}::text || ':' || ${a.gatewayAddress}::text, 0))`);
      [gateway] = await rows<{ id: string; network_id: string }>(sql`
        SELECT id, network_id FROM learned_network_gateways
         WHERE org_id = ${device.orgId}::uuid AND gateway_mac = ${a.gatewayMac}::macaddr
           AND gateway_address = ${a.gatewayAddress}::inet`);
    }
    if (!gateway) {
      const [{ n } = { n: 0 }] = await rows<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM learned_networks WHERE org_id = ${device.orgId}::uuid`);
      if (n >= LEARNED_NETWORKS_PER_ORG_MAX) {
        console.warn('[learnedNetworks] per-org network limit reached; new fingerprint not learned', {
          orgId: device.orgId, deviceId: device.id, limit: LEARNED_NETWORKS_PER_ORG_MAX,
        });
        continue;
      }
      [gateway] = await rows<{ id: string; network_id: string }>(sql`
        WITH network AS (
          INSERT INTO learned_networks (org_id, prefix, first_seen_at, last_seen_at, created_at, updated_at)
          VALUES (${device.orgId}::uuid, network(set_masklen(${a.localAddress}::inet, ${a.prefixLength}::int)),
                  ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz)
          RETURNING id)
        INSERT INTO learned_network_gateways (org_id, network_id, gateway_address, gateway_mac, first_seen_at, last_seen_at)
        SELECT ${device.orgId}::uuid, network.id, ${a.gatewayAddress}::inet, ${a.gatewayMac}::macaddr,
               ${at}::timestamptz, ${at}::timestamptz
          FROM network
        RETURNING id, network_id`);
    }
    if (gateway) resolved.push({ gatewayId: gateway.id, networkId: gateway.network_id, attachment: a });
  }

  // 4. Memberships, ascending gateway_id.
  resolved.sort((x, y) => compareText(x.gatewayId, y.gatewayId));
  if (resolved.length > 0) {
    const values = sql.join(resolved.map((r) => sql`(${device.orgId}::uuid, ${device.id}::uuid, ${r.gatewayId}::uuid,
      ${r.attachment.interfaceName}, ${r.attachment.localAddress}::inet, ${r.attachment.primary}, true,
      ${at}::timestamptz, ${at}::timestamptz)`), sql`, `);
    await db.execute(sql`
      INSERT INTO learned_network_devices
        (org_id, device_id, gateway_id, interface_name, local_address, is_primary, is_current, first_seen_at, last_seen_at)
      VALUES ${values}
      ON CONFLICT (device_id, gateway_id) DO UPDATE SET
        interface_name = EXCLUDED.interface_name, local_address = EXCLUDED.local_address,
        is_primary = EXCLUDED.is_primary, is_current = true, last_seen_at = EXCLUDED.last_seen_at`);
  }

  // 5. A complete report clears current rows it no longer lists, except the ones a null-MAC attachment protects
  //    (same interface, address and gateway address: a gateway that dropped out of the neighbour cache).
  if (report.complete) {
    const kept = resolved.length > 0
      ? sql`AND m.gateway_id NOT IN (${sql.join(resolved.map((r) => sql`${r.gatewayId}::uuid`), sql`, `)})`
      : sql``;
    const unresolved = report.attachments.filter((a) => a.gatewayMac === null);
    const protectedRows = unresolved.length > 0
      ? sql`AND (m.interface_name, m.local_address, g.gateway_address) NOT IN (${sql.join(unresolved.map((a) =>
        sql`(${a.interfaceName}::varchar, ${a.localAddress}::inet, ${a.gatewayAddress}::inet)`), sql`, `)})`
      : sql``;
    await db.execute(sql`
      UPDATE learned_network_devices m SET is_current = false
        FROM learned_network_gateways g
       WHERE g.id = m.gateway_id AND m.device_id = ${device.id}::uuid AND m.is_current ${kept} ${protectedRows}`);
  }

  // 6a. Prefix, one per network (its primary attachment, else the lowest interface name), only when different.
  const perNetwork = new Map<string, FingerprintAttachment>();
  for (const r of resolved) {
    const held = perNetwork.get(r.networkId);
    perNetwork.set(r.networkId, held ? preferAttachment(held, r.attachment) : r.attachment);
  }
  for (const networkId of [...perNetwork.keys()].sort(compareText)) {
    const a = perNetwork.get(networkId)!;
    await db.execute(sql`
      UPDATE learned_networks
         SET prefix = network(set_masklen(${a.localAddress}::inet, ${a.prefixLength}::int)), updated_at = ${at}::timestamptz
       WHERE id = ${networkId}::uuid
         AND prefix IS DISTINCT FROM network(set_masklen(${a.localAddress}::inet, ${a.prefixLength}::int))`);
  }

  // 6b. WAN on the primary attachment's network. An existing row is never rewritten here: the hourly refresh
  //     dates it, so an office that applies at once does not queue on one row.
  if (wanAddress !== null) {
    const primary = resolved.find((r) => r.attachment.primary);
    if (primary) {
      const inserted = await rows<{ id: string }>(sql`
        INSERT INTO learned_network_wan_addresses (org_id, network_id, address, first_seen_at, last_seen_at)
        VALUES (${device.orgId}::uuid, ${primary.networkId}::uuid, ${wanAddress}::inet, ${at}::timestamptz, ${at}::timestamptz)
        ON CONFLICT (network_id, address) DO NOTHING
        RETURNING id`);
      if (inserted.length > 0) {
        await db.execute(sql`
          DELETE FROM learned_network_wan_addresses
           WHERE network_id = ${primary.networkId}::uuid
             AND id NOT IN (
               SELECT id FROM learned_network_wan_addresses WHERE network_id = ${primary.networkId}::uuid
                ORDER BY last_seen_at DESC, id DESC LIMIT ${WAN_ADDRESSES_PER_NETWORK_MAX})`);
      }
    }
  }
}
