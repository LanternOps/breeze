/**
 * Backup status report (Cove email layout) — Backup Provider Integration W05.
 * Persisted `report_runs.result.summary` shape for the `backup_status` report
 * type: an org-scoped, as-of snapshot over the unified backup health read
 * model (`apps/api/src/services/backupHealthReadModel.ts`, W03) plus the
 * bucket groupings the Cove "Backup & Recovery: All devices" email shows.
 *
 * Single-sourced like `HardwareLifecycleSummary` / `PostureSummary`: the API
 * produces this with `satisfies`, the shared PDF renderer consumes it, and
 * every field must survive a JSON round-trip through `report_runs.result`.
 */
import type { BackupHealthRow, BackupHealthSummary, BackupRecency, BackupStatusBucketId } from './backupHealth';

/**
 * The six buckets `bucketForBackupStatus` (W01, `./backupHealth`) sorts every
 * `ExternalBackupStatus` into — the same shared mapping the W03 web overview
 * uses for its own status bar, so this report and the overview can never
 * disagree about where a status lands: `no_backups`, `completed`,
 * `completed_with_errors`, `in_progress`, `unsuccessful` (`failed` +
 * `over_quota` + `no_selection` + `interrupted`), `other` (`not_started` +
 * `unknown`). `other` is the catch-all for the two statuses the spec's Web UI
 * section's five named buckets don't mention by name; see
 * `buildStatusBuckets` (Task 4) for why it is rendered only when non-zero,
 * unlike the other five.
 */
export type BackupStatusBucket = {
  key: BackupStatusBucketId;
  count: number;
  /** Percentage of the report's total row count, rounded to one decimal. */
  pct: number;
};

export type BackupRecencyBucket = {
  key: BackupRecency;
  count: number;
  pct: number;
};

export type BackupStatusReportOptions = {
  /** Default true — see `backupStatusReportConfigSchema`
   *  (`apps/api/src/routes/reports/schemas.ts`) for why this report's default
   *  differs from the web overview's `onlyWithBackup: true` default. */
  includeDevicesWithoutBackup: boolean;
  sources: Array<'breeze' | 'provider'>;
};

export type BackupStatusReportData = {
  org: { id: string; name: string };
  /** ISO timestamp the snapshot (rows + summary) was read at. Equal to
   *  `generatedAt` in phase 1 — kept as its own field because a future
   *  cached/scheduled variant may render later than it reads. */
  asOf: string;
  generatedAt: string;
  summary: BackupHealthSummary;
  statusBuckets: BackupStatusBucket[];
  recencyBuckets: BackupRecencyBucket[];
  /** Every row in scope, sorted unhealthy-first (critical, warning, unknown,
   *  healthy; ties broken by `EXTERNAL_BACKUP_STATUS_SEVERITY`, then name —
   *  see `sortUnhealthyFirst` in `apps/api/src/services/backupStatusReport.ts`). */
  rows: BackupHealthRow[];
  /** True when the row list hit the report's row ceiling and was cut short
   *  (the summary and buckets still describe what was read, not the whole org). */
  truncated: boolean;
  options: BackupStatusReportOptions;
};
