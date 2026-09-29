/**
 * Backup status report (Cove email layout) — Backup Provider Integration W05.
 *
 * Org-scoped, as-of snapshot over BOTH backup sources (Breeze first-party
 * jobs and linked/unlinked provider devices), laid out like Cove's own daily
 * "Backup & Recovery: All devices" email: status buckets, last-successful-
 * backup recency buckets, and a device table ordered unhealthy-first. Built
 * entirely from `backupHealthReadModel.ts` (W03) — this file adds no new
 * queries of its own beyond the org's display name, and derives nothing
 * `deriveBackupHealth` (W01) hasn't already computed onto each row.
 *
 * Managed-evidence registry registration (the deliverables-track hookup that
 * would let this report be scheduled as service-plan evidence) is explicitly
 * OUT of scope for this wave — see the spec's Reports section, last sentence.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { organizations } from '../db/schema';
import { backupStatusReportConfigSchema } from './reportConfigSchemas';
import {
  BACKUP_STATUS_BUCKET_IDS,
  bucketForBackupStatus,
  EXTERNAL_BACKUP_STATUS_SEVERITY,
  type BackupHealth,
  type BackupHealthRow,
  type BackupRecency,
  type BackupRecencyBucket,
  type BackupStatusBucket,
  type BackupStatusBucketId,
  type BackupStatusReportData,
  type BackupStatusReportOptions,
} from '@breeze/shared';
import { emptyBackupHealthSummary } from './backupHealthRows';
import { listBackupHealthRows, summarizeBackupHealth } from './backupHealthReadModel';
import { assertReportExecutionPreflight, type ReportResult } from './reportGenerationService';
import type { OrgReportExecutionAuthority } from './siteScope';

/** One page of `listBackupHealthRows` at a time; a full-org snapshot report
 *  reads every row, never just one page for a UI. */
const PAGE_SIZE = 500;
/** Safety valve, not an expected path — an org's device + provider-device
 *  count is bounded well under this in phase 1. Stops a runaway loop rather
 *  than silently truncating without saying so. */
const MAX_ROWS = 20_000;

/**
 * "Unhealthy first" (the spec's Cove-email ordering) — primary by health
 * bucket (critical, then warning, then unknown, then healthy), secondary by
 * the underlying status's severity (`EXTERNAL_BACKUP_STATUS_SEVERITY`,
 * higher = worse, W01), tertiary by name for a stable, readable order.
 */
const HEALTH_SORT_WEIGHT: Record<BackupHealth, number> = {
  critical: 0,
  warning: 1,
  unknown: 2,
  healthy: 3,
};

/** Spec's literal display order ("never / < 24 h / < 48 h / > 48 h") — not
 *  severity-monotonic (a device with NO evidence is arguably worse than one
 *  with 40-hour-old evidence), but this is the order the spec's Web UI
 *  section gives for the sibling bucket bar, and this report mirrors it
 *  verbatim so the two surfaces read the same way. */
const RECENCY_BUCKET_ORDER: BackupRecency[] = ['never', 'under_24h', 'under_48h', 'over_48h'];

function pct(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((count / total) * 1000) / 10;
}

/**
 * Status-bucket grouping is a SHARED contract, not a local fold: W01's
 * `bucketForBackupStatus` (`@breeze/shared`) sorts every `ExternalBackupStatus`
 * into one of `BACKUP_STATUS_BUCKET_IDS` — `no_backups`, `completed`,
 * `completed_with_errors`, `in_progress`, `unsuccessful` (`failed` +
 * `over_quota` + `no_selection` + `interrupted`), `other` (`not_started` +
 * `unknown`) — and the W03 web overview uses the exact same mapping for its
 * own status bar, so this report and the overview can never disagree about
 * where a status lands. (This plan's first draft defined an equivalent local
 * fold here under the DECISION that no shared helper existed yet at W05
 * plan-authoring time — it does now, per the coordinator's follow-up, and
 * this file imports it instead of re-deriving it.)
 *
 * `other` is the catch-all for the two statuses the spec's Web UI section's
 * five NAMED buckets don't mention (`not_started`, `unknown`) — this function
 * renders it only when its count is non-zero, the same rule the overview
 * applies, so an org with no `other`-bucketed device never shows an empty,
 * unfamiliar sixth segment next to Cove's own five.
 */
function buildStatusBuckets(rows: BackupHealthRow[]): BackupStatusBucket[] {
  const counts: Record<BackupStatusBucketId, number> = {
    no_backups: 0,
    completed: 0,
    completed_with_errors: 0,
    in_progress: 0,
    unsuccessful: 0,
    other: 0,
  };
  for (const row of rows) counts[bucketForBackupStatus(row.status)] += 1;
  const total = rows.length;
  return BACKUP_STATUS_BUCKET_IDS
    .filter((key) => key !== 'other' || counts[key] > 0)
    .map((key) => ({ key, count: counts[key], pct: pct(counts[key], total) }));
}

