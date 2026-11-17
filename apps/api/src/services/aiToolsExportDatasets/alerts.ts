/**
 * `alerts` for `export_dataset` (Wisp analysis sessions W05): device-owned
 * alerts across the run's device frame, every status, newest first.
 *
 * Only `owner_kind = 'device'` rows. A topology-site alert keeps its origin
 * device in `device_id` as provenance only (db/schema/alerts.ts), and a
 * backup-workload alert has no device: neither is a fact about a device in the
 * frame, so neither is exported.
 *
 * Alert titles and messages are built from agent data (process and service
 * names, paths, share names, URLs), so both are URL-scrubbed and redacted with
 * the agent-text pass before the cut. `context`, `resolution_note` (technician
 * free text) and the actor/principal columns are never selected.
 *
 * The `.from(alerts)` stays inline in `createAlertsPager` so the scope
 * contract scans credit it to the function that calls `exportDeviceSet`.
 */
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { ALERT_RESOLUTION_REASONS } from '@breeze/shared';
import { db } from '../../db';
import { alertRules, alerts } from '../../db/schema';
import {
  deviceIdIn,
  emptyExportPager,
  exportDeviceSet,
  exportEnum,
  exportText,
  keysetBefore,
  keysetPager,
  noteOn,
  runExportQuery,
  timeRangeFromFilters,
} from '../aiToolsExportShared';
import type { DatasetAdapter, DatasetRequest } from '../aiToolsExportDatasets';

export const ALERTS_DEVICE_OWNED_NOTE =
  'alerts lists device-owned alerts only (topology-site and backup alerts are left out); alert context is not exported.';

const RESOLUTION_REASONS: ReadonlySet<string> = new Set(ALERT_RESOLUTION_REASONS);

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

async function createAlertsPager(req: DatasetRequest) {
  const { start, end } = timeRangeFromFilters(req.filters);
  const scope = await exportDeviceSet(req);
  noteOn(req, ALERTS_DEVICE_OWNED_NOTE);
  if (scope.deviceIds.length === 0) return emptyExportPager;

  return keysetPager({
    pageSize: req.pageSize,
    shape: ['timestamp', 'uuid'],
    fetch: async (after, limit) => {
      const a = alerts;
      return await runExportQuery(
        db
          .select({
            id: a.id,
            deviceId: a.deviceId,
            ruleId: a.ruleId,
            // Null when the alert has no rule or the run's DB context cannot see it (RLS).
            ruleName: alertRules.name,
            severity: a.severity,
            status: a.status,
            title: a.title,
            message: a.message,
            triggeredAt: a.triggeredAt,
            // The keyset key: full microsecond precision, never a JS Date.
            triggeredAtText: sql<string>`${a.triggeredAt}::text`,
            acknowledgedAt: a.acknowledgedAt,
            resolvedAt: a.resolvedAt,
            dismissedAt: a.dismissedAt,
            suppressedUntil: a.suppressedUntil,
            resolutionReason: a.resolutionReason,
          })
          .from(alerts)
          .leftJoin(alertRules, eq(alertRules.id, a.ruleId))
          .where(and(
            eq(a.orgId, req.orgId),
            // A SQL literal, not a bound parameter: the planner can only prove
            // the partial index predicate (alerts_org_device_triggered_idx)
            // from the literal.
            sql`${a.ownerKind} = 'device'`,
            deviceIdIn(a.deviceId, scope.deviceIds),
            gte(a.triggeredAt, start),
            lte(a.triggeredAt, end),
            keysetBefore(a.triggeredAt, a.id, after, 'timestamp'),
          ))
          .orderBy(desc(a.triggeredAt), desc(a.id))
          .limit(limit),
      );
    },
    keyOf: (row) => [row.triggeredAtText, row.id],
    toRows: (rows) => rows.map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      hostname: row.deviceId ? scope.hostnames.get(row.deviceId) ?? null : null,
      ruleId: row.ruleId,
      ruleName: exportText(row.ruleName, { paths: true }),
      severity: row.severity,
      status: row.status,
      title: exportText(row.title, { urls: true, paths: true }),
      message: exportText(row.message, { urls: true, paths: true }),
      triggeredAt: row.triggeredAt.toISOString(),
      acknowledgedAt: iso(row.acknowledgedAt),
      resolvedAt: iso(row.resolvedAt),
      dismissedAt: iso(row.dismissedAt),
      suppressedUntil: iso(row.suppressedUntil),
      resolutionReason: exportEnum(row.resolutionReason, RESOLUTION_REASONS),
    })),
  });
}

export const alertsAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  createPager: createAlertsPager,
};
