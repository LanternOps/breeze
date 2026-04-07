import { describe, expect, it } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../db/schema';
import { DEVICE_CASCADE_DELETE_TABLES, DEVICE_LINKED_DEVICE_ID_TABLES } from './core';

/**
 * Tables that have a column named `device_id` but it does NOT reference devices.id.
 * Add a table here only when its device_id FK points to a different table.
 */
const NOT_DEVICES_FK: ReadonlySet<string> = new Set([
  'mobile_devices',        // device_id is a varchar identifier, not a FK to devices
  'snmp_alert_thresholds', // device_id → snmp_devices.id
  'snmp_metrics',          // device_id → snmp_devices.id
]);

function getTableColumns(table: PgTable<any>): any[] {
  return Object.values(
    (table as any)[Symbol.for('drizzle:Columns')] ?? {}
  );
}

describe('DEVICE_CASCADE_DELETE_TABLES coverage', () => {
  it('includes every table whose device_id FK references devices.id', () => {
    const cascadeSet = new Set(DEVICE_CASCADE_DELETE_TABLES);
    const allTables = Object.values(schema).filter(
      (v): v is PgTable<any> => v instanceof PgTable
    );

    const missing: string[] = [];

    for (const table of allTables) {
      const tableName = getTableName(table);
      if (NOT_DEVICES_FK.has(tableName)) continue;

      const hasDeviceId = getTableColumns(table).some((col) => col.name === 'device_id');

      if (hasDeviceId && !cascadeSet.has(tableName)) {
        missing.push(tableName);
      }
    }

    expect(
      missing,
      `These tables have a device_id FK but are missing from DEVICE_CASCADE_DELETE_TABLES in core.ts. ` +
        `Add them to the array (order matters — children before parents). ` +
        `If the device_id column references a table other than devices, add to NOT_DEVICES_FK in this test instead.\n\n` +
        `Missing: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('includes every table whose linked_device_id FK references devices.id', () => {
    const linkedSet = new Set(DEVICE_LINKED_DEVICE_ID_TABLES);
    const allTables = Object.values(schema).filter(
      (v): v is PgTable<any> => v instanceof PgTable
    );

    const missing: string[] = [];

    for (const table of allTables) {
      const tableName = getTableName(table);
      const hasLinkedDeviceId = getTableColumns(table).some(
        (col) => col.name === 'linked_device_id'
      );

      if (hasLinkedDeviceId && !linkedSet.has(tableName)) {
        missing.push(tableName);
      }
    }

    expect(
      missing,
      `These tables have a linked_device_id FK but are missing from DEVICE_LINKED_DEVICE_ID_TABLES in core.ts. ` +
        `Add them so linked_device_id gets SET NULL during cascade delete.\n\n` +
        `Missing: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('does not list tables that no longer exist in the schema', () => {
    const allTableNames = new Set(
      Object.values(schema)
        .filter((v): v is PgTable<any> => v instanceof PgTable)
        .map((t) => getTableName(t))
    );

    const staleCascade = DEVICE_CASCADE_DELETE_TABLES.filter(
      (t) => !allTableNames.has(t)
    );
    const staleLinked = DEVICE_LINKED_DEVICE_ID_TABLES.filter(
      (t) => !allTableNames.has(t)
    );

    expect(
      staleCascade,
      `These tables are in DEVICE_CASCADE_DELETE_TABLES but no longer exist in the schema. Remove them.`
    ).toEqual([]);
    expect(
      staleLinked,
      `These tables are in DEVICE_LINKED_DEVICE_ID_TABLES but no longer exist in the schema. Remove them.`
    ).toEqual([]);
  });
});
