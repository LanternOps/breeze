/**
 * W08 admission level state machine (spec W1c). Pure: no timers, no I/O.
 *
 * Levels: 0 normal, 1 shed bulk, 2 shed standard too, 3 critical (WS paced
 * hardest; protected traffic, heartbeats included, is never shed).
 *
 * Escalation (rise gate, #9353): when the target level (max over the lag, DB
 * pool-wait and DB-timeout signals) is above the current one for
 * config.riseTicks consecutive ticks, jump to the LOWEST target seen in that
 * streak (a 2 then a 3 lands on 2). A tick only counts when its evidence is
 * fresh. The lag median is re-read unchanged on a tick that consumed no new
 * monitor sample, so a tick whose only elevated reading is that stale median
 * holds the streak: it neither advances nor resets it. A streak that ends
 * without rising is reported as `suppressed`, so the gate's effect is
 * observable. An emergency (peak lag or oldest DB waiter >= emergencyMs) is
 * never gated: it jumps to 3 on the tick it is seen, because by then the
 * latency is already lost.
 *
 * Recovery: one level down after a dwell continuously below
 * ADMISSION_EXIT_RATIO x the current level's enter thresholds. The dwell is
 * config.level1HoldMs at level 1 and ADMISSION_RECOVER_MS at levels 2 and 3.
 * The dwell restarts after each step. A DB timeout (pool-acquire or prologue)
 * within ADMISSION_DB_TIMEOUT_FLOOR_MS pins the target at 2 or higher at both
 * scales, so it also blocks recovery.
 */
import {
  ADMISSION_EXIT_RATIO,
  ADMISSION_DB_TIMEOUT_FLOOR_MS,
  ADMISSION_RECOVER_MS,
  type AdmissionConfig,
  type LevelThresholds,
} from './admissionConfig';
import type { AdmissionSignals } from './admissionSignals';

export type AdmissionLevel = 0 | 1 | 2 | 3;
export type AdmissionTrigger = 'none' | 'lag' | 'db' | 'db_timeout' | 'emergency';
export type RiseTrigger = Exclude<AdmissionTrigger, 'none' | 'emergency'>;

/** A rise streak that ended before reaching riseTicks: the rise the gate held back. */
export interface SuppressedRise {
  /** Lowest target seen in the streak: the level the controller would have entered. */
  level: AdmissionLevel;
  trigger: RiseTrigger;
  /** Fresh elevated ticks in the streak (1 .. riseTicks - 1). */
  ticks: number;
}

export interface ControllerStep {
  level: AdmissionLevel;
  previous: AdmissionLevel;
  changed: boolean;
  trigger: AdmissionTrigger;
  /** Set on the tick a rise streak broke without rising; null otherwise. */
  suppressed: SuppressedRise | null;
}

export function levelFor(value: number | null, thresholds: LevelThresholds, scale = 1): AdmissionLevel {
  if (value === null) return 0;
  if (value >= thresholds[2] * scale) return 3;
  if (value >= thresholds[1] * scale) return 2;
  if (value >= thresholds[0] * scale) return 1;
  return 0;
}

type ControllerConfig = Pick<AdmissionConfig, 'lagMs' | 'dbWaitMs' | 'emergencyMs' | 'riseTicks' | 'level1HoldMs'>;

interface Target {
  level: AdmissionLevel;
  trigger: AdmissionTrigger;
}

function target(signals: AdmissionSignals, config: ControllerConfig, scale: number, includeLag = true): Target {
  // DB first: pool wait is the direct cause of DB-bound request latency, so ties go to it.
  let level = levelFor(signals.dbWaitMs, config.dbWaitMs, scale);
  let trigger: AdmissionTrigger = level > 0 ? 'db' : 'none';
  const lag = includeLag ? levelFor(signals.lagMs, config.lagMs, scale) : 0;
  if (lag > level) {
    level = lag;
    trigger = 'lag';
  }
  const recentExpiry = signals.msSinceLastDbTimeout !== null
    && signals.msSinceLastDbTimeout < ADMISSION_DB_TIMEOUT_FLOOR_MS;
  if (recentExpiry && level < 2) {
    level = 2;
    trigger = 'db_timeout';
  }
  return { level, trigger };
}

