/**
 * W08 admission level state machine (spec W1c). Pure: no timers, no I/O.
 *
 * Levels: 0 normal, 1 shed bulk, 2 shed standard too, 3 critical (WS paced
 * hardest; protected traffic, heartbeats included, is never shed).
 *
 * Escalation: when the target level (max over the lag, DB pool-wait and
 * DB-timeout signals) is above the current one for ADMISSION_ESCALATE_TICKS
 * consecutive ticks, jump to the LOWEST target seen in that streak — a 2 then
 * a 3 lands on 2. An emergency (peak lag or oldest DB waiter >= emergencyMs)
 * jumps to 3 on the tick it is seen: by then latency is already lost.
 *
 * Recovery: one level down after ADMISSION_RECOVER_MS continuously below
 * ADMISSION_EXIT_RATIO x the current level's enter thresholds; the streak
 * restarts after each step. A DB timeout (pool-acquire or prologue) within ADMISSION_DB_TIMEOUT_FLOOR_MS
 * pins the target at 2 or higher at both scales, so it also blocks recovery.
 */
import {
  ADMISSION_ESCALATE_TICKS,
  ADMISSION_EXIT_RATIO,
  ADMISSION_DB_TIMEOUT_FLOOR_MS,
  ADMISSION_RECOVER_MS,
  type AdmissionConfig,
  type LevelThresholds,
} from './admissionConfig';
import type { AdmissionSignals } from './admissionSignals';

export type AdmissionLevel = 0 | 1 | 2 | 3;
export type AdmissionTrigger = 'none' | 'lag' | 'db' | 'db_timeout' | 'emergency';

export interface ControllerStep {
  level: AdmissionLevel;
  previous: AdmissionLevel;
  changed: boolean;
  trigger: AdmissionTrigger;
}

export function levelFor(value: number | null, thresholds: LevelThresholds, scale = 1): AdmissionLevel {
  if (value === null) return 0;
  if (value >= thresholds[2] * scale) return 3;
  if (value >= thresholds[1] * scale) return 2;
  if (value >= thresholds[0] * scale) return 1;
  return 0;
}

type ControllerConfig = Pick<AdmissionConfig, 'lagMs' | 'dbWaitMs' | 'emergencyMs'>;

function target(signals: AdmissionSignals, config: ControllerConfig, scale: number): { level: AdmissionLevel; trigger: AdmissionTrigger } {
  // DB first: pool wait is the direct cause of DB-bound request latency, so ties go to it.
  let level = levelFor(signals.dbWaitMs, config.dbWaitMs, scale);
  let trigger: AdmissionTrigger = level > 0 ? 'db' : 'none';
  const lag = levelFor(signals.lagMs, config.lagMs, scale);
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
  private escalateStreak = 0;
  private streakMin: AdmissionLevel = 3;
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
      this.escalateStreak += 1;
      this.streakMin = Math.min(this.streakMin, enter.level) as AdmissionLevel;
      if (this.escalateStreak >= ADMISSION_ESCALATE_TICKS) {
        this.current = this.streakMin;
        this.lastTrigger = enter.trigger;
        this.escalateStreak = 0;
        this.streakMin = 3;
      }
      return this.result(previous);
    }
    this.escalateStreak = 0;
    this.streakMin = 3;

    const exit = target(signals, this.config, ADMISSION_EXIT_RATIO);
    if (this.current === 0 || exit.level >= this.current) {
      this.belowSinceMs = null;
      return this.result(previous);
    }
    if (this.belowSinceMs === null) {
      this.belowSinceMs = nowMs;
      return this.result(previous);
    }
    if (nowMs - this.belowSinceMs >= ADMISSION_RECOVER_MS) {
      this.current = (this.current - 1) as AdmissionLevel;
      this.belowSinceMs = this.current > 0 ? nowMs : null;
      if (this.current === 0) this.lastTrigger = 'none';
    }
    return this.result(previous);
  }

  /** Fail-open escape hatch: forget all state and return to level 0. */
  reset(): void {
    this.current = 0;
    this.lastTrigger = 'none';
    this.resetStreaks();
  }

  private resetStreaks(): void {
    this.escalateStreak = 0;
    this.streakMin = 3;
    this.belowSinceMs = null;
  }

  private result(previous: AdmissionLevel): ControllerStep {
    return { level: this.current, previous, changed: this.current !== previous, trigger: this.lastTrigger };
  }
}
