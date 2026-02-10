import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  pgEnum,
  integer,
  index,
  uniqueIndex
} from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { users } from './users';
import { organizations } from './orgs';

export const securityProviderEnum = pgEnum('security_provider', [
  'windows_defender',
  'bitdefender',
  'sophos',
  'sentinelone',
  'crowdstrike',
  'malwarebytes',
  'eset',
  'kaspersky',
  'other'
]);

export const threatSeverityEnum = pgEnum('threat_severity', [
  'low',
  'medium',
  'high',
  'critical'
]);

export const threatStatusEnum = pgEnum('threat_status', [
  'detected',
  'quarantined',
  'removed',
  'allowed',
  'failed'
]);

export const securityRiskLevelEnum = pgEnum('security_risk_level', [
  'low',
  'medium',
  'high',
  'critical'
]);

export const securityStatus = pgTable('security_status', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  provider: securityProviderEnum('provider').notNull(),
  providerVersion: varchar('provider_version', { length: 50 }),
  definitionsVersion: varchar('definitions_version', { length: 100 }),
  definitionsDate: timestamp('definitions_date'),
  realTimeProtection: boolean('real_time_protection'),
  lastScan: timestamp('last_scan'),
  lastScanType: varchar('last_scan_type', { length: 50 }),
  threatCount: integer('threat_count').notNull().default(0),
  firewallEnabled: boolean('firewall_enabled'),
  encryptionStatus: varchar('encryption_status', { length: 50 }),
  encryptionDetails: jsonb('encryption_details'),
  localAdminSummary: jsonb('local_admin_summary'),
  passwordPolicySummary: jsonb('password_policy_summary'),
  gatekeeperEnabled: boolean('gatekeeper_enabled'),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  deviceUnique: uniqueIndex('security_status_device_id_unique').on(table.deviceId),
  providerIdx: index('security_status_provider_idx').on(table.provider)
}));

export const securityThreats = pgTable('security_threats', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  provider: securityProviderEnum('provider').notNull(),
  threatName: varchar('threat_name', { length: 200 }).notNull(),
  threatType: varchar('threat_type', { length: 100 }),
  severity: threatSeverityEnum('severity').notNull(),
  status: threatStatusEnum('status').notNull(),
  filePath: text('file_path'),
  processName: varchar('process_name', { length: 200 }),
  detectedAt: timestamp('detected_at').notNull(),
  resolvedAt: timestamp('resolved_at'),
  resolvedBy: varchar('resolved_by', { length: 100 }),
  details: jsonb('details')
}, (table) => ({
  deviceDetectedIdx: index('security_threats_device_detected_idx').on(table.deviceId, table.detectedAt),
  statusIdx: index('security_threats_status_idx').on(table.status)
}));

export const securityScans = pgTable('security_scans', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  scanType: varchar('scan_type', { length: 50 }).notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  itemsScanned: integer('items_scanned'),
  threatsFound: integer('threats_found'),
  duration: integer('duration'),
  initiatedBy: uuid('initiated_by').references(() => users.id)
}, (table) => ({
  deviceStartedIdx: index('security_scans_device_started_idx').on(table.deviceId, table.startedAt),
  statusIdx: index('security_scans_status_idx').on(table.status)
}));

export const securityPolicies = pgTable('security_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  settings: jsonb('settings').notNull().default({}),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  orgIdx: index('security_policies_org_id_idx').on(table.orgId)
}));

export const securityPostureSnapshots = pgTable('security_posture_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  capturedAt: timestamp('captured_at').defaultNow().notNull(),
  overallScore: integer('overall_score').notNull(),
  riskLevel: securityRiskLevelEnum('risk_level').notNull(),
  patchComplianceScore: integer('patch_compliance_score').notNull(),
  encryptionScore: integer('encryption_score').notNull(),
  avHealthScore: integer('av_health_score').notNull(),
  firewallScore: integer('firewall_score').notNull(),
  openPortsScore: integer('open_ports_score').notNull(),
  passwordPolicyScore: integer('password_policy_score').notNull(),
  osCurrencyScore: integer('os_currency_score').notNull(),
  adminExposureScore: integer('admin_exposure_score').notNull(),
  factorDetails: jsonb('factor_details').notNull().default({}),
  recommendations: jsonb('recommendations').notNull().default([])
}, (table) => ({
  orgCapturedIdx: index('security_posture_snapshots_org_captured_idx').on(table.orgId, table.capturedAt),
  deviceCapturedIdx: index('security_posture_snapshots_device_captured_idx').on(table.deviceId, table.capturedAt),
  orgScoreIdx: index('security_posture_snapshots_org_score_idx').on(table.orgId, table.overallScore)
}));

export const securityPostureOrgSnapshots = pgTable('security_posture_org_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  capturedAt: timestamp('captured_at').defaultNow().notNull(),
  overallScore: integer('overall_score').notNull(),
  devicesAudited: integer('devices_audited').notNull().default(0),
  lowRiskDevices: integer('low_risk_devices').notNull().default(0),
  mediumRiskDevices: integer('medium_risk_devices').notNull().default(0),
  highRiskDevices: integer('high_risk_devices').notNull().default(0),
  criticalRiskDevices: integer('critical_risk_devices').notNull().default(0),
  patchComplianceScore: integer('patch_compliance_score').notNull(),
  encryptionScore: integer('encryption_score').notNull(),
  avHealthScore: integer('av_health_score').notNull(),
  firewallScore: integer('firewall_score').notNull(),
  openPortsScore: integer('open_ports_score').notNull(),
  passwordPolicyScore: integer('password_policy_score').notNull(),
  osCurrencyScore: integer('os_currency_score').notNull(),
  adminExposureScore: integer('admin_exposure_score').notNull(),
  topIssues: jsonb('top_issues').notNull().default([]),
  summary: jsonb('summary').notNull().default({})
}, (table) => ({
  orgCapturedIdx: index('security_posture_org_snapshots_org_captured_idx').on(table.orgId, table.capturedAt),
  orgScoreIdx: index('security_posture_org_snapshots_org_score_idx').on(table.orgId, table.overallScore)
}));
