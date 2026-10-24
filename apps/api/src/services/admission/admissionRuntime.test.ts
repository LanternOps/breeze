import { afterEach, describe, expect, it, vi } from 'vitest';
import { metricsRegistry } from '../metricsRegistry';
import { ADMISSION_DEFAULTS, type AdmissionConfig } from './admissionConfig';
import { createSignalSampler, type AdmissionSignals } from './admissionSignals';
import { createPoolAdmission } from '../../db/poolAdmission';
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
  lagMs: 20, lagFresh: true, peakLagMs: 25, dbWaitMs: 2, oldestDbWaitMs: 0, msSinceLastDbTimeout: null, eluRatio: 0.3,
  pool: { available: true, inUse: 1, waiting: 0, effectivePermits: 30, oldestWaitMs: 0, grantWaitP95Ms: 2, dbTimeoutsTotal: 0 },
};

function make(over: Partial<AdmissionConfig> = {}, random: () => number = () => 0) {
  let signals = quiet;
  let nowMs = 0;
  let broken = false;
  const lines: string[] = [];
  const rt = new AdmissionRuntime({ ...ADMISSION_DEFAULTS, mode: 'enforce', ...over }, {
    sampler: {
      sample: () => {
        if (broken) throw new Error('sampler boom');
        return signals;
      },
    },
    now: () => nowMs,
    random,
    log: (line) => lines.push(line),
  });
  const raiseTo = (level: 1 | 2 | 3) => {
    signals = { ...quiet, lagMs: [0, 220, 300, 700][level]! };
    for (let i = 0; i < rt.config.riseTicks; i += 1) { nowMs += 1_000; rt.tick(); }
    expect(rt.level).toBe(level);
  };
  /** One controller tick, 1 s after the previous one, on the given signals. */
  const tickWith = (over: Partial<AdmissionSignals>) => {
    signals = { ...quiet, ...over };
    nowMs += 1_000;
    return rt.tick();
  };
  return {
    rt, lines, raiseTo, tickWith,
    advance: (ms: number) => { nowMs += ms; },
    setBroken: (value: boolean) => { broken = value; },
  };
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

  it('WS: refund() gives the token back once (idempotent) and the slot is untouched', () => {
    const { rt } = make({ wsBurst: 2, wsMaxSetups: 100 });
    const a = rt.decide(WS) as { refund: () => void; wsSlot: { release(): void } };
    const b = rt.decide(WS) as { refund: () => void; wsSlot: { release(): void } };
    expect(rt.decide(WS)).toMatchObject({ action: 'shed', reason: 'ws_bucket' });
    a.wsSlot.release(); a.refund(); a.refund();      // second refund is a no-op
    expect(rt.decide(WS)).toMatchObject({ action: 'admit' });
    expect(rt.decide(WS)).toMatchObject({ action: 'shed', reason: 'ws_bucket' });
    b.wsSlot.release();
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

  it('shouldDeferOfflineTransition is false in off, and in observe at level 1+', () => {
    for (const mode of ['off', 'observe'] as const) {
      const { rt, raiseTo } = make({ mode });
      raiseTo(1);
      expect(rt.shouldDeferOfflineTransition(), `${mode} level 1`).toBe(false);
      raiseTo(3);
      expect(rt.shouldDeferOfflineTransition(), `${mode} level 3`).toBe(false);
    }
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

describe('AdmissionRuntime tick failures', () => {
  afterEach(() => vi.useRealTimers());

  it('counts failures, throttles the log, fails open to level 0 after 5 in a row, and resets on success', async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rt, lines, raiseTo, setBroken, advance } = make();
    raiseTo(3);
    const before = await count('breeze_admission_tick_failures_total', {});
    const transitionsBefore = lines.length;
    rt.start(1_000);
    setBroken(true);
    vi.advanceTimersByTime(4_000);
    expect(rt.level).toBe(3);                       // 4 consecutive failures: still holding
    expect(errors).toHaveBeenCalledTimes(1);        // first failure logged, rest throttled
    setBroken(false);
    vi.advanceTimersByTime(1_000);                  // a success resets the consecutive count
    setBroken(true);
    vi.advanceTimersByTime(4_000);
    expect(rt.level).toBe(3);
    vi.advanceTimersByTime(1_000);                  // 5th consecutive failure -> fail open
    expect(rt.level).toBe(0);
    expect(rt.decide(SOFTWARE)).toMatchObject({ action: 'admit' });
    expect(lines.slice(transitionsBefore).filter((l) => /failing open/.test(l))).toHaveLength(1);
    vi.advanceTimersByTime(3_000);
    expect(lines.slice(transitionsBefore).filter((l) => /failing open/.test(l))).toHaveLength(1); // logged once
    expect(await count('breeze_admission_tick_failures_total', {})).toBe(before + 12);
    advance(61_000);
    vi.advanceTimersByTime(1_000);
    expect(errors).toHaveBeenCalledTimes(2);        // at most once per 60 s
    rt.stop();
    errors.mockRestore();
  });
});

describe('AdmissionRuntime rise gate and level-1 hold (#9353)', () => {
  const BULK_WOULD_SHED = { class: 'bulk', route: '/api/v1/agents/:id/software', outcome: 'would_shed', reason: 'level' };
  /** The pre-#9353 controller: level-1 at 100 ms lag / 75 ms DB wait, a 2-tick rise gate, a 15 s level-1 hold. */
  const PRE_9353: Partial<AdmissionConfig> = { lagMs: [100, 250, 600], dbWaitMs: [75, 200, 600], riseTicks: 2, level1HoldMs: 15_000 };

  it('(a) one 300 ms lag sample at idle leaves the level at 0 and counts the suppressed rise', async () => {
    const { rt, tickWith } = make({ mode: 'observe' });
    const suppressedBefore = await count('breeze_admission_rise_suppressed_total', { to: '2', trigger: 'lag' });
    const shedBefore = await count('breeze_admission_decisions_total', BULK_WOULD_SHED);
    tickWith({ lagMs: 300 });
    expect(rt.level).toBe(0);
    rt.decide(SOFTWARE);
    tickWith({});
    expect(rt.level).toBe(0);
    expect(await count('breeze_admission_rise_suppressed_total', { to: '2', trigger: 'lag' })).toBe(suppressedBefore + 1);
    expect(await count('breeze_admission_decisions_total', BULK_WOULD_SHED)).toBe(shedBefore);
  });

  it('(b) three consecutive elevated samples raise the level to 1 and nothing is counted as suppressed', async () => {
    const { rt, tickWith } = make({ mode: 'observe' });
    const suppressedBefore = await count('breeze_admission_rise_suppressed_total', {});
    expect(tickWith({ lagMs: 220 }).level).toBe(0);
    expect(tickWith({ lagMs: 220 }).level).toBe(0);
    expect(tickWith({ lagMs: 220 })).toMatchObject({ previous: 0, level: 1, changed: true, trigger: 'lag' });
    expect(await count('breeze_admission_rise_suppressed_total', {})).toBe(suppressedBefore);
    const shedBefore = await count('breeze_admission_decisions_total', BULK_WOULD_SHED);
    expect(rt.decide(SOFTWARE).action).toBe('admit');                 // observe never refuses
    expect(await count('breeze_admission_decisions_total', BULK_WOULD_SHED)).toBe(shedBefore + 1);
  });

  it('(c) the emergency path is still immediate', () => {
    const { rt, tickWith } = make();
    expect(tickWith({ peakLagMs: 1_500 })).toMatchObject({ previous: 0, level: 3, trigger: 'emergency' });
    expect(rt.decide(STATUS)).toMatchObject({ action: 'shed', reason: 'level' });
  });

  it('(d) a level-1 episode decays within the 5 s level-1 hold and bulk is admitted again', () => {
    const { rt, raiseTo, tickWith } = make();
    raiseTo(1);
    expect(rt.decide(SOFTWARE)).toMatchObject({ action: 'shed', reason: 'level' });
    const levels = Array.from({ length: 6 }, () => tickWith({}).level);
    expect(levels).toEqual([1, 1, 1, 1, 1, 0]);                      // first quiet tick starts the hold; 5 s later -> 0
    const admitted = rt.decide(SOFTWARE);
    expect(admitted).toMatchObject({ action: 'admit' });
    (admitted as { release: () => void }).release();
  });

  it('(e) old vs new configuration on the issue trace: the old one sheds bulk for 15 s+, the new one never rises', async () => {
    // Issue #9353's EU shape: a two-sample median-lag blip at 251 ms, then idle.
    const trace: Partial<AdmissionSignals>[] = [{ lagMs: 251 }, { lagMs: 251 }, ...Array(20).fill({})];
    const replay = async (over: Partial<AdmissionConfig>) => {
      const { rt, tickWith } = make({ mode: 'observe', ...over });
      const before = await count('breeze_admission_decisions_total', BULK_WOULD_SHED);
      const levels = trace.map((s) => { const level = tickWith(s).level; rt.decide(SOFTWARE); return level; });
      return { levels, wouldShed: (await count('breeze_admission_decisions_total', BULK_WOULD_SHED)) - before };
    };
    const old = await replay(PRE_9353);
    expect(Math.max(...old.levels)).toBe(2);
    expect(old.wouldShed).toBeGreaterThanOrEqual(16);                // one bulk request per tick at level >= 1
    const now = await replay({});
    expect(now.levels.every((level) => level === 0)).toBe(true);
    expect(now.wouldShed).toBe(0);
  });

  it('a single slow pool grant at idle never raises the level (grant-wait window is 1.5 ticks wide)', async () => {
    // The issue's other shape: "level 0 -> 1 (trigger=db, dbWait=110ms, dbWaiting=0, dbInUse=0)".
    // Real gate + real sampler: one 243 ms grant must not be read on three consecutive ticks.
    let nowMs = 0;
    const gate = createPoolAdmission({ permits: 1, nestedReserve: 0, now: () => nowMs });
    const sampler = createSignalSampler({
      readSamplesSince: () => [],
      readLatest: () => ({ monitored: true, coversWindow: true, sampledMaxLagMs: 0, inFlightLagMs: 0, worstLagMs: 0, sampleCount: 1 }),
      readPool: () => {
        const stats = gate.waitStats();
        const snapshot = gate.snapshot();
        return {
          available: true, inUse: snapshot.inUse, waiting: snapshot.waiting, effectivePermits: 1,
          oldestWaitMs: stats.oldestWaitMs, grantWaitP95Ms: stats.grantWaitP95Ms, dbTimeoutsTotal: 0,
        };
      },
      now: () => nowMs,
    });
    const rt = new AdmissionRuntime({ ...ADMISSION_DEFAULTS, mode: 'enforce' }, { sampler, now: () => nowMs, log: () => {} });
    rt.tick();                                                         // seeds the sampler
    const held = await gate.acquire('a');
    const slow = gate.acquire('b');
    nowMs += 243;
    held.release('resolved');
    (await slow).release('resolved');                                  // granted after 243 ms
    const seen = Array.from({ length: 5 }, () => { nowMs += 1_000; return rt.tick().level; });
    expect(seen).toEqual([0, 0, 0, 0, 0]);
  });
});
