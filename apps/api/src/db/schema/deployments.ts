import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  pgEnum,
  integer,
  uniqueIndex
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import { devices } from './devices';

export const deploymentStatusEnum = pgEnum('deployment_status', [
  'draft',
  'pending',
  'running',
  'paused',
  'downloading',
  'installing',
  'completed',
  'failed',
  'cancelled',
  'rollback'
]);

export const deploymentDeviceStatusEnum = pgEnum('deployment_device_status', [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped'
]);

export const deployments = pgTable('deployments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 200 }).notNull(),
  type: varchar('type', { length: 50 }).notNull(),
  payload: jsonb('payload').notNull(),
  targetType: varchar('target_type', { length: 20 }).notNull(),
  targetConfig: jsonb('target_config').notNull(),
  schedule: jsonb('schedule'),
  rolloutConfig: jsonb('rollout_config').notNull(),
  status: deploymentStatusEnum('status').notNull().default('draft'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at')
});

export const deploymentDevices = pgTable('deployment_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  deploymentId: uuid('deployment_id').notNull().references(() => deployments.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  batchNumber: integer('batch_number'),
  status: deploymentDeviceStatusEnum('status').notNull().default('pending'),
  retryCount: integer('retry_count').notNull().default(0),
  maxRetries: integer('max_retries').notNull().default(3),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  result: jsonb('result')
}, (table) => ({
  deploymentDeviceUnique: uniqueIndex('deployment_devices_deployment_device_unique').on(
    table.deploymentId,
    table.deviceId
  )
}));
