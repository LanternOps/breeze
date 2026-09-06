import { boolean, date, doublePrecision, foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { customFieldDefinitions } from './customFields';

/**
 * Normalized custom-field values for devices (#3257 W05).
 *
 * This table is the SOURCE OF TRUTH. `devices.custom_fields` survives only as
 * a trigger-maintained PROJECTION (`breeze_device_custom_field_project`) kept
 * in sync for the ~34 existing JS readers and the two partner-export
 * statement triggers — it must NOT be written directly; every write goes
 * through this table instead.
 *
 * `field_key` is denormalized off `custom_field_definitions.field_key` on
 * purpose: `services/tenantExport.ts` does a bare column projection with no
 * joins, so a definition_id-only row would export as an opaque uuid the data
 * subject cannot read. The BEFORE INSERT/UPDATE trigger
 * `breeze_device_custom_field_value_coherent()` is what keeps the
 * denormalized copy honest against its (dual-axis org/partner)
 * `custom_field_definitions` row.
 *
 * Tenancy: RLS shape 5 (device-id scoped, hot, DENORMALIZED `org_id`) via a
 * direct `breeze_has_org_access(org_id)` policy, structurally pinned to its
 * device by the composite FK below.
 */
export const deviceCustomFieldValues = pgTable('device_custom_field_values', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull(),
  orgId: uuid('org_id').notNull(),
  definitionId: uuid('definition_id').notNull().references(() => customFieldDefinitions.id, { onDelete: 'cascade' }),
  fieldKey: varchar('field_key', { length: 100 }).notNull(),
  valueText: text('value_text'),
  valueNumber: doublePrecision('value_number'),
  valueBool: boolean('value_bool'),
  valueDate: date('value_date'),
  // 'manual' | 'api' | 'script' | 'import' | 'backfill'
  source: varchar('source', { length: 32 }).notNull().default('manual'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  // Structurally pins every value row to the SAME org as its device.
  // DEFERRABLE INITIALLY DEFERRED in SQL (org merge and the device-move
  // rehome helper re-point both sides in separate statements); Drizzle does
  // not model deferrability, so the migration is the source of truth.
  deviceCustomFieldValuesDeviceOrgFk: foreignKey({
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
    name: 'device_custom_field_values_device_org_fk',
  }).onUpdate('cascade').onDelete('cascade'),
  deviceCustomFieldValuesDeviceDefUq: uniqueIndex('device_custom_field_values_device_def_uq')
    .on(table.deviceId, table.definitionId),
  deviceCustomFieldValuesOrgKeyTextIdx: index('device_custom_field_values_org_key_text_idx')
    .on(table.orgId, table.fieldKey, table.valueText),
  deviceCustomFieldValuesDefinitionIdx: index('device_custom_field_values_definition_idx').on(table.definitionId),
  deviceCustomFieldValuesDeviceIdx: index('device_custom_field_values_device_idx').on(table.deviceId),
}));

export type DeviceCustomFieldValue = typeof deviceCustomFieldValues.$inferSelect;
export type NewDeviceCustomFieldValue = typeof deviceCustomFieldValues.$inferInsert;
