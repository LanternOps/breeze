import { z } from 'zod';
import { collectionOutcomeSchema } from './topology';
import { refineTopologySectionRows, topologySection } from './topologyCollection';
import { sorted } from './topologyCollectionCanonical';
import { topologyDigestSchema, topologyFamilySchema, topologyReasonSchema, topologyUint32Schema, topologyUtf8KeySchema } from './topologyPrimitives';
import {
  ADJACENCY_V2_SECTION_LIMITS, cdpRowSchema, fdbRowSchema, lldpRowSchema, physicalInterfaceRowSchema,
  unifiClientRowSchema, unifiDeviceDetailRowSchema, unifiDeviceRowSchema, unifiStatisticsRowSchema,
} from './topologyPhysical';
import type { FdbRow } from '../types/topologyPhysical';

/**
 * Normalized physical source sections: the shapes the API ingest seam retains
 * per (producer, protocol, context). They are distinct from M1's OS
 * `topologyContextSectionSchema` — in particular SNMP interface inventory is
 * `snmp_interfaces`, never M1's `interfaces` kind.
 *
 * FDB (D13 SPEC AMENDMENT): a port keeps per-MAC rows while it has at most
 * FDB_SHARED_PORT_MAC_THRESHOLD distinct eligible (learned, unicast, non-zero)
 * MACs; above that it persists as one `shared_port` row with a size bucket.
 * Shared/upstream ports carry aggregate coverage only, never per-MAC membership.
 * The Go agent mirrors `normalizeFdbSection` via
 * packages/shared/src/testing/topology-fdb-normalization-v1.json.
 */
export const FDB_SHARED_PORT_MAC_THRESHOLD = 16;
export const FDB_SHARED_PORT_BUCKETS = ['17-64', '65-256', '257+'] as const;
export type FdbSharedPortBucket = (typeof FDB_SHARED_PORT_BUCKETS)[number];
export const PHYSICAL_SOURCE_SECTION_KINDS = [
  'lldp', 'cdp', 'fdb', 'snmp_interfaces',
  'unifi_device_list', 'unifi_client_list', 'unifi_device_details', 'unifi_statistics',
] as const;
export type PhysicalSourceSectionKind = (typeof PHYSICAL_SOURCE_SECTION_KINDS)[number];
export const ADJACENCY_SOURCE_SECTION_KINDS = ['lldp', 'cdp', 'fdb', 'snmp_interfaces'] as const;
export const UNIFI_SOURCE_SECTION_KINDS = ['unifi_device_list', 'unifi_client_list', 'unifi_device_details', 'unifi_statistics'] as const;

export function fdbSharedPortBucket(distinctMacs: number): FdbSharedPortBucket {
  return distinctMacs <= 64 ? '17-64' : distinctMacs <= 256 ? '65-256' : '257+';
}
export const fdbSharedPortRowKey = (bridgeContext: string, bridgePort: number) => `shared_port|${bridgeContext}|${bridgePort}`;
const portId = (r: { bridgeContext: string; bridgePort: number }) => JSON.stringify([r.bridgeContext, r.bridgePort]);
/** Learned unicast, non-zero MACs only. self/management/invalid/other and group addresses are counted, not retained. */
export function isEligibleFdbRow(row: Pick<FdbRow, 'status' | 'mac'>): boolean {
  const firstOctet = Number.parseInt(row.mac.slice(0, 2), 16);
  return row.status === 'learned' && (firstOctet & 1) === 0 && row.mac !== '00:00:00:00:00:00';
}

const key = topologyUtf8KeySchema;
const uint = topologyUint32Schema;
export const fdbSharedPortRowSchema = z.object({
  rowType: z.literal('shared_port'), rowKey: key, bridgeContext: key, bridgePort: uint, ifIndex: uint.nullable(),
  sizeBucket: z.enum(FDB_SHARED_PORT_BUCKETS),
}).strict().refine(v => v.rowKey === fdbSharedPortRowKey(v.bridgeContext, v.bridgePort), 'shared_port rowKey must be shared_port|bridgeContext|bridgePort');
export const normalizedFdbRowSchema = z.union([fdbSharedPortRowSchema, fdbRowSchema]);
export const normalizedFdbMetadataSchema = z.object({ ineligibleRowCount: uint, sharedPortCount: uint, collapsedRowCount: uint }).strict();