export class AdmissionController {
  private current: AdmissionLevel = 0;
  private lastTrigger: AdmissionTrigger = 'none';
  private riseStreak = 0;
  private streakMin: AdmissionLevel = 3;
  private streakTrigger: RiseTrigger = 'lag';
  private belowSinceMs: number | null = null;

  constructor(private readonly config: ControllerConfig) {}

  get level(): AdmissionLevel {
    return this.current;
  }

  get trigger(): AdmissionTrigger {
    return this.lastTrigger;
  }

  step(signals: AdmissionSignals, nowMs: number): ControllerStep {
    const previous = this.current;

    const emergency = (signals.peakLagMs !== null && signals.peakLagMs >= this.config.emergencyMs)
      || signals.oldestDbWaitMs >= this.config.emergencyMs;
    if (emergency) {
      this.resetStreaks();
      if (this.current < 3) {
        this.current = 3;
        this.lastTrigger = 'emergency';
      }
      return this.result(previous);
    }

    const enter = target(signals, this.config, 1);
    if (enter.level > this.current) {
      this.belowSinceMs = null;
      // A lag median with no new monitor sample behind it is not new evidence.
      const evidence = signals.lagFresh ? enter : target(signals, this.config, 1, false);
      if (evidence.level <= this.current) return this.result(previous); // hold the streak
      this.riseStreak += 1;
      if (evidence.level < this.streakMin || this.riseStreak === 1) {
        this.streakMin = evidence.level;
        this.streakTrigger = evidence.trigger as RiseTrigger;
      }
      if (this.riseStreak >= this.config.riseTicks) {
        this.current = this.streakMin;
        this.lastTrigger = this.streakTrigger;
        this.clearRiseStreak();
      }
      return this.result(previous);
    }
    const suppressed = this.endRiseStreak();

    const exit = target(signals, this.config, ADMISSION_EXIT_RATIO);
    if (this.current === 0 || exit.level >= this.current) {
      this.belowSinceMs = null;
      return this.result(previous, suppressed);
    }
    if (this.belowSinceMs === null) {
      this.belowSinceMs = nowMs;
      return this.result(previous, suppressed);
    }
    const dwellMs = this.current === 1 ? this.config.level1HoldMs : ADMISSION_RECOVER_MS;
    if (nowMs - this.belowSinceMs >= dwellMs) {
      this.current = (this.current - 1) as AdmissionLevel;
      this.belowSinceMs = this.current > 0 ? nowMs : null;
      if (this.current === 0) this.lastTrigger = 'none';
    }
    return this.result(previous, suppressed);
  }

  /** Fail-open escape hatch: forget all state and return to level 0. */
  reset(): void {
    this.current = 0;
    this.lastTrigger = 'none';
    this.resetStreaks();
  }

  /** Close an unfinished rise streak, returning what it would have risen to (null if there was none). */
  private endRiseStreak(): SuppressedRise | null {
    const suppressed = this.riseStreak > 0
      ? { level: this.streakMin, trigger: this.streakTrigger, ticks: this.riseStreak }
      : null;
    this.clearRiseStreak();
    return suppressed;
  }

  private clearRiseStreak(): void {
    this.riseStreak = 0;
    this.streakMin = 3;
    this.streakTrigger = 'lag';
  }

  private resetStreaks(): void {
    this.clearRiseStreak();
    this.belowSinceMs = null;
  }

  private result(previous: AdmissionLevel, suppressed: SuppressedRise | null = null): ControllerStep {
    return { level: this.current, previous, changed: this.current !== previous, trigger: this.lastTrigger, suppressed };
  }
}
