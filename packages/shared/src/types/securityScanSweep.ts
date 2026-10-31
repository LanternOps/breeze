/**
 * IOC sweep contract shared by the API, the AI tool and the web (#6263 W05).
 *
 * A sweep runs one or more pinned YARA rule sets against every eligible device
 * in a scope. The API stores one `security_scan_sweeps` row per org touched
 * (rows of one request share `groupId`); each targeted device gets an ordinary
 * `security_scans` row carrying `sweep_id`.
 */

export const SECURITY_SWEEP_STATES = ['active', 'completed', 'cancelled', 'expired'] as const;
export type SecuritySweepState = (typeof SECURITY_SWEEP_STATES)[number];

/** Who created the sweep: a user session, an API key, in-app AI chat, or an MCP client. */
export const SECURITY_SWEEP_ORIGINS = ['web', 'api', 'ai_chat', 'mcp'] as const;
export type SecuritySweepOrigin = (typeof SECURITY_SWEEP_ORIGINS)[number];

/** Why an in-scope device received no scan row. */
export const SECURITY_SWEEP_SKIP_REASONS = ['agent_too_old', 'busy_same_sweep', 'rule_set_not_eligible'] as const;
export type SecuritySweepSkipReason = (typeof SECURITY_SWEEP_SKIP_REASONS)[number];

export const SECURITY_SWEEP_SCAN_TYPES = ['quick', 'full', 'custom'] as const;
export type SecuritySweepScanType = (typeof SECURITY_SWEEP_SCAN_TYPES)[number];

/** Eligible devices per request, across orgs (env `SECURITY_SWEEP_MAX_DEVICES`). */
export const SECURITY_SWEEP_MAX_DEVICES_DEFAULT = 10_000;
/** Default sweep lifetime in hours (env `SECURITY_SWEEP_TTL_HOURS_DEFAULT`). */
export const SECURITY_SWEEP_TTL_HOURS_DEFAULT = 24;
/** Longest sweep lifetime a request may ask for. */
export const SECURITY_SWEEP_TTL_HOURS_MAX = 72;
/** Human creates above this many devices need an interactive session with satisfied MFA. */
export const SECURITY_SWEEP_MFA_DEVICE_THRESHOLD = 50;
/** AI sweeps above this many expected devices need a second approver (W05 PR B). */
export const IOC_HUNT_FOUR_EYES_DEVICE_THRESHOLD = 25;

/** Custom-scan path limits, shared with the single-device scan route. */
export const SECURITY_SCAN_PATH_MAX_CHARS = 1024;
export const SECURITY_SWEEP_MAX_PATHS = 20;

export type SecuritySweepScope =
  | { kind: 'all' }
  | { kind: 'orgs'; orgIds: string[] }
  | { kind: 'sites'; siteIds: string[] }
  | { kind: 'groups'; groupIds: string[] }
  | { kind: 'devices'; deviceIds: string[] };

export type SecuritySweepScopeKind = SecuritySweepScope['kind'];

/** A rule-set version approved at sweep create; every scan of the sweep runs exactly this. */
export interface YaraRuleSetPin {
  id: string;
  version: number;
  /** sha256 (64 lowercase hex) of the published bundle. */
  sha256: string;
}

/** Computed from the sweep's `security_scans` children; nothing is stored. */
export interface SweepProgress {
  queued: number;
  running: number;
  completed: number;
  timedOut: number;
  failed: number;
  cancelled: number;
  expired: number;
  /** Completed or timed-out children that ran the legacy engine or reported rule-set errors. */
  degraded: number;
  threatsFound: number;
}

export interface SweepSummary {
  id: string;
  groupId: string;
  orgId: string;
  orgName: string | null;
  ruleSets: Array<{ id: string; name: string | null; version: number }>;
  scanType: SecuritySweepScanType;
  /** The custom-scan paths, so a re-sweep can carry them over; null unless `scanType` is 'custom'. */
  paths: string[] | null;
  state: SecuritySweepState;
  /** Devices that received a scan row at create. */
  targeted: number;
  skipped: Partial<Record<SecuritySweepSkipReason, number>>;
  progress: SweepProgress;
  origin: SecuritySweepOrigin;
  createdBy: { id: string; name: string | null } | null;
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
}
