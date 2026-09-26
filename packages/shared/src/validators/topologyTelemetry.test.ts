import { describe, expect, it } from 'vitest';
import fixture from '../testing/topology-interface-metrics-v1.json';
import pollFixture from '../testing/topology-interface-poll-v1.json';
import {
  parseTopologyInterfaceMetricEnvelopeV1,
  TOPOLOGY_INTERFACE_METRIC_SERIES,
  TOPOLOGY_INTERFACE_METRIC_UNITS,
  TOPOLOGY_INTERFACE_METRICS_MAX_SAMPLES,
  topologyInterfaceHistoryQuerySchema,
  topologyInterfaceHistoryResponseSchema,
  topologyLinkHealthResponseSchema,
  TOPOLOGY_INTERFACE_HEALTH_THRESHOLDS,
  TOPOLOGY_INTERFACE_HISTORY_MAX_EPOCHS,
  topologyInterfaceMetricEnvelopeV1Schema,
  topologyInterfaceSampleV1Schema,
  TOPOLOGY_INTERFACE_POLL_COMMAND_TYPE,
  TOPOLOGY_INTERFACE_POLL_MAX_INTERFACES,
  TOPOLOGY_INTERFACE_POLL_SECRET_FIELDS,
  topologyInterfacePollCommandV1Schema,
} from './topologyTelemetry';
import * as barrel from './index';

const IF_C = '44444444-4444-4444-8444-444444444444';

describe('interface measurement transport v1', () => {
  it('keeps uint64 precision and rejects a fabricated zero for missing counters', () => {
    const sample = { ...fixture.valid.samples[0], inOctets: '18446744073709551615', outOctets: null };
    const parsed = topologyInterfaceSampleV1Schema.parse(sample);
    expect(parsed.inOctets).toBe('18446744073709551615');
    expect(parsed.outOctets).toBeNull();
    expect(parsed.unavailable.outOctets).toBe('not_reported');
    expect(topologyInterfaceSampleV1Schema.safeParse({ ...sample, inOctets: 18446744073709551615 }).success).toBe(false);
    expect(topologyInterfaceSampleV1Schema.safeParse({ ...sample, counterWidth: 32 }).success).toBe(false);
  });

  it('parses the shared valid envelope unchanged, including true measured zeros', () => {
    const result = parseTopologyInterfaceMetricEnvelopeV1(fixture.valid);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.envelope).toEqual(fixture.valid);
    expect(result.envelope.samples[0]!.outOctets).toBe('0');
    expect(result.envelope.samples[1]!.reportedInBps).toBe(0);
  });

  it.each(fixture.normalization)('$name', ({ sample, expected }) => {
    expect(topologyInterfaceSampleV1Schema.parse(sample)).toEqual(expected);
  });

  it.each(fixture.invalid)('rejects: $name', ({ envelope }) => {
    expect(parseTopologyInterfaceMetricEnvelopeV1(envelope).accepted).toBe(false);
  });

  it('reports an unknown major version distinctly', () => {
    expect(parseTopologyInterfaceMetricEnvelopeV1({ ...fixture.valid, schemaVersion: 2 })).toEqual({ accepted: false, reason: 'unsupported_major_version' });
  });

  it('rejects nonfinite reported rates', () => {
    for (const value of [Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(topologyInterfaceSampleV1Schema.safeParse({ ...fixture.valid.samples[1], reportedOutBps: value }).success).toBe(false);
    }
  });

  it('bounds a batch at 256 samples', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({
      ...fixture.valid.samples[0], interfaceId: `${IF_C.slice(0, 24)}${i.toString(16).padStart(12, '0')}`,
    }));
    const envelope = (n: number) => ({ ...fixture.valid, samples: many(n) });
    expect(topologyInterfaceMetricEnvelopeV1Schema.safeParse(envelope(TOPOLOGY_INTERFACE_METRICS_MAX_SAMPLES)).success).toBe(true);
    expect(topologyInterfaceMetricEnvelopeV1Schema.safeParse(envelope(TOPOLOGY_INTERFACE_METRICS_MAX_SAMPLES + 1)).success).toBe(false);
  });

  it('is exported from the shared barrel', () => {
    expect(barrel.parseTopologyInterfaceMetricEnvelopeV1).toBe(parseTopologyInterfaceMetricEnvelopeV1);
  });
});

