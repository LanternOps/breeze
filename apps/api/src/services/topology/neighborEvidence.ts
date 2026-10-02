import { sql } from 'drizzle-orm';
import {
  TOPOLOGY_NEIGHBOR_MAPPING_STATES, topologyCidrSchema, topologyNetworkClass,
  type GraphQuery, type TopologyNeighborMappingState, type TopologyNetworkClass, type TopologyScope,
} from '@breeze/shared';
import type { db } from '../../db';
import { topologyOsContextKey } from './collectionFactKeys';
import { nodeFilter, nodeLabelSql, scoped, type ReadExposure } from './graphRead';
import { parseIpAddress, parsePrefix, type Family } from './ipAddress';

export { topologyOsContextKey } from './collectionFactKeys';

/**
 * Neighbour-evidence selector (#7816/#7817, design note
 * docs/superpowers/plans/monitoring/2026-10-02-topology-neighbour-corroboration.md).
 *
 * Reads agents' PUBLISHED ARP/NDP `neighbors` baselines and the matching published
 * `interfaces` baselines of one site, under the graph read's publication lock, and
 * indexes the rows that qualify as exact (IP, MAC) cache mappings. It writes nothing
 * and grants nothing: callers use it only to corroborate presentation placement
 * (inferred/low) and gateway candidates. Pending (unpublished) content never counts,
 * and a missing or truncated row never means absence.
 */

/** Neighbour sources read per site (observers x contexts). Beyond it coverage is limited. */
export const NEIGHBOR_SOURCE_CAP = 256;
/** Address-filtered rows read per neighbour source. Beyond it coverage is limited. */
export const NEIGHBOR_ROWS_PER_SOURCE_CAP = 256;
/** Qualifying tuples indexed per read. Beyond it coverage is limited. */
export const NEIGHBOR_TUPLE_BUDGET = 16_384;
/** Distinct addresses a read may ask about. Beyond it coverage is limited. */
export const NEIGHBOR_ADDRESS_CAP = 8_192;

export type NeighborRowInput = {
  rowKey: string; address: string; family: string; zone: string | null; interfaceKey: string;
  mac: string | null; state: string; isRouter: boolean | null;
};
export type InterfaceAddressInput = { address: string; prefixLength: number; family: string; zone: string | null; state: string };
export type InterfaceRowInput = {
  interfaceKey: string; name: string | null; kind: string; adminState: string; operState: string;
  addresses: InterfaceAddressInput[]; currentMac?: string | null; permanentMac?: string | null;
};
/** One observer context: its published neighbours baseline plus the same context's published interfaces baseline. */
export type NeighborObserverBaseline = {
  sourceId: string; observerNodeId: string; observerLabel: string; producerId: string; contextKey: string;
  addressFamily: 'any' | 'ipv4' | 'ipv6';
  outcome: string; omittedRowCount: number;
  /** The read stopped at NEIGHBOR_ROWS_PER_SOURCE_CAP for this source. */
  rowsTruncated: boolean;
  /** Collection confirmation time / expiry of the published neighbours content (null = unknown). */
  confirmedAt: string | null; expiresAt: string | null;
  rows: NeighborRowInput[];
  /** null when no qualifying published interfaces baseline exists for this context. */
  interfaces: { rows: InterfaceRowInput[]; expiresAt: string | null } | null;
  /** interfaceKey -> canonical topology_interfaces.id of the observer under the current epoch. */
  interfaceIds: Record<string, string>;
};
export type NeighborEvidenceRead = { baselines: NeighborObserverBaseline[]; limited: boolean };

export type NeighborTuple = {
  observerNodeId: string; observerLabel: string; sourceId: string; producerId: string; contextKey: string;
  /** Opaque OS context key, equal to the relationship `logical_context.contextKey` of the same context. */
  context: string;
  rowKey: string; interfaceKey: string; interfaceId: string | null; interfaceName: string | null;
  family: Family; address: string; addressKey: string; zone: string | null; mac: string;
  state: TopologyNeighborMappingState; isRouter: boolean | null;
  /** The observer interface prefix (canonical CIDR) that contains the neighbour. */
  prefix: string; networkClass: TopologyNetworkClass; linkLocal: boolean;
  confirmedAt: string; expiresAt: string;
};
export type NeighborRowRejection = 'state' | 'mac' | 'address' | 'interface' | 'interface_down' | 'tunnel' | 'self' | 'not_in_prefix';
export type NeighborRowQualification =
  | { ok: true; mac: string; addressKey: string; family: Family; prefix: string; networkClass: TopologyNetworkClass; linkLocal: boolean; interfaceName: string | null }
  | { ok: false; reason: NeighborRowRejection };
