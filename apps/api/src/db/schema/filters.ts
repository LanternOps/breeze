import { pgTable, uuid, varchar, text, timestamp, jsonb, integer, pgEnum, primaryKey, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { organizations, partners } from './orgs';
import { users } from './users';

export const savedFilterScopeEnum = pgEnum('saved_filter_scope', ['private', 'org', 'partner']);

export const savedFilterFolders = pgTable('saved_filter_folders', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 200 }).notNull(),
  parentId: uuid('parent_id').references((): AnyPgColumn => savedFilterFolders.id, { onDelete: 'cascade' }),
  sortOrder: integer('sort_order').notNull().default(0),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
});

export const savedFilters = pgTable('saved_filters', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Dual-axis tenancy: exactly one of orgId/partnerId is set (CHECK enforced in migration).
  // org_id → org-scoped filter; partner_id → partner-wide filter visible across all the partner's orgs.
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  conditions: jsonb('conditions').notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  scope: savedFilterScopeEnum('scope').notNull().default('private'),
  folderId: uuid('folder_id').references(() => savedFilterFolders.id, { onDelete: 'set null' }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  useCount: integer('use_count').notNull().default(0),
  icon: varchar('icon', { length: 50 }),
  color: varchar('color', { length: 7 })
});

export const savedFilterStars = pgTable('saved_filter_stars', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  filterId: uuid('filter_id').notNull().references(() => savedFilters.id, { onDelete: 'cascade' }),
  starredAt: timestamp('starred_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.filterId] })
}));
