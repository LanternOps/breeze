# Breeze RMM - Phase 11 Implementation Plan

> **Goal**: Achieve 90%+ NinjaOne feature parity with focus on administrative features, critical operational gaps, and production readiness

---

## Executive Summary

Based on comprehensive analysis, Breeze RMM is at **70% feature parity** with NinjaOne. This plan addresses:

| Priority | Area | Current | Target |
|----------|------|---------|--------|
| Critical | Backup & Recovery | 0% | 80% |
| Critical | Security/EP | 35% | 75% |
| High | Software Deployment | 45% | 85% |
| High | Policy Management | 60% | 90% |
| High | Script Library | 65% | 90% |
| Medium | Asset Lifecycle | 50% | 80% |
| Medium | Integrations UI | 20% | 80% |
| Medium | Audit & Compliance | 40% | 80% |

---

## Phase 11A: Administrative Foundation (Week 1-2)

### 11A.1: Enhanced Script Library

**Current State**: Basic script CRUD, execution queue, results storage
**Gap**: No categories, tagging, versioning, community sharing

#### Database Schema Updates

**File: `apps/api/src/db/schema/scripts.ts`** (extend existing)

```typescript
// Add to existing schema
export const scriptCategories = pgTable('script_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  icon: varchar('icon', { length: 50 }),
  color: varchar('color', { length: 7 }),
  parentId: uuid('parent_id').references(() => scriptCategories.id),
  order: integer('order').default(0),
  createdAt: timestamp('created_at').defaultNow(),
});

export const scriptVersions = pgTable('script_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  scriptId: uuid('script_id').references(() => scripts.id).notNull(),
  version: integer('version').notNull(),
  content: text('content').notNull(),
  changelog: text('changelog'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
});

export const scriptTags = pgTable('script_tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  name: varchar('name', { length: 50 }).notNull(),
  color: varchar('color', { length: 7 }),
});

export const scriptToTags = pgTable('script_to_tags', {
  scriptId: uuid('script_id').references(() => scripts.id).notNull(),
  tagId: uuid('tag_id').references(() => scriptTags.id).notNull(),
}, (t) => ({
  pk: primaryKey(t.scriptId, t.tagId),
}));

export const scriptTemplates = pgTable('script_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  category: varchar('category', { length: 100 }),
  language: scriptLanguageEnum('language').notNull(),
  content: text('content').notNull(),
  parameters: jsonb('parameters').$type<ScriptParameter[]>(),
  isBuiltIn: boolean('is_built_in').default(false),
  downloads: integer('downloads').default(0),
  rating: decimal('rating', { precision: 2, scale: 1 }),
});
```

#### API Endpoints

```
GET/POST   /api/v1/scripts/categories
PATCH/DEL  /api/v1/scripts/categories/:id
GET/POST   /api/v1/scripts/tags
GET        /api/v1/scripts/:id/versions
POST       /api/v1/scripts/:id/versions (create new version)
POST       /api/v1/scripts/:id/rollback/:versionId
GET        /api/v1/scripts/templates
POST       /api/v1/scripts/from-template/:templateId
GET        /api/v1/scripts/:id/usage-stats
```

#### UI Components

| Component | Purpose |
|-----------|---------|
| `ScriptCategoryTree.tsx` | Hierarchical category navigation |
| `ScriptTagManager.tsx` | Tag CRUD and bulk tagging |
| `ScriptVersionHistory.tsx` | Version list with diff viewer |
| `ScriptTemplateGallery.tsx` | Template browser with search |
| `ScriptEditor.tsx` | Monaco editor with syntax highlighting |

---

### 11A.2: Policy Management System

**Current State**: Basic policies table, no policy groups or inheritance
**Gap**: No templates, versioning, hierarchy, compliance tracking

#### Database Schema

**File: `apps/api/src/db/schema/policies.ts`** (new file)