function buildRecencyBuckets(rows: BackupHealthRow[]): BackupRecencyBucket[] {
  const counts: Record<BackupRecency, number> = { never: 0, under_24h: 0, under_48h: 0, over_48h: 0 };
  for (const row of rows) counts[row.recency] += 1;
  const total = rows.length;
  return RECENCY_BUCKET_ORDER.map((key) => ({ key, count: counts[key], pct: pct(counts[key], total) }));
}

function sortUnhealthyFirst(rows: BackupHealthRow[]): BackupHealthRow[] {
  return [...rows].sort((a, b) => {
    const healthDiff = HEALTH_SORT_WEIGHT[a.health] - HEALTH_SORT_WEIGHT[b.health];
    if (healthDiff !== 0) return healthDiff;
    const severityDiff = EXTERNAL_BACKUP_STATUS_SEVERITY[b.status] - EXTERNAL_BACKUP_STATUS_SEVERITY[a.status];
    if (severityDiff !== 0) return severityDiff;
    return a.name.localeCompare(b.name);
  });
}

/** Flat, CSV/Excel-safe projection of a `BackupHealthRow` for
 *  `ReportResult.rows` (the generic `extractTable`/`rowsToCsv` export path,
 *  `apps/web/src/components/reports/reportExport.ts`) — distinct from
 *  `summary.rows`, which keeps the FULL row (incl. `history28d`, an array of
 *  objects `Object.keys` would dump as "[object Object]" in a spreadsheet).
 *  `hardwareLifecycleReport.ts` returns the same flat rows both top-level and
 *  nested in `summary.rows` because its row shape has no such fields; here
 *  the two genuinely differ. */
function toCsvRow(row: BackupHealthRow): Record<string, string | number | boolean | null> {
  return {
    device: row.name,
    computerName: row.computerName,
    organization: row.orgName,
    source: row.source,
    provider: row.providerLabel,
    deviceType: row.osType,
    accountType: row.accountType,
    status: row.status,
    health: row.health,
    recency: row.recency,
    covered: row.covered,
    lastSuccessAt: row.lastSuccessAt,
    selectedBytes: row.selectedBytes,
    usedBytes: row.usedBytes,
    errorsCount: row.errorsCount,
    dataSources: row.dataSources.join('; '),
    agentOnline: row.agentOnline,
  };
}

function emptyData(orgId: string, generatedAt: string, options: BackupStatusReportOptions): BackupStatusReportData {
  return {
    org: { id: orgId, name: '' },
    asOf: generatedAt,
    generatedAt,
    summary: emptyBackupHealthSummary(),
    statusBuckets: buildStatusBuckets([]),
    recencyBuckets: buildRecencyBuckets([]),
    rows: [],
    truncated: false,
    options,
  };
}

export async function generateBackupStatusReport(
  orgId: string,
  rawConfig: Record<string, unknown>,
  authority: OrgReportExecutionAuthority,
): Promise<ReportResult> {
  const cfg = backupStatusReportConfigSchema.parse(rawConfig ?? {});
  const generatedAt = new Date().toISOString();
  const options: BackupStatusReportOptions = {
    includeDevicesWithoutBackup: cfg.includeDevicesWithoutBackup,
    sources: cfg.sources,
  };

  assertReportExecutionPreflight(orgId, cfg, authority, 'backup_status');

  const restrictedScope = authority.scope.kind === 'restricted' ? authority.scope : null;
  if (restrictedScope && restrictedScope.siteIds.length === 0) {
    const data = emptyData(orgId, generatedAt, options);
    return { rows: [], rowCount: 0, generatedAt, summary: data };
  }

  const [orgRow] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const siteIds = cfg.sites.length > 0 ? cfg.sites : restrictedScope ? restrictedScope.siteIds : undefined;
  const scope = { orgIds: [orgId], ...(siteIds ? { siteIds } : {}) };
  const listOpts = {
    sources: cfg.sources,
    onlyWithBackup: !cfg.includeDevicesWithoutBackup,
  };

  const allRows: BackupHealthRow[] = [];
  let cursor: string | undefined;
  let truncated = false;
  let guard = 0;
  const maxPages = Math.ceil(MAX_ROWS / PAGE_SIZE) + 1;
  for (;;) {
    const page = await listBackupHealthRows(scope, { ...listOpts, page: { limit: PAGE_SIZE, cursor } });
    allRows.push(...page.rows);
    guard += 1;
    if (!page.nextCursor) break;
    if (allRows.length >= MAX_ROWS || guard >= maxPages) {
      truncated = true;
      break;
    }
    cursor = page.nextCursor;
  }

  const summary = await summarizeBackupHealth(scope, listOpts);
  const rows = sortUnhealthyFirst(allRows);

  const data: BackupStatusReportData = {
    org: { id: orgRow?.id ?? orgId, name: orgRow?.name ?? '' },
    asOf: generatedAt,
    generatedAt,
    summary,
    statusBuckets: buildStatusBuckets(rows),
    recencyBuckets: buildRecencyBuckets(rows),
    rows,
    truncated,
    options,
  };

  const csvRows = rows.map(toCsvRow);
  return { rows: csvRows, rowCount: csvRows.length, generatedAt, summary: data };
}
