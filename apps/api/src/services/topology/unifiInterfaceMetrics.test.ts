import { describe, expect, it } from 'vitest';
import { parseTopologyInterfaceMetricEnvelopeV1, unifiEndpointKey, type UnifiResource } from '@breeze/shared';
import { normalizeUnifiInterfaceMetrics, UNIFI_TELEMETRY_INTERVAL_SECONDS } from './unifiInterfaceMetrics';
import { unifiControllerPortKey } from './unifiPorts';

const HOST = 'host-1', SITE = 'default';
const producer = { producerEpoch: 'p'.repeat(64), configurationRevision: 'c'.repeat(64) };
const report = { sequence: '1790000000000', capturedAt: '2026-11-02T10:00:00.000Z' };
const IF1 = '11111111-1111-4111-8111-111111111111', IF2 = '22222222-2222-4222-8222-222222222222';
const endpoint = (deviceId: string) => unifiEndpointKey({ hostKey: HOST, controllerSiteId: SITE, kind: 'device', value: deviceId });
const details = (ports: { portIndex: number; name: string | null; linkUp: boolean | null; speedMbps: number | null; poeMode: string | null }[], over: Partial<UnifiResource> = {}) => ({
  controllerSiteId: SITE, kind: 'device_details', contentDigest: 'a'.repeat(64), outcome: 'complete', rowCount: 1,
  rows: [{ rowKey: 'sw1', deviceId: 'sw1', uplinkDeviceId: null, uplinkPortIndex: null, ports }], ...over,
}) as UnifiResource;
const interfaces = new Map([[unifiControllerPortKey(endpoint('sw1'), 1), { id: IF1, epoch: 'gen:1' }], [unifiControllerPortKey(endpoint('sw1'), 2), { id: IF2, epoch: 'gen:2' }]]);
const run = (resource: UnifiResource, latest = new Map()) => normalizeUnifiInterfaceMetrics({ producer, report, resource, hostKey: HOST, interfaces, latest });

describe('normalizeUnifiInterfaceMetrics', () => {
  it('reports link state and negotiated speed only — no counters, rates or PoE', () => {
    const { envelopes, omitted } = run(details([
      { portIndex: 1, name: 'Port 1', linkUp: true, speedMbps: 1000, poeMode: 'auto' },
      { portIndex: 2, name: 'Port 2', linkUp: false, speedMbps: 0, poeMode: null },
    ]));
    expect(omitted).toEqual({});
    expect(envelopes).toHaveLength(1);
    const parsed = parseTopologyInterfaceMetricEnvelopeV1(envelopes[0]);
    expect(parsed.accepted).toBe(true);
    const [up, down] = envelopes[0]!.samples;
    expect(up).toMatchObject({ interfaceId: IF1, interfaceEpoch: 'gen:1', operStatus: 'up', adminStatus: 'unknown', capacityBps: '1000000000',
      counterWidth: null, inOctets: null, outOctets: null, reportedInBps: null, reportedOutBps: null, sampledAt: report.capturedAt });
    expect(up!.unavailable.inOctets).toBe('not_supported_by_source');
    expect(up!.unavailable.reportedOutBps).toBe('not_supported_by_source');
    expect(down).toMatchObject({ interfaceId: IF2, interfaceEpoch: 'gen:2', operStatus: 'down', capacityBps: null });
    expect(down!.unavailable.capacityBps).toBe('link_down');
    expect(envelopes[0]).toMatchObject({ expectedIntervalSeconds: UNIFI_TELEMETRY_INTERVAL_SECONDS, commandId: null, outcome: 'complete', ...producer });
    expect(JSON.stringify(envelopes[0])).not.toContain('poe');
  });

  it('never attaches a sample to a port without a canonical mapping', () => {
    const { envelopes, omitted } = run(details([{ portIndex: 9, name: null, linkUp: true, speedMbps: 100, poeMode: null }]));
    expect(envelopes).toEqual([]);
    expect(omitted).toEqual({ port_not_identified: 1 });
  });

  it('treats an unknown link as unknown, not down, and a missing speed as unavailable, not zero', () => {
    const { envelopes } = run(details([{ portIndex: 1, name: null, linkUp: null, speedMbps: null, poeMode: null }]));
    expect(envelopes[0]!.samples[0]).toMatchObject({ operStatus: 'unknown', capacityBps: null });
    expect(envelopes[0]!.samples[0]!.unavailable.capacityBps).toBe('speed_not_reported');
  });

  it('emits nothing for a failed or unsupported detail resource (never withdraws or claims zero)', () => {
    for (const outcome of ['failed', 'unsupported', 'not_attempted'] as const) {
      expect(run(details([{ portIndex: 1, name: null, linkUp: true, speedMbps: 1000, poeMode: null }], { outcome, reasonCode: 'endpoint_unsupported', rows: [] })).envelopes).toEqual([]);
    }
  });

  it('marks a partial detail resource partial and ignores other resource kinds', () => {
    const partial = run(details([{ portIndex: 1, name: null, linkUp: true, speedMbps: 1000, poeMode: null }], { outcome: 'partial', reasonCode: 'detail_timeout' }));
    expect(partial.envelopes[0]).toMatchObject({ outcome: 'partial', reasonCode: 'detail_timeout' });
    expect(run({ ...details([]), kind: 'statistics', rows: [] } as unknown as UnifiResource).envelopes).toEqual([]);
  });

  it('refreshes unchanged state only after the refresh period, but reports a change at once', () => {
    const ports = [{ portIndex: 1, name: null, linkUp: true, speedMbps: 1000, poeMode: null }];
    const recent = new Map([[IF1, { sampledAt: new Date(Date.parse(report.capturedAt) - 60_000), operStatus: 'up', capacityBps: '1000000000' }]]);
    expect(run(details(ports), recent).envelopes).toEqual([]);
    const changed = new Map([[IF1, { sampledAt: new Date(Date.parse(report.capturedAt) - 60_000), operStatus: 'down', capacityBps: null }]]);
    expect(run(details(ports), changed).envelopes[0]!.samples).toHaveLength(1);
    const stale = new Map([[IF1, { sampledAt: new Date(Date.parse(report.capturedAt) - 300_000), operStatus: 'up', capacityBps: '1000000000' }]]);
    expect(run(details(ports), stale).envelopes[0]!.samples).toHaveLength(1);
  });

  it('splits more than 256 ports into strictly increasing, bounded batches', () => {
    const many = new Map<string, { id: string; epoch: string }>();
    const rows = Array.from({ length: 3 }, (_, d) => ({ rowKey: `sw${d}`, deviceId: `sw${d}`, uplinkDeviceId: null, uplinkPortIndex: null,
      ports: Array.from({ length: 100 }, (_, p) => {
        many.set(unifiControllerPortKey(endpoint(`sw${d}`), p + 1), { id: `44444444-4444-4444-8444-${String(d * 1000 + p).padStart(12, '0')}`, epoch: 'gen:1' });
        return { portIndex: p + 1, name: null, linkUp: true, speedMbps: 1000, poeMode: null };
      }) }));
    const resource = { ...details([]), rows, rowCount: 3 } as UnifiResource;
    const { envelopes } = normalizeUnifiInterfaceMetrics({ producer, report, resource, hostKey: HOST, interfaces: many, latest: new Map() });
    expect(envelopes.map(e => e.samples.length)).toEqual([256, 44]);
    expect(envelopes.map(e => e.sequence)).toEqual([String(1790000000000n * 4096n), String(1790000000000n * 4096n + 1n)]);
  });
});
