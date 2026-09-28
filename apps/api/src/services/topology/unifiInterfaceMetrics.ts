import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  TOPOLOGY_INTERFACE_MEASURED_FIELDS, TOPOLOGY_INTERFACE_METRICS_MAX_SAMPLES, unifiEndpointKey,
  type TopologyInterfaceMetricEnvelopeV1, type TopologyInterfaceSampleV1, type TopologyScope, type UnifiResource,
} from '@breeze/shared';
import { assertInTransaction, db } from '../../db';
import { topologyInterfaces } from '../../db/schema';
import {
  isTopologyTelemetryAuthorityRegistered, registerTopologyTelemetryAuthority, resolveTopologyTelemetryProducer, TOPOLOGY_TELEMETRY_MAX_AUTHORIZED_INTERFACES,
  TOPOLOGY_TELEMETRY_PRODUCER_REJECTIONS, type TopologyTelemetryAuthority,
} from './collectionAuthority';
import { loadTopologyFlags } from './flags';
import { persistTopologyInterfaceSamples } from './interfaceSamples';
import { loadUnifiCollector, unifiHostKey, unifiTopologyAuthority, type UnifiCollectorAuthority } from './unifiAuthority';
import { unifiControllerPortKey, unifiControllerPortNamespace } from './unifiPorts';

/**
 * UniFi port link state into the interface telemetry sink (M3 Task 4,
 * amendment M3-D9: link/speed only).
 *
 * The controller's device-detail resource — already fetched by the M2
 * collector, no new controller request — reports per port `linkUp` and the
 * negotiated `speedMbps`. Those become if_metrics samples for canonical
 * controller-port interfaces (unifiPorts) under the `unifi` telemetry producer
 * and the same controller-site authority as the structural source. Nothing
 * else is claimed: no octet counters, no per-port rates (the controller only
 * reports device-level rates), and no PoE until supported-version fixtures prove
 * its fields. A port with no canonical mapping is `port_not_identified`, never
 * attached to a guess; a failed/unsupported detail resource emits nothing.
 * Unchanged state is refreshed at most every UNIFI_TELEMETRY_REFRESH_MS so the
 * per-source daily quota holds for large controllers.
 */
export const UNIFI_TELEMETRY_INTERVAL_SECONDS = 300;
export const UNIFI_TELEMETRY_REFRESH_MS = 240_000;
/** Batch sequences are `reportSequence * 4096 + batch` (≤ 16 batches per report). */
const BATCH_SEQUENCE_STRIDE = 4096n;
const UINT64_MAX = 18446744073709551615n;
const NOT_SUPPORTED = 'not_supported_by_source';

type PortMapping = { id: string; epoch: string };
type LatestState = { sampledAt: Date; operStatus: string; capacityBps: string | null };
type DetailRow = { deviceId: string; ports: { portIndex: number; linkUp: boolean | null; speedMbps: number | null }[] };

