import { describe, expect, it } from 'vitest';
import type { AdmissionSignals } from './admissionSignals';
import { ADMISSION_DEFAULTS, type AdmissionConfig } from './admissionConfig';
import { AdmissionController, levelFor } from './admissionController';

const quiet: AdmissionSignals = {
  lagMs: 20, lagFresh: true, peakLagMs: 25, dbWaitMs: 2, oldestDbWaitMs: 0, msSinceLastDbTimeout: null, eluRatio: 0.3,
  pool: { available: true, inUse: 1, waiting: 0, effectivePermits: 30, oldestWaitMs: 0, grantWaitP95Ms: 2, dbTimeoutsTotal: 0 },
};
const sig = (over: Partial<AdmissionSignals>): AdmissionSignals => ({ ...quiet, ...over });

/** The pre-#9353 controller: level-1 at 100 ms lag / 75 ms DB wait, a 2-tick rise gate, a 15 s level-1 hold. */
const PRE_9353: AdmissionConfig = {
  ...ADMISSION_DEFAULTS, lagMs: [100, 250, 600], dbWaitMs: [75, 200, 600], riseTicks: 2, level1HoldMs: 15_000,
};

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
  const make = (over: Partial<AdmissionConfig> = {}) => new AdmissionController({ ...ADMISSION_DEFAULTS, ...over });

  it('stays at 0 under quiet signals', () => {
    const c = make();
    run(c, Array(30).fill(quiet));
    expect(c.level).toBe(0);
  });

  it('a single spike does not escalate, and the gate reports the rise it suppressed (#9353)', () => {
    const c = make();
    const steps = run(c, [quiet, sig({ lagMs: 400, dbWaitMs: 300 }), quiet, quiet]);
    expect(c.level).toBe(0);
    expect(steps.map((s) => s.suppressed)).toEqual([null, null, { level: 2, trigger: 'db', ticks: 1 }, null]);
  });

  it('two consecutive elevated ticks no longer escalate under the default 3-tick gate (#9353)', () => {
    const c = make();
    const steps = run(c, [sig({ lagMs: 300 }), sig({ lagMs: 300 }), quiet]);
    expect(steps.every((s) => s.level === 0)).toBe(true);
    expect(steps[2]!.suppressed).toEqual({ level: 2, trigger: 'lag', ticks: 2 });
  });

  it('escalates after riseTicks consecutive elevated ticks, to the lowest target in the streak', () => {
    const c = make();
    const steps = run(c, [sig({ lagMs: 300 }), sig({ lagMs: 700 }), sig({ lagMs: 700 })]);
    expect(steps[1]).toMatchObject({ level: 0, changed: false });
    expect(steps[2]).toMatchObject({ previous: 0, level: 2, changed: true, trigger: 'lag', suppressed: null });
    run(c, [sig({ lagMs: 700 }), sig({ lagMs: 700 }), sig({ lagMs: 700 })], 3_000);
    expect(c.level).toBe(3);
  });

  it('riseTicks is configurable: 1 rises on the first elevated tick', () => {
    const c = make({ riseTicks: 1 });
    expect(c.step(sig({ lagMs: 220 }), 1_000)).toMatchObject({ level: 1, changed: true });
  });

  it('the raised level-1 thresholds ignore sustained readings that used to enter level 1 (#9353)', () => {
    const lag = make();
    run(lag, Array(20).fill(sig({ lagMs: 150 })));
    expect(lag.level).toBe(0);
    const db = make();
    run(db, Array(20).fill(sig({ dbWaitMs: 110 })));
    expect(db.level).toBe(0);
  });

  it('DB pool wait alone drives the level, and wins a tie with lag', () => {
    const c = make();
    const steps = run(c, Array(3).fill(sig({ lagMs: 210, dbWaitMs: 160 })));
    expect(steps[2]).toMatchObject({ level: 1, trigger: 'db' });
  });

  it('jumps straight to 3 on an emergency stall or an emergency DB wait, mid-streak included', () => {
    const a = make();
    expect(a.step(sig({ peakLagMs: 1_500 }), 1_000)).toMatchObject({ level: 3, changed: true, trigger: 'emergency' });
    const b = make();
    expect(b.step(sig({ oldestDbWaitMs: 1_000 }), 1_000)).toMatchObject({ level: 3, trigger: 'emergency' });
    const c = make();
    run(c, [sig({ lagMs: 300 })]);
    expect(c.step(sig({ peakLagMs: 1_200 }), 2_000)).toMatchObject({ level: 3, trigger: 'emergency', suppressed: null });
  });

  it('ignores lag when it is unknown (monitor off) and still reacts to the DB signal', () => {
    const c = make();
    run(c, Array(3).fill(sig({ lagMs: null, lagFresh: false, peakLagMs: null, dbWaitMs: 250 })));
    expect(c.level).toBe(2);
  });

  describe('stale lag readings (no new monitor sample this tick)', () => {
    it('neither advance nor reset the streak, so a 2-sample blip cannot reach 3 ticks (#9353)', () => {
      const c = make();
      const steps = run(c, [
        sig({ lagMs: 300 }), sig({ lagMs: 300, lagFresh: false }), sig({ lagMs: 300 }), quiet,
      ]);
      expect(steps.every((s) => s.level === 0)).toBe(true);
      expect(steps[3]!.suppressed).toEqual({ level: 2, trigger: 'lag', ticks: 2 });
    });

    it('do not break a sustained streak', () => {
      const c = make();
      const steps = run(c, [
        sig({ lagMs: 300 }), sig({ lagMs: 300, lagFresh: false }), sig({ lagMs: 300 }), sig({ lagMs: 300 }),
      ]);
      expect(steps[3]).toMatchObject({ previous: 0, level: 2, changed: true, trigger: 'lag' });
    });

    it('leave fresh DB evidence counting on its own', () => {
      const c = make();
      const steps = run(c, Array(3).fill(sig({ lagMs: 700, lagFresh: false, dbWaitMs: 160 })));
      expect(steps[2]).toMatchObject({ level: 1, trigger: 'db' });
    });
  });

  it('levels 2 and 3 step down after 15 s continuously below 60 % of their thresholds; level 1 after level1HoldMs', () => {
    const c = make();
    run(c, Array(3).fill(sig({ lagMs: 700 })));                    // -> 3 at t=3s
    run(c, Array(15).fill(quiet), 3_000);                          // t=4..18s: below since t=4s
    expect(c.level).toBe(3);
    run(c, [quiet], 18_000);                                       // t=19s: 15 s reached
    expect(c.level).toBe(2);
    run(c, Array(15).fill(quiet), 19_000);                         // t=20..34s: 2 -> 1 at t=34s
    expect(c.level).toBe(1);
    run(c, Array(4).fill(quiet), 34_000);                          // t=35..38s: inside the 5 s level-1 hold
    expect(c.level).toBe(1);
    run(c, [quiet], 38_000);                                       // t=39s: 5 s reached
    expect(c.level).toBe(0);
    expect(c.trigger).toBe('none');
  });

  it('a transient level 1 costs seconds, not the 15 s it used to (#9353)', () => {
    const now = make();
    run(now, Array(3).fill(sig({ lagMs: 220 })));                  // -> 1 at t=3s
    const nowSteps = run(now, Array(6).fill(quiet), 3_000);        // below since t=4s
    expect(nowSteps.findIndex((s) => s.level === 0)).toBe(5);      // back to 0 at t=9s
    const before = new AdmissionController(PRE_9353);
    run(before, Array(2).fill(sig({ lagMs: 120 })));                // -> 1 at t=2s
    const beforeSteps = run(before, Array(20).fill(quiet), 2_000); // below since t=3s
    expect(beforeSteps.findIndex((s) => s.level === 0)).toBe(15);  // back to 0 at t=18s
  });

  it('a signal between the exit and enter thresholds holds the level (hysteresis)', () => {
    const c = make();
    run(c, Array(3).fill(sig({ lagMs: 300 })));                    // -> 2
    run(c, Array(60).fill(sig({ lagMs: 160 })), 3_000);             // 160 >= 0.6 * 250: not "below"
    expect(c.level).toBe(2);
    const one = make();
    run(one, Array(3).fill(sig({ lagMs: 220 })));                  // -> 1
    run(one, Array(60).fill(sig({ lagMs: 130 })), 3_000);           // 130 >= 0.6 * 200
    expect(one.level).toBe(1);
  });

  it('a recent DB timeout holds level 2 and blocks recovery below it', () => {
    const c = make();
    run(c, [1_000, 2_000, 3_000].map((ms) => sig({ msSinceLastDbTimeout: ms })));
    expect(c.level).toBe(2);
    run(c, Array(25).fill(sig({ msSinceLastDbTimeout: 10_000 })), 3_000);
    expect(c.level).toBe(2);
    run(c, Array(40).fill(sig({ msSinceLastDbTimeout: 40_000 })), 28_000);
    expect(c.level).toBe(0);
  });

  it('the pre-#9353 configuration still reproduces the reported blip behaviour', () => {
    // The issue's EU log: "level 0 -> 2 (trigger=lag, lag=251ms, ...)" from a two-sample median blip.
    const blip = [sig({ lagMs: 251 }), sig({ lagMs: 251 }), quiet];
    const before = new AdmissionController(PRE_9353);
    expect(run(before, blip)[1]).toMatchObject({ previous: 0, level: 2, changed: true, trigger: 'lag' });
    const now = make();
    expect(run(now, blip).map((s) => s.level)).toEqual([0, 0, 0]);
  });

  describe('rise gate state machine (#9353)', () => {
    it('a rise from level 1 to 2 needs its own streak; a target equal to the current level starts none', () => {
      const c = make();
      run(c, Array(3).fill(sig({ lagMs: 220 })));                  // -> 1 at t=3s
      const same = run(c, Array(5).fill(sig({ lagMs: 220 })), 3_000);
      expect(same.every((s) => s.level === 1 && s.suppressed === null)).toBe(true);
      const up = run(c, Array(3).fill(sig({ lagMs: 300 })), 8_000);
      expect(up.map((s) => s.level)).toEqual([1, 1, 2]);
      expect(up[2]).toMatchObject({ previous: 1, changed: true, trigger: 'lag' });
    });

    it('at level 1, a stale lag median plus level-1 DB evidence holds a level-2 streak', () => {
      const c = make();
      run(c, Array(3).fill(sig({ lagMs: 220 })));                  // -> 1
      const steps = run(c, [
        sig({ lagMs: 300 }), sig({ lagMs: 300, lagFresh: false, dbWaitMs: 160 }), sig({ lagMs: 300 }), quiet,
      ], 3_000);
      expect(steps.every((s) => s.level === 1)).toBe(true);
      expect(steps[3]!.suppressed).toEqual({ level: 2, trigger: 'lag', ticks: 2 });
    });

    it('enters the lowest level in a mixed streak, with that tick\'s trigger', () => {
      const dbFirst = run(make(), [sig({ dbWaitMs: 210 }), sig({ lagMs: 700 }), sig({ lagMs: 700 })]);
      expect(dbFirst[2]).toMatchObject({ level: 2, trigger: 'db' });
      const dbMiddle = run(make(), [sig({ lagMs: 700 }), sig({ dbWaitMs: 210 }), sig({ lagMs: 700 })]);
      expect(dbMiddle[2]).toMatchObject({ level: 2, trigger: 'db' });
      const tie = run(make(), [sig({ dbWaitMs: 210 }), sig({ lagMs: 300 }), sig({ lagMs: 300 })]);
      expect(tie[2]).toMatchObject({ level: 2, trigger: 'db' });   // equal levels keep the first trigger
      const broken = run(make(), [sig({ lagMs: 700 }), sig({ dbWaitMs: 210 }), quiet]);
      expect(broken[2]!.suppressed).toEqual({ level: 2, trigger: 'db', ticks: 2 });
    });

    it('an emergency clears an unfinished streak: nothing is reported as suppressed afterwards', () => {
      const c = make();
      run(c, [sig({ lagMs: 300 }), sig({ lagMs: 300 })]);
      expect(c.step(sig({ peakLagMs: 1_500 }), 3_000)).toMatchObject({ level: 3, suppressed: null });
      expect(c.step(quiet, 4_000).suppressed).toBeNull();
    });

    it('a stale-only elevated tick with no streak behind it is not reported as suppressed', () => {
      const steps = run(make(), [sig({ lagMs: 300, lagFresh: false }), quiet]);
      expect(steps.map((s) => [s.level, s.suppressed])).toEqual([[0, null], [0, null]]);
    });

    it('honours a non-default level1HoldMs', () => {
      const c = make({ level1HoldMs: 1_000 });
      run(c, Array(3).fill(sig({ lagMs: 220 })));                  // -> 1 at t=3s
      expect(run(c, [quiet, quiet], 3_000).map((s) => s.level)).toEqual([1, 0]); // below since t=4s, 0 at t=5s
    });
  });
});
