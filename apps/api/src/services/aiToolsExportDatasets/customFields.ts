/**
 * `custom_fields` for `export_dataset`, set-based (Wisp analysis sessions W05
 * carry-over). Replaces the per-device adapter that ran one access check per
 * device.
 *
 * One definitions read (the shared `readCustomFieldDefinitions`: org XOR
 * partner, so partner-wide definitions are kept), one `exportDeviceSet` call,
 * then one keyset page of devices per call (`devices.id` ascending), each
 * device expanded to one row per definition. A page holds at most
 * `floor(pageSize / definitions)` devices, so a page stays near `pageSize`
 * rows.
 *
 * Shape unchanged: one row per device x definition. Values are free text a
 * technician typed, so a string value is now redacted (secret assignments and
 * bare tokens) and cut like every other export cell; numbers and booleans pass
 * through; any other JSON value is exported as redacted JSON text.
 */
import { and, asc, eq, gt } from 'drizzle-orm';
import { db } from '../../db';
import { devices } from '../../db/schema';
import {
  deviceIdIn,
  emptyExportPager,
  exportDeviceSet,
  exportJsonText,
  exportText,
  keysetPager,
  runExportQuery,
} from '../aiToolsExportShared';
import type { DatasetAdapter, DatasetRequest } from '../aiToolsExportDatasets';
import type { readCustomFieldDefinitions as ReadCustomFieldDefinitionsFn } from '../aiToolsDevice';
import { withRequestedDevicesAsFrame } from './legacyFrame';

/** Lazy: `aiToolsDevice` imports `aiTools`, which registers this tool at load
 *  (the same cycle the hub's own lazy import breaks). */
async function getReadCustomFieldDefinitions(): Promise<typeof ReadCustomFieldDefinitionsFn> {
  return (await import('../aiToolsDevice')).readCustomFieldDefinitions;
}

function exportFieldValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return exportText(value);
  return exportJsonText(value);
}

async function createCustomFieldsPager(req: DatasetRequest) {
  const scope = await exportDeviceSet(withRequestedDevicesAsFrame(req));
  if (scope.deviceIds.length === 0) return emptyExportPager;
  const readCustomFieldDefinitions = await getReadCustomFieldDefinitions();
  const definitions = await readCustomFieldDefinitions(req.auth);
  if (definitions.length === 0) return emptyExportPager;

  return keysetPager({
    pageSize: Math.max(1, Math.floor(req.pageSize / definitions.length)),
    shape: ['uuid'],
    fetch: async (after, limit) => {
      const d = devices;
      return await runExportQuery(
        db
          .select({ id: d.id, customFields: d.customFields })
          .from(devices)
          .where(and(
            eq(d.orgId, req.orgId),
            deviceIdIn(d.id, scope.deviceIds),
            after ? gt(d.id, after[0]!) : undefined,
          ))
          .orderBy(asc(d.id))
          .limit(limit),
      );
    },
    keyOf: (row) => [row.id],
    toRows: (rows) => rows.flatMap((row) => {
      const values = (row.customFields ?? {}) as Record<string, unknown>;
      return definitions.map((definition) => ({
        deviceId: row.id,
        hostname: scope.hostnames.get(row.id) ?? null,
        fieldKey: definition.fieldKey,
        fieldName: exportText(definition.name),
        fieldType: definition.type,
        value: exportFieldValue(values[definition.fieldKey]),
      }));
    }),
  });
}

export const customFieldsAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  createPager: createCustomFieldsPager,
};
