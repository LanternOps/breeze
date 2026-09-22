import {
  SECURITY_SCAN_TYPES,
  type SecurityScanSettings,
  type SecurityScanType,
} from '../types/securityScan';

export const SECURITY_SCAN_MAX_FILE_SIZE_MB_RANGE = [1, 512] as const;
export const SECURITY_SCAN_TIMEOUT_MINUTES_RANGE = [5, 720] as const;

/** The exact option sets the Security tab renders; anything else is rejected. */
export const SECURITY_SCAN_MINUTE_OPTIONS = ['0', '15', '30', '45'] as const;
export const SECURITY_SCAN_HOUR_OPTIONS = ['0', '2', '6', '12', '18'] as const;
export const SECURITY_SCAN_DAY_OF_MONTH_OPTIONS = ['*', '1', '15'] as const;
export const SECURITY_SCAN_DAY_OF_WEEK_OPTIONS = ['*', '0', '1', '2', '3', '4', '5', '6'] as const;

export const SECURITY_SCAN_SETTINGS_DEFAULTS: SecurityScanSettings = {
  scheduledScans: true,
  scanType: 'quick',
  scanMinute: '0',
  scanHour: '2',
  scanDayOfMonth: '*',
  scanDayOfWeek: '*',
  autoQuarantine: true,
  exclusions: [],
  maxFileSizeMb: 50,
  scanTimeoutMinutes: 120,
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const boolOr = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : fallback;

const clampedIntOr = (v: unknown, [min, max]: readonly [number, number], fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};

const oneOfOr = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : fallback;

/**
 * Total: never throws, never returns an unknown key. A blob written by an older
 * build (or by a tech's hand-edited API call) degrades to the defaults field by
 * field rather than poisoning a scan command.
 */
export function parseSecurityScanSettings(raw: unknown): SecurityScanSettings {
  if (!isRecord(raw)) return { ...SECURITY_SCAN_SETTINGS_DEFAULTS };
  const d = SECURITY_SCAN_SETTINGS_DEFAULTS;

  const exclusions: string[] = [];
  if (Array.isArray(raw.exclusions)) {
    for (const item of raw.exclusions) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (!trimmed || exclusions.includes(trimmed)) continue;
      exclusions.push(trimmed);
    }
  }

  return {
    scheduledScans: boolOr(raw.scheduledScans, d.scheduledScans),
    scanType: oneOfOr<SecurityScanType>(raw.scanType, SECURITY_SCAN_TYPES, d.scanType),
    scanMinute: oneOfOr(raw.scanMinute, SECURITY_SCAN_MINUTE_OPTIONS, d.scanMinute),
    scanHour: oneOfOr(raw.scanHour, SECURITY_SCAN_HOUR_OPTIONS, d.scanHour),
    scanDayOfMonth: oneOfOr(raw.scanDayOfMonth, SECURITY_SCAN_DAY_OF_MONTH_OPTIONS, d.scanDayOfMonth),
    scanDayOfWeek: oneOfOr(raw.scanDayOfWeek, SECURITY_SCAN_DAY_OF_WEEK_OPTIONS, d.scanDayOfWeek),
    autoQuarantine: boolOr(raw.autoQuarantine, d.autoQuarantine),
    exclusions,
    maxFileSizeMb: clampedIntOr(raw.maxFileSizeMb, SECURITY_SCAN_MAX_FILE_SIZE_MB_RANGE, d.maxFileSizeMb),
    scanTimeoutMinutes: clampedIntOr(
      raw.scanTimeoutMinutes, SECURITY_SCAN_TIMEOUT_MINUTES_RANGE, d.scanTimeoutMinutes,
    ),
  };
}

/**
 * Five-field cron for `isCronDue(expr, timeZone, date)`
 * (apps/api/src/services/cronDue.ts:149), which rejects anything that is not
 * exactly five whitespace-separated fields.
 */
export function securityScanCron(settings: SecurityScanSettings): string | null {
  if (!settings.scheduledScans) return null;
  return [
    settings.scanMinute,
    settings.scanHour,
    settings.scanDayOfMonth,
    '*',
    settings.scanDayOfWeek,
  ].join(' ');
}