/** Pure: one detail resource → bounded envelopes of link/speed samples. */
export function normalizeUnifiInterfaceMetrics(input: {
  producer: { producerEpoch: string; configurationRevision: string };
  report: { sequence: string; capturedAt: string };
  resource: UnifiResource; hostKey: string;
  interfaces: ReadonlyMap<string, PortMapping>;
  latest: ReadonlyMap<string, LatestState>;
}): { envelopes: TopologyInterfaceMetricEnvelopeV1[]; omitted: Record<string, number> } {
  const { resource } = input;
  const omitted: Record<string, number> = {};
  if (resource.kind !== 'device_details' || (resource.outcome !== 'complete' && resource.outcome !== 'partial')) return { envelopes: [], omitted };
  const capturedAt = new Date(input.report.capturedAt);
  const sampledAt = capturedAt.toISOString();
  const samples: TopologyInterfaceSampleV1[] = [];
  for (const row of resource.rows as DetailRow[]) {
    const endpointKey = unifiEndpointKey({ hostKey: input.hostKey, controllerSiteId: resource.controllerSiteId, kind: 'device', value: row.deviceId });
    for (const port of row.ports) {
      const mapping = input.interfaces.get(unifiControllerPortKey(endpointKey, port.portIndex));
      if (!mapping) { omitted.port_not_identified = (omitted.port_not_identified ?? 0) + 1; continue; }
      const operStatus = port.linkUp === true ? 'up' : port.linkUp === false ? 'down' : 'unknown';
      const capacityBps = port.linkUp === true && port.speedMbps !== null && port.speedMbps > 0 ? (BigInt(port.speedMbps) * 1_000_000n).toString() : null;
      const previous = input.latest.get(mapping.id);
      if (previous && previous.operStatus === operStatus && previous.capacityBps === capacityBps
        && capturedAt.getTime() - previous.sampledAt.getTime() < UNIFI_TELEMETRY_REFRESH_MS) continue;
      const unavailable: TopologyInterfaceSampleV1['unavailable'] = {};
      for (const field of TOPOLOGY_INTERFACE_MEASURED_FIELDS) if (field !== 'capacityBps') unavailable[field] = NOT_SUPPORTED;
      if (capacityBps === null) unavailable.capacityBps = port.linkUp === false ? 'link_down' : 'speed_not_reported';
      samples.push({
        interfaceId: mapping.id, interfaceEpoch: mapping.epoch, sampledAt, counterWidth: null,
        inOctets: null, outOctets: null, inErrors: null, outErrors: null, inDiscards: null, outDiscards: null, inPackets: null, outPackets: null,
        capacityBps, discontinuityTicks: null, deviceUptimeTicks: null, reportedInBps: null, reportedOutBps: null,
        adminStatus: 'unknown', operStatus, unavailable,
      });
    }
  }
  const partial = resource.outcome === 'partial' || (omitted.port_not_identified ?? 0) > 0;
  const reasonCode = partial ? resource.reasonCode ?? 'port_not_identified' : null;
  const envelopes: TopologyInterfaceMetricEnvelopeV1[] = [];
  for (let index = 0; index * TOPOLOGY_INTERFACE_METRICS_MAX_SAMPLES < samples.length; index += 1) {
    const sequence = BigInt(input.report.sequence) * BATCH_SEQUENCE_STRIDE + BigInt(index);
    if (index >= Number(BATCH_SEQUENCE_STRIDE) || sequence > UINT64_MAX) { omitted.sequence_overflow = (omitted.sequence_overflow ?? 0) + 1; break; }
    envelopes.push({
      schemaVersion: 1, family: 'if_metrics', producerEpoch: input.producer.producerEpoch, sequence: sequence.toString(), commandId: null,
      configurationRevision: input.producer.configurationRevision, startedAt: sampledAt, finishedAt: sampledAt, captureAgeAtSendMs: null,
      expectedIntervalSeconds: UNIFI_TELEMETRY_INTERVAL_SECONDS, outcome: partial ? 'partial' : 'complete', reasonCode,
      samples: samples.slice(index * TOPOLOGY_INTERFACE_METRICS_MAX_SAMPLES, (index + 1) * TOPOLOGY_INTERFACE_METRICS_MAX_SAMPLES),
    });
  }
  return { envelopes, omitted };
}

/**
 * `unifi` telemetry authority: the structural controller-site authority
 * (collector owned + enabled, exact mapping to exactly this scope) plus the
 * interface allowlist = current canonical ports under this host/controller
 * site's port namespace.
 */
export const unifiTelemetryAuthority: TopologyTelemetryAuthority = async request => {
  const decision = await unifiTopologyAuthority({ producerKind: 'unifi', scope: request.scope, device: request.device,
    authorityKey: request.authorityKey, ...(request.collectorId !== undefined ? { collectorId: request.collectorId } : {}) });
  if (!decision.authorized) return decision;
  const collector = await loadUnifiCollector(request.collectorId!);
  if (!collector) return { authorized: false, reason: 'collector_not_owned' };
  const namespace = unifiControllerPortNamespace(unifiHostKey(collector), request.authorityKey.slice(request.collectorId!.length + 1));
  const rows = await db.select({ id: topologyInterfaces.id }).from(topologyInterfaces).where(and(eq(topologyInterfaces.orgId, request.scope.orgId),
    eq(topologyInterfaces.siteId, request.scope.siteId), isNull(topologyInterfaces.retiredAt), sql`starts_with(${topologyInterfaces.controllerPortKey}, ${namespace})`))
    .orderBy(topologyInterfaces.id).limit(TOPOLOGY_TELEMETRY_MAX_AUTHORIZED_INTERFACES);
  return { authorized: true, configurationGeneration: decision.configurationGeneration, interfaceIds: rows.map(row => row.id) };
};
/** Idempotent explicit registration (boot via registerTopologyPhysicalAuthorities, and the adapter). */
export function ensureUnifiTelemetryAuthority(): void {
  if (!isTopologyTelemetryAuthorityRegistered('unifi')) registerTopologyTelemetryAuthority('unifi', unifiTelemetryAuthority);
}

