# Breeze RMM - Phase 9 Architecture Plan

> **Goal**: Feature parity with NinjaOne through integration & extensibility, patch management, and high-performance remote control
>
> **Created**: 2026-01-13
> **Status**: Approved for Implementation

---

## Executive Summary

Phase 9 transforms Breeze from a functional RMM into a competitive enterprise platform by adding:

1. **Integration & Extensibility** - Plugin system, webhook delivery, PSA integrations
2. **Patch Management** - Windows Update, 200+ third-party apps, compliance reporting
3. **High-Performance Remote Control** - GPU-accelerated capture, H.264/VP9 encoding, adaptive bitrate

---

## Phase 9.1: Integration & Extensibility

### Database Schema

**New file: `apps/api/src/db/schema/integrations.ts`**

| Table | Purpose |
|-------|---------|
| `plugins` | Plugin registry (name, version, permissions, hooks) |
| `plugin_instances` | Per-org plugin configurations |
| `webhooks` | Outbound webhook definitions |
| `webhook_deliveries` | Delivery history with retry tracking |
| `event_bus_events` | Internal event log for replay/audit |
| `psa_connections` | PSA provider connections (Jira, ServiceNow, ConnectWise) |
| `psa_ticket_mappings` | Alert-to-ticket bidirectional mapping |

### API Endpoints

```
# Plugins
GET/POST   /api/v1/integrations/plugins
GET/PATCH/DELETE /api/v1/integrations/plugins/:id
POST       /api/v1/integrations/plugins/:id/enable|disable

# Webhooks
GET/POST   /api/v1/integrations/webhooks
GET/PATCH/DELETE /api/v1/integrations/webhooks/:id
GET        /api/v1/integrations/webhooks/:id/deliveries
POST       /api/v1/integrations/webhooks/:id/test

# PSA Connections
GET/POST   /api/v1/integrations/psa
GET/PATCH/DELETE /api/v1/integrations/psa/:id
POST       /api/v1/integrations/psa/:id/sync
```

### Key Services

| Service | File | Purpose |
|---------|------|---------|
| Event Bus | `services/eventBus.ts` | Redis Streams for guaranteed event delivery |
| Webhook Worker | `workers/webhookDelivery.ts` | BullMQ with exponential backoff, HMAC signing |
| PSA Sync Worker | `workers/psaSync.ts` | Bidirectional ticket synchronization |

### Supported PSA Integrations

- Jira (Cloud + Server)
- ServiceNow
- ConnectWise Manage
- Autotask
- Freshservice
- Zendesk

---

## Phase 9.2: Patch Management

### Database Schema

**New file: `apps/api/src/db/schema/patches.ts`**

| Table | Purpose |
|-------|---------|
| `patches` | Patch catalog (200+ apps, all OS) |
| `patch_policies` | Org-level patching policies |
| `patch_approvals` | Per-org patch approval status |
| `device_patches` | Device-level patch status |
| `patch_jobs` | Deployment job tracking |
| `patch_job_results` | Per-device job results |
| `patch_rollbacks` | Rollback history |
| `patch_compliance_snapshots` | Daily compliance snapshots |

### API Endpoints

```
# Patch Catalog
GET        /api/v1/patches
POST       /api/v1/patches/scan
GET        /api/v1/patches/sources

# Approvals
GET        /api/v1/patches/approvals
POST       /api/v1/patches/:id/approve|decline|defer
POST       /api/v1/patches/bulk-approve

# Policies
CRUD       /api/v1/patch-policies

# Jobs
CRUD       /api/v1/patch-jobs
POST       /api/v1/patch-jobs/:id/cancel

# Device Patches
GET        /api/v1/devices/:id/patches
POST       /api/v1/devices/:id/patches/install
POST       /api/v1/devices/:id/patches/:patchId/rollback

# Compliance
GET        /api/v1/patches/compliance
GET        /api/v1/patches/compliance/report
```

### Agent Modifications

**New package: `agent/internal/patching/`**

