import { describe, expect, it } from 'vitest';
import type { EventLoopLagReading, EventLoopLagSample } from '../eventLoopMonitor';
import type { PoolSignals } from './poolSignals';
import { createSignalSampler } from './admissionSignals';

const pool = (over: Partial<PoolSignals> = {}): PoolSignals => ({
  available: true, inUse: 0, waiting: 0, effectivePermits: 30, oldestWaitMs: 0, grantWaitP95Ms: 0, dbTimeoutsTotal: 0, ...over,
});
const reading = (over: Partial<EventLoopLagReading> = {}): EventLoopLagReading => ({
  monitored: true, coversWindow: true, sampledMaxLagMs: 0, inFlightLagMs: 0, worstLagMs: 0, sampleCount: 1, ...over,
});

function harness() {
  const store: EventLoopLagSample[] = [];
  let latest = reading();
  let poolSnapshot = pool();
  let nowMs = 0;
  const sampler = createSignalSampler({
    readSamplesSince: (afterMs) => store.filter((s) => s.atMs > afterMs),
    readLatest: () => latest,
    readPool: () => poolSnapshot,
    now: () => nowMs,
    elu: (prev) => (prev ? { idle: 250, active: 750, utilization: 0.75 } : { idle: 0, active: 0, utilization: 0 }),
  });
  return {
    sampler,
    push: (atMs: number, maxLagMs: number) => store.push({ atMs, maxLagMs, meanLagMs: maxLagMs / 2 }),
    setLatest: (r: EventLoopLagReading) => { latest = r; },
    setPool: (p: PoolSignals) => { poolSnapshot = p; },
    advance: (ms: number) => { nowMs += ms; },
  };
}

describe('createSignalSampler', () => {
  it('takes the lower median of the newest three samples, reading each sample once', () => {
    const h = harness();
    h.push(1_000, 30); h.push(2_000, 400); h.push(3_000, 35);
    expect(h.sampler.sample().lagMs).toBe(35);       // [30, 35, 400] -> 35: one spike is filtered
    h.push(4_000, 500); h.push(5_000, 600);
    expect(h.sampler.sample().lagMs).toBe(500);      // window is now [35, 500, 600]
    expect(h.sampler.sample().lagMs).toBe(500);      // no new samples: window unchanged, nothing re-read
  });

  it('peak lag is the worst of the in-flight stall and the samples consumed this tick', () => {
    const h = harness();
    h.push(1_000, 1_200);
    h.setLatest(reading({ inFlightLagMs: 300 }));
    expect(h.sampler.sample().peakLagMs).toBe(1_200);
    h.setLatest(reading({ inFlightLagMs: 2_500 }));
    expect(h.sampler.sample().peakLagMs).toBe(2_500);
  });

  it('reports lag as unknown (null) when the monitor is not running', () => {
    const h = harness();
    h.push(1_000, 900);
    h.setLatest(reading({ monitored: false }));
    expect(h.sampler.sample()).toMatchObject({ lagMs: null, peakLagMs: null });
  });

  it('DB pool wait is the larger of the grant-wait p95 and the oldest waiter', () => {
    const h = harness();
    h.setPool(pool({ grantWaitP95Ms: 80, oldestWaitMs: 20 }));
    expect(h.sampler.sample()).toMatchObject({ dbWaitMs: 80, oldestDbWaitMs: 20 });
    h.setPool(pool({ grantWaitP95Ms: 10, oldestWaitMs: 900 }));
    expect(h.sampler.sample()).toMatchObject({ dbWaitMs: 900, oldestDbWaitMs: 900 });
  });

  it('reports the time since the DB timeout counter last moved (timeouts before the first sample do not count)', () => {
    const h = harness();
    h.setPool(pool({ dbTimeoutsTotal: 5 }));
    expect(h.sampler.sample().msSinceLastDbTimeout).toBeNull();
    h.advance(1_000);
    h.setPool(pool({ dbTimeoutsTotal: 7 }));
    expect(h.sampler.sample().msSinceLastDbTimeout).toBe(0);
    h.advance(4_000);
    expect(h.sampler.sample().msSinceLastDbTimeout).toBe(4_000);
  });

  it('reports ELU over the interval since the previous sample', () => {
    expect(harness().sampler.sample().eluRatio).toBe(0.75);
  });
});