```typescript
export const policyTypeEnum = pgEnum('policy_type', [
  'monitoring', 'patching', 'security', 'backup',
  'maintenance', 'software', 'alert', 'custom'
]);

export const policyStatusEnum = pgEnum('policy_status', [
  'draft', 'active', 'inactive', 'archived'
]);

export const policies = pgTable('policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id).notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  type: policyTypeEnum('type').notNull(),
  status: policyStatusEnum('status').default('draft'),
  priority: integer('priority').default(50), // 1-100, higher = more important
  settings: jsonb('settings').notNull(), // Type-specific settings
  conditions: jsonb('conditions'), // When policy applies
  version: integer('version').default(1),
  parentId: uuid('parent_id').references(() => policies.id), // For inheritance
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const policyVersions = pgTable('policy_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  policyId: uuid('policy_id').references(() => policies.id).notNull(),
  version: integer('version').notNull(),
  settings: jsonb('settings').notNull(),
  conditions: jsonb('conditions'),
  changelog: text('changelog'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
});

export const policyAssignments = pgTable('policy_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  policyId: uuid('policy_id').references(() => policies.id).notNull(),
  targetType: varchar('target_type', { length: 50 }).notNull(), // org, site, group, device
  targetId: uuid('target_id').notNull(),
  priority: integer('priority').default(0), // Override priority at assignment
  createdAt: timestamp('created_at').defaultNow(),
});

export const policyTemplates = pgTable('policy_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  type: policyTypeEnum('type').notNull(),
  category: varchar('category', { length: 100 }),
  settings: jsonb('settings').notNull(),
  isBuiltIn: boolean('is_built_in').default(false),
  usageCount: integer('usage_count').default(0),
});

export const policyCompliance = pgTable('policy_compliance', {
  id: uuid('id').primaryKey().defaultRandom(),
  policyId: uuid('policy_id').references(() => policies.id).notNull(),
  deviceId: uuid('device_id').references(() => devices.id).notNull(),
  status: varchar('status', { length: 20 }).notNull(), // compliant, non_compliant, pending, error
  lastChecked: timestamp('last_checked').defaultNow(),
  details: jsonb('details'),
  remediationAttempts: integer('remediation_attempts').default(0),
});
```

#### API Endpoints

```
GET/POST   /api/v1/policies
GET/PATCH/DEL /api/v1/policies/:id
POST       /api/v1/policies/:id/activate
POST       /api/v1/policies/:id/deactivate
GET        /api/v1/policies/:id/versions
POST       /api/v1/policies/:id/rollback/:versionId
GET/POST   /api/v1/policies/:id/assignments
DELETE     /api/v1/policies/:id/assignments/:assignmentId
GET        /api/v1/policies/:id/compliance
GET        /api/v1/policies/templates
POST       /api/v1/policies/from-template/:templateId
GET        /api/v1/policies/effective/:deviceId (computed effective policy)
POST       /api/v1/policies/:id/test (dry run)
```

#### UI Components

| Component | Purpose |
|-----------|---------|
| `PolicyList.tsx` | Policy table with type/status filters |
| `PolicyEditor.tsx` | Type-specific policy form builder |
| `PolicyAssignmentPanel.tsx` | Drag-drop target assignment |
| `PolicyVersionHistory.tsx` | Version timeline with compare |
| `PolicyTemplateGallery.tsx` | Template browser by type |
| `PolicyComplianceView.tsx` | Device compliance dashboard |
| `EffectivePolicyViewer.tsx` | Show merged policy for device |

---

### 11A.3: Software Deployment

**Current State**: Software inventory collection, basic package schema
**Gap**: No software catalog, deployment UI, uninstall tracking

#### Database Schema

**File: `apps/api/src/db/schema/software.ts`** (new file)