| File | Purpose |
|------|---------|
| `manager.go` | PatchManager coordinates providers |
| `windows.go` | Windows Update via DXGI/COM |
| `wsus.go` | WSUS server integration |
| `chocolatey.go` | Chocolatey package manager |
| `apt.go` | Debian/Ubuntu apt-get |
| `yum.go` | RHEL/CentOS yum/dnf |
| `homebrew.go` | macOS Homebrew |

### Heartbeat Extension

```go
// Add to HeartbeatPayload
PatchStatus *PatchStatusSummary `json:"patchStatus,omitempty"`

type PatchStatusSummary struct {
    LastScanAt       time.Time
    AvailablePatches int
    CriticalPatches  int
    PendingReboot    bool
}
```

### Third-Party Patch Sources (200+ apps)

- **Windows**: Chocolatey community repository
- **macOS**: Homebrew casks
- **Linux**: Native package managers (apt, yum, dnf)
- **Custom**: User-defined package definitions

---

## Phase 9.3: High-Performance Remote Control

### Design Goals

| Metric | Target | NinjaOne Comparison |
|--------|--------|---------------------|
| Latency | <50ms | Competitive |
| FPS | 30-60fps | Better than avg |
| Resolution | Up to 4K | Full support |
| Multi-monitor | Yes | Parity |
| Clipboard | Bidirectional | Parity |
| File drag-drop | Yes | Parity |

### Database Schema Updates

**Modify: `apps/api/src/db/schema/remote.ts`**

New columns for `remote_sessions`:
- `video_codec` (h264, vp9, vp8, av1)
- `quality_preset` (auto, low, medium, high, ultra)
- `max_fps`, `max_bitrate`
- `multi_monitor`, `active_monitors`
- `clipboard_enabled`, `file_drop_enabled`
- Performance metrics (avg_latency, avg_fps, frames_encoded)

New tables:
- `remote_session_metrics` - Time-series quality data
- `clipboard_sync_events` - Audit trail

### Agent Architecture

**New package: `agent/internal/remote/desktop/`**

| File | Purpose |
|------|---------|
| `capture.go` | GPU-accelerated screen capture |
| `encoder.go` | Hardware video encoding |
| `adaptive.go` | Bandwidth estimation & quality adaptation |

**Screen Capture (GPU-Accelerated)**

| Platform | API | Performance |
|----------|-----|-------------|
| Windows | DXGI Desktop Duplication | <1ms capture |
| macOS | CGDisplayStream | Hardware accelerated |
| Linux | PipeWire/X11 SHM | Wayland + X11 support |

**Video Encoding (Hardware-Accelerated)**

| Hardware | Encoder | Codecs |
|----------|---------|--------|
| NVIDIA | NVENC | H.264, HEVC |
| Intel | Quick Sync | H.264, VP9 |
| AMD | VCE | H.264, HEVC |
| Apple | VideoToolbox | H.264, HEVC |
| Linux | VAAPI | H.264, VP9 |

**Adaptive Bitrate Algorithm**

```
1. Measure RTT via WebRTC stats
2. Track packet loss rate
3. If congestion detected:
   a. Reduce bitrate (primary)
   b. Reduce resolution (secondary)
   c. Reduce FPS (last resort)
4. If bandwidth available:
   a. Increase bitrate up to max
   b. Increase resolution up to native
```

### Clipboard & File Drop

**New files:**
- `agent/internal/remote/clipboard/sync.go` - Bidirectional clipboard
- `agent/internal/remote/filedrop/handler.go` - Drag-drop file transfers

**Supported content:**
- Plain text, Rich text (RTF)
- Images (PNG/JPEG)
- Files (via WebRTC data channel)

### UI Components

**New/Modified in `apps/web/src/components/remote/`:**

| Component | Purpose |
|-----------|---------|
| `RemoteDesktop.tsx` | WebGL-accelerated canvas viewer |
| `MonitorSelector.tsx` | Multi-monitor picker |
| `QualitySettings.tsx` | Codec/quality controls |
| `SessionMetrics.tsx` | Real-time latency/FPS display |
| `ClipboardSync.tsx` | Clipboard send/receive |
| `FileDropZone.tsx` | Drag-drop overlay |

---

