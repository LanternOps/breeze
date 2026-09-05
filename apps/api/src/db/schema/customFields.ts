import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum } from 'drizzle-orm/pg-core';
import { organizations, partners } from './orgs';

export const customFieldTypeEnum = pgEnum('custom_field_type', [
  'text',
  'number',
  'boolean',
  'dropdown',
  'date'
]);

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
