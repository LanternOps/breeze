import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';
import { backupJobs, backupSnapshots } from './backup';

export const backupVerifications = pgTable('backup_verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  backupJobId: uuid('backup_job_id').notNull().references(() => backupJobs.id),
  snapshotId: uuid('snapshot_id').references(() => backupSnapshots.id),
  verificationType: varchar('verification_type', { length: 30 }).notNull(), // integrity|test_restore
  status: varchar('status', { length: 20 }).notNull(), // passed|failed|partial
  startedAt: timestamp('started_at').notNull(),
  completedAt: timestamp('completed_at'),
  restoreTimeSeconds: integer('restore_time_seconds'),
  filesVerified: integer('files_verified').default(0),
  filesFailed: integer('files_failed').default(0),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  details: jsonb('details'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  orgDeviceIdx: index('backup_verify_org_device_idx').on(table.orgId, table.deviceId),
  statusIdx: index('backup_verify_status_idx').on(table.status),
}));

export const recoveryReadiness = pgTable('recovery_readiness', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  readinessScore: integer('readiness_score').notNull(),
  estimatedRtoMinutes: integer('estimated_rto_minutes'),
  estimatedRpoMinutes: integer('estimated_rpo_minutes'),
  riskFactors: jsonb('risk_factors'),
  calculatedAt: timestamp('calculated_at').notNull(),
}, (table) => ({
  orgScoreIdx: index('recovery_readiness_org_score_idx').on(table.orgId, table.readinessScore),
  orgDeviceUnique: uniqueIndex('recovery_readiness_org_device_unique').on(table.orgId, table.deviceId),
}));
