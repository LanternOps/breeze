import { z } from 'zod';
import { collectionOutcomeSchema } from './topology';
import { refineTopologySectionRows, topologySection } from './topologyCollection';
import { topologyDigestSchema, topologyIpSchema, topologyMacSchema, topologyReasonSchema, topologySequenceSchema, topologyTimestampSchema, topologyUint32Schema, topologyUtf8KeySchema, topologyWireGuard } from './topologyPrimitives';

/**
 * Physical (M2) collection contracts — Collection spec §7 (SNMP adjacency v2) and
 * §8 (UniFi topology v1). These are wire shapes only: nothing here grants tenant,
 * site, target or protocol authority. The ingest path authorizes the parent
 * job/command and requested scope; payload strings never establish it.
 */
/** One report = one authorized target, one immutable snapshot, one HTTP body (no chunking). */
export const ADJACENCY_V2_MAX_BYTES = 4 * 1024 * 1024;
export const ADJACENCY_V2_FDB_MAX_ROWS = 20_000;
export const ADJACENCY_V2_SECTION_LIMITS = { lldp: 4096, cdp: 4096, fdb: ADJACENCY_V2_FDB_MAX_ROWS, interfaces: 4096 } as const;
export const ADJACENCY_V2_SECTION_KINDS = ['lldp', 'cdp', 'fdb', 'interfaces'] as const;
export const UNIFI_TOPOLOGY_V1_MAX_BYTES = 8 * 1024 * 1024;
export const UNIFI_RESOURCE_KINDS = ['device_list', 'client_list', 'device_details', 'statistics'] as const;
export const UNIFI_CLIENT_TYPES = ['WIRED', 'WIRELESS', 'VPN', 'TELEPORT', 'unknown'] as const;
export const PORT_REF_NAMESPACES = ['if_index', 'if_name', 'bridge_port', 'lldp_local', 'controller_port'] as const;
export const FDB_ROW_STATUSES = ['learned', 'self', 'management', 'invalid', 'other'] as const;
export const FDB_VLAN_MAPPINGS = ['complete', 'partial', 'unknown'] as const;

const key = topologyUtf8KeySchema;
const uint = topologyUint32Schema;
const optionalList = <T extends z.ZodType>(item: T) => z.array(item).max(64);
const NUMERIC_NAMESPACES = new Set(['if_index', 'bridge_port', 'lldp_local']);
const isUint32Text = (s: string) => /^(0|[1-9]\d{0,9})$/.test(s) && Number(s) <= 4294967295;

/** A tagged port reference. Numeric equality across namespaces never proves a match. */
export const portRefSchema = z.object({
  namespace: z.enum(PORT_REF_NAMESPACES), value: key, resolvedInterfaceKey: key.nullable(),
}).refine(v => !NUMERIC_NAMESPACES.has(v.namespace) || isUint32Text(v.value), 'Numeric port namespace requires a uint32 decimal value');

/** Typed chassis/port/device identity. Only subtype `mac_address` is normalized as a MAC. */
export const typedIdSchema = z.object({ subtype: topologyReasonSchema, value: key }).transform((v, ctx) => {
  if (v.subtype !== 'mac_address') return v;
  const parsed = topologyMacSchema.safeParse(v.value);
  if (!parsed.success) { ctx.addIssue({ code: 'custom', message: 'mac_address subtype requires a MAC value' }); return z.NEVER; }
  return { subtype: v.subtype, value: parsed.data };
});

export const lldpRowKey = (localPortNum: string | number, remoteIndex: number) => `${localPortNum}.${remoteIndex}`;
export const cdpRowKey = (ifIndex: string | number, deviceIndex: number) => `${ifIndex}.${deviceIndex}`;
export const fdbRowKey = (r: { bridgeContext: string; fdbId: number | null; mac: string; bridgePort: number }) => `${r.bridgeContext}|${r.fdbId ?? '-'}|${r.mac}|${r.bridgePort}`;
export const physicalInterfaceRowKey = (ifIndex: number) => String(ifIndex);