## Implementation Sequence

### Phase 9.1: Integration Foundation (2 weeks)
- [ ] Event bus service (Redis Streams)
- [ ] Webhook delivery with BullMQ
- [ ] Webhook CRUD API & UI
- [ ] Event types definition

### Phase 9.2: PSA Integration (2 weeks)
- [ ] PSA connection management
- [ ] Jira integration
- [ ] ServiceNow integration
- [ ] ConnectWise integration
- [ ] Ticket sync workers

### Phase 9.3: Plugin System (3 weeks)
- [ ] Plugin manifest format
- [ ] Plugin loader & sandbox
- [ ] Hook system for events
- [ ] Plugin marketplace UI

### Phase 9.4: Patch Management Core (3 weeks)
- [ ] Patch catalog schema & sync
- [ ] Windows Update agent integration
- [ ] Patch policy engine
- [ ] Approval workflow API
- [ ] Compliance dashboard

### Phase 9.5: Patch Management Advanced (2 weeks)
- [ ] Third-party package managers (Chocolatey, Homebrew, apt)
- [ ] Rollback system
- [ ] Maintenance windows
- [ ] Compliance reporting

### Phase 9.6: Remote Control Enhancement (3 weeks)
- [ ] DXGI/CGDisplayStream capture
- [ ] H.264/VP9 hardware encoding
- [ ] Adaptive bitrate controller
- [ ] Multi-monitor support
- [ ] Clipboard sync

### Phase 9.7: File Drag-Drop (1 week)
- [ ] Drag-drop protocol
- [ ] Agent file receiver
- [ ] Browser drop zone UI

---

## Critical Files to Modify

### API
| File | Changes |
|------|---------|
| `apps/api/src/db/schema/index.ts` | Export new schema modules |
| `apps/api/src/index.ts` | Register new routes |
| `apps/api/src/services/redis.ts` | Add Redis Streams support |

### Agent
| File | Changes |
|------|---------|
| `agent/internal/heartbeat/heartbeat.go` | Add patch status to payload |
| `agent/cmd/breeze-agent/main.go` | Register patch & remote commands |
| `agent/go.mod` | Add encoding libraries |

### Web
| File | Changes |
|------|---------|
| `apps/web/src/components/Sidebar.tsx` | Add integrations, patches nav |
| `apps/web/src/pages/` | New pages for each feature area |

---

## Verification Plan

### Integration & Extensibility
1. Create webhook pointing to webhook.site
2. Trigger device.online event
3. Verify webhook delivery with HMAC signature
4. Create Jira PSA connection
5. Trigger alert, verify ticket created in Jira

### Patch Management
1. Enroll Windows device
2. Verify patch scan populates available patches
3. Approve critical patch
4. Deploy via patch job
5. Verify installation on device
6. Test rollback functionality

### Remote Control
1. Start desktop session to Windows device
2. Verify 30+ FPS with <100ms latency
3. Switch between monitors
4. Test clipboard copy/paste both directions
5. Drag file from browser to remote desktop
6. Verify adaptive quality under bandwidth constraints

---

## Performance Targets

| Feature | Target | Measurement |
|---------|--------|-------------|
| Webhook delivery | <500ms p95 | BullMQ metrics |
| Patch scan | <30s for 1000 devices | Job completion time |
| Remote latency | <50ms p95 | WebRTC stats |
| Remote FPS | 30-60fps | Client-side counter |
| Patch compliance query | <1s | API response time |

---

## Dependencies to Add

### API (package.json)
```json
{
  "prom-client": "^15.1.0",
  "bullmq": "^5.0.0",
  "ioredis": "^5.3.0"
}
```

### Agent (go.mod)
```go
require (
  github.com/pion/webrtc/v4 v4.0.0
  github.com/pion/mediadevices v0.6.0
  golang.org/x/sys v0.15.0
)
```

---

## NinjaOne Feature Parity Checklist