```typescript
export const softwareCatalog = pgTable('software_catalog', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 200 }).notNull(),
  vendor: varchar('vendor', { length: 200 }),
  description: text('description'),
  category: varchar('category', { length: 100 }),
  iconUrl: text('icon_url'),
  websiteUrl: text('website_url'),
  isManaged: boolean('is_managed').default(false), // Built-in catalog item
  createdAt: timestamp('created_at').defaultNow(),
});

export const softwareVersions = pgTable('software_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  catalogId: uuid('catalog_id').references(() => softwareCatalog.id).notNull(),
  version: varchar('version', { length: 100 }).notNull(),
  releaseDate: timestamp('release_date'),
  releaseNotes: text('release_notes'),
  downloadUrl: text('download_url'),
  checksum: varchar('checksum', { length: 128 }),
  fileSize: bigint('file_size', { mode: 'number' }),
  supportedOs: jsonb('supported_os').$type<string[]>(), // windows, linux, darwin
  architecture: varchar('architecture', { length: 20 }), // x64, x86, arm64
  silentInstallArgs: text('silent_install_args'),
  silentUninstallArgs: text('silent_uninstall_args'),
  preInstallScript: text('pre_install_script'),
  postInstallScript: text('post_install_script'),
  isLatest: boolean('is_latest').default(false),
});

export const deploymentStatusEnum = pgEnum('deployment_status', [
  'pending', 'downloading', 'installing', 'completed',
  'failed', 'cancelled', 'rollback'
]);

export const softwareDeployments = pgTable('software_deployments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id).notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  softwareVersionId: uuid('software_version_id').references(() => softwareVersions.id).notNull(),
  deploymentType: varchar('deployment_type', { length: 20 }).notNull(), // install, uninstall, update
  targetType: varchar('target_type', { length: 50 }).notNull(), // org, site, group, device
  targetIds: jsonb('target_ids').$type<string[]>().notNull(),
  scheduleType: varchar('schedule_type', { length: 20 }).notNull(), // immediate, scheduled, maintenance
  scheduledAt: timestamp('scheduled_at'),
  maintenanceWindowId: uuid('maintenance_window_id'),
  options: jsonb('options').$type<DeploymentOptions>(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
});

export const deploymentResults = pgTable('deployment_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  deploymentId: uuid('deployment_id').references(() => softwareDeployments.id).notNull(),
  deviceId: uuid('device_id').references(() => devices.id).notNull(),
  status: deploymentStatusEnum('status').notNull(),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  exitCode: integer('exit_code'),
  output: text('output'),
  errorMessage: text('error_message'),
  retryCount: integer('retry_count').default(0),
});

export const softwareInventory = pgTable('software_inventory', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').references(() => devices.id).notNull(),
  catalogId: uuid('catalog_id').references(() => softwareCatalog.id),
  name: varchar('name', { length: 500 }).notNull(),
  version: varchar('version', { length: 100 }),
  vendor: varchar('vendor', { length: 200 }),
  installDate: timestamp('install_date'),
  installLocation: text('install_location'),
  uninstallString: text('uninstall_string'),
  isManaged: boolean('is_managed').default(false),
  lastSeen: timestamp('last_seen').defaultNow(),
});
```

#### API Endpoints

```
# Software Catalog
GET/POST   /api/v1/software/catalog
GET/PATCH/DEL /api/v1/software/catalog/:id
GET/POST   /api/v1/software/catalog/:id/versions
GET        /api/v1/software/catalog/search

# Deployments
GET/POST   /api/v1/software/deployments
GET        /api/v1/software/deployments/:id
POST       /api/v1/software/deployments/:id/cancel
GET        /api/v1/software/deployments/:id/results

# Inventory
GET        /api/v1/software/inventory
GET        /api/v1/software/inventory/:deviceId
POST       /api/v1/software/inventory/:deviceId/:softwareId/uninstall
```

#### UI Components

| Component | Purpose |
|-----------|---------|
| `SoftwareCatalog.tsx` | Browse/search catalog with cards |
| `SoftwareVersionManager.tsx` | Manage versions for catalog item |
| `DeploymentWizard.tsx` | Multi-step deployment creator |
| `DeploymentList.tsx` | Deployment history and status |
| `DeploymentProgress.tsx` | Real-time deployment tracking |
| `SoftwareInventoryView.tsx` | Per-device software list |
| `SoftwareComplianceReport.tsx` | Version drift analysis |

---

## Phase 11B: Security & Compliance (Week 3-4)

### 11B.1: Endpoint Protection Integration

**Current State**: Antivirus status in device details
**Gap**: No AV management, threat alerts, quarantine actions

#### Database Schema

**File: `apps/api/src/db/schema/security.ts`** (new file)

