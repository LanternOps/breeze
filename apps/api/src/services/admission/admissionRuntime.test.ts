import { afterEach, describe, expect, it } from 'vitest';
import { metricsRegistry } from '../metricsRegistry';
import { ADMISSION_DEFAULTS, type AdmissionConfig } from './admissionConfig';
import type { AdmissionSignals } from './admissionSignals';
import {
  AdmissionRuntime,
  __setAdmissionRuntimeForTests,
  shouldDeferOfflineTransition,
} from './admissionRuntime';
import { classifyAgentRequest } from './agentRouteClasses';

const AGENT = 'a'.repeat(64);
const SOFTWARE = classifyAgentRequest('PUT', `/api/v1/agents/${AGENT}/software`)!;
const STATUS = classifyAgentRequest('PUT', `/api/v1/agents/${AGENT}/security/status`)!;
const HEARTBEAT = classifyAgentRequest('POST', `/api/v1/agents/${AGENT}/heartbeat`)!;
const EVENTLOGS = classifyAgentRequest('PUT', `/api/v1/agents/${AGENT}/eventlogs`)!;
const LOGS = classifyAgentRequest('POST', `/api/v1/agents/${AGENT}/logs`)!;
const WS = classifyAgentRequest('GET', `/api/v1/agent-ws/${AGENT}/ws`)!;

const quiet: AdmissionSignals = {
  lagMs: 20, peakLagMs: 25, dbWaitMs: 2, oldestDbWaitMs: 0, msSinceLastDbTimeout: null, eluRatio: 0.3,
  pool: { available: true, inUse: 1, waiting: 0, effectivePermits: 30, oldestWaitMs: 0, grantWaitP95Ms: 2, dbTimeoutsTotal: 0 },
};

function make(over: Partial<AdmissionConfig> = {}, random: () => number = () => 0) {
  let signals = quiet;
  let nowMs = 0;
  const lines: string[] = [];
  const rt = new AdmissionRuntime({ ...ADMISSION_DEFAULTS, mode: 'enforce', ...over }, {
    sampler: { sample: () => signals },
    now: () => nowMs,
    random,
    log: (line) => lines.push(line),
  });
  const raiseTo = (level: 1 | 2 | 3) => {
    signals = { ...quiet, lagMs: [0, 150, 300, 700][level]! };
    nowMs += 1_000; rt.tick();
    nowMs += 1_000; rt.tick();
    expect(rt.level).toBe(level);
  };
  return { rt, lines, raiseTo, advance: (ms: number) => { nowMs += ms; } };
}

async function count(name: string, labels: Record<string, string>): Promise<number> {
  const metric = metricsRegistry.getSingleMetric(name);
  if (!metric) return 0;
  const { values } = await metric.get();
  return values
    .filter((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))
    .reduce((sum, v) => sum + v.value, 0);
}

afterEach(() => __setAdmissionRuntimeForTests(null));

