import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { organizations } from './orgs';
import { users } from './users';

export const sensitiveDataPolicies = pgTable('sensitive_data_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 200 }).notNull(),
  scope: jsonb('scope').notNull().default({}),
  detectionClasses: jsonb('detection_classes').notNull().default([]),
  schedule: jsonb('schedule'),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  orgIdx: index('sensitive_policy_org_idx').on(table.orgId),
}));

export const sensitiveDataScans = pgTable('sensitive_data_scans', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  policyId: uuid('policy_id').references(() => sensitiveDataPolicies.id),
  requestedBy: uuid('requested_by').references(() => users.id),
  status: varchar('status', { length: 20 }).notNull().default('queued'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  idempotencyKey: varchar('idempotency_key', { length: 128 }),
  requestFingerprint: varchar('request_fingerprint', { length: 64 }),
  summary: jsonb('summary'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  orgDeviceIdx: index('sensitive_scan_org_device_idx').on(table.orgId, table.deviceId),
  statusIdx: index('sensitive_scan_status_idx').on(table.status),
  orgIdempotencyIdx: index('sensitive_scan_org_idempotency_idx').on(table.orgId, table.idempotencyKey),
}));

export const sensitiveDataFindings = pgTable('sensitive_data_findings', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  scanId: uuid('scan_id').notNull().references(() => sensitiveDataScans.id),
  filePath: text('file_path').notNull(),
  dataType: varchar('data_type', { length: 20 }).notNull(),
  patternId: varchar('pattern_id', { length: 80 }).notNull(),
  matchCount: integer('match_count').notNull().default(1),
  risk: varchar('risk', { length: 20 }).notNull(),
  confidence: real('confidence').notNull().default(0.5),
  fileOwner: varchar('file_owner', { length: 255 }),
  fileModifiedAt: timestamp('file_modified_at'),
  firstSeenAt: timestamp('first_seen_at').defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
  occurrenceCount: integer('occurrence_count').notNull().default(1),
  status: varchar('status', { length: 20 }).notNull().default('open'),
  remediationAction: varchar('remediation_action', { length: 40 }),
  remediationMetadata: jsonb('remediation_metadata'),
  remediatedAt: timestamp('remediated_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  orgRiskIdx: index('sensitive_findings_org_risk_idx').on(table.orgId, table.risk),
  scanIdx: index('sensitive_findings_scan_idx').on(table.scanId),
  orgLastSeenIdx: index('sensitive_findings_org_last_seen_idx').on(table.orgId, table.lastSeenAt),
}));