```typescript
export const securityProviderEnum = pgEnum('security_provider', [
  'windows_defender', 'bitdefender', 'sophos', 'sentinelone',
  'crowdstrike', 'malwarebytes', 'eset', 'kaspersky', 'other'
]);

export const threatSeverityEnum = pgEnum('threat_severity', [
  'low', 'medium', 'high', 'critical'
]);

export const threatStatusEnum = pgEnum('threat_status', [
  'detected', 'quarantined', 'removed', 'allowed', 'failed'
]);

export const securityStatus = pgTable('security_status', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').references(() => devices.id).notNull().unique(),
  provider: securityProviderEnum('provider'),
  providerVersion: varchar('provider_version', { length: 50 }),
  definitionsVersion: varchar('definitions_version', { length: 100 }),
  definitionsDate: timestamp('definitions_date'),
  realTimeProtection: boolean('real_time_protection'),
  lastScan: timestamp('last_scan'),
  lastScanType: varchar('last_scan_type', { length: 50 }),
  threatCount: integer('threat_count').default(0),
  firewallEnabled: boolean('firewall_enabled'),
  encryptionStatus: varchar('encryption_status', { length: 50 }),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const securityThreats = pgTable('security_threats', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').references(() => devices.id).notNull(),
  provider: securityProviderEnum('provider'),
  threatName: varchar('threat_name', { length: 200 }).notNull(),
  threatType: varchar('threat_type', { length: 100 }),
  severity: threatSeverityEnum('severity').notNull(),
  status: threatStatusEnum('status').notNull(),
  filePath: text('file_path'),
  processName: varchar('process_name', { length: 200 }),
  detectedAt: timestamp('detected_at').notNull(),
  resolvedAt: timestamp('resolved_at'),
  resolvedBy: varchar('resolved_by', { length: 100 }),
  details: jsonb('details'),
});

export const securityScans = pgTable('security_scans', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').references(() => devices.id).notNull(),
  scanType: varchar('scan_type', { length: 50 }).notNull(), // quick, full, custom
  status: varchar('status', { length: 20 }).notNull(),
  startedAt: timestamp('started_at').notNull(),
  completedAt: timestamp('completed_at'),
  itemsScanned: integer('items_scanned'),
  threatsFound: integer('threats_found'),
  duration: integer('duration'), // seconds
  initiatedBy: uuid('initiated_by').references(() => users.id),
});

export const securityPolicies = pgTable('security_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id).notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  settings: jsonb('settings').$type<SecurityPolicySettings>().notNull(),
  isDefault: boolean('is_default').default(false),
  createdAt: timestamp('created_at').defaultNow(),
});
```

#### Agent Module

**Package: `apps/agent/internal/security/`**

| File | Purpose |
|------|---------|
| `status.go` | Collect AV/firewall/encryption status |
| `defender.go` | Windows Defender integration |
| `threats.go` | Threat detection monitoring |
| `scan.go` | Trigger and monitor scans |

#### API Endpoints

```
GET        /api/v1/security/status
GET        /api/v1/security/status/:deviceId
GET        /api/v1/security/threats
GET        /api/v1/security/threats/:deviceId
POST       /api/v1/security/threats/:id/quarantine
POST       /api/v1/security/threats/:id/restore
POST       /api/v1/security/threats/:id/remove
POST       /api/v1/security/scan/:deviceId
GET        /api/v1/security/scans/:deviceId
GET/POST   /api/v1/security/policies
```

#### UI Components

| Component | Purpose |
|-----------|---------|
| `SecurityDashboard.tsx` | Overview with threat stats |
| `ThreatList.tsx` | Threat table with actions |
| `ThreatDetail.tsx` | Threat investigation view |
| `DeviceSecurityStatus.tsx` | Per-device security card |
| `SecurityScanManager.tsx` | Initiate/view scans |
| `SecurityPolicyEditor.tsx` | Security policy settings |

---

### 11B.2: Audit & Compliance UI

**Current State**: Audit logs table exists, no UI
**Gap**: No audit log viewer, compliance reports, data export

#### API Endpoints

```
GET        /api/v1/audit/logs
GET        /api/v1/audit/logs/:id
GET        /api/v1/audit/search
POST       /api/v1/audit/export
GET        /api/v1/audit/reports/user-activity
GET        /api/v1/audit/reports/security-events
GET        /api/v1/audit/reports/compliance
```

#### UI Components