export type NeighborEvidenceIndex = {
  coverage: 'complete' | 'limited';
  tupleCount: number;
  /** Canonical address key (`addressKey`) -> qualifying, fresh tuples. */
  byAddress: Map<string, NeighborTuple[]>;
  rejected: Partial<Record<NeighborRowRejection | 'expired', number>>;
};

const MAPPING_STATES: ReadonlySet<string> = new Set(TOPOLOGY_NEIGHBOR_MAPPING_STATES);
const USABLE_ADDRESS_STATES: ReadonlySet<string> = new Set(['preferred', 'deprecated']);

/** `aa:bb:cc:dd:ee:ff` for any common 48-bit MAC spelling (colon, dash, dotted, bare), else null. */
export function canonicalMac(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (!/^(?:[0-9a-f]{2}([:-]?)(?:[0-9a-f]{2}\1){4}[0-9a-f]{2}|[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})$/.test(text)) return null;
  const hex = text.replace(/[^0-9a-f]/g, '');
  return hex.match(/../g)!.join(':');
}
/** Unicast, non-zero: the I/G bit of the first octet is clear (this also rejects broadcast). Locally administered stays eligible. */
function unicastMac(mac: string): boolean {
  return mac !== '00:00:00:00:00:00' && (parseInt(mac.slice(0, 2), 16) & 1) === 0;
}
/** Stable comparison key of an IP address: `<family>:<hex value>` (zone ignored). */
export function addressKey(text: string): string | null {
  const parsed = parseIpAddress(text);
  return parsed ? `${parsed.family}:${parsed.value.toString(16)}` : null;
}
function inRange(value: bigint, base: bigint, length: number, bits: number): boolean {
  const shift = BigInt(bits - length);
  return (value >> shift) === (base >> shift);
}
function specialAddress(family: Family, value: bigint): boolean {
  if (family === 4) {
    return inRange(value, 0n, 8, 32) || inRange(value, 0x7f000000n, 8, 32) || inRange(value, 0xe0000000n, 4, 32) || value === 0xffffffffn;
  }
  return value === 0n || value === 1n || inRange(value, 0xffn << 120n, 8, 128);
}
function linkLocal(family: Family, value: bigint): boolean {
  return family === 4 ? inRange(value, 0xa9fe0000n, 16, 32) : inRange(value, 0xfe80n << 112n, 10, 128);
}
const familyOf = (text: string): Family | null => (text === 'ipv4' ? 4 : text === 'ipv6' ? 6 : null);

/**
 * Row qualification (contract §2): an explicit mapping state, a valid unicast MAC, a
 * routable unicast address of the row's family, on a known interface that is not
 * explicitly down and not a tunnel, inside one of that interface's preferred/deprecated
 * prefixes (zone-scoped for link-local), and never the observer itself. `isRouter` is
 * a hint only and is ignored here.
 */