describe('interface history contract', () => {
  const now = Date.parse('2026-11-02T12:00:00Z');
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

  it('names eight fixed-unit series', () => {
    expect(TOPOLOGY_INTERFACE_METRIC_SERIES).toEqual(['in_bps', 'out_bps', 'in_utilization_pct', 'out_utilization_pct',
      'in_errors_per_second', 'out_errors_per_second', 'in_discards_per_second', 'out_discards_per_second']);
    expect(TOPOLOGY_INTERFACE_METRIC_UNITS.in_utilization_pct).toBe('percent');
  });

  it('bounds series count, buckets and raw range', () => {
    const base = { series: ['in_bps'], from: iso(-3_600_000), to: iso(0) };
    expect(topologyInterfaceHistoryQuerySchema.parse(base)).toMatchObject({ resolution: 'auto', maxBuckets: 1000 });
    expect(topologyInterfaceHistoryQuerySchema.safeParse({ ...base, series: [...TOPOLOGY_INTERFACE_METRIC_SERIES, 'in_bps'] }).success).toBe(false);
    expect(topologyInterfaceHistoryQuerySchema.safeParse({ ...base, series: ['in_bps', 'in_bps'] }).success).toBe(false);
    expect(topologyInterfaceHistoryQuerySchema.safeParse({ ...base, maxBuckets: 1001 }).success).toBe(false);
    expect(topologyInterfaceHistoryQuerySchema.safeParse({ ...base, resolution: 'raw', from: iso(-8 * 86_400_000) }).success).toBe(false);
    expect(topologyInterfaceHistoryQuerySchema.safeParse({ ...base, resolution: 'raw', from: iso(-7 * 86_400_000) }).success).toBe(true);
    expect(topologyInterfaceHistoryQuerySchema.safeParse({ ...base, from: iso(0), to: iso(-1) }).success).toBe(false);
  });

  const SOURCE = '55555555-5555-4555-8555-555555555555';
  const point = { at: iso(-60_000), value: null, min: null, max: null, validDurationMs: 0, sampleCount: 0, gapDurationMs: 60_000, reasons: ['no_samples'] };
  const series = { name: 'in_bps', unit: 'bits_per_second', interfaceEpoch: 'gen:1', sourceId: SOURCE, sourceKind: 'snmp', producerEpoch: 'p1', coverage: 'none',
    points: [point], gaps: [{ from: iso(-60_000), to: iso(0), reason: 'no_samples' }], reasons: [] };
  const epoch = { interfaceEpoch: 'gen:1', sourceId: SOURCE, sourceKind: 'snmp', producerEpoch: 'p1', current: true, sourceState: 'active', from: iso(-60_000), to: iso(0) };
  const response = { interfaceId: IF_C, interfaceEpoch: 'gen:1', resolution: 'raw', interval: { from: iso(-60_000), to: iso(0), bucketSeconds: 60 },
    series: [series], epochs: [epoch], coverage: 'none', reasons: [], asOf: iso(0) };

  it('requires unit, epoch, source, coverage and gaps on every series', () => {
    expect(topologyInterfaceHistoryResponseSchema.safeParse(response).success).toBe(true);
    expect(topologyInterfaceHistoryResponseSchema.safeParse({ ...response, series: [{ ...series, unit: 'percent' }] }).success).toBe(false);
    for (const field of ['gaps', 'coverage', 'interfaceEpoch', 'sourceId', 'unit', 'producerEpoch'] as const) {
      const { [field]: _omitted, ...without } = series;
      expect(topologyInterfaceHistoryResponseSchema.safeParse({ ...response, series: [without] }).success, field).toBe(false);
    }
  });

  it('breaks a series at an interface generation: every series names a represented epoch', () => {
    expect(topologyInterfaceHistoryResponseSchema.safeParse({ ...response, series: [{ ...series, interfaceEpoch: 'gen:2' }] }).success).toBe(false);
    const second = { ...epoch, interfaceEpoch: 'gen:2', current: false };
    expect(topologyInterfaceHistoryResponseSchema.safeParse({ ...response, epochs: [epoch, second], series: [series, { ...series, interfaceEpoch: 'gen:2' }] }).success).toBe(true);
    expect(topologyInterfaceHistoryResponseSchema.safeParse({ ...response, epochs: Array.from({ length: TOPOLOGY_INTERFACE_HISTORY_MAX_EPOCHS + 1 }, (_, i) => ({ ...epoch, producerEpoch: `p${i}` })) }).success).toBe(false);
  });

  it('bounds points per series and keeps point aggregates honest', () => {
    expect(topologyInterfaceHistoryResponseSchema.safeParse({ ...response, series: [{ ...series, points: Array.from({ length: 1001 }, () => point) }] }).success).toBe(false);
    expect(topologyInterfaceHistoryResponseSchema.safeParse({ ...response, series: [{ ...series, points: [{ ...point, sampleCount: -1 }] }] }).success).toBe(false);
    expect(topologyInterfaceHistoryResponseSchema.safeParse({ ...response, interval: { ...response.interval, bucketSeconds: 0 } }).success).toBe(false);
  });

  it('describes link health with per-endpoint measurement, never a summed rate', () => {
    const endpoint = { interfaceId: IF_C, interfaceEpoch: 'gen:1', retired: false, status: 'failed_check', coverage: 'monitored', freshness: 'fresh',
      reasons: ['interface_link_down'], adminStatus: 'up', operStatus: 'down', capacityBps: '1000000000', sourceId: SOURCE, sourceKind: 'snmp',
      observedAt: iso(-30_000), freshUntil: iso(150_000), expectedIntervalSeconds: 60,
      rates: { from: iso(-90_000), to: iso(-30_000), values: [{ name: 'in_bps', unit: 'bits_per_second', value: 12.5, reason: null }] } };
    const health = { status: 'failed_check', coverage: 'monitored', scope: 'relationship', originNodeId: null, resultId: null, reasons: [{ code: 'interface_link_down', message: 'x' }], freshness: 'fresh' };
    const body = { siteId: SOURCE, relationshipId: IF_C, graphRevision: '3', healthRevision: '9', health, freshUntil: iso(150_000),
      interfaceEvidence: { applies: true, reason: null }, endpoints: { source: endpoint, target: null }, asOf: iso(0) };
    expect(topologyLinkHealthResponseSchema.safeParse(body).success).toBe(true);
    expect(topologyLinkHealthResponseSchema.safeParse({ ...body, endpoints: { ...body.endpoints, combined: endpoint } }).success).toBe(false);
    expect(topologyLinkHealthResponseSchema.safeParse({ ...body, endpoints: { source: { ...endpoint, rates: { ...endpoint.rates, values: [{ name: 'in_bps', unit: 'percent', value: 1, reason: null }] } }, target: null } }).success).toBe(false);
    expect(TOPOLOGY_INTERFACE_HEALTH_THRESHOLDS.errorsPerSecond).toBeGreaterThan(0);
  });
});