| Component | Purpose |
|-----------|---------|
| `AuditLogViewer.tsx` | Searchable audit log table |
| `AuditLogDetail.tsx` | Log entry with context |
| `AuditFilters.tsx` | Date, user, action, resource filters |
| `AuditExport.tsx` | Export to CSV/JSON |
| `UserActivityReport.tsx` | Per-user activity timeline |
| `ComplianceReport.tsx` | Compliance status report |

---

## Phase 11C: Backup & Recovery (Week 5-6)

### 11C.1: Backup Infrastructure

**Current State**: No backup functionality
**Gap**: Critical - No cloud backup, no file recovery

#### Database Schema

**File: `apps/api/src/db/schema/backup.ts`** (new file)

```typescript
export const backupProviderEnum = pgEnum('backup_provider', [
  'local', 's3', 'azure_blob', 'google_cloud', 'backblaze'
]);

export const backupTypeEnum = pgEnum('backup_type', [
  'file', 'system_image', 'database', 'application'
]);

export const backupStatusEnum = pgEnum('backup_status', [
  'pending', 'running', 'completed', 'failed', 'cancelled', 'partial'
]);

export const backupConfigs = pgTable('backup_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id).notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  type: backupTypeEnum('type').notNull(),
  provider: backupProviderEnum('provider').notNull(),
  providerConfig: jsonb('provider_config').notNull(), // Encrypted credentials
  schedule: jsonb('schedule').$type<BackupSchedule>(),
  retention: jsonb('retention').$type<RetentionPolicy>(),
  compression: boolean('compression').default(true),
  encryption: boolean('encryption').default(true),
  encryptionKey: text('encryption_key'), // Encrypted
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
});

export const backupPolicies = pgTable('backup_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  configId: uuid('config_id').references(() => backupConfigs.id).notNull(),
  targetType: varchar('target_type', { length: 50 }).notNull(),
  targetId: uuid('target_id').notNull(),
  includes: jsonb('includes').$type<string[]>(), // Paths/patterns to include
  excludes: jsonb('excludes').$type<string[]>(), // Paths/patterns to exclude
  priority: integer('priority').default(50),
});

export const backupJobs = pgTable('backup_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  configId: uuid('config_id').references(() => backupConfigs.id).notNull(),
  deviceId: uuid('device_id').references(() => devices.id).notNull(),
  status: backupStatusEnum('status').notNull(),
  type: varchar('type', { length: 20 }).notNull(), // scheduled, manual, incremental
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  totalSize: bigint('total_size', { mode: 'number' }),
  transferredSize: bigint('transferred_size', { mode: 'number' }),
  fileCount: integer('file_count'),
  errorCount: integer('error_count').default(0),
  errorLog: text('error_log'),
  snapshotId: varchar('snapshot_id', { length: 200 }),
});

export const backupSnapshots = pgTable('backup_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').references(() => backupJobs.id).notNull(),
  deviceId: uuid('device_id').references(() => devices.id).notNull(),
  snapshotId: varchar('snapshot_id', { length: 200 }).notNull(),
  timestamp: timestamp('timestamp').notNull(),
  size: bigint('size', { mode: 'number' }),
  fileCount: integer('file_count'),
  isIncremental: boolean('is_incremental').default(false),
  parentSnapshotId: varchar('parent_snapshot_id', { length: 200 }),
  expiresAt: timestamp('expires_at'),
  metadata: jsonb('metadata'),
});

export const restoreJobs = pgTable('restore_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  snapshotId: uuid('snapshot_id').references(() => backupSnapshots.id).notNull(),
  deviceId: uuid('device_id').references(() => devices.id).notNull(),
  restoreType: varchar('restore_type', { length: 20 }).notNull(), // full, selective, bare_metal
  targetPath: text('target_path'),
  selectedPaths: jsonb('selected_paths').$type<string[]>(),
  status: backupStatusEnum('status').notNull(),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  restoredSize: bigint('restored_size', { mode: 'number' }),
  restoredFiles: integer('restored_files'),
  initiatedBy: uuid('initiated_by').references(() => users.id),
});
```

#### Agent Module

**Package: `apps/agent/internal/backup/`**

