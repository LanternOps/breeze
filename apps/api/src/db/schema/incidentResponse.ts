import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';

export const incidentSeverityEnum = pgEnum('incident_severity', ['p1', 'p2', 'p3', 'p4']);
export const incidentStatusEnum = pgEnum('incident_status', [
  'detected',
  'analyzing',
  'contained',
  'recovering',
  'closed',
]);
export const incidentEvidenceTypeEnum = pgEnum('incident_evidence_type', [
  'file',
  'log',
  'screenshot',
  'memory',
  'network',
]);
export const incidentCollectedByEnum = pgEnum('incident_collected_by', ['user', 'brain', 'system']);
export const incidentActionActorEnum = pgEnum('incident_action_actor', ['user', 'brain', 'system']);
export const incidentActionStatusEnum = pgEnum('incident_action_status', [
  'pending',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
]);
export const incidentHashAlgorithmEnum = pgEnum('incident_hash_algorithm', ['sha256']);

export interface IncidentTimelineEntry {
  at: string;
  type: string;
  actor: 'user' | 'brain' | 'system';
  summary: string;
  metadata?: Record<string, unknown>;
}

export const incidents = pgTable('incidents', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  title: text('title').notNull(),
  classification: varchar('classification', { length: 40 }).notNull(),
  severity: incidentSeverityEnum('severity').notNull(),
  status: incidentStatusEnum('status').notNull().default('detected'),
  summary: text('summary'),
  relatedAlerts: jsonb('related_alerts').$type<string[]>().notNull().default([]),
  affectedDevices: jsonb('affected_devices').$type<string[]>().notNull().default([]),
  timeline: jsonb('timeline').$type<IncidentTimelineEntry[]>().notNull().default([]),
  assignedTo: uuid('assigned_to').references(() => users.id),
  detectedAt: timestamp('detected_at').notNull(),
  containedAt: timestamp('contained_at'),
  resolvedAt: timestamp('resolved_at'),
  closedAt: timestamp('closed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  orgStatusIdx: index('incidents_org_status_idx').on(table.orgId, table.status),
  severityIdx: index('incidents_severity_idx').on(table.severity),
  assignedToIdx: index('incidents_assigned_to_idx').on(table.assignedTo),
  detectedAtIdx: index('incidents_detected_at_idx').on(table.detectedAt),
}));

export const incidentEvidence = pgTable('incident_evidence', {
  id: uuid('id').primaryKey().defaultRandom(),
  incidentId: uuid('incident_id').notNull().references(() => incidents.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  evidenceType: incidentEvidenceTypeEnum('evidence_type').notNull(),
  description: text('description'),
  collectedAt: timestamp('collected_at').notNull(),
  collectedBy: incidentCollectedByEnum('collected_by').notNull().default('user'),
  hash: varchar('hash', { length: 64 }),
  hashAlgorithm: incidentHashAlgorithmEnum('hash_algorithm').notNull().default('sha256'),
  storagePath: text('storage_path').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  incidentIdx: index('incident_evidence_incident_idx').on(table.incidentId),
  orgIdx: index('incident_evidence_org_idx').on(table.orgId),
  collectedAtIdx: index('incident_evidence_collected_at_idx').on(table.collectedAt),
}));

export const incidentActions = pgTable('incident_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  incidentId: uuid('incident_id').notNull().references(() => incidents.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  actionType: varchar('action_type', { length: 40 }).notNull(),
  description: text('description').notNull(),
  executedBy: incidentActionActorEnum('executed_by').notNull().default('user'),
  status: incidentActionStatusEnum('status').notNull().default('completed'),
  result: jsonb('result').$type<Record<string, unknown>>(),
  reversible: boolean('reversible').notNull().default(false),
  reversed: boolean('reversed').notNull().default(false),
  approvalRef: varchar('approval_ref', { length: 128 }),
  executedAt: timestamp('executed_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  incidentIdx: index('incident_actions_incident_idx').on(table.incidentId),
  orgIdx: index('incident_actions_org_idx').on(table.orgId),
  executedAtIdx: index('incident_actions_executed_at_idx').on(table.executedAt),
  statusIdx: index('incident_actions_status_idx').on(table.status),
  actionTypeIdx: index('incident_actions_action_type_idx').on(table.actionType),
  orgStatusIdx: index('incident_actions_org_status_idx').on(table.orgId, table.status),
  incidentExecutedAtIdx: index('incident_actions_incident_executed_at_idx').on(table.incidentId, table.executedAt),
}));