export type UnifiTelemetryReceipt = { accepted: number; inserted: number; rejected: string[]; omitted: Record<string, number>; skipped?: string };
/**
 * Ingest the link state of one accepted device-detail resource. Caller owns the
 * transaction and system DB context; runs in its own savepoint so a telemetry
 * refusal never touches the structural receipt.
 */
export async function ingestUnifiInterfaceTelemetry(input: {
  deviceId: string; collector: UnifiCollectorAuthority; scope: TopologyScope; authorityKey: string;
  report: { sequence: string; capturedAt: string }; resource: UnifiResource;
}): Promise<UnifiTelemetryReceipt> {
  assertInTransaction('ingestUnifiInterfaceTelemetry');
  const receipt: UnifiTelemetryReceipt = { accepted: 0, inserted: 0, rejected: [], omitted: {} };
  if (input.resource.kind !== 'device_details') return { ...receipt, skipped: 'not_device_details' };
  if (!(await loadTopologyFlags({ scope: input.scope })).interfaceHealth) return { ...receipt, skipped: 'interface_health_disabled' };
  ensureUnifiTelemetryAuthority();
  try {
    return await db.transaction(async () => {
      const producer = await resolveTopologyTelemetryProducer({ producerKind: 'unifi', deviceId: input.deviceId, scope: input.scope,
        authorityKey: input.authorityKey, collectorId: input.collector.id });
      const hostKey = unifiHostKey(input.collector);
      const keys = (input.resource.rows as DetailRow[]).flatMap(row => row.ports.map(port => unifiControllerPortKey(
        unifiEndpointKey({ hostKey, controllerSiteId: input.resource.controllerSiteId, kind: 'device', value: row.deviceId }), port.portIndex)));
      const mapped = keys.length ? await db.select({ id: topologyInterfaces.id, epoch: topologyInterfaces.epoch, key: topologyInterfaces.controllerPortKey })
        .from(topologyInterfaces).where(and(eq(topologyInterfaces.orgId, input.scope.orgId), eq(topologyInterfaces.siteId, input.scope.siteId),
          isNull(topologyInterfaces.retiredAt), inArray(topologyInterfaces.controllerPortKey, keys))) : [];
      const interfaces = new Map(mapped.map(row => [row.key!, { id: row.id, epoch: row.epoch }]));
      const latest = new Map<string, LatestState>();
      if (mapped.length) {
        const rows = await db.execute<{ interface_id: string; sampled_at: Date | string; readings: { operStatus?: string; capacityBps?: string | null } }>(sql`
          SELECT DISTINCT ON (interface_id) interface_id, sampled_at, readings FROM topology_interface_samples
          WHERE resolution = 'raw' AND org_id = ${input.scope.orgId}::uuid AND site_id = ${input.scope.siteId}::uuid
            AND interface_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(mapped.map(row => row.id))}::jsonb)::uuid)
            AND sampled_at >= now() - interval '1 hour'
          ORDER BY interface_id, sampled_at DESC`);
        for (const row of rows) latest.set(row.interface_id, { sampledAt: new Date(row.sampled_at), operStatus: row.readings.operStatus ?? 'unknown', capacityBps: row.readings.capacityBps ?? null });
      }
      const { envelopes, omitted } = normalizeUnifiInterfaceMetrics({ producer, report: input.report, resource: input.resource, hostKey, interfaces, latest });
      receipt.omitted = omitted;
      for (const envelope of envelopes) {
        const result = await persistTopologyInterfaceSamples(producer, envelope);
        if (result.accepted) { receipt.accepted += 1; receipt.inserted += result.inserted; } else receipt.rejected.push(result.reason ?? 'not_accepted');
      }
      return receipt;
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    if (!TOPOLOGY_TELEMETRY_PRODUCER_REJECTIONS.has(reason) && reason !== 'invalid_envelope') throw error;
    return { ...receipt, rejected: [...receipt.rejected, reason] };
  }
}