| File | Purpose |
|------|---------|
| `backup.go` | Main backup orchestration |
| `snapshot.go` | Incremental snapshot management |
| `providers/s3.go` | S3-compatible storage |
| `providers/azure.go` | Azure Blob storage |
| `providers/local.go` | Local/NAS backup |
| `compression.go` | Compression handling |
| `encryption.go` | AES-256 encryption |
| `vss.go` | Windows VSS integration |

#### API Endpoints

```
# Backup Configuration
GET/POST   /api/v1/backup/configs
GET/PATCH/DEL /api/v1/backup/configs/:id
POST       /api/v1/backup/configs/:id/test

# Backup Policies
GET/POST   /api/v1/backup/policies
GET/PATCH/DEL /api/v1/backup/policies/:id

# Backup Jobs
GET        /api/v1/backup/jobs
GET        /api/v1/backup/jobs/:id
POST       /api/v1/backup/jobs/run/:deviceId
POST       /api/v1/backup/jobs/:id/cancel

# Snapshots & Restore
GET        /api/v1/backup/snapshots
GET        /api/v1/backup/snapshots/:id
GET        /api/v1/backup/snapshots/:id/browse
POST       /api/v1/backup/restore
GET        /api/v1/backup/restore/:id

# Dashboard
GET        /api/v1/backup/dashboard
GET        /api/v1/backup/status/:deviceId
```

#### UI Components

| Component | Purpose |
|-----------|---------|
| `BackupDashboard.tsx` | Overview with job status |
| `BackupConfigList.tsx` | Manage backup configurations |
| `BackupConfigEditor.tsx` | Create/edit backup config |
| `BackupPolicyAssignment.tsx` | Assign policies to targets |
| `BackupJobList.tsx` | Job history with filters |
| `BackupJobProgress.tsx` | Real-time job monitoring |
| `SnapshotBrowser.tsx` | Browse snapshot contents |
| `RestoreWizard.tsx` | Multi-step restore process |
| `DeviceBackupStatus.tsx` | Per-device backup health |

---

## Phase 11D: Integrations & UI Polish (Week 7-8)

### 11D.1: Integration Management UI

**Current State**: Schema for webhooks, PSA, patches - no UI
**Gap**: Cannot configure integrations without direct API calls

#### UI Components

| Component | Purpose |
|-----------|---------|
| `IntegrationsPage.tsx` | Integration hub |
| `WebhookList.tsx` | Manage webhooks |
| `WebhookEditor.tsx` | Create/edit webhook |
| `WebhookTestPanel.tsx` | Test webhook delivery |
| `PSAConnectionList.tsx` | Manage PSA connections |
| `PSAConnectionWizard.tsx` | Setup PSA integration |
| `PSAMappingEditor.tsx` | Field mapping config |
| `ConnectorStatusPanel.tsx` | Integration health |

### 11D.2: Organization Settings UI

**Current State**: Org schema exists, no settings UI
**Gap**: Cannot manage org branding, defaults, preferences

#### UI Components

| Component | Purpose |
|-----------|---------|
| `OrgSettingsPage.tsx` | Tabbed settings page |
| `OrgBrandingEditor.tsx` | Logo, colors, theme |
| `OrgDefaultsEditor.tsx` | Default policies, groups |
| `OrgNotificationSettings.tsx` | Email, Slack, webhook |
| `OrgSecuritySettings.tsx` | Password policy, MFA |
| `OrgBillingInfo.tsx` | Billing/subscription |

### 11D.3: Remote Tools Integration

**Current State**: UI components with placeholder data
**Gap**: No wiring to API and agent

#### Tasks

1. Update `RemoteToolsPage.tsx` to use actual components
2. Wire API calls from UI to `/api/v1/system-tools/*`
3. Implement WebSocket for real-time updates
4. Add agent command routing in remote module

---

## Phase 11E: Advanced Features (Week 9-10)

### 11E.1: Alert Correlation & Templates

**Current State**: Basic alerts, no correlation or templates
**Gap**: Too many alerts, no intelligent grouping

#### Database Schema

