/**
 * `change_log` for `export_dataset` (Wisp analysis sessions W05): device
 * configuration changes across the run's frame, newest first.
 *
 * The `user_account_changes` sensitive gate (spec §4.4, decision 8): user
 * account changes name the accounts on a device and who was added to or
 * removed from which group, so they are exported only when the run holds the
 * frozen gate (the same `devices:execute` permission as security event logs).
 * Without it the rows are excluded IN SQL (a literal predicate, so nothing is
 * read and dropped later) and the result says so. Asking for user account
 * changes alone, without the gate, runs no query at all.
 *
 * Every other change type is free text the agent collected: software, service
 * and scheduled task names, startup command lines, paths, network values. The
 * subject and the jsonb before/after/details all get the URL and agent-text
 * passes before the cut. `fingerprint` (a hash of the change content) and
 * `created_at` are never selected.
 *
 * The `.from(deviceChangeLog)` stays inline in `createChangeLogPager` so the
 * scope contract scans credit it to the function that calls `exportDeviceSet`.
 */
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../../db';
import { changeTypeEnum, deviceChangeLog } from '../../db/schema';
import {
  ExportFilterError,
  deviceIdIn,
  emptyExportPager,
  exportDeviceSet,
  exportJsonText,
  exportText,
  holdsSensitiveGate,
  keysetBefore,
  keysetPager,
  noteDefaultWindow,
  noteOn,
  rejectUnknownFilters,
  runExportQuery,
  timeRangeFromFilters,
} from '../aiToolsExportShared';
import type { DatasetAdapter, DatasetRequest } from '../aiToolsExportDatasets';

export const USER_ACCOUNT_CHANGES_NOTE =
  'change_log: user account changes were left out; this run does not hold the user_account_changes permission (devices:execute).';

type ChangeType = (typeof changeTypeEnum.enumValues)[number];
const CHANGE_TYPES: ReadonlySet<string> = new Set(changeTypeEnum.enumValues);

function changeTypeFilter(value: unknown): ChangeType[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || !value.every((t) => typeof t === 'string' && CHANGE_TYPES.has(t))) {
    throw new ExportFilterError('invalid_filter', `filters.changeType must be an array of ${changeTypeEnum.enumValues.join(', ')}`);
  }
  return [...new Set(value as ChangeType[])];
}

const VALUE_TEXT = { urls: true, paths: true } as const;

async function createChangeLogPager(req: DatasetRequest) {
  rejectUnknownFilters('change_log', req.filters, ['timeRange', 'changeType']);
  const { start, end } = timeRangeFromFilters(req.filters);
  let changeTypes = changeTypeFilter(req.filters.changeType);
  const scope = await exportDeviceSet(req);
  noteDefaultWindow(req, 'change_log', 'timestamp', { start, end });
  const gated = !holdsSensitiveGate(req, 'user_account_changes');
  if (gated) {
    noteOn(req, USER_ACCOUNT_CHANGES_NOTE);
    if (changeTypes) {
      changeTypes = changeTypes.filter((t) => t !== 'user_account');
      // Only user account changes were asked for, and none may leave.
      if (changeTypes.length === 0) return emptyExportPager;
    }
  }
  if (scope.deviceIds.length === 0) return emptyExportPager;

  return keysetPager({
    pageSize: req.pageSize,
    shape: ['timestamp', 'uuid'],
    fetch: async (after, limit) => {
      const t = deviceChangeLog;
      return await runExportQuery(
        db
          .select({
            id: t.id,
            deviceId: t.deviceId,
            timestamp: t.timestamp,
            // The keyset key: full microsecond precision, never a JS Date.
            timestampText: sql<string>`${t.timestamp}::text`,
            changeType: t.changeType,
            changeAction: t.changeAction,
            subject: t.subject,
            beforeValue: t.beforeValue,
            afterValue: t.afterValue,
            details: t.details,
          })
          .from(deviceChangeLog)
          .where(and(
            eq(t.orgId, req.orgId),
            deviceIdIn(t.deviceId, scope.deviceIds),
            gte(t.timestamp, start),
            lte(t.timestamp, end),
            // The gate: a SQL literal, never a parameter the model could vary.
            gated ? sql`${t.changeType} <> 'user_account'` : undefined,
            changeTypes ? inArray(t.changeType, changeTypes) : undefined,
            keysetBefore(t.timestamp, t.id, after, 'timestamp'),
          ))
          .orderBy(desc(t.timestamp), desc(t.id))
          .limit(limit),
      );
    },
    keyOf: (row) => [row.timestampText, row.id],
    toRows: (rows) => rows.map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      hostname: scope.hostnames.get(row.deviceId) ?? null,
      timestamp: row.timestamp.toISOString(),
      changeType: row.changeType,
      changeAction: row.changeAction,
      subject: exportText(row.subject, VALUE_TEXT),
      beforeValue: exportJsonText(row.beforeValue, VALUE_TEXT),
      afterValue: exportJsonText(row.afterValue, VALUE_TEXT),
      details: exportJsonText(row.details, VALUE_TEXT),
    })),
  });
}

export const changeLogAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  createPager: createChangeLogPager,
};
