/**
 * The single contract for Breeze IOC scan configuration (#6263 W01).
 *
 * Home: Config Policies -> Security tab, stored in
 * `config_policy_feature_links.inline_settings` with `feature_type = 'security'`.
 * There is no other writer and no other reader — the API resolver, the
 * scheduler, the manual scan route and the web tab all go through
 * `parseSecurityScanSettings`.
 *
 * Deliberately NOT here: real-time protection, behavioural monitoring, cloud
 * lookup, USB blocking and user notification. None has an engine behind it
 * (see the W01 plan, DECISION 3); USB belongs to `peripheral_control`.
 */
export const SECURITY_SCAN_TYPES = ['quick', 'full'] as const;
export type SecurityScanType = (typeof SECURITY_SCAN_TYPES)[number];

export interface SecurityScanSettings {
  /** Master switch for the server-driven scheduler. */
  scheduledScans: boolean;
  scanType: SecurityScanType;
  /** Cron fields, restricted to the values the Security tab offers. */
  scanMinute: string;
  scanHour: string;
  scanDayOfMonth: string;
  scanDayOfWeek: string;
  /** Agent quarantines a detection the moment it is found. */
  autoQuarantine: boolean;
  /** Absolute paths skipped by the walk, in addition to the agent's built-ins. */
  exclusions: string[];
  /** Files larger than this are counted as skipped, never read. */
  maxFileSizeMb: number;
  /** Wall-clock deadline for one scan; a hit deadline yields partial results. */
  scanTimeoutMinutes: number;
}
