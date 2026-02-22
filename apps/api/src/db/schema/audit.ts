import { pgTable, uuid, varchar, text, timestamp, jsonb, pgEnum, integer, boolean } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';

export const actorTypeEnum = pgEnum('actor_type', ['user', 'api_key', 'agent', 'system']);
export const auditResultEnum = pgEnum('audit_result', ['success', 'failure', 'denied']);
export const initiatedByEnum = pgEnum('initiated_by_type', ['manual', 'ai', 'automation', 'policy', 'schedule', 'agent', 'integration']);

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  actorType: actorTypeEnum('actor_type').notNull(),
  actorId: uuid('actor_id').notNull(),
  actorEmail: varchar('actor_email', { length: 255 }),
  action: varchar('action', { length: 100 }).notNull(),
  resourceType: varchar('resource_type', { length: 50 }).notNull(),
  resourceId: uuid('resource_id'),
  resourceName: varchar('resource_name', { length: 255 }),
  details: jsonb('details'),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: text('user_agent'),
  result: auditResultEnum('result').notNull(),
  errorMessage: text('error_message'),
  checksum: varchar('checksum', { length: 128 }),
  initiatedBy: initiatedByEnum('initiated_by'),
});

export const auditRetentionPolicies = pgTable('audit_retention_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  retentionDays: integer('retention_days').notNull().default(365),
  archiveToS3: boolean('archive_to_s3').notNull().default(false),
  lastCleanupAt: timestamp('last_cleanup_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});
