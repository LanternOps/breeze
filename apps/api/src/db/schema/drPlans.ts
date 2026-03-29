import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';

export const drPlans = pgTable(
  'dr_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description'),
    status: varchar('status', { length: 20 }).notNull().default('draft'),
    rpoTargetMinutes: integer('rpo_target_minutes'),
    rtoTargetMinutes: integer('rto_target_minutes'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index('dr_plans_org_idx').on(table.orgId),
  })
);

export const drPlanGroups = pgTable(
  'dr_plan_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => drPlans.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    name: varchar('name', { length: 200 }).notNull(),
    sequence: integer('sequence').notNull().default(0),
    dependsOnGroupId: uuid('depends_on_group_id').references(
      (): AnyPgColumn => drPlanGroups.id
    ),
    devices: jsonb('devices').$type<string[]>().default([]),
    restoreConfig: jsonb('restore_config').$type<Record<string, unknown>>().default({}),
    estimatedDurationMinutes: integer('estimated_duration_minutes'),
  },
  (table) => ({
    planIdx: index('dr_groups_plan_idx').on(table.planId),
  })
);

export const drExecutions = pgTable(
  'dr_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => drPlans.id),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    executionType: varchar('execution_type', { length: 20 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    initiatedBy: uuid('initiated_by').references(() => users.id),
    results: jsonb('results'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    planIdx: index('dr_executions_plan_idx').on(table.planId),
    orgIdx: index('dr_executions_org_idx').on(table.orgId),
  })
);
