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
  /** Peak lag or oldest DB waiter (ms) that jumps straight to level 3. */
  emergencyMs: number;
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
  lagMs: [100, 250, 600] as const,
  dbWaitMs: [75, 200, 600] as const,
  emergencyMs: 1_000,
  bulkMaxInFlight: 15,
  wsRatePerSec: 10,
  wsBurst: 20,
  wsMaxSetups: 8,
}) as AdmissionConfig;

export const ADMISSION_TICK_MS = 1_000;
export const ADMISSION_ESCALATE_TICKS = 2;
export const ADMISSION_RECOVER_MS = 15_000;
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
      bulkMaxInFlight: positive('BREEZE_ADMISSION_BULK_MAX_IN_FLIGHT', env.BREEZE_ADMISSION_BULK_MAX_IN_FLIGHT, ADMISSION_DEFAULTS.bulkMaxInFlight, true),
      wsRatePerSec: positive('BREEZE_ADMISSION_WS_RATE_PER_SEC', env.BREEZE_ADMISSION_WS_RATE_PER_SEC, ADMISSION_DEFAULTS.wsRatePerSec, false),
      wsBurst: positive('BREEZE_ADMISSION_WS_BURST', env.BREEZE_ADMISSION_WS_BURST, ADMISSION_DEFAULTS.wsBurst, true),
      wsMaxSetups: positive('BREEZE_ADMISSION_WS_MAX_SETUPS', env.BREEZE_ADMISSION_WS_MAX_SETUPS, ADMISSION_DEFAULTS.wsMaxSetups, true),
    },
    warnings,
  };
}
