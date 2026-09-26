import { describe, expect, it } from 'vitest';
import fixture from '../../../../../packages/shared/src/testing/topology-interface-metrics-v1.json';
import { parseTopologyInterfaceMetricEnvelopeV1, type TopologyInterfaceMetricEnvelopeV1 } from '@breeze/shared';
import {
  isTopologyTelemetryProtocol, TOPOLOGY_TELEMETRY_PROTOCOL, topologyInterfaceMetricDigest, topologyInterfaceSampleReadings,
} from './interfaceMetricTypes';
import { topologySourceFamily } from './collectionTypes';

const valid = (): TopologyInterfaceMetricEnvelopeV1 => {
  const parsed = parseTopologyInterfaceMetricEnvelopeV1(structuredClone(fixture.valid));
  if (!parsed.accepted) throw new Error('fixture must parse');
  return parsed.envelope;
};

describe('interface metric API contract', () => {
  it('names a telemetry protocol that is never a structural source family', () => {
    expect(TOPOLOGY_TELEMETRY_PROTOCOL).toBe('if_metrics');
    expect(isTopologyTelemetryProtocol('if_metrics')).toBe(true);
    expect(isTopologyTelemetryProtocol('lldp')).toBe(false);
    expect(() => topologySourceFamily(TOPOLOGY_TELEMETRY_PROTOCOL)).toThrow('unsupported_source_family');
  });

  it('digests the batch independently of key order and sensitive to any reading', () => {
    const a = valid();
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as TopologyInterfaceMetricEnvelopeV1;
    expect(topologyInterfaceMetricDigest(reordered)).toBe(topologyInterfaceMetricDigest(a));
    expect(topologyInterfaceMetricDigest(a)).toMatch(/^[a-f0-9]{64}$/);
    const changed = valid();
    changed.samples[0]!.inOctets = '18446744073709551614';
    expect(topologyInterfaceMetricDigest(changed)).not.toBe(topologyInterfaceMetricDigest(a));
  });

  it('stores readings with string counters, the reason map and no identity or scope fields', () => {
    const envelope = valid();
    const readings = topologyInterfaceSampleReadings(envelope, envelope.samples[1]!);
    expect(readings).toMatchObject({ v: 1, counterWidth: 32, inOctets: '4294967295', inErrors: null, reportedOutBps: 8000.5,
      adminStatus: 'down', operStatus: 'lower_layer_down', expectedIntervalSeconds: 60, unavailable: { inErrors: 'timeout' } });
    for (const field of ['interfaceId', 'interfaceEpoch', 'sampledAt', 'orgId', 'siteId', 'sourceId']) expect(readings).not.toHaveProperty(field);
    expect(JSON.parse(JSON.stringify(readings)).inOctets).toBe('4294967295');
  });
});
