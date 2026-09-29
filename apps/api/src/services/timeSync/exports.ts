import { z } from 'zod';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { db } from '../../db';
import { deviceTimeDaily, devices } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { csvRow } from '../spreadsheetExport';
import { deviceScopeCondition, siteScopeCondition } from '../aiToolsSiteScope';
import {
  fleetTimeFiltersSchema,
  listFleetTimeStatus,
  type FleetTimeFilters,
} from './fleet';
export const TIME_EVIDENCE_HEADER =
  'Observed synchronization reported by the Breeze agent; days without a report are listed as gaps.';
const DAY_MS = 86_400_000;
const daySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }, 'Invalid UTC date');
export const historyTimeQuerySchema = fleetTimeFiltersSchema
  .extend({ from: daySchema, to: daySchema })
  .superRefine((q, ctx) => {
    const from = Date.parse(`${q.from}T00:00:00Z`),
      to = Date.parse(`${q.to}T00:00:00Z`);
    const today = Date.parse(
      `${new Date().toISOString().slice(0, 10)}T00:00:00Z`,
    );
    if (
      to < from ||
      to - from > 399 * DAY_MS ||
      from < today - 400 * DAY_MS ||
      to > today
    )
      ctx.addIssue({
        code: 'custom',
        path: ['from'],
        message:
          'Choose 1–400 UTC days within the retained window, ending no later than today',
      });
  });
export function evidenceDays(from: string, to: string): string[] {
  const result: string[] = [];
  for (
    let time = Date.parse(`${from}T00:00:00Z`);
    time <= Date.parse(`${to}T00:00:00Z`);
    time += DAY_MS
  )
    result.push(new Date(time).toISOString().slice(0, 10));
  return result;
}
export async function* exportCurrentTimeCsv(
  filters: FleetTimeFilters,
  auth: AuthContext,
): AsyncGenerator<string> {
  yield `${TIME_EVIDENCE_HEADER}\r\n${csvRow(['device_id', 'hostname', 'org_id', 'organization', 'site', 'state', 'health', 'stale', 'received_at', 'collected_at', 'finding_codes', 'domain_dns', 'domain_role', 'source', 'source_kind', 'sync_type', 'last_successful_sync_at', 'expected_timezone', 'timezone_windows_id'])}\r\n`;
  for (let page = 1; ; page++) {
    const result = await listFleetTimeStatus(
      { ...filters, page, limit: 100 },
      auth,
    );
    if (!result.data.length) break;
    yield result.data
      .map((r) => {
        const v = r.view;
        return csvRow([
          r.deviceId,
          r.hostname,
          r.orgId,
          r.orgName,
          r.siteName,
          v.state,
          v.health,
          v.stale,
          v.receivedAt,
          v.collectedAt,
          v.findings.map((f) => f.code).join(';'),
          v.domain?.domainDns,
          v.domain?.role,
          v.status?.source,
          v.status?.sourceKind,
          v.config?.syncType,
          v.status?.lastSuccessfulSyncAt,
          v.timezone?.expected?.iana,
          v.timezone?.windowsId,
        ]);
      })
      .join('\r\n') + '\r\n';
    if (page * result.limit >= result.total) break;
  }
}
export async function* exportHistoryTimeCsv(
  filters: FleetTimeFilters,
  range: { from: string; to: string },
  auth: AuthContext,
): AsyncGenerator<string> {
  const q = historyTimeQuerySchema.parse({ ...filters, ...range }),
    days = evidenceDays(q.from, q.to);
  yield `${TIME_EVIDENCE_HEADER}\r\n${csvRow(['device_id', 'hostname', 'org_id', 'organization', 'site', 'day', 'evidence_state', 'worst_health', 'finding_codes', 'source', 'source_kind', 'sync_type', 'last_successful_sync_at', 'snapshot_count', 'expected_timezone', 'timezone_windows_id'])}\r\n`;
  for (let page = 1; ; page++) {
    const result = await listFleetTimeStatus(
      { ...filters, page, limit: 100 },
      auth,
    );
    if (!result.data.length) break;
    const daily = await db
      .select({ row: deviceTimeDaily })
      .from(deviceTimeDaily)
      .innerJoin(devices, eq(devices.id, deviceTimeDaily.deviceId))
      .where(
        and(
          auth.orgCondition(deviceTimeDaily.orgId),
          siteScopeCondition(auth, devices.siteId),
          deviceScopeCondition(auth, devices.id),
          inArray(
            deviceTimeDaily.deviceId,
            result.data.map((r) => r.deviceId),
          ),
          gte(deviceTimeDaily.day, q.from),
          lte(deviceTimeDaily.day, q.to),
        ),
      );
    const byKey = new Map(
        daily.map(({ row }) => [`${row.deviceId}:${row.day}`, row]),
      ),
      lines: string[] = [];
    for (const device of result.data)
      for (const day of days) {
        const row = byKey.get(`${device.deviceId}:${day}`);
        lines.push(
          csvRow([
            device.deviceId,
            device.hostname,
            device.orgId,
            device.orgName,
            device.siteName,
            day,
            row ? 'observed' : 'gap',
            row?.worstHealth,
            row?.findingCodes.join(';'),
            row?.source,
            row?.sourceKind,
            row?.syncType,
            row?.lastSuccessfulSyncAt?.toISOString(),
            row?.snapshotCount ?? 0,
            row?.expectedTimezone,
            row?.timezoneWindowsId,
          ]),
        );
      }
    yield lines.join('\r\n') + '\r\n';
    if (page * result.limit >= result.total) break;
  }
}