describe('topology_interface_poll command v1', () => {
  it('parses the shared valid, v2c and terminally-erased commands', () => {
    for (const command of [pollFixture.valid, pollFixture.validV2c, pollFixture.erased]) {
      const parsed = topologyInterfacePollCommandV1Schema.safeParse(command);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
    expect(topologyInterfacePollCommandV1Schema.parse(pollFixture.valid).interfaces[0]!.ifIndex).toBe(7);
  });

  it.each(pollFixture.invalid)('rejects: $name', ({ command }) => {
    expect(topologyInterfacePollCommandV1Schema.safeParse(command).success).toBe(false);
  });

  it('names the command, its secret fields and its bounds once', () => {
    expect(TOPOLOGY_INTERFACE_POLL_COMMAND_TYPE).toBe('topology_interface_poll');
    expect(TOPOLOGY_INTERFACE_POLL_SECRET_FIELDS).toEqual(['snmpCommunity', 'snmpAuthPassphrase', 'snmpPrivPassphrase']);
    expect(TOPOLOGY_INTERFACE_POLL_MAX_INTERFACES).toBe(TOPOLOGY_INTERFACE_METRICS_MAX_SAMPLES);
    expect(barrel.topologyInterfacePollCommandV1Schema).toBe(topologyInterfacePollCommandV1Schema);
  });
});
