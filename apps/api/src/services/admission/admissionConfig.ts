/**
 * W08 admission-control configuration (spec W1c, #8147).
 *
 * Operator knobs come from env. Every consumer treats '' as unset because
 * compose passes `${VAR:-}`. An invalid value never refuses boot: it falls
 * back to the default with a warning that names the variable — an admission
 * controller that crashed the API on a typo would be its own outage.
 *
 * The controller constants below are deliberately NOT env knobs: they shape
 * stability (tick, hysteresis), and exposing them invites oscillating configs.
 * The two exceptions, riseTicks and level1HoldMs (#9353), have hard bounds
 * (see their *_BOUNDS constants). A level always needs at least one elevated
 * tick to rise and one tick to drop, so no accepted value can make it switch
 * on and off within a single tick.
 *
 * Why the level-1 defaults moved (#9353). In production observe mode at idle
 * (7 and ~90 agents), single sub-second blips crossed the old level-1 entry
 * (lag 100 ms, DB wait 75 ms). A pool acquire against a managed database pays
 * a network round trip plus the provider's occasional stalls. A lone GC or
 * sync-crypto pause moves the lag median when it lands in two adjacent monitor
 * samples. The averages were 24-27 ms lag and <= 0.2 ms DB wait, yet the level
 * rose about every 70 s and counted hundreds of bulk would_shed per hour.
 * Level 1 now starts at 200 ms lag / 150 ms DB wait: twice the old entry, and
 * the highest round values that still leave a level-1 band below the unchanged
 * level-2 entry (250 / 200). Thresholds must be strictly increasing, so
 * 250 / 200 for level 1 would be rejected, and would make level 1 unreachable
 * anyway. The main fix is the sustained-pressure requirement (riseTicks); the
 * higher thresholds mean the gate is not the only defence.
 */
export type AdmissionMode = 'off' | 'observe' | 'enforce';
export type LevelThresholds = readonly [number, number, number];

export interface AdmissionConfig {
  /** off = kill switch; observe = compute and count, never refuse (default); enforce = refuse. */
  mode: AdmissionMode;
  /** Median event-loop lag (ms) that enters level 1 / 2 / 3. */
  lagMs: LevelThresholds;
  /** DB pool wait (ms, from W04's gate) that enters level 1 / 2 / 3. */
  dbWaitMs: LevelThresholds;
  /** Peak lag or oldest DB waiter (ms) that jumps straight to level 3. Never gated by riseTicks. */
  emergencyMs: number;
  /**
   * Consecutive ticks of fresh evidence above a higher level's enter threshold
   * before the level rises (#9353). A tick whose only elevated reading is a lag
   * median with no new monitor sample holds the streak instead of advancing it.
   */
  riseTicks: number;
  /** Time (ms) continuously below 60 % of level 1's thresholds before level 1 drops to 0 (#9353). */
  level1HoldMs: number;
  /** Bulk-class requests admitted concurrently, at every level, in enforce mode. */
  bulkMaxInFlight: number;
  /** Agent WS upgrades per second at level 0 (scaled by ADMISSION_WS_LEVEL_SCALE). */
  wsRatePerSec: number;
  /** Agent WS upgrade bucket capacity at level 0 (scaled likewise). */
  wsBurst: number;
  /** Agent WS upgrades between admission and the end of onOpen, at once. */
  wsMaxSetups: number;
}

export const ADMISSION_DEFAULTS: AdmissionConfig = Object.freeze({
  mode: 'observe',
  lagMs: [200, 250, 600] as const,
  dbWaitMs: [150, 200, 600] as const,
  emergencyMs: 1_000,
  riseTicks: 3,
  level1HoldMs: 5_000,
  bulkMaxInFlight: 15,
  wsRatePerSec: 10,
  wsBurst: 20,
  wsMaxSetups: 8,
}) as AdmissionConfig;

export const ADMISSION_TICK_MS = 1_000;
/**
 * riseTicks bounds. 1 restores "rise on the first elevated tick" for lab runs.
 * 10 caps how long a sustained overload can run before shedding starts (the
 * emergency path still fires at once).
 *
 * Default 3 (#9353). The old 2-tick gate let a single blip through because each
 * signal is smoothed over more than one tick: lag is the median of three 1 s
 * monitor samples, and the DB grant-wait p95 used a 3 s window (now 1.5 ticks,
 * POOL_WAIT_STATS_WINDOW_MS). Three fresh ticks is about three seconds of
 * continuous pressure.
 */
export const ADMISSION_RISE_TICKS_BOUNDS = [1, 10] as const;
/** Recovery dwell for levels 2 and 3; level 1 uses config.level1HoldMs. */
export const ADMISSION_RECOVER_MS = 15_000;
/**
 * level1HoldMs bounds: at least one tick, at most a minute.
 *
 * Default 5 s (#9353), down from the shared 15 s. Level 1 sheds only bulk-class
 * uploads. Almost all of them carry a 120-180 s Retry-After; /logs is the
 * exception at 2-4 s (agentRouteClasses.ts). Shipped agents give up that
 * cycle's attempt, and W09 agents defer the loop for the full Retry-After. The
 * shed inventory load stays away for minutes whatever the level does next.
 * Holding level 1 after the pressure ends protects nothing and only refuses
 * more uploads. Under real pressure the
 * signal stays above the 60 % exit line, so the hold never starts. 5 s is
 * still longer than the 3-tick rise, so a borderline signal cycles
 * 0 -> 1 -> 0 at most about once every 9 s.
 */
