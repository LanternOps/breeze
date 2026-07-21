import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import type { TicketFormField } from '@breeze/shared';
import { organizations, partners } from './orgs';
import { users } from './users';
import { ticketCategories } from './tickets';
import { ticketPriorityEnum } from './portal';

/**
 * Ticket intake forms (spec: docs/superpowers/specs/ticketing/2026-07-10-ticket-intake-forms-design.md).
 * Dual-axis ownership (Partner-Wide First, epic #2135): org_id XOR partner_id,
 * enforced by ticket_forms_one_owner_chk in the migration. Field definitions
 * are a self-contained jsonb document validated by ticketFormFieldsSchema in
 * packages/shared — NOT rows in custom_field_definitions (device-only system).
 */
export const ticketForms = pgTable(
  'ticket_forms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description'),
    // Plain FK; partner ownership of the category is validated app-side
    // (assertCategoryInPartner), same as tickets.category_id.
    categoryId: uuid('category_id').references(() => ticketCategories.id, { onDelete: 'set null' }),
    fields: jsonb('fields').$type<TicketFormField[]>().notNull().default([]),
    titleTemplate: varchar('title_template', { length: 300 }),
    descriptionIntro: text('description_intro'),
    defaultPriority: ticketPriorityEnum('default_priority'),
    defaultTags: text('default_tags').array().notNull().default([]),
    showInPortal: boolean('show_in_portal').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull()
  },
  (t) => [index('ticket_forms_partner_id_idx').on(t.partnerId), index('ticket_forms_org_id_idx').on(t.orgId)]
);