| Feature | NinjaOne | Breeze Phase 9 |
|---------|----------|----------------|
| 200+ third-party patches | Yes | Yes (via Chocolatey/Homebrew) |
| Patch Intelligence AI | Yes | No (future Phase 10) |
| Single-click remote | Yes | Yes |
| Cross-OS remote | Yes | Yes |
| PSA integrations | Yes | Yes (Jira, ServiceNow, ConnectWise) |
| Webhook automation | Yes | Yes |
| Multi-monitor | Yes | Yes |
| Clipboard sync | Yes | Yes |
| File drag-drop | Yes | Yes |
| 256-bit encryption | Yes | Yes (WebRTC DTLS) |

---

## Schema Definitions

### Integrations Schema (TypeScript)

```typescript
// apps/api/src/db/schema/integrations.ts

import { pgTable, pgEnum, uuid, varchar, text, boolean, integer, timestamp, jsonb, unique, primaryKey } from 'drizzle-orm/pg-core';
import { organizations, users, alerts, devices } from './index';

// Enums
export const pluginStatusEnum = pgEnum('plugin_status', ['active', 'disabled', 'error', 'pending']);
export const webhookStatusEnum = pgEnum('webhook_status', ['active', 'paused', 'failed']);
export const webhookDeliveryStatusEnum = pgEnum('webhook_delivery_status', ['pending', 'delivered', 'failed', 'retrying']);
export const psaProviderEnum = pgEnum('psa_provider', ['jira', 'servicenow', 'connectwise', 'autotask', 'freshservice', 'zendesk']);
export const eventPriorityEnum = pgEnum('event_priority', ['low', 'normal', 'high', 'critical']);

// Plugin System Tables
export const plugins = pgTable('plugins', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  version: varchar('version', { length: 50 }).notNull(),
  description: text('description'),
  author: varchar('author', { length: 255 }),
  homepage: text('homepage'),
  manifestUrl: text('manifest_url'),
  entryPoint: text('entry_point').notNull(),
  permissions: jsonb('permissions').default([]),
  hooks: jsonb('hooks').default([]),
  settings: jsonb('settings').default({}),
  status: pluginStatusEnum('status').notNull().default('pending'),
  isSystem: boolean('is_system').notNull().default(false),
  installedAt: timestamp('installed_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  errorMessage: text('error_message'),
  lastActiveAt: timestamp('last_active_at')
});

// Webhooks
export const webhooks = pgTable('webhooks', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  url: text('url').notNull(),
  secret: varchar('secret', { length: 128 }),
  events: text('events').array().notNull(),
  headers: jsonb('headers').default({}),
  status: webhookStatusEnum('status').notNull().default('active'),
  retryPolicy: jsonb('retry_policy').default({
    maxRetries: 5,
    backoffMultiplier: 2,
    initialDelayMs: 1000,
    maxDelayMs: 300000
  }),
  successCount: integer('success_count').notNull().default(0),
  failureCount: integer('failure_count').notNull().default(0),
  lastDeliveryAt: timestamp('last_delivery_at'),
  lastSuccessAt: timestamp('last_success_at'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  webhookId: uuid('webhook_id').notNull().references(() => webhooks.id),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  eventId: uuid('event_id').notNull(),
  payload: jsonb('payload').notNull(),
  status: webhookDeliveryStatusEnum('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextRetryAt: timestamp('next_retry_at'),
  responseStatus: integer('response_status'),
  responseBody: text('response_body'),
  responseTimeMs: integer('response_time_ms'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  deliveredAt: timestamp('delivered_at')
});

// Event Bus
export const eventBusEvents = pgTable('event_bus_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  source: varchar('source', { length: 100 }).notNull(),
  priority: eventPriorityEnum('priority').notNull().default('normal'),
  payload: jsonb('payload').notNull(),
  metadata: jsonb('metadata').default({}),
  processedAt: timestamp('processed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

// PSA Connections
export const psaConnections = pgTable('psa_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  provider: psaProviderEnum('provider').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  credentials: jsonb('credentials').notNull(),
  settings: jsonb('settings').default({}),
  syncSettings: jsonb('sync_settings').default({
    autoCreateTickets: true,
    syncInterval: 15,
    ticketMapping: {}
  }),
  enabled: boolean('enabled').notNull().default(true),
  lastSyncAt: timestamp('last_sync_at'),
  lastSyncStatus: varchar('last_sync_status', { length: 50 }),
  lastSyncError: text('last_sync_error'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const psaTicketMappings = pgTable('psa_ticket_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull().references(() => psaConnections.id),
  alertId: uuid('alert_id').references(() => alerts.id),
  deviceId: uuid('device_id').references(() => devices.id),
  externalTicketId: varchar('external_ticket_id', { length: 255 }).notNull(),
  externalTicketUrl: text('external_ticket_url'),
  status: varchar('status', { length: 50 }).notNull(),
  lastSyncAt: timestamp('last_sync_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});
```

