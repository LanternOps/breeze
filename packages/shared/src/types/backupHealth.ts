/**
 * Provider-neutral backup status, health and read-model types (#6008).
 *
 * Shared, not API-local, because four surfaces derive from the same rule: the
 * `/backup` overview, the device Backup tab, the client portal Backups page
 * and the posture report. A second copy of this vocabulary is how "this device
 * is protected" came to mean three different things.
 */

/**
 * The normalized outcome of a device's most recent backup session, for BOTH
 * first-party Breeze backups (via `mapBackupJobStatus`) and external vendors
 * (via each adapter's own mapper).
 *
 * The tuple order mirrors the `external_backup_status` Postgres enum created by
 * `apps/api/migrations/2026-10-17-120000-backup-provider-integration.sql` and
 * is asserted against live `pg_enum` by
 * `backupProviderRls.integration.test.ts`. `ALTER TYPE ... ADD VALUE` appends,
 * so any future label goes on the END of both.
 *
 * `no_backups` means "we looked and there is no session at all" — a real,
 * actionable state. `unknown` means "the vendor reported something we do not
 * recognise", which is a gap in OUR mapping and must never be rendered as
 * either healthy or failed.
 */
export const EXTERNAL_BACKUP_STATUSES = [
  'completed',
  'completed_with_errors',
  'failed',
  'in_progress',
  'interrupted',
  'over_quota',
  'no_selection',
  'not_started',
  'no_backups',
  'unknown',
] as const;

export type ExternalBackupStatus = (typeof EXTERNAL_BACKUP_STATUSES)[number];

/** The user-facing verdict. `unknown` is a fourth state, never a synonym for healthy. */
export type BackupHealth = 'healthy' | 'warning' | 'critical' | 'unknown';

/** Age of the newest SUCCESSFUL backup. `never` when there has not been one. */
export type BackupRecency = 'under_24h' | 'under_48h' | 'over_48h' | 'never';

/** The conditions W02's alert evaluator can raise for a linked provider device. */
export type BackupProviderAlertCondition =
  | 'failed'
  | 'over_quota'
  | 'no_selection'
  | 'no_backups'
  | 'completed_with_errors'
  | 'stale';

/**
 * One row of the unified backup read model (W03,
 * `apps/api/src/services/backupHealthReadModel.ts`). Declared here in W01 so
 * the API, the web overview and the portal all consume ONE shape.
 *
 * Invariants the producer must hold (spec "Unified read model"):
 * - EVERY active Breeze device in scope yields a row (`source: 'breeze'`,
 *   `status: 'no_backups'` when it has no jobs) — the unprotected population
 *   must never drop out of a jobs/provider union.
 * - A device that is both first-party-backed-up AND provider-linked yields
 *   TWO rows; consumers group by `deviceId`.
 * - Verification, test-restore, SLA-breach and readiness stay first-party and
 *   are NOT on this row: a provider success proves none of them.
 */
export interface BackupHealthRow {
  /** `'breeze:<device id>'` | `'provider:<row id>'` — stable across pages. */
  key: string;
  source: 'breeze' | 'provider';
  /** Adapter key (`'cove'`), or null for a first-party row. */
  providerKey: string | null;
  /**
   * The label to SHOW. The generic "Managed cloud backup" unless the row's
   * connection has `showProviderNameInPortal` and the caller is allowed the
   * vendor name (spec D5). Null for a first-party row.
   */
  providerLabel: string | null;
  orgId: string;
  orgName: string;
  siteId: string | null;
  /** The linked Breeze device; always set when `source === 'breeze'`. */
  deviceId: string | null;
  name: string;
  computerName: string | null;
  osType: 'workstation' | 'server' | 'unknown';
  /** `m365` rows are vendor cloud-mailbox accounts and are never linked to a device. */
  accountType: 'endpoint' | 'm365';
  status: ExternalBackupStatus;
  health: BackupHealth;
  recency: BackupRecency;
  covered: boolean;
  /** The connection is inactive or its sync is stale; `covered` is forced false. */
  stale: boolean;
  lastSuccessAt: string | null;
  lastSessionAt: string | null;
  selectedBytes: number | null;
  usedBytes: number | null;
  errorsCount: number;
  dataSources: string[];
  /** 28 entries, oldest first. `status: null` = no observation that day (grey). */
  history28d: Array<{ day: string; status: ExternalBackupStatus | null }>;
  /** `devices.status` when linked — "backup stale but the device is offline" context. */
  agentOnline: boolean | null;
}

/**
 * Bucket counts for the overview (W03). `endpoints` counts DISTINCT Breeze
 * devices; provider-only endpoints and M365 accounts have their own
 * denominators so a partner-wide view can never imply complete vendor coverage.
 */
export interface BackupHealthSummary {
  endpoints: { total: number; covered: number; uncovered: number };
  providerOnly: number;
  m365Accounts: number;
  byStatus: Record<ExternalBackupStatus, number>;
  byHealth: Record<BackupHealth, number>;
  byRecency: Record<BackupRecency, number>;
}