export function qualifyNeighborRow(row: NeighborRowInput, context: { addressFamily: 'any' | 'ipv4' | 'ipv6'; interfaces: InterfaceRowInput[] }): NeighborRowQualification {
  if (!MAPPING_STATES.has(row.state)) return { ok: false, reason: 'state' };
  const mac = canonicalMac(row.mac);
  if (!mac || !unicastMac(mac)) return { ok: false, reason: 'mac' };
  const parsed = parseIpAddress(row.address);
  const family = familyOf(row.family);
  if (!parsed || parsed.family !== family || (context.addressFamily !== 'any' && familyOf(context.addressFamily) !== family)
    || specialAddress(parsed.family, parsed.value)) return { ok: false, reason: 'address' };
  const iface = context.interfaces.find((candidate) => candidate.interfaceKey === row.interfaceKey);
  if (!iface) return { ok: false, reason: 'interface' };
  if (iface.adminState === 'down' || iface.operState === 'down') return { ok: false, reason: 'interface_down' };
  if (iface.kind === 'tunnel') return { ok: false, reason: 'tunnel' };
  for (const own of context.interfaces) {
    if ([own.currentMac, own.permanentMac].some((value) => canonicalMac(value) === mac)) return { ok: false, reason: 'self' };
    for (const address of own.addresses ?? []) {
      const ownParsed = parseIpAddress(address.address);
      if (ownParsed && ownParsed.family === parsed.family && ownParsed.value === parsed.value) return { ok: false, reason: 'self' };
    }
  }
  const local = linkLocal(parsed.family, parsed.value);
  let best: { prefix: string; length: number } | null = null;
  for (const address of iface.addresses ?? []) {
    if (!USABLE_ADDRESS_STATES.has(address.state) || familyOf(address.family) !== parsed.family) continue;
    // Zones are interface scope: a link-local neighbour matches only its own zone.
    if (local && (address.zone ?? null) !== (row.zone ?? null)) continue;
    const prefix = topologyCidrSchema.safeParse(`${address.address}/${address.prefixLength}`);
    const canonical = prefix.success ? prefix.data : undefined;
    const network = canonical ? parsePrefix(canonical) : null;
    if (!canonical || !network || !inRange(parsed.value, network.value, network.length, parsed.family === 4 ? 32 : 128)) continue;
    if (!best || network.length > best.length) best = { prefix: canonical, length: network.length };
  }
  if (!best) return { ok: false, reason: 'not_in_prefix' };
  if (parsed.family === 4 && best.length <= 30) {
    const hostBits = (1n << BigInt(32 - best.length)) - 1n;
    const host = parsed.value & hostBits;
    if (host === 0n || host === hostBits) return { ok: false, reason: 'address' };
  }
  return { ok: true, mac, addressKey: `${parsed.family}:${parsed.value.toString(16)}`, family: parsed.family, prefix: best.prefix,
    networkClass: topologyNetworkClass(best.prefix), linkLocal: local, interfaceName: iface.name?.trim() ? iface.name.trim().slice(0, 255) : null };
}

const POSITIVE_OUTCOMES: ReadonlySet<string> = new Set(['complete', 'partial']);
const notExpired = (value: string | null | undefined, now: Date) => !!value && Number.isFinite(Date.parse(value)) && Date.parse(value) > now.getTime();
const iso = (value: string) => new Date(value).toISOString();

/** Build the bounded tuple index once per read. Expired/unknown freshness removes a row; truncation marks coverage limited. */
export function buildNeighborEvidenceIndex(read: NeighborEvidenceRead, now: Date, options: { tupleBudget?: number } = {}): NeighborEvidenceIndex {
  const budget = options.tupleBudget ?? NEIGHBOR_TUPLE_BUDGET;
  const index: NeighborEvidenceIndex = { coverage: read.limited ? 'limited' : 'complete', tupleCount: 0, byAddress: new Map(), rejected: {} };
  const reject = (reason: NeighborRowRejection | 'expired', count = 1) => { index.rejected[reason] = (index.rejected[reason] ?? 0) + count; };
  const ordered = [...read.baselines].sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
  for (const baseline of ordered) {
    if (baseline.omittedRowCount > 0 || baseline.rowsTruncated) index.coverage = 'limited';
    if (!POSITIVE_OUTCOMES.has(baseline.outcome)) continue;
    if (!baseline.interfaces || !notExpired(baseline.expiresAt, now) || !notExpired(baseline.interfaces.expiresAt, now) || !baseline.confirmedAt
      || !Number.isFinite(Date.parse(baseline.confirmedAt))) { reject('expired', baseline.rows.length); continue; }
    const context = topologyOsContextKey(baseline.producerId, baseline.contextKey);
    for (const row of baseline.rows) {
      const qualified = qualifyNeighborRow(row, { addressFamily: baseline.addressFamily, interfaces: baseline.interfaces.rows });
      if (!qualified.ok) { reject(qualified.reason); continue; }
      if (index.tupleCount >= budget) { index.coverage = 'limited'; return index; }
      const tuple: NeighborTuple = {
        observerNodeId: baseline.observerNodeId, observerLabel: baseline.observerLabel.slice(0, 255), sourceId: baseline.sourceId,
        producerId: baseline.producerId, contextKey: baseline.contextKey, context, rowKey: row.rowKey.slice(0, 255), interfaceKey: row.interfaceKey,
        interfaceId: baseline.interfaceIds[row.interfaceKey] ?? null, interfaceName: qualified.interfaceName, family: qualified.family,
        address: row.address.trim(), addressKey: qualified.addressKey, zone: row.zone ?? null, mac: qualified.mac,
        state: row.state as TopologyNeighborMappingState, isRouter: row.isRouter ?? null, prefix: qualified.prefix, networkClass: qualified.networkClass,
        linkLocal: qualified.linkLocal, confirmedAt: iso(baseline.confirmedAt), expiresAt: iso(baseline.expiresAt!),
      };
      index.byAddress.set(tuple.addressKey, [...(index.byAddress.get(tuple.addressKey) ?? []), tuple]);
      index.tupleCount += 1;
    }
  }
  return index;
}

