/**
 * `patch_state` and `patch_attempts` for `export_dataset` (Wisp analysis
 * sessions W05).
 *
 * - `patch_state`: the current per-device patch rows (`device_patches` joined
 *   to the shared `patches` catalog), without the `missing` scan tombstones
 *   (db/schema/patches.ts `OUTSTANDING_DEVICE_PATCH_STATUSES`). Current state:
 *   `timeRange` is validated but not applied, and the result says so.
 * - `patch_attempts`: patch job results across the frame, newest first. The
 *   raw installer `output` is NEVER selected (spec decision 9).
 *
 * `patch_job_results` has no `org_id`. Its org scope is two independent
 * conditions, both required: the job is in this org (`patch_jobs.org_id`), and
 * the device is in this org's frame (`exportDeviceSet` reads only
 * `devices.org_id = req.orgId`). A job in another org that names an in-org
 * device, and an in-org job whose device has since moved orgs, are both out.
 *
 * Patch titles, categories and external ids can come from the agent
 * (third-party and Linux providers, `reported_category`), so they get the
 * agent-text pass; error text is URL-scrubbed too (installer errors echo
 * download URLs with signed query strings). Version columns get the secret
 * pass only: the address-shape rules would redact a dotted version such as
 * `8.8.8.8`.
 *
 * Each `.from(...)` stays inline in the `create<X>Pager` that calls
 * `exportDeviceSet`, so the scope contract scans credit it.
 */
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../../db';
import { devicePatches, patchJobResults, patchJobs, patches, patchSeverityEnum } from '../../db/schema';
import { EFFECTIVE_PATCH_CATEGORY_SQL, EFFECTIVE_PATCH_SEVERITY_SQL } from '../patchSeverityOverlay';
import {
  ExportFilterError,
  deviceIdIn,
  emptyExportPager,
  exportDeviceSet,
  exportEnum,
  exportText,
  keysetAfterIds,
  keysetBefore,
  keysetPager,
  noteOn,
  runExportQuery,
  timeRangeFromFilters,
} from '../aiToolsExportShared';
import type { DatasetAdapter, DatasetRequest } from '../aiToolsExportDatasets';

export const PATCH_STATE_CURRENT_NOTE =
  'patch_state is current state per device and patch; stale scan rows (status missing) are left out.';
export const PATCH_STATE_TIME_RANGE_NOTE = 'patch_state is current state; timeRange was not applied.';
export const PATCH_ATTEMPTS_NO_OUTPUT_NOTE =
  'patch_attempts carries no raw installer output; errorMessage is redacted and cut to 2000 characters.';

/** The `device_patches.status` values a filter may name: every one but the `missing` tombstone. */
const PATCH_STATE_STATUSES = ['pending', 'installed', 'failed', 'skipped'] as const;
type PatchStateStatus = (typeof PATCH_STATE_STATUSES)[number];
const PATCH_SEVERITIES: ReadonlySet<string> = new Set(patchSeverityEnum.enumValues);

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

function statusFilter(value: unknown): PatchStateStatus[] | null {
  if (value === undefined || value === null) return null;
  const allowed = new Set<string>(PATCH_STATE_STATUSES);
  if (!Array.isArray(value) || value.length === 0 || !value.every((s) => typeof s === 'string' && allowed.has(s))) {
    throw new ExportFilterError('invalid_filter', `filters.status must be an array of ${PATCH_STATE_STATUSES.join(', ')}`);
  }
  return [...new Set(value as PatchStateStatus[])];
}