export const normalizedFdbSectionSchema = z.object({
  kind: z.literal('fdb'), contextKey: key, addressFamily: topologyFamilySchema.optional(), contentDigest: topologyDigestSchema,
  outcome: collectionOutcomeSchema, reasonCode: topologyReasonSchema.optional(), rowCount: uint, omittedRowCount: uint.optional(),
  rows: z.array(normalizedFdbRowSchema).max(ADJACENCY_V2_SECTION_LIMITS.fdb), metadata: normalizedFdbMetadataSchema,
}).superRefine((v, ctx) => {
  refineTopologySectionRows(v, ctx);
  const shared = new Set<string>();
  const macs = new Map<string, Set<string>>();
  for (const row of v.rows) {
    if ('rowType' in row) { shared.add(portId(row)); continue; }
    if (!isEligibleFdbRow(row)) ctx.addIssue({ code: 'custom', message: 'Normalized FDB retains only eligible rows' });
    const port = portId(row);
    macs.set(port, (macs.get(port) ?? new Set()).add(row.mac));
  }
  for (const [port, set] of macs) {
    if (shared.has(port)) ctx.addIssue({ code: 'custom', message: 'A shared_port cannot also carry per-MAC rows' });
    if (set.size > FDB_SHARED_PORT_MAC_THRESHOLD) ctx.addIssue({ code: 'custom', message: 'Port above the MAC threshold must be a shared_port row' });
  }
  if (v.metadata.sharedPortCount !== shared.size) ctx.addIssue({ code: 'custom', message: 'sharedPortCount mismatch' });
});

type WireFdbSection = { kind: 'fdb'; contextKey: string; addressFamily?: 'ipv4' | 'ipv6'; contentDigest: string; outcome: z.infer<typeof collectionOutcomeSchema>;
  reasonCode?: string; rowCount: number; omittedRowCount?: number; rows: FdbRow[] };
export type FdbSharedPortRow = z.infer<typeof fdbSharedPortRowSchema>;
export type NormalizedFdbRow = FdbRow | FdbSharedPortRow;
export type NormalizedFdbSection = z.infer<typeof normalizedFdbSectionSchema>;
export const isFdbSharedPortRow = (row: NormalizedFdbRow): row is FdbSharedPortRow => 'rowType' in row && row.rowType === 'shared_port';

/**
 * Pure D13 rule. Keeps the section's outcome/reason/omissions and its
 * contentDigest verbatim — the caller recomputes the digest over the
 * normalized form (agent and server hash the same normalized bytes).
 */
export function normalizeFdbSection(section: WireFdbSection): NormalizedFdbSection {
  let ineligible = 0;
  const ports = new Map<string, FdbRow[]>();
  for (const row of section.rows) {
    if (!isEligibleFdbRow(row)) { ineligible++; continue; }
    const port = portId(row);
    ports.set(port, [...(ports.get(port) ?? []), row]);
  }
  const rows: NormalizedFdbRow[] = [];
  let sharedPortCount = 0, collapsedRowCount = 0;
  for (const portRows of ports.values()) {
    const distinct = new Set(portRows.map(r => r.mac)).size;
    if (distinct <= FDB_SHARED_PORT_MAC_THRESHOLD) { rows.push(...portRows); continue; }
    const first = portRows[0]!;
    const ifIndexes = new Set(portRows.map(r => r.ifIndex));
    rows.push({ rowType: 'shared_port', rowKey: fdbSharedPortRowKey(first.bridgeContext, first.bridgePort), bridgeContext: first.bridgeContext,
      bridgePort: first.bridgePort, ifIndex: ifIndexes.size === 1 ? first.ifIndex : null, sizeBucket: fdbSharedPortBucket(distinct) });
    sharedPortCount++;
    collapsedRowCount += portRows.length;
  }
  const ordered = sorted(rows, r => r.rowKey);
  return { ...section, rows: ordered, rowCount: ordered.length, metadata: { ineligibleRowCount: ineligible, sharedPortCount, collapsedRowCount } };
}

const section = topologySection;
export const snmpInterfacesSectionSchema = section('snmp_interfaces', physicalInterfaceRowSchema, ADJACENCY_V2_SECTION_LIMITS.interfaces);
export const physicalSourceSectionSchema = z.discriminatedUnion('kind', [
  section('lldp', lldpRowSchema, ADJACENCY_V2_SECTION_LIMITS.lldp),
  section('cdp', cdpRowSchema, ADJACENCY_V2_SECTION_LIMITS.cdp),
  normalizedFdbSectionSchema,
  snmpInterfacesSectionSchema,
  section('unifi_device_list', unifiDeviceRowSchema, 2048),
  section('unifi_client_list', unifiClientRowSchema, 10000),
  section('unifi_device_details', unifiDeviceDetailRowSchema, 2048),
  section('unifi_statistics', unifiStatisticsRowSchema, 2048),
]);
export type PhysicalSourceSection = z.infer<typeof physicalSourceSectionSchema>;
export const isPhysicalSourceSectionKind = (kind: string): kind is PhysicalSourceSectionKind => (PHYSICAL_SOURCE_SECTION_KINDS as readonly string[]).includes(kind);
