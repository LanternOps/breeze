import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ db: {}, assertInTransaction: () => undefined }));

import {
  planTopologyTelemetryWindow, TOPOLOGY_TELEMETRY_SOURCE_DAILY_BYTES, TOPOLOGY_TELEMETRY_SOURCE_DAILY_SAMPLES,
  topologyInterfaceMeasurementChanged, topologyTelemetryInFlightLockKey,
} from './interfaceSamples';
import type { TopologyInterfaceSampleReadingsV1 } from './interfaceMetricTypes';

const readings = (over: Partial<TopologyInterfaceSampleReadingsV1> = {}): TopologyInterfaceSampleReadingsV1 => ({
  v: 1, counterWidth: 64, inOctets: '10', outOctets: '20', inErrors: '0', outErrors: '0', inDiscards: '0', outDiscards: '0',
  inPackets: null, outPackets: null, capacityBps: '1000000000', discontinuityTicks: '0', deviceUptimeTicks: '5000',
  reportedInBps: null, reportedOutBps: null, adminStatus: 'up', operStatus: 'up',
  unavailable: { inPackets: 'unsupported', outPackets: 'unsupported', reportedInBps: 'unsupported', reportedOutBps: 'unsupported' },
  expectedIntervalSeconds: 60, ...over,
});
const at = (seconds: number) => new Date(Date.UTC(2026, 10, 2, 10, 0, seconds));

describe('telemetry admission window', () => {
  it('opens a new daily window and accumulates within it', () => {
    const first = planTopologyTelemetryWindow({ startedAt: null, samples: 0, bytes: 0 }, at(0), 10, 1000);
    expect(first).toEqual({ allowed: true, window: { startedAt: at(0), samples: 10, bytes: 1000 } });
    const second = planTopologyTelemetryWindow(first.window, at(30), 5, 500);
    expect(second).toEqual({ allowed: true, window: { startedAt: at(0), samples: 15, bytes: 1500 } });
  });

  it('refuses a batch that would exceed the per-source sample or byte quota', () => {
    const full = { startedAt: at(0), samples: TOPOLOGY_TELEMETRY_SOURCE_DAILY_SAMPLES - 1, bytes: 0 };
    expect(planTopologyTelemetryWindow(full, at(60), 1, 10).allowed).toBe(true);
    expect(planTopologyTelemetryWindow(full, at(60), 2, 10).allowed).toBe(false);
    expect(planTopologyTelemetryWindow({ startedAt: at(0), samples: 0, bytes: TOPOLOGY_TELEMETRY_SOURCE_DAILY_BYTES }, at(60), 1, 1).allowed).toBe(false);
  });

  it('resets after 24 hours and after a window start in the future', () => {
    const full = { startedAt: at(0), samples: TOPOLOGY_TELEMETRY_SOURCE_DAILY_SAMPLES, bytes: 0 };
    const tomorrow = new Date(at(0).getTime() + 86_400_000);
    expect(planTopologyTelemetryWindow(full, tomorrow, 1, 1)).toEqual({ allowed: true, window: { startedAt: tomorrow, samples: 1, bytes: 1 } });
    expect(planTopologyTelemetryWindow({ ...full, startedAt: at(120) }, at(60), 1, 1).window.startedAt).toEqual(at(60));
  });
});

describe('current measurement change', () => {
  const next = (seconds: number, over: Partial<TopologyInterfaceSampleReadingsV1> = {}) => ({ sampledAt: at(seconds), readings: readings(over) });

  it('treats the first sample and a return after a gap as a change', () => {
    expect(topologyInterfaceMeasurementChanged(null, next(0))).toBe(true);
    expect(topologyInterfaceMeasurementChanged(next(0), next(121))).toBe(true);
    expect(topologyInterfaceMeasurementChanged(next(0), next(120))).toBe(false);
  });

  it('ignores counter advances but not status, capacity, width or discontinuity', () => {
    expect(topologyInterfaceMeasurementChanged(next(0), next(60, { inOctets: '999999', deviceUptimeTicks: '11000' }))).toBe(false);
    for (const over of [{ operStatus: 'down' as const }, { adminStatus: 'down' as const }, { capacityBps: '100000000' }, { counterWidth: 32 as const }, { discontinuityTicks: '7' }]) {
      expect(topologyInterfaceMeasurementChanged(next(0), next(60, over)), JSON.stringify(over)).toBe(true);
    }
  });

  it('treats a device uptime reset (counters restarted) as a change', () => {
    expect(topologyInterfaceMeasurementChanged(next(0), next(60, { deviceUptimeTicks: '10' }))).toBe(true);
  });
});

describe('in-flight lock key', () => {
  it('is per source identity and authority', () => {
    const a = topologyTelemetryInFlightLockKey({ sourceIdentity: 'o:s:snmp:d', authorityKey: 'snmp:192.0.2.1' });
    expect(a).toBe('o:s:snmp:d|if_metrics|snmp:192.0.2.1');
    expect(topologyTelemetryInFlightLockKey({ sourceIdentity: 'o:s:snmp:d', authorityKey: 'snmp:192.0.2.2' })).not.toBe(a);
  });
});
