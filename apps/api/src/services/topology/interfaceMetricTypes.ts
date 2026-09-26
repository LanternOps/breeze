import { createHash } from 'node:crypto';
import type {
  TopologyInterfaceHistoryQuery, TopologyInterfaceHistoryResponse, TopologyInterfaceHistorySeries,
  TopologyInterfaceMetricEnvelopeV1, TopologyInterfaceSampleV1,
} from '@breeze/shared';

/**
 * API aliases for the M3 interface measurement contract (Task 1, amendment
 * M3-D1). Interface telemetry is a separate family from structural collection:
 * its source rows live in `topology_collection_sources` (so they share producer
 * epochs, fencing and sequence acceptance with M2 ingest) under the reserved
 * protocol `if_metrics`, but they never produce collection runs and are
 * excluded from structural publication and coverage.
 */
export type {
  TopologyInterfaceHistoryQuery, TopologyInterfaceHistoryResponse, TopologyInterfaceHistorySeries,
  TopologyInterfaceMetricEnvelopeV1, TopologyInterfaceSampleV1,
};
export { parseTopologyInterfaceMetricEnvelopeV1 } from '@breeze/shared';

export const TOPOLOGY_TELEMETRY_PROTOCOL = 'if_metrics' as const;
export type TopologyTelemetryFamily = typeof TOPOLOGY_TELEMETRY_PROTOCOL;
/** Producer kinds that may own an `if_metrics` source: SNMP pollers (standing
 * telemetry arm) and UniFi controllers (controller-site authority). */
export const TOPOLOGY_TELEMETRY_PRODUCER_KINDS = ['snmp', 'unifi'] as const;
export type TopologyTelemetryProducerKind = typeof TOPOLOGY_TELEMETRY_PRODUCER_KINDS[number];
/** Source-row protocols that carry telemetry and must never be structurally published. */
export const TOPOLOGY_TELEMETRY_PROTOCOLS: readonly string[] = [TOPOLOGY_TELEMETRY_PROTOCOL];
export const isTopologyTelemetryProtocol = (protocol: string) => TOPOLOGY_TELEMETRY_PROTOCOLS.includes(protocol);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Key-order-independent digest of a parsed batch: a replay of the accepted
 * sequence must match it exactly, anything else at that sequence is a conflict. */
export function topologyInterfaceMetricDigest(envelope: TopologyInterfaceMetricEnvelopeV1): string {
  return createHash('sha256').update('topology-if-metrics-v1\n').update(canonicalJson(envelope)).digest('hex');
}

/** Version 1 of the stored `readings` document of a raw sample row. */
export type TopologyInterfaceSampleReadingsV1 = Omit<TopologyInterfaceSampleV1, 'interfaceId' | 'interfaceEpoch' | 'sampledAt'> & {
  v: 1; expectedIntervalSeconds: number;
};
/** The immutable raw readings persisted for one sample. Identity (interface,
 * epoch, time, source, sequence) lives in columns; scope is never copied in. */
export function topologyInterfaceSampleReadings(envelope: TopologyInterfaceMetricEnvelopeV1, sample: TopologyInterfaceSampleV1): TopologyInterfaceSampleReadingsV1 {
  const { interfaceId: _id, interfaceEpoch: _epoch, sampledAt: _at, ...readings } = sample;
  return { v: 1, ...readings, expectedIntervalSeconds: envelope.expectedIntervalSeconds };
}
