import { beforeEach, describe, expect, it } from 'vitest';
import { createInFlightGate } from './inFlight';
import { renderMetrics, resetMetrics } from './metrics';

describe('per-instance in-flight gate', () => {
  beforeEach(() => resetMetrics());

  it('refuses sync beyond the sync cap while interactive still has headroom', () => {
    const gate = createInFlightGate({ syncMaxInFlight: 2, maxInFlight: 4 });
    const first = gate.acquire('sync');
    const second = gate.acquire('sync');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(gate.acquire('sync')).toBeNull();          // sync cap reached…
    expect(gate.acquire('interactive')).not.toBeNull(); // …but an AI tool call still gets in
    expect(gate.snapshot()).toEqual({ sync: 2, total: 3 });
  });

  it('refuses everything past the total cap', () => {
    const gate = createInFlightGate({ syncMaxInFlight: 2, maxInFlight: 2 });
    gate.acquire('interactive');
    gate.acquire('interactive');
    expect(gate.acquire('interactive')).toBeNull();
    expect(gate.acquire('sync')).toBeNull();
  });

  it('releases exactly once, however many times release is called', () => {
    const gate = createInFlightGate({ syncMaxInFlight: 1, maxInFlight: 1 });
    const lease = gate.acquire('sync')!;
    lease.release();
    lease.release();
    expect(gate.snapshot()).toEqual({ sync: 0, total: 0 });
    expect(gate.acquire('sync')).not.toBeNull();
  });

  it('publishes the gauges and the rejection counter', () => {
    const gate = createInFlightGate({ syncMaxInFlight: 1, maxInFlight: 2 });
    gate.acquire('sync');
    gate.acquire('sync');
    const text = renderMetrics();
    expect(text).toContain('m365_sync_in_flight 1');
    expect(text).toContain('m365_in_flight_total 1');
    expect(text).toContain('m365_sync_capacity_rejected_total{kind="sync"} 1');
  });
});
