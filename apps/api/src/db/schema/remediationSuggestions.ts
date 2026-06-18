import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  integer,
  doublePrecision,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { organizations } from './orgs';
import { devices } from './devices';
import { users } from './users';
import { alerts, alertCorrelationGroups } from './alerts';
import { metricAnomalies } from './analytics';
import { scripts, scriptExecutions, scriptTemplates } from './scripts';
import { playbookDefinitions, playbookExecutions } from './playbooks';
import { aiToolExecutions } from './ai';
import { elevationRequests } from './elevations';

export const remediationSuggestions = pgTable('remediation_suggestions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  sourceType: varchar('source_type', { length: 40 }).notNull(),
  sourceId: varchar('source_id', { length: 255 }).notNull(),
  deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
  alertId: uuid('alert_id').references(() => alerts.id, { onDelete: 'set null' }),
  anomalyId: uuid('anomaly_id').references(() => metricAnomalies.id, { onDelete: 'set null' }),
  correlationGroupId: uuid('correlation_group_id').references(() => alertCorrelationGroups.id, { onDelete: 'set null' }),
  rcaId: varchar('rca_id', { length: 255 }),
  targetType: varchar('target_type', { length: 40 }).notNull(),
  scriptId: uuid('script_id').references(() => scripts.id, { onDelete: 'set null' }),
  scriptTemplateId: uuid('script_template_id').references(() => scriptTemplates.id, { onDelete: 'set null' }),
  playbookId: uuid('playbook_id').references(() => playbookDefinitions.id, { onDelete: 'set null' }),
  title: varchar('title', { length: 255 }).notNull(),
  rationale: text('rationale').notNull(),
  expectedAction: text('expected_action').notNull(),
  riskTier: varchar('risk_tier', { length: 20 }).notNull().default('medium'),
  status: varchar('status', { length: 40 }).notNull().default('suggested'),
  confidence: doublePrecision('confidence'),
  evidence: jsonb('evidence').notNull().default({}),
  parameters: jsonb('parameters').notNull().default({}),
  targetDeviceIds: uuid('target_device_ids').array().notNull().default([]),
  elevationRequestId: uuid('elevation_request_id').references(() => elevationRequests.id, { onDelete: 'set null' }),
  toolExecutionId: uuid('tool_execution_id').references(() => aiToolExecutions.id, { onDelete: 'set null' }),
  scriptExecutionId: uuid('script_execution_id').references(() => scriptExecutions.id, { onDelete: 'set null' }),
  playbookExecutionId: uuid('playbook_execution_id').references(() => playbookExecutions.id, { onDelete: 'set null' }),
  editedBy: uuid('edited_by').references(() => users.id),
  acceptedBy: uuid('accepted_by').references(() => users.id),
  rejectedBy: uuid('rejected_by').references(() => users.id),
  executedBy: uuid('executed_by').references(() => users.id),
  failureMessage: text('failure_message'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  acceptedAt: timestamp('accepted_at'),
  rejectedAt: timestamp('rejected_at'),
  executedAt: timestamp('executed_at'),
}, (table) => ({
  sourceScriptUniq: uniqueIndex('remediation_suggestions_source_script_uq').on(
    table.orgId,
    table.sourceType,
    table.sourceId,
    table.scriptId
  ).where(sql`target_type = 'script'`),
  sourceTemplateUniq: uniqueIndex('remediation_suggestions_source_template_uq').on(
    table.orgId,
    table.sourceType,
    table.sourceId,
    table.scriptTemplateId
  ).where(sql`target_type = 'script_template'`),
  sourcePlaybookUniq: uniqueIndex('remediation_suggestions_source_playbook_uq').on(
    table.orgId,
    table.sourceType,
    table.sourceId,
    table.playbookId
  ).where(sql`target_type = 'playbook'`),
  sourceDiagnosticUniq: uniqueIndex('remediation_suggestions_source_diagnostic_uq').on(
    table.orgId,
    table.sourceType,
    table.sourceId,
    table.targetType
  ).where(sql`target_type = 'diagnostic'`),
  orgStatusIdx: index('remediation_suggestions_org_status_idx').on(table.orgId, table.status, table.createdAt),
  sourceIdx: index('remediation_suggestions_source_idx').on(table.orgId, table.sourceType, table.sourceId),
  deviceStatusIdx: index('remediation_suggestions_device_status_idx').on(table.deviceId, table.status, table.createdAt),
  alertIdx: index('remediation_suggestions_alert_idx').on(table.alertId),
  anomalyIdx: index('remediation_suggestions_anomaly_idx').on(table.anomalyId),
}));