export const lldpRowSchema = z.object({
  rowKey: key, timeMark: uint, remoteIndex: uint, localPort: portRefSchema, remoteChassis: typedIdSchema, remotePort: typedIdSchema,
  remoteSysName: key.optional(), remoteAddresses: optionalList(topologyIpSchema).optional(),
}).superRefine((v, ctx) => {
  if (v.localPort.namespace !== 'lldp_local') ctx.addIssue({ code: 'custom', message: 'LLDP local port is an lldp_local port number' });
  if (v.rowKey !== lldpRowKey(v.localPort.value, v.remoteIndex)) ctx.addIssue({ code: 'custom', message: 'LLDP rowKey must be localPortNum.remoteIndex (timeMark excluded)' });
  if (v.remoteAddresses && new Set(v.remoteAddresses).size !== v.remoteAddresses.length) ctx.addIssue({ code: 'custom', message: 'Duplicate remote address' });
});

export const cdpRowSchema = z.object({
  rowKey: key, deviceIndex: uint, localPort: portRefSchema, remoteDevice: typedIdSchema, remotePort: typedIdSchema, remoteAddress: topologyIpSchema.optional(),
}).superRefine((v, ctx) => {
  if (v.localPort.namespace !== 'if_index') ctx.addIssue({ code: 'custom', message: 'CDP local port is a cache ifIndex' });
  if (v.rowKey !== cdpRowKey(v.localPort.value, v.deviceIndex)) ctx.addIssue({ code: 'custom', message: 'CDP rowKey must be ifIndex.deviceIndex' });
});

const vlanSchema = z.number().int().min(1).max(4094);
export const fdbRowSchema = z.object({
  rowKey: key, bridgeContext: key, fdbId: uint.nullable(), mac: topologyMacSchema, bridgePort: uint, ifIndex: uint.nullable(),
  status: z.enum(FDB_ROW_STATUSES), vlans: optionalList(vlanSchema), vlanMapping: z.enum(FDB_VLAN_MAPPINGS), ifName: key.optional(),
}).superRefine((v, ctx) => {
  if (v.rowKey !== fdbRowKey(v)) ctx.addIssue({ code: 'custom', message: 'FDB rowKey must be bridgeContext|fdbId|mac|bridgePort' });
  // Canonical set: strictly ascending. An empty unknown list is not untagged membership.
  if (v.vlans.some((n, i) => i > 0 && n <= v.vlans[i - 1]!)) ctx.addIssue({ code: 'custom', message: 'VLAN set must be strictly ascending' });
  if (v.vlanMapping === 'unknown' && v.vlans.length) ctx.addIssue({ code: 'custom', message: 'Unknown VLAN mapping cannot list VLANs' });
  if (v.vlanMapping === 'complete' && (!v.vlans.length || v.fdbId === null)) ctx.addIssue({ code: 'custom', message: 'Complete VLAN mapping requires an FDB id and at least one VLAN' });
});

/** SNMP interface inventory row (adjacency `interfaces` section; not M1's OS interface row). */
export const physicalInterfaceRowSchema = z.object({
  rowKey: key, interfaceKey: key, ifIndex: uint, ifName: key.nullable(), ifAlias: key.nullable(), physAddress: topologyMacSchema.nullable(),
  lldpLocalPort: uint.nullable(), bridgePort: uint.nullable(),
}).refine(v => v.rowKey === physicalInterfaceRowKey(v.ifIndex), 'Interface rowKey must be the ifIndex');

export const adjacencyLldpSectionSchema = topologySection('lldp', lldpRowSchema, ADJACENCY_V2_SECTION_LIMITS.lldp);
export const adjacencyCdpSectionSchema = topologySection('cdp', cdpRowSchema, ADJACENCY_V2_SECTION_LIMITS.cdp);
export const adjacencyFdbSectionSchema = topologySection('fdb', fdbRowSchema, ADJACENCY_V2_SECTION_LIMITS.fdb);
export const adjacencyInterfaceSectionSchema = topologySection('interfaces', physicalInterfaceRowSchema, ADJACENCY_V2_SECTION_LIMITS.interfaces).superRefine((v, ctx) => {
  if (new Set(v.rows.map(r => r.interfaceKey)).size !== v.rows.length) ctx.addIssue({ code: 'custom', message: 'Duplicate interface key' });
});
/** Physical adjacency sections. Kept separate from M1's topologyContextSectionSchema (its `interfaces` is the OS row). */
export const adjacencySectionSchema = z.discriminatedUnion('kind', [adjacencyLldpSectionSchema, adjacencyCdpSectionSchema, adjacencyFdbSectionSchema, adjacencyInterfaceSectionSchema]);