### Patches Schema (TypeScript)

```typescript
// apps/api/src/db/schema/patches.ts

import { pgTable, pgEnum, uuid, varchar, text, boolean, integer, timestamp, date, jsonb, unique, real, bigint } from 'drizzle-orm/pg-core';
import { organizations, devices, users, scripts } from './index';

// Enums
export const patchSourceEnum = pgEnum('patch_source', ['windows_update', 'wsus', 'chocolatey', 'ninite', 'custom', 'apt', 'yum', 'homebrew']);
export const patchSeverityEnum = pgEnum('patch_severity', ['critical', 'important', 'moderate', 'low', 'unspecified']);
export const patchStatusEnum = pgEnum('patch_status', ['available', 'approved', 'declined', 'deferred', 'installed', 'failed', 'rolled_back']);
export const patchApprovalStatusEnum = pgEnum('patch_approval_status', ['pending', 'approved', 'declined', 'auto_approved']);
export const patchJobStatusEnum = pgEnum('patch_job_status', ['scheduled', 'running', 'completed', 'failed', 'cancelled']);
export const rollbackStatusEnum = pgEnum('rollback_status', ['pending', 'in_progress', 'completed', 'failed']);

// Patch Catalog
export const patches = pgTable('patches', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: patchSourceEnum('source').notNull(),
  externalId: varchar('external_id', { length: 255 }).notNull(),
  title: varchar('title', { length: 500 }).notNull(),
  description: text('description'),
  severity: patchSeverityEnum('severity').notNull().default('unspecified'),
  category: varchar('category', { length: 100 }),
  osTypes: text('os_types').array().notNull(),
  osVersions: text('os_versions').array(),
  architecture: text('architecture').array(),
  releaseDate: timestamp('release_date'),
  kbArticleUrl: text('kb_article_url'),
  supersedes: text('supersedes').array(),
  supersededBy: varchar('superseded_by', { length: 255 }),
  requiresReboot: boolean('requires_reboot').notNull().default(false),
  downloadUrl: text('download_url'),
  downloadSizeMb: integer('download_size_mb'),
  installCommand: text('install_command'),
  uninstallCommand: text('uninstall_command'),
  detectScript: text('detect_script'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  uniqueSourceId: unique().on(table.source, table.externalId)
}));

// Patch Policies
export const patchPolicies = pgTable('patch_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  enabled: boolean('enabled').notNull().default(true),
  targets: jsonb('targets').notNull(),
  sources: text('sources').array().notNull(),
  autoApprove: jsonb('auto_approve').default({
    enabled: false,
    severity: ['critical', 'important'],
    delayDays: 7,
    excludePatterns: []
  }),
  schedule: jsonb('schedule').notNull(),
  rebootPolicy: jsonb('reboot_policy').default({
    allowReboot: true,
    forceReboot: false,
    rebootDelayMinutes: 15,
    notifyUser: true,
    deferralCount: 3
  }),
  rollbackOnFailure: boolean('rollback_on_failure').notNull().default(true),
  preInstallScript: uuid('pre_install_script').references(() => scripts.id),
  postInstallScript: uuid('post_install_script').references(() => scripts.id),
  notifyOnComplete: boolean('notify_on_complete').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

// Patch Approvals
export const patchApprovals = pgTable('patch_approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  patchId: uuid('patch_id').notNull().references(() => patches.id),
  policyId: uuid('policy_id').references(() => patchPolicies.id),
  status: patchApprovalStatusEnum('status').notNull().default('pending'),
  approvedBy: uuid('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at'),
  deferUntil: timestamp('defer_until'),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  uniqueOrgPatch: unique().on(table.orgId, table.patchId)
}));

// Device Patches
export const devicePatches = pgTable('device_patches', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  patchId: uuid('patch_id').notNull().references(() => patches.id),
  status: patchStatusEnum('status').notNull().default('available'),
  installedAt: timestamp('installed_at'),
  installedVersion: varchar('installed_version', { length: 100 }),
  lastCheckedAt: timestamp('last_checked_at'),
  failureCount: integer('failure_count').notNull().default(0),
  lastError: text('last_error'),
  rollbackAvailable: boolean('rollback_available').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  uniqueDevicePatch: unique().on(table.deviceId, table.patchId)
}));

// Patch Jobs
export const patchJobs = pgTable('patch_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  policyId: uuid('policy_id').references(() => patchPolicies.id),
  name: varchar('name', { length: 255 }).notNull(),
  patches: jsonb('patches').notNull(),
  targets: jsonb('targets').notNull(),
  status: patchJobStatusEnum('status').notNull().default('scheduled'),
  scheduledAt: timestamp('scheduled_at'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  devicesTotal: integer('devices_total').notNull().default(0),
  devicesCompleted: integer('devices_completed').notNull().default(0),
  devicesFailed: integer('devices_failed').notNull().default(0),
  devicesPending: integer('devices_pending').notNull().default(0),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

// Patch Job Results
export const patchJobResults = pgTable('patch_job_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => patchJobs.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  patchId: uuid('patch_id').notNull().references(() => patches.id),
  status: patchStatusEnum('status').notNull().default('available'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  exitCode: integer('exit_code'),
  output: text('output'),
  errorMessage: text('error_message'),
  rebootRequired: boolean('reboot_required').notNull().default(false),
  rebootedAt: timestamp('rebooted_at'),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

// Patch Rollbacks
export const patchRollbacks = pgTable('patch_rollbacks', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  patchId: uuid('patch_id').notNull().references(() => patches.id),
  originalJobId: uuid('original_job_id').references(() => patchJobs.id),
  reason: text('reason'),
  status: rollbackStatusEnum('status').notNull().default('pending'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  output: text('output'),
  errorMessage: text('error_message'),
  initiatedBy: uuid('initiated_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

// Compliance Snapshots
export const patchComplianceSnapshots = pgTable('patch_compliance_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  snapshotDate: date('snapshot_date').notNull(),
  totalDevices: integer('total_devices').notNull(),
  compliantDevices: integer('compliant_devices').notNull(),
  nonCompliantDevices: integer('non_compliant_devices').notNull(),
  criticalMissing: integer('critical_missing').notNull(),
  importantMissing: integer('important_missing').notNull(),
  patchesPendingApproval: integer('patches_pending_approval').notNull(),
  patchesInstalled24h: integer('patches_installed_24h').notNull(),
  failedInstalls24h: integer('failed_installs_24h').notNull(),
  detailsByCategory: jsonb('details_by_category').default({}),
  createdAt: timestamp('created_at').defaultNow().notNull()
});
```

---

## Event Types

Standard event types for the event bus and webhooks:

```typescript
// Device Events
'device.enrolled'
'device.online'
'device.offline'
'device.updated'
'device.decommissioned'

// Alert Events
'alert.triggered'
'alert.acknowledged'
'alert.resolved'
'alert.escalated'

// Script Events
'script.started'
'script.completed'
'script.failed'

// Automation Events
'automation.started'
'automation.completed'
'automation.failed'

// Patch Events
'patch.available'
'patch.approved'
'patch.installed'
'patch.failed'
'patch.rollback'

// Remote Events
'remote.session.started'
'remote.session.ended'
'remote.file.transferred'

// User Events
'user.login'
'user.logout'
'user.mfa.enabled'
```

---

## Notes

- All times in UTC
- All IDs are UUIDs
- JSONB fields for flexibility
- Soft deletes where appropriate
- Comprehensive audit trail