```typescript
export const alertTemplates = pgTable('alert_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  conditions: jsonb('conditions').notNull(),
  severity: alertSeverityEnum('severity').notNull(),
  titleTemplate: text('title_template').notNull(),
  messageTemplate: text('message_template').notNull(),
  autoResolve: boolean('auto_resolve').default(false),
  autoResolveConditions: jsonb('auto_resolve_conditions'),
  isBuiltIn: boolean('is_built_in').default(false),
});

export const alertCorrelations = pgTable('alert_correlations', {
  id: uuid('id').primaryKey().defaultRandom(),
  parentAlertId: uuid('parent_alert_id').references(() => alerts.id),
  childAlertId: uuid('child_alert_id').references(() => alerts.id),
  correlationType: varchar('correlation_type', { length: 50 }),
  confidence: decimal('confidence', { precision: 3, scale: 2 }),
});
```

### 11E.2: Network Device Monitoring

**Current State**: Discovery exists, no ongoing monitoring
**Gap**: Cannot monitor SNMP devices continuously

#### Database Schema

```typescript
export const snmpDevices = pgTable('snmp_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  assetId: uuid('asset_id').references(() => discoveredAssets.id),
  orgId: uuid('org_id').references(() => organizations.id).notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  ipAddress: varchar('ip_address', { length: 45 }).notNull(),
  snmpVersion: varchar('snmp_version', { length: 10 }).notNull(),
  community: varchar('community', { length: 100 }), // v2c
  authConfig: jsonb('auth_config'), // v3
  pollingInterval: integer('polling_interval').default(300),
  templateId: uuid('template_id').references(() => snmpTemplates.id),
  isActive: boolean('is_active').default(true),
});

export const snmpMetrics = pgTable('snmp_metrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').references(() => snmpDevices.id).notNull(),
  oid: varchar('oid', { length: 200 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  value: text('value'),
  valueType: varchar('value_type', { length: 20 }),
  timestamp: timestamp('timestamp').defaultNow(),
});
```

---

## Implementation Sequence

### Phase 11A: Administrative Foundation
| Order | Task | Delegatable |
|-------|------|-------------|
| 1 | Script library schema updates | Codex |
| 2 | Script library API routes | Codex |
| 3 | Script library UI components | Codex |
| 4 | Policy management schema | Codex |
| 5 | Policy management API routes | Codex |
| 6 | Policy management UI | Codex |
| 7 | Software deployment schema | Codex |
| 8 | Software deployment API | Codex |
| 9 | Software deployment UI | Codex |

### Phase 11B: Security & Compliance
| Order | Task | Delegatable |
|-------|------|-------------|
| 1 | Security schema | Codex |
| 2 | Security agent module | Codex |
| 3 | Security API routes | Codex |
| 4 | Security UI components | Codex |
| 5 | Audit UI components | Codex |

### Phase 11C: Backup & Recovery
| Order | Task | Delegatable |
|-------|------|-------------|
| 1 | Backup schema | Codex |
| 2 | Backup agent module | Codex |
| 3 | Backup API routes | Codex |
| 4 | Backup UI components | Codex |

### Phase 11D: Integrations & Polish
| Order | Task | Delegatable |
|-------|------|-------------|
| 1 | Integration UI components | Codex |
| 2 | Org settings UI | Codex |
| 3 | Remote tools wiring | Claude |

### Phase 11E: Advanced Features
| Order | Task | Delegatable |
|-------|------|-------------|
| 1 | Alert templates/correlation | Codex |
| 2 | SNMP monitoring | Codex |

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Overall Feature Parity | 70% | 90% |
| Backup Coverage | 0% | 80% |
| Security/EP | 35% | 75% |
| Software Deployment | 45% | 85% |
| Policy Management | 60% | 90% |
| Script Library | 65% | 90% |
| Integration UI | 20% | 80% |
| Audit UI | 40% | 80% |

---

## Dependencies

### New NPM Packages
```json
{
  "@monaco-editor/react": "^4.6.0",
  "react-diff-viewer-continued": "^3.4.0",
  "react-flow": "^11.0.0"
}
```

### New Go Packages
```go
require (
  github.com/minio/minio-go/v7 v7.0.70
  github.com/Azure/azure-sdk-for-go/sdk/storage/azblob v1.3.0
  github.com/restic/chunker v0.4.0
)
```

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Backup data loss | Multi-provider support, encryption verification |
| Security credential exposure | Vault integration, encrypted storage |
| Policy conflicts | Priority-based resolution, conflict detection |
| Large file transfers | Chunked uploads, resume support |