const adjacencySourceSchema = z.object({ sourceKey: key, address: topologyIpSchema, zone: key.nullable() }).superRefine((v, ctx) => {
  const ipv6 = v.address.includes(':');
  if (!ipv6 && v.zone !== null) ctx.addIssue({ code: 'custom', message: 'IPv4 source cannot have zone' });
  if (ipv6 && /^fe[89ab]/i.test(v.address) && !v.zone) ctx.addIssue({ code: 'custom', message: 'Link-local source requires zone' });
});
const adjacencyEnvelope = {
  version: z.literal(2), parentJobId: z.uuid(), parentCommandId: z.uuid(), producerEpoch: key, snapshotId: z.uuid(), sequence: topologySequenceSchema,
  capturedAt: topologyTimestampSchema, captureAgeAtSendMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  expectedIntervalSeconds: z.number().int().min(60).max(86400), contentDigest: topologyDigestSchema, source: adjacencySourceSchema,
};
/** Final scope manifest: every requested protocol/context scope with its outcome, counts and digest. */
export const adjacencyManifestScopeSchema = z.object({
  kind: z.enum(ADJACENCY_V2_SECTION_KINDS), contextKey: key, outcome: collectionOutcomeSchema, rowCount: uint, omittedRowCount: uint.optional(), contentDigest: topologyDigestSchema,
});
export const adjacencyFinalManifestSchema = z.object({ scopes: z.array(adjacencyManifestScopeSchema).max(256) });
const scopeId = (s: { kind: string; contextKey: string }) => JSON.stringify([s.kind, s.contextKey]);

export const adjacencyV2FullSchema = z.object({
  ...adjacencyEnvelope, reportKind: z.literal('full'), sections: z.array(adjacencySectionSchema).max(256),
  finalManifest: adjacencyFinalManifestSchema, baseSnapshotId: z.never().optional(),
}).superRefine((v, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  const sections = new Map<string, (typeof v.sections)[number]>();
  for (const s of v.sections) { const id = scopeId(s); if (sections.has(id)) issue('Duplicate section scope'); sections.set(id, s); }
  const scopes = new Set<string>();
  for (const m of v.finalManifest.scopes) {
    const id = scopeId(m);
    if (scopes.has(id)) issue('Duplicate manifest scope');
    scopes.add(id);
    if (m.rowCount > ADJACENCY_V2_SECTION_LIMITS[m.kind]) issue(`Manifest ${m.kind} rows exceed limit`);
    if ((m.omittedRowCount ?? 0) > 0 && m.outcome !== 'partial') issue('Omitted rows require a partial scope');
    const s = sections.get(id);
    if (!s) { issue('Manifest scope has no section'); continue; }
    if (s.outcome !== m.outcome || s.rowCount !== m.rowCount || (s.omittedRowCount ?? 0) !== (m.omittedRowCount ?? 0) || s.contentDigest !== m.contentDigest) issue('Section differs from its manifest scope');
  }
  for (const id of sections.keys()) if (!scopes.has(id)) issue('Section scope missing from manifest');
});
export const adjacencyV2UnchangedSchema = z.object({
  ...adjacencyEnvelope, reportKind: z.literal('unchanged'), baseSnapshotId: z.uuid(),
  sections: z.never().optional(), finalManifest: z.never().optional(),
});
export const adjacencyV2Schema = z.discriminatedUnion('reportKind', [adjacencyV2FullSchema, adjacencyV2UnchangedSchema]);
export const adjacencyV2WireSchema = topologyWireGuard(ADJACENCY_V2_MAX_BYTES).pipe(adjacencyV2Schema);
/** Byte/authority guard first, then the strict-kind union; version rejection is report-local. */
export function parseAdjacencyV2Report(value: unknown) {
  if (value && typeof value === 'object' && 'version' in value && value.version !== 2) return { accepted: false as const, reason: 'unsupported_major_version' as const };
  const result = adjacencyV2WireSchema.safeParse(value);
  return result.success ? { accepted: true as const, report: result.data } : { accepted: false as const, reason: 'invalid_report' as const, issues: result.error.issues };
}

