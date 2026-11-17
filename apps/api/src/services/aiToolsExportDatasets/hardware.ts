/**
 * `hardware_events` for `export_dataset` (Wisp analysis sessions W04): the
 * component health/state change ledger, joined to the component row for its
 * name, model, serial and firmware. The `.from(deviceHardwareEvents)` stays
 * inline in `createHardwareEventsPager` so the scope contract scans credit it to
 * the function that calls `exportDeviceSet`.
 */
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../../db';
import { deviceHardwareComponents, deviceHardwareEvents } from '../../db/schema';
import {
  deviceIdIn,
  emptyExportPager,
  exportDeviceSet,
  exportJsonText,
  exportText,
  keysetBefore,
  keysetPager,
  runExportQuery,
  timeRangeFromFilters,
} from '../aiToolsExportShared';
import type { DatasetAdapter, DatasetRequest } from '../aiToolsExportDatasets';

async function createHardwareEventsPager(req: DatasetRequest) {
  const { start, end } = timeRangeFromFilters(req.filters);
  const scope = await exportDeviceSet(req);
  if (scope.deviceIds.length === 0) return emptyExportPager;

  return keysetPager({
    pageSize: req.pageSize,
    shape: ['timestamptz', 'uuid'],
    fetch: async (after, limit) => {
      const e = deviceHardwareEvents;
      const c = deviceHardwareComponents;
      return await runExportQuery(
        db
          .select({
            id: e.id,
            deviceId: e.deviceId,
            occurredAt: e.occurredAt,
            // The keyset key: full microsecond precision and offset, never a JS Date.
            occurredAtText: sql<string>`${e.occurredAt}::text`,
            componentKey: e.componentKey,
            componentType: e.componentType,
            componentName: c.name,
            model: c.model,
            serial: c.serial,
            firmware: c.firmware,
            eventType: e.eventType,
            fromHealth: e.fromHealth,
            toHealth: e.toHealth,
            fromState: e.fromState,
            toState: e.toState,
            detail: e.detail,
          })
          .from(deviceHardwareEvents)
          .leftJoin(deviceHardwareComponents, and(
            eq(c.deviceId, e.deviceId),
            eq(c.componentKey, e.componentKey),
            eq(c.orgId, e.orgId),
          ))
          .where(and(
            eq(e.orgId, req.orgId),
            deviceIdIn(e.deviceId, scope.deviceIds),
            gte(e.occurredAt, start),
            lte(e.occurredAt, end),
            keysetBefore(e.occurredAt, e.id, after, 'timestamptz'),
          ))
          .orderBy(desc(e.occurredAt), desc(e.id))
          .limit(limit),
      );
    },
    keyOf: (row) => [row.occurredAtText, row.id],
    toRows: (rows) => rows.map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      hostname: scope.hostnames.get(row.deviceId) ?? null,
      occurredAt: row.occurredAt.toISOString(),
      // Agent-reported text: redacted (incl. user-profile paths) then cut.
      componentKey: exportText(row.componentKey, { paths: true }),
      componentType: row.componentType,
      componentName: exportText(row.componentName, { paths: true }),
      model: exportText(row.model, { paths: true }),
      serial: exportText(row.serial, { paths: true }),
      firmware: exportText(row.firmware, { paths: true }),
      eventType: row.eventType,
      fromHealth: row.fromHealth,
      toHealth: row.toHealth,
      fromState: exportText(row.fromState, { paths: true }),
      toState: exportText(row.toState, { paths: true }),
      detail: exportJsonText(row.detail, { paths: true }),
    })),
  });
}

export const hardwareEventsAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  createPager: createHardwareEventsPager,
};
