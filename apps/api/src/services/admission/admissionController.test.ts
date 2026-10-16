import { describe, expect, it } from 'vitest';
import type { AdmissionSignals } from './admissionSignals';
import { ADMISSION_DEFAULTS } from './admissionConfig';
import { AdmissionController, levelFor } from './admissionController';

const quiet: AdmissionSignals = {
  lagMs: 20, peakLagMs: 25, dbWaitMs: 2, oldestDbWaitMs: 0, msSinceLastDbTimeout: null, eluRatio: 0.3,
  pool: { available: true, inUse: 1, waiting: 0, effectivePermits: 30, oldestWaitMs: 0, grantWaitP95Ms: 2, dbTimeoutsTotal: 0 },
};
const sig = (over: Partial<AdmissionSignals>): AdmissionSignals => ({ ...quiet, ...over });

function run(controller: AdmissionController, signals: AdmissionSignals[], startMs = 0, stepMs = 1_000) {
  let nowMs = startMs;
  return signals.map((s) => { nowMs += stepMs; return controller.step(s, nowMs); });
}

describe('levelFor', () => {
  it('maps a value onto 0..3 and treats null as 0', () => {
    expect([10, 100, 249, 250, 600, 5_000, null].map((v) => levelFor(v, [100, 250, 600]))).toEqual([0, 1, 1, 2, 3, 3, 0]);
    expect(levelFor(60, [100, 250, 600], 0.6)).toBe(1);
  });
});

describe('AdmissionController', () => {
  const make = () => new AdmissionController(ADMISSION_DEFAULTS);

  it('stays at 0 under quiet signals', () => {
    const c = make();
    run(c, Array(30).fill(quiet));
    expect(c.level).toBe(0);
  });

  it('a single spike does not escalate (Review Focus 2)', () => {
    const c = make();
    run(c, [quiet, sig({ lagMs: 400, dbWaitMs: 300 }), quiet, quiet]);
    expect(c.level).toBe(0);
  });

  it('escalates after two consecutive elevated ticks, to the lower of the two targets', () => {
    const c = make();
    const steps = run(c, [sig({ lagMs: 300 }), sig({ lagMs: 700 })]);
    expect(steps[1]).toMatchObject({ previous: 0, level: 2, changed: true, trigger: 'lag' });
    run(c, [sig({ lagMs: 700 }), sig({ lagMs: 700 })]);
    expect(c.level).toBe(3);
  });

  it('DB pool wait alone drives the level, and wins a tie with lag', () => {
    const c = make();
    const steps = run(c, [sig({ lagMs: 120, dbWaitMs: 90 }), sig({ lagMs: 120, dbWaitMs: 90 })]);
    expect(steps[1]).toMatchObject({ level: 1, trigger: 'db' });
  });

  it('jumps straight to 3 on an emergency stall or an emergency DB wait', () => {
    const a = make();
    expect(a.step(sig({ peakLagMs: 1_500 }), 1_000)).toMatchObject({ level: 3, changed: true, trigger: 'emergency' });
    const b = make();
    expect(b.step(sig({ oldestDbWaitMs: 1_000 }), 1_000)).toMatchObject({ level: 3, trigger: 'emergency' });
  });

  it('ignores lag when it is unknown (monitor off) and still reacts to the DB signal', () => {
    const c = make();
    run(c, [sig({ lagMs: null, peakLagMs: null, dbWaitMs: 250 }), sig({ lagMs: null, peakLagMs: null, dbWaitMs: 250 })]);
    expect(c.level).toBe(2);
  });

  it('steps down one level per 15 s continuously below 60 % of the current thresholds', () => {
    const c = make();
    run(c, [sig({ lagMs: 700 }), sig({ lagMs: 700 })]);            // -> 3 at t=2s
    run(c, Array(14).fill(quiet), 2_000);                          // t=3..16s: below since t=3s
    expect(c.level).toBe(3);
    run(c, Array(4).fill(quiet), 16_000);                          // t=17..20s: 15 s reached at t=18s
    expect(c.level).toBe(2);
    run(c, Array(30).fill(quiet), 20_000);
    expect(c.level).toBe(0);
    expect(c.trigger).toBe('none');
  });

  it('a signal between the exit and enter thresholds holds the level (hysteresis)', () => {
    const c = make();
    run(c, [sig({ lagMs: 300 }), sig({ lagMs: 300 })]);            // -> 2
    run(c, Array(60).fill(sig({ lagMs: 160 })), 2_000);             // 160 >= 0.6 * 250: not "below"
    expect(c.level).toBe(2);
  });

  it('a recent DB timeout holds level 2 and blocks recovery below it', () => {
    const c = make();
    run(c, [sig({ msSinceLastDbTimeout: 1_000 }), sig({ msSinceLastDbTimeout: 2_000 })]);
    expect(c.level).toBe(2);
    run(c, Array(25).fill(sig({ msSinceLastDbTimeout: 10_000 })), 2_000);
    expect(c.level).toBe(2);
    run(c, Array(40).fill(sig({ msSinceLastDbTimeout: 40_000 })), 27_000);
    expect(c.level).toBe(0);
  });
});