// ---- UniFi topology v1 (Collection §8): additive companion to the legacy telemetry body ----
export const unifiDeviceRowSchema = z.object({
  rowKey: key, deviceId: key, mac: topologyMacSchema.nullable(), name: key.nullable(), model: key.nullable(), ipAddress: topologyIpSchema.nullable(), state: key.nullable(),
}).refine(v => v.rowKey === v.deviceId, 'Device rowKey must be the controller device id');
export const unifiClientRowSchema = z.object({
  rowKey: key, clientId: key, mac: topologyMacSchema.nullable(), clientType: z.enum(UNIFI_CLIENT_TYPES), uplinkDeviceId: key.nullable(), name: key.nullable(), ipAddress: topologyIpSchema.nullable(),
  uplinkPortIndex: uint.nullable(), ssid: key.nullable(), vlan: vlanSchema.nullable(), signalDbm: z.number().int().min(-150).max(0).nullable(),
}).refine(v => v.rowKey === v.clientId, 'Client rowKey must be the controller client id');
const unifiPortSchema = z.object({ portIndex: uint, name: key.nullable(), linkUp: z.boolean().nullable(), speedMbps: uint.nullable(), poeMode: key.nullable() });
export const unifiDeviceDetailRowSchema = z.object({
  rowKey: key, deviceId: key, uplinkDeviceId: key.nullable(), uplinkPortIndex: uint.nullable(), ports: z.array(unifiPortSchema).max(128),
}).superRefine((v, ctx) => {
  if (v.rowKey !== v.deviceId) ctx.addIssue({ code: 'custom', message: 'Detail rowKey must be the controller device id' });
  if (v.ports.some((p, i) => i > 0 && p.portIndex <= v.ports[i - 1]!.portIndex)) ctx.addIssue({ code: 'custom', message: 'Ports must be strictly ascending by portIndex' });
});
const percent = z.number().min(0).max(100);
export const unifiStatisticsRowSchema = z.object({
  rowKey: key, deviceId: key, uptimeSeconds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(), cpuUtilizationPct: percent.nullable(), memoryUtilizationPct: percent.nullable(),
}).refine(v => v.rowKey === v.deviceId, 'Statistics rowKey must be the controller device id');

function unifiResource<K extends string, S extends z.ZodType<{ rowKey: string }>>(kind: K, row: S, limit: number) {
  return z.object({ controllerSiteId: key, kind: z.literal(kind), contentDigest: topologyDigestSchema, outcome: collectionOutcomeSchema,
    reasonCode: topologyReasonSchema.optional(), rowCount: uint, omittedRowCount: uint.optional(), rows: z.array(row).max(limit),
  }).superRefine(refineTopologySectionRows);
}
export const unifiResourceSchema = z.discriminatedUnion('kind', [
  unifiResource('device_list', unifiDeviceRowSchema, 2048), unifiResource('client_list', unifiClientRowSchema, 10000),
  unifiResource('device_details', unifiDeviceDetailRowSchema, 2048), unifiResource('statistics', unifiStatisticsRowSchema, 2048),
]);
export const unifiTopologyV1Schema = z.object({
  version: z.literal(1), producerEpoch: key, snapshotId: z.uuid(), sequence: topologySequenceSchema, capturedAt: topologyTimestampSchema,
  captureAgeAtSendMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(), expectedIntervalSeconds: z.number().int().min(60).max(86400),
  resources: z.array(unifiResourceSchema).max(256),
}).superRefine((v, ctx) => {
  const ids = v.resources.map(r => JSON.stringify([r.controllerSiteId, r.kind]));
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Duplicate controller-site resource' });
});
export const unifiTopologyV1WireSchema = topologyWireGuard(UNIFI_TOPOLOGY_V1_MAX_BYTES).pipe(unifiTopologyV1Schema);
export function parseUnifiTopologyV1(value: unknown) {
  if (value && typeof value === 'object' && 'version' in value && value.version !== 1) return { accepted: false as const, reason: 'unsupported_major_version' as const };
  const result = unifiTopologyV1WireSchema.safeParse(value);
  return result.success ? { accepted: true as const, report: result.data } : { accepted: false as const, reason: 'invalid_report' as const, issues: result.error.issues };
}

