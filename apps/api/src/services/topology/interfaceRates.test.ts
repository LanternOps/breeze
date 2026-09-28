import { describe, expect, it } from 'vitest';
import { calculateInterfaceWindow, type InterfaceRateSample } from './interfaceRates';

const IF = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const T0 = Date.parse('2026-09-15T00:00:00Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

/** 60-second cadence, 64-bit width, increasing uptime, 1,000,000 bps capacity. */
function sample(over: Partial<InterfaceRateSample> & { seconds?: number } = {}): InterfaceRateSample {
  const { seconds = 0, ...rest } = over;
  return {
    interfaceId: IF, interfaceEpoch: 'gen:1', sourceId: SOURCE, producerEpoch: 'epoch-a', expectedIntervalSeconds: 60,
    sampledAt: at(seconds), counterWidth: 64,
    inOctets: '0', outOctets: '0', inErrors: '0', outErrors: '0', inDiscards: '0', outDiscards: '0', inPackets: null, outPackets: null,
    capacityBps: '1000000', discontinuityTicks: '0', deviceUptimeTicks: String(100_000 + seconds * 100),
    adminStatus: 'up', operStatus: 'up',
    ...rest,
  };
}

describe('calculateInterfaceWindow', () => {
  it('subtracts big integers before converting the delta', () => {
    const a = sample({ sampledAt: '2026-09-15T00:00:00Z', inOctets: '9007199254740993' });
    const b = sample({ sampledAt: '2026-09-15T00:01:00Z', inOctets: '9007199254748493', deviceUptimeTicks: '106000' });
    expect(calculateInterfaceWindow(a, b).inBps).toBe(1000);
  });

  it('computes both directions, utilization and error/discard rates independently', () => {
    const w = calculateInterfaceWindow(sample(), sample({ seconds: 60, inOctets: '7500', outOctets: '75000', inErrors: '6', outDiscards: '120' }));
    expect(w).toMatchObject({ elapsedMs: 60_000, validDurationMs: 60_000, inBps: 1000, outBps: 10_000, inUtilizationPct: 0.1, outUtilizationPct: 1,
      inErrorsPerSecond: 0.1, outErrorsPerSecond: 0, inDiscardsPerSecond: 0, outDiscardsPerSecond: 2, invalid: [] });
  });

  it('keeps a measured zero delta as zero and missing evidence as null', () => {
    const w = calculateInterfaceWindow(sample(), sample({ seconds: 60, outOctets: null }));
    expect(w.inBps).toBe(0);
    expect(w.outBps).toBeNull();
    expect(w.reasons.out_bps).toBe('not_reported');
  });

  it.each([
    ['first sample', null, sample(), 'first_sample'],
    ['duplicate time', sample(), sample(), 'non_increasing_time'],
    ['out-of-order time', sample({ seconds: 60 }), sample(), 'non_increasing_time'],
    ['interface generation change', sample(), sample({ seconds: 60, interfaceEpoch: 'gen:2' }), 'interface_generation_changed'],
    ['source change', sample(), sample({ seconds: 60, sourceId: '33333333-3333-4333-8333-333333333333' }), 'source_changed'],
    ['producer epoch (origin) change', sample(), sample({ seconds: 60, producerEpoch: 'epoch-b' }), 'source_changed'],
    ['uptime rollback', sample({ deviceUptimeTicks: '900000' }), sample({ seconds: 60, deviceUptimeTicks: '100' }), 'device_restarted'],
    ['discontinuity change', sample(), sample({ seconds: 60, discontinuityTicks: '5000' }), 'counter_discontinuity'],
    ['gap beyond three cadences', sample(), sample({ seconds: 181 }), 'gap'],
    ['counter width change', sample({ counterWidth: 32 }), sample({ seconds: 60 }), 'counter_width_changed'],
  ] as const)('never produces a rate across %s', (_name, previous, current, reason) => {
    const w = calculateInterfaceWindow(previous, current);
    expect(w.invalid).toContain(reason);
    expect([w.inBps, w.outBps, w.inUtilizationPct, w.inErrorsPerSecond]).toEqual([null, null, null, null]);
    expect(w.validDurationMs).toBe(0);
  });

  it('invalidates a decreasing 64-bit counter', () => {
    const w = calculateInterfaceWindow(sample({ inOctets: '1000' }), sample({ seconds: 60, inOctets: '10' }));
    expect(w.inBps).toBeNull();
    expect(w.reasons.in_bps).toBe('counter_decreased');
    expect(w.outBps).toBe(0);
  });

  it('accepts a unique feasible 32-bit wrap under the capacity bound', () => {
    // 100 Mbps for 60 s can move at most 750,000,000 octets < 2^32: exactly one wrap is feasible.
    const prev = sample({ counterWidth: 32, capacityBps: '100000000', inOctets: String(4294967295 - 999) });
    const curr = sample({ seconds: 60, counterWidth: 32, capacityBps: '100000000', inOctets: '6500' });
    expect(calculateInterfaceWindow(prev, curr).inBps).toBe(1000);
  });

  it('refuses a 32-bit window with unknown capacity even when the counter increased', () => {
    const w = calculateInterfaceWindow(sample({ counterWidth: 32, capacityBps: null }), sample({ seconds: 60, counterWidth: 32, capacityBps: null, inOctets: '7500' }));
    expect(w.inBps).toBeNull();
    expect(w.reasons.in_bps).toBe('ambiguous_wrap');
  });

  it('refuses a 32-bit window where more than one wrap is possible', () => {
    // 10 Gbps for 60 s can move 75 GB: many wraps fit, so the delta is ambiguous.
    const w = calculateInterfaceWindow(sample({ counterWidth: 32, capacityBps: '10000000000' }), sample({ seconds: 60, counterWidth: 32, capacityBps: '10000000000', inOctets: '7500' }));
    expect(w.inBps).toBeNull();
    expect(w.reasons.in_bps).toBe('ambiguous_wrap');
  });

  it('keeps the rate but drops utilization when speed changes', () => {
    const w = calculateInterfaceWindow(sample(), sample({ seconds: 60, capacityBps: '10000000', inOctets: '7500' }));
    expect(w.inBps).toBe(1000);
    expect(w.inUtilizationPct).toBeNull();
    expect(w.reasons.in_utilization_pct).toBe('capacity_changed');
  });

  it('flags an implausible rate above capacity without clamping it to 100%', () => {
    const w = calculateInterfaceWindow(sample(), sample({ seconds: 60, inOctets: '15000000' }));
    expect(w.inBps).toBe(2_000_000);
    expect(w.inUtilizationPct).toBe(200);
    expect(w.anomalies).toContain('in_exceeds_capacity');
  });

  it('treats a Counter32 error decrease as unknown, not a negative rate', () => {
    const w = calculateInterfaceWindow(sample({ inErrors: '10' }), sample({ seconds: 60, inErrors: '4' }));
    expect(w.inErrorsPerSecond).toBeNull();
    expect(w.reasons.in_errors_per_second).toBe('counter_decreased');
  });

  it('carries the window span and never mutates its inputs', () => {
    const a = sample(), b = sample({ seconds: 60, inOctets: '7500' });
    const before = JSON.stringify([a, b]);
    const w = calculateInterfaceWindow(a, b);
    expect(JSON.stringify([a, b])).toBe(before);
    expect(w.from.toISOString()).toBe(a.sampledAt);
    expect(w.to.toISOString()).toBe(b.sampledAt);
  });
});