async function createPatchStatePager(req: DatasetRequest) {
  // Validated (a bad range is refused) but not applied: this is current state.
  timeRangeFromFilters(req.filters);
  const statuses = statusFilter(req.filters.status);
  const scope = await exportDeviceSet(req);
  noteOn(req, PATCH_STATE_CURRENT_NOTE);
  if (req.filters.timeRange !== undefined && req.filters.timeRange !== null) noteOn(req, PATCH_STATE_TIME_RANGE_NOTE);
  if (scope.deviceIds.length === 0) return emptyExportPager;

  return keysetPager({
    pageSize: req.pageSize,
    shape: ['uuid', 'uuid'],
    fetch: async (after, limit) => {
      const dp = devicePatches;
      return await runExportQuery(
        db
          .select({
            id: dp.id,
            deviceId: dp.deviceId,
            patchId: dp.patchId,
            source: patches.source,
            externalId: patches.externalId,
            title: patches.title,
            // The same overlay `manage_patches list` reads.
            severity: EFFECTIVE_PATCH_SEVERITY_SQL,
            category: EFFECTIVE_PATCH_CATEGORY_SQL,
            releaseDate: patches.releaseDate,
            requiresReboot: patches.requiresReboot,
            status: dp.status,
            installedAt: dp.installedAt,
            installedVersion: dp.installedVersion,
            availableVersion: dp.availableVersion,
            lastCheckedAt: dp.lastCheckedAt,
            failureCount: dp.failureCount,
            lastError: dp.lastError,
          })
          .from(devicePatches)
          .innerJoin(patches, eq(patches.id, dp.patchId))
          .where(and(
            eq(dp.orgId, req.orgId),
            // A SQL literal: the tombstone rule never depends on a parameter.
            sql`${dp.status} <> 'missing'`,
            deviceIdIn(dp.deviceId, scope.deviceIds),
            statuses ? inArray(dp.status, statuses) : undefined,
            keysetAfterIds([dp.deviceId, dp.patchId], after),
          ))
          .orderBy(asc(dp.deviceId), asc(dp.patchId))
          .limit(limit),
      );
    },
    keyOf: (row) => [row.deviceId, row.patchId],
    toRows: (rows) => rows.map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      hostname: scope.hostnames.get(row.deviceId) ?? null,
      patchId: row.patchId,
      source: row.source,
      externalId: exportText(row.externalId, { paths: true }),
      title: exportText(row.title, { paths: true }),
      severity: exportEnum(row.severity, PATCH_SEVERITIES),
      category: exportText(row.category, { paths: true }),
      releaseDate: row.releaseDate,
      requiresReboot: row.requiresReboot,
      status: row.status,
      installedAt: iso(row.installedAt),
      installedVersion: exportText(row.installedVersion),
      availableVersion: exportText(row.availableVersion),
      lastCheckedAt: iso(row.lastCheckedAt),
      failureCount: row.failureCount,
      lastError: exportText(row.lastError, { urls: true, paths: true }),
    })),
  });
}

async function createPatchAttemptsPager(req: DatasetRequest) {
  const { start, end } = timeRangeFromFilters(req.filters);
  const scope = await exportDeviceSet(req);
  noteOn(req, PATCH_ATTEMPTS_NO_OUTPUT_NOTE);
  if (scope.deviceIds.length === 0) return emptyExportPager;

  return keysetPager({
    pageSize: req.pageSize,
    shape: ['timestamp', 'uuid'],
    fetch: async (after, limit) => {
      const r = patchJobResults;
      return await runExportQuery(
        db
          .select({
            id: r.id,
            jobId: r.jobId,
            jobName: patchJobs.name,
            deviceId: r.deviceId,
            // NULL patch = a whole-device summary row; the left join keeps it.
            patchId: r.patchId,
            patchTitle: patches.title,
            patchExternalId: patches.externalId,
            status: r.status,
            startedAt: r.startedAt,
            completedAt: r.completedAt,
            exitCode: r.exitCode,
            rebootRequired: r.rebootRequired,
            rebootedAt: r.rebootedAt,
            errorMessage: r.errorMessage,
            createdAt: r.createdAt,
            // The keyset key: full microsecond precision, never a JS Date.
            createdAtText: sql<string>`${r.createdAt}::text`,
          })
          .from(patchJobResults)
          .innerJoin(patchJobs, eq(patchJobs.id, r.jobId))
          .leftJoin(patches, eq(patches.id, r.patchId))
          .where(and(
            // Both org conditions; neither alone is enough (see the header).
            eq(patchJobs.orgId, req.orgId),
            deviceIdIn(r.deviceId, scope.deviceIds),
            gte(r.createdAt, start),
            lte(r.createdAt, end),
            keysetBefore(r.createdAt, r.id, after, 'timestamp'),
          ))
          .orderBy(desc(r.createdAt), desc(r.id))
          .limit(limit),
      );
    },
    keyOf: (row) => [row.createdAtText, row.id],
    toRows: (rows) => rows.map((row) => ({
      id: row.id,
      jobId: row.jobId,
      jobName: exportText(row.jobName, { paths: true }),
      deviceId: row.deviceId,
      hostname: scope.hostnames.get(row.deviceId) ?? null,
      patchId: row.patchId,
      patchTitle: exportText(row.patchTitle, { paths: true }),
      patchExternalId: exportText(row.patchExternalId, { paths: true }),
      status: row.status,
      startedAt: iso(row.startedAt),
      completedAt: iso(row.completedAt),
      exitCode: row.exitCode,
      rebootRequired: row.rebootRequired,
      rebootedAt: iso(row.rebootedAt),
      errorMessage: exportText(row.errorMessage, { urls: true, paths: true }),
      createdAt: row.createdAt.toISOString(),
    })),
  });
}

export const patchStateAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  createPager: createPatchStatePager,
};

export const patchAttemptsAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  createPager: createPatchAttemptsPager,
};