type BaselineRow = Omit<NeighborObserverBaseline, 'interfaces' | 'rows' | 'confirmedAt' | 'expiresAt' | 'omittedRowCount' | 'rowsTruncated'> & {
  protocol: 'neighbors' | 'interfaces'; omittedRowCount: string | number | null; rows: unknown;
  confirmedAt: string | Date | null; expiresAt: string | Date | null;
};
const timestampText = (value: string | Date | null) => (value === null ? null : new Date(value).toISOString());

/**
 * Read the site's qualifying published neighbour and interfaces baselines. A source
 * counts only when it is an agent's, unrevoked, under its current producer epoch,
 * with a published digest that is the published baseline's own digest, and its
 * observer is a live-bound, active endpoint this view may expose. Freshness follows
 * the graph read's support rule (observedFreshUntilSql): the published run's own
 * `max(3 x cadence, 900 s)` expiry, extended by compact confirmations only while the
 * published digest is still the current one. Neighbour rows are narrowed to the
 * `addresses` asked about (canonical text, as the collection schema normalises it).
 */
export async function readNeighborEvidence(
  tx: Pick<typeof db, 'execute'>, scope: TopologyScope, view: Exclude<GraphQuery['view'], 'physical'>, exposure: ReadExposure, requested: Iterable<string>,
): Promise<NeighborEvidenceRead> {
  const distinct = [...new Set(requested)].sort();
  const addresses = distinct.slice(0, NEIGHBOR_ADDRESS_CAP);
  let limited = distinct.length > addresses.length;
  if (!addresses.length) return { baselines: [], limited };
  const siteNodes = nodeFilter(scope, { view, hops: 1, includeHealth: false, limit: 1 }, 'n', exposure);
  const addressArray = `{${addresses.map((address) => `"${address.replace(/["\\]/g, '')}"`).join(',')}}`;
  const rows = await tx.execute<BaselineRow>(sql`WITH site_endpoints AS MATERIALIZED (
      SELECT n.id FROM topology_nodes n WHERE ${siteNodes} AND n.kind = 'endpoint'
    ), qualified AS MATERIALIZED (
      SELECT DISTINCT ON (cs.id) cs.id, cs.producer_id, cs.protocol, cs.context_key, cs.address_family, cs.producer_epoch, b.node_id,
        (cs.published_digest = cs.content_digest AND cs.last_outcome IN ('complete','partial')) AS compact,
        cs.confirmed_through_at, cs.fresh_until, cs.published_baseline
      FROM topology_collection_sources cs
      JOIN topology_node_bindings b ON ${scoped(scope, 'b')} AND b.device_id = cs.producer_id
      JOIN site_endpoints s ON s.id = b.node_id
      WHERE ${scoped(scope, 'cs')} AND cs.producer_kind = 'agent' AND cs.protocol IN ('neighbors','interfaces') AND cs.revoked_at IS NULL
        AND cs.published_digest IS NOT NULL AND cs.published_baseline->>'producerEpoch' = cs.producer_epoch
        AND cs.published_baseline->>'contentDigest' = cs.published_digest
        AND cs.published_baseline->'section'->>'kind' = cs.protocol
      ORDER BY cs.id, b.id
    ), neighbor_sources AS (
      SELECT * FROM qualified WHERE protocol = 'neighbors' ORDER BY producer_id, context_key, address_family, id LIMIT ${NEIGHBOR_SOURCE_CAP + 1}
    ), chosen AS (
      SELECT * FROM neighbor_sources
      UNION ALL SELECT q.* FROM qualified q WHERE q.protocol = 'interfaces'
        AND EXISTS (SELECT 1 FROM neighbor_sources ns WHERE ns.producer_id = q.producer_id AND ns.context_key = q.context_key AND ns.node_id = q.node_id)
    )
    SELECT c.id AS "sourceId", c.producer_id AS "producerId", c.protocol, c.context_key AS "contextKey", c.address_family AS "addressFamily",
      c.node_id AS "observerNodeId", (SELECT ${nodeLabelSql} FROM topology_nodes n WHERE n.id = c.node_id) AS "observerLabel",
      c.published_baseline->'section'->>'outcome' AS outcome,
      CASE WHEN c.published_baseline->'section'->>'omittedRowCount' ~ '^[0-9]{1,10}$' THEN c.published_baseline->'section'->>'omittedRowCount' END AS "omittedRowCount",
      CASE WHEN c.compact THEN greatest(run.effective_at, c.confirmed_through_at) ELSE run.effective_at END AS "confirmedAt",
      CASE WHEN c.compact THEN greatest(run.fresh_until, c.fresh_until) ELSE run.fresh_until END AS "expiresAt",
      CASE WHEN c.protocol = 'neighbors' THEN (SELECT coalesce(jsonb_agg(f.r ORDER BY f.o), '[]'::jsonb) FROM (
          SELECT x.r, x.o FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.published_baseline->'section'->'rows') = 'array'
            THEN c.published_baseline->'section'->'rows' ELSE '[]'::jsonb END) WITH ORDINALITY AS x(r, o)
          WHERE x.r->>'address' = ANY(${addressArray}::text[]) ORDER BY x.o LIMIT ${NEIGHBOR_ROWS_PER_SOURCE_CAP + 1}) f)
        ELSE CASE WHEN jsonb_typeof(c.published_baseline->'section'->'rows') = 'array' THEN c.published_baseline->'section'->'rows' ELSE '[]'::jsonb END
      END AS rows,
      CASE WHEN c.protocol = 'interfaces' THEN (SELECT coalesce(jsonb_object_agg(ti.interface_key, ti.id ORDER BY ti.id), '{}'::jsonb)
        FROM topology_interfaces ti WHERE ${scoped(scope, 'ti')} AND ti.owner_node_id = c.node_id AND ti.epoch = c.producer_epoch AND ti.retired_at IS NULL)
        ELSE '{}'::jsonb END AS "interfaceIds"
    FROM chosen c
    LEFT JOIN LATERAL (
      SELECT r.effective_at, r.effective_at + make_interval(secs => greatest(3 * r.expected_interval_seconds, 900)) AS fresh_until
      FROM topology_collection_runs r
      WHERE ${scoped(scope, 'r')} AND r.source_id = c.id AND r.producer_epoch = c.producer_epoch
        AND c.published_baseline->>'sequence' ~ '^[0-9]{1,20}$' AND r.sequence = (c.published_baseline->>'sequence')::numeric
      LIMIT 1
    ) run ON true
    ORDER BY c.protocol, c.producer_id, c.context_key, c.address_family, c.id`);

  const neighbors = rows.filter((row) => row.protocol === 'neighbors');
  if (neighbors.length > NEIGHBOR_SOURCE_CAP) limited = true;
  const interfaces = new Map<string, BaselineRow>();
  for (const row of rows) {
    if (row.protocol !== 'interfaces') continue;
    const key = JSON.stringify([row.observerNodeId, row.producerId, row.contextKey]);
    // Two interface scopes for one context (per-family sections) are ambiguous: use neither.
    interfaces.set(key, interfaces.has(key) ? { ...row, rows: null } : row);
  }
  const baselines = neighbors.slice(0, NEIGHBOR_SOURCE_CAP).map((row): NeighborObserverBaseline => {
    const list = Array.isArray(row.rows) ? row.rows as NeighborRowInput[] : [];
    const iface = interfaces.get(JSON.stringify([row.observerNodeId, row.producerId, row.contextKey]));
    const ifaceRows = iface && Array.isArray(iface.rows) ? iface.rows as InterfaceRowInput[] : null;
    return {
      sourceId: row.sourceId, observerNodeId: row.observerNodeId, observerLabel: String(row.observerLabel ?? ''), producerId: row.producerId,
      contextKey: row.contextKey, addressFamily: row.addressFamily, outcome: String(row.outcome ?? ''),
      omittedRowCount: Number(row.omittedRowCount ?? 0), rowsTruncated: list.length > NEIGHBOR_ROWS_PER_SOURCE_CAP,
      confirmedAt: timestampText(row.confirmedAt), expiresAt: timestampText(row.expiresAt), rows: list.slice(0, NEIGHBOR_ROWS_PER_SOURCE_CAP),
      interfaces: iface && ifaceRows && POSITIVE_OUTCOMES.has(String(iface.outcome)) ? { rows: ifaceRows, expiresAt: timestampText(iface.expiresAt) } : null,
      interfaceIds: iface && iface.interfaceIds && typeof iface.interfaceIds === 'object' ? iface.interfaceIds as Record<string, string> : {},
    };
  });
  return { baselines, limited };
}