describe('AdmissionRuntime.decide (enforce)', () => {
  it('admits bulk at level 0 up to the in-flight cap, then refuses with a bulk Retry-After', () => {
    const { rt } = make({ bulkMaxInFlight: 2 });
    const a = rt.decide(SOFTWARE);
    const b = rt.decide(SOFTWARE);
    expect(a).toMatchObject({ action: 'admit' });
    expect(b).toMatchObject({ action: 'admit' });
    expect(rt.decide(SOFTWARE)).toEqual({ action: 'shed', reason: 'bulk_in_flight', retryAfterSec: 120 });
    (a as { release: () => void }).release();
    (a as { release: () => void }).release(); // idempotent
    expect(rt.decide(SOFTWARE)).toMatchObject({ action: 'admit' });
  });

  it('level 1 sheds bulk only; heartbeat and eventlogs are never shed, even at level 3', () => {
    const { rt, raiseTo } = make();
    raiseTo(1);
    expect(rt.decide(SOFTWARE)).toMatchObject({ action: 'shed', reason: 'level', retryAfterSec: 120 });
    expect(rt.decide(STATUS)).toMatchObject({ action: 'admit' });
    raiseTo(2);
    expect(rt.decide(STATUS)).toMatchObject({ action: 'shed', reason: 'level', retryAfterSec: 60 });
    raiseTo(3);
    expect(rt.decide(HEARTBEAT)).toEqual({ action: 'admit' });
    expect(rt.decide(EVENTLOGS)).toEqual({ action: 'admit' });
  });

  it('jitters Retry-After inside the class range and uses the logs override', () => {
    const high = make({}, () => 0.999);
    high.raiseTo(1);
    expect(high.rt.decide(SOFTWARE)).toMatchObject({ retryAfterSec: 180 });
    expect(high.rt.decide(LOGS)).toMatchObject({ retryAfterSec: 4 });
    const low = make();
    low.raiseTo(1);
    expect(low.rt.decide(LOGS)).toMatchObject({ retryAfterSec: 2 });
  });

  it('WS: setup slots cap concurrent upgrades; released slots are reusable', () => {
    const { rt } = make({ wsMaxSetups: 2, wsBurst: 100 });
    const first = rt.decide(WS);
    const second = rt.decide(WS);
    expect(first).toMatchObject({ action: 'admit' });
    expect((first as { wsSlot?: unknown }).wsSlot).toBeDefined();
    expect(rt.decide(WS)).toMatchObject({ action: 'shed', reason: 'ws_setups' });
    (first as { wsSlot: { release(): void } }).wsSlot.release();
    expect(rt.decide(WS)).toMatchObject({ action: 'admit' });
    (second as { wsSlot: { release(): void } }).wsSlot.release();
  });

  it('WS: the bucket refuses past the burst with a Retry-After inside 5..120 s', () => {
    const { rt } = make({ wsBurst: 3, wsMaxSetups: 100 });
    for (let i = 0; i < 3; i += 1) {
      const d = rt.decide(WS);
      expect(d.action).toBe('admit');
      (d as { wsSlot: { release(): void } }).wsSlot.release();
    }
    const refused = rt.decide(WS);
    expect(refused).toMatchObject({ action: 'shed', reason: 'ws_bucket' });
    const ra = (refused as { retryAfterSec: number }).retryAfterSec;
    expect(ra).toBeGreaterThanOrEqual(5);
    expect(ra).toBeLessThanOrEqual(120);
  });

  it('counts sheds per class, route template and reason', async () => {
    const { rt, raiseTo } = make();
    raiseTo(1);
    const before = await count('breeze_admission_decisions_total', { class: 'bulk', route: '/api/v1/agents/:id/software', outcome: 'shed', reason: 'level' });
    rt.decide(SOFTWARE);
    expect(await count('breeze_admission_decisions_total', { class: 'bulk', route: '/api/v1/agents/:id/software', outcome: 'shed', reason: 'level' })).toBe(before + 1);
  });
});

describe('AdmissionRuntime modes', () => {
  it('observe never refuses anything, including an empty WS bucket, and counts would_shed (Review Focus 5)', async () => {
    const { rt, raiseTo } = make({ mode: 'observe', wsBurst: 1, wsMaxSetups: 1 });
    raiseTo(3);
    const before = await count('breeze_admission_decisions_total', { outcome: 'would_shed' });
    for (const req of [SOFTWARE, STATUS, HEARTBEAT, WS, WS, WS]) {
      expect(rt.decide(req).action).toBe('admit');
    }
    expect(await count('breeze_admission_decisions_total', { outcome: 'would_shed' })).toBeGreaterThan(before);
    expect(rt.shouldDeferOfflineTransition()).toBe(false);
  });

  it('off admits everything, consumes no WS slot, and still ticks', () => {
    const { rt, raiseTo } = make({ mode: 'off', wsMaxSetups: 1 });
    raiseTo(2);
    expect(rt.decide(SOFTWARE)).toEqual({ action: 'admit' });
    expect(rt.decide(WS)).toEqual({ action: 'admit' });
    expect(rt.decide(WS)).toEqual({ action: 'admit' });
  });
});

describe('AdmissionRuntime tick and process helpers', () => {
  it('logs each transition with its trigger and the signals behind it', () => {
    const { lines, raiseTo } = make();
    raiseTo(2);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[admission\] level 0 -> 2 \(trigger=lag, mode=enforce, lag=300ms/);
  });

  it('defers offline transitions only when enforcing at level 1+', () => {
    const { rt, raiseTo } = make();
    __setAdmissionRuntimeForTests(rt);
    expect(shouldDeferOfflineTransition()).toBe(false);
    raiseTo(1);
    expect(shouldDeferOfflineTransition()).toBe(true);
    __setAdmissionRuntimeForTests(null);
    expect(shouldDeferOfflineTransition()).toBe(false);
  });
});