export const ADMISSION_LEVEL1_HOLD_BOUNDS_MS = [ADMISSION_TICK_MS, 60_000] as const;
export const ADMISSION_EXIT_RATIO = 0.6;
export const ADMISSION_DB_TIMEOUT_FLOOR_MS = 30_000;
export const ADMISSION_WS_LEVEL_SCALE = [1, 0.5, 0.2, 0.05] as const;

const MODES: readonly AdmissionMode[] = ['off', 'observe', 'enforce'];

function present(raw: string | undefined): string | null {
  const value = raw?.trim() ?? '';
  return value.length > 0 ? value : null;
}

export function resolveAdmissionConfig(env: NodeJS.ProcessEnv = process.env): {
  config: AdmissionConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  const warn = (name: string, raw: string, expected: string) =>
    warnings.push(`${name}=${JSON.stringify(raw)} is invalid (${expected}); using the default`);

  const positive = (name: string, raw: string | undefined, fallback: number, integer: boolean): number => {
    const value = present(raw);
    if (value === null) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
      warn(name, value, integer ? 'a positive integer' : 'a positive number');
      return fallback;
    }
    return parsed;
  };

  const boundedInt = (name: string, raw: string | undefined, fallback: number, [min, max]: readonly [number, number]): number => {
    const value = present(raw);
    if (value === null) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      warn(name, value, `an integer from ${min} to ${max}`);
      return fallback;
    }
    return parsed;
  };

  const triplet = (name: string, raw: string | undefined, fallback: LevelThresholds): LevelThresholds => {
    const value = present(raw);
    if (value === null) return fallback;
    const parts = value.split(',').map((part) => Number(part.trim()));
    const valid = parts.length === 3
      && parts.every((part) => Number.isFinite(part) && part > 0)
      && parts[0]! < parts[1]! && parts[1]! < parts[2]!;
    if (!valid) {
      warn(name, value, 'three increasing positive numbers, e.g. "100,250,600"');
      return fallback;
    }
    return [parts[0]!, parts[1]!, parts[2]!] as const;
  };

  let mode = ADMISSION_DEFAULTS.mode;
  const rawMode = present(env.BREEZE_ADMISSION_MODE);
  if (rawMode !== null) {
    const normalized = rawMode.toLowerCase() as AdmissionMode;
    if (MODES.includes(normalized)) mode = normalized;
    else warn('BREEZE_ADMISSION_MODE', rawMode, 'off | observe | enforce');
  }

  return {
    config: {
      mode,
      lagMs: triplet('BREEZE_ADMISSION_LAG_MS', env.BREEZE_ADMISSION_LAG_MS, ADMISSION_DEFAULTS.lagMs),
      dbWaitMs: triplet('BREEZE_ADMISSION_DB_WAIT_MS', env.BREEZE_ADMISSION_DB_WAIT_MS, ADMISSION_DEFAULTS.dbWaitMs),
      emergencyMs: positive('BREEZE_ADMISSION_EMERGENCY_MS', env.BREEZE_ADMISSION_EMERGENCY_MS, ADMISSION_DEFAULTS.emergencyMs, false),
      riseTicks: boundedInt('BREEZE_ADMISSION_RISE_TICKS', env.BREEZE_ADMISSION_RISE_TICKS, ADMISSION_DEFAULTS.riseTicks, ADMISSION_RISE_TICKS_BOUNDS),
      level1HoldMs: boundedInt(
        'BREEZE_ADMISSION_LEVEL1_HOLD_MS', env.BREEZE_ADMISSION_LEVEL1_HOLD_MS,
        ADMISSION_DEFAULTS.level1HoldMs, ADMISSION_LEVEL1_HOLD_BOUNDS_MS,
      ),
      bulkMaxInFlight: positive('BREEZE_ADMISSION_BULK_MAX_IN_FLIGHT', env.BREEZE_ADMISSION_BULK_MAX_IN_FLIGHT, ADMISSION_DEFAULTS.bulkMaxInFlight, true),
      wsRatePerSec: positive('BREEZE_ADMISSION_WS_RATE_PER_SEC', env.BREEZE_ADMISSION_WS_RATE_PER_SEC, ADMISSION_DEFAULTS.wsRatePerSec, false),
      wsBurst: positive('BREEZE_ADMISSION_WS_BURST', env.BREEZE_ADMISSION_WS_BURST, ADMISSION_DEFAULTS.wsBurst, true),
      wsMaxSetups: positive('BREEZE_ADMISSION_WS_MAX_SETUPS', env.BREEZE_ADMISSION_WS_MAX_SETUPS, ADMISSION_DEFAULTS.wsMaxSetups, true),
    },
    warnings,
  };
}
