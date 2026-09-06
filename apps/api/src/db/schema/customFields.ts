import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum } from 'drizzle-orm/pg-core';
import { organizations, partners } from './orgs';

export const customFieldTypeEnum = pgEnum('custom_field_type', [
  'text',
  'number',
  'boolean',
  'dropdown',
  'date'
]);

/**
 * Three database-level rules on this table are invisible to Drizzle — it models
 * columns, not constraints, indexes or triggers — so they are recorded here for
 * anyone reading the schema to work out what a write can fail with:
 *
 *  - `custom_field_definitions_one_owner_chk` (#3257 W02): `org_id` XOR
 *    `partner_id`. Violations raise 23514.
 *  - `custom_field_definitions_{org,partner}_key_uq` (#3257 W02): `field_key` is
 *    unique per owner, on each axis independently. Violations raise 23505.
 *  - `custom_field_definitions_no_shadow` (#3257 W03,
 *    `2026-10-11-141000-custom-field-no-cross-axis-shadowing.sql`): a BEFORE
 *    INSERT/UPDATE trigger forbidding an org-owned `field_key` from colliding
 *    with a partner-wide one under that org's partner, in either direction.
 *    Violations raise **P0001** with operator-facing copy naming the key and the
 *    colliding axis — `routes/customFields.ts` maps it to a 409 rather than
 *    letting it surface as a 500.
 *
 * The trigger exists because `devices.custom_fields` is a FLAT jsonb object: two
 * definitions for one key means one datum with two identities, which the partner
 * export and #3257 W05's normalized value table cannot represent.
 */
export const customFieldDefinitions = pgTable('custom_field_definitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  name: varchar('name', { length: 100 }).notNull(),
  fieldKey: varchar('field_key', { length: 100 }).notNull(),
  type: customFieldTypeEnum('type').notNull(),
  options: jsonb('options'),
  required: boolean('required').notNull().default(false),
  defaultValue: jsonb('default_value'),
  deviceTypes: text('device_types').array(),
  // #2698: per-field opt-in for script write-back. Default false so no
  // existing field silently becomes writable by any script that runs.
  scriptWrite: boolean('script_write').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});
