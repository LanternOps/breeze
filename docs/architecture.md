# Breeze RMM - Architecture Plan

## Overview

A fast, modern Remote Monitoring and Management platform targeting MSPs and internal IT teams. Built for 10,000+ agents with enterprise features.

**Tech Stack:**
- **Web**: Astro + React Islands + Hono + Drizzle + PostgreSQL + BullMQ/Redis
- **Agent**: Go (cross-platform: Windows, macOS, Linux)
- **Real-time**: WebSocket (on-demand) + HTTP polling (heartbeat)
- **Remote Access**: Built-in WebRTC for terminal and desktop sharing

---

## Core Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         BREEZE RMM                                  │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Astro Frontend (SSR + React Islands)                       │   │
│  │  - Dashboard, Device Views, Reports, Settings               │   │
│  │  - WebRTC client for remote access                          │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Hono API Layer                                             │   │
│  │  ├── /api/v1/auth/*        (login, MFA, SSO, tokens)        │   │
│  │  ├── /api/v1/agents/*      (registration, heartbeat, cmds)  │   │
│  │  ├── /api/v1/devices/*     (inventory, status, groups)      │   │
│  │  ├── /api/v1/scripts/*     (library, execution, results)    │   │
│  │  ├── /api/v1/automation/*  (policies, workflows, triggers)  │   │
│  │  ├── /api/v1/alerts/*      (rules, notifications, history)  │   │
│  │  ├── /api/v1/orgs/*        (tenants, sites, billing)        │   │
│  │  ├── /api/v1/users/*       (accounts, roles, permissions)   │   │
│  │  ├── /api/v1/audit/*       (logs, reports, exports)         │   │
│  │  └── /ws/*                 (real-time connections)          │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐      │
│  │  PostgreSQL  │  │    Redis     │  │  Object Storage      │      │
│  │  (Drizzle)   │  │  (BullMQ +   │  │  (S3/R2/Minio)       │      │
│  │              │  │   Caching)   │  │  Scripts, Logs, etc  │      │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   ┌─────────┐          ┌─────────┐          ┌─────────┐
   │ Go Agent│          │ Go Agent│          │ Go Agent│
   │ Windows │          │  macOS  │          │  Linux  │
   └─────────┘          └─────────┘          └─────────┘
```

---

## Data Models

### Multi-Level Multi-Tenancy

The system supports a hierarchical multi-tenant structure designed for MSPs:

```
Hierarchy:
  Partner (Top-level MSP/Reseller)
    └── Organization (MSP's Customer)
          └── Site (Customer Location)
                └── DeviceGroup
                      └── Device

Example:
  Acme IT Solutions (Partner - MSP)
    ├── First National Bank (Organization - Customer)
    │     ├── HQ Office (Site)
    │     │     ├── Servers (DeviceGroup)
    │     │     └── Workstations (DeviceGroup)
    │     └── Branch Office (Site)
    │
    ├── City Hospital (Organization - Customer)
    │     ├── Main Campus (Site)
    │     └── Clinic A (Site)
    │
    └── [Direct/Internal Use] (Organization)
          └── MSP Internal IT (Site)
```

```
Partner (Top-level tenant - MSP/Reseller)
├── id: uuid (PK)
├── name: string
├── slug: string (unique, for URLs)
├── type: enum (msp, enterprise, internal)
├── plan: enum (free, pro, enterprise, unlimited)
├── max_organizations: int (null = unlimited)
├── max_devices: int (null = unlimited)
├── settings: jsonb (branding, white-label config)
├── sso_config: jsonb (SAML/OIDC settings)
├── billing_email: string
├── created_at, updated_at
└── deleted_at (soft delete)

Organization (MSP's Customer / Sub-tenant)
├── id: uuid (PK)
├── partner_id: uuid (FK -> Partner)
├── name: string
├── slug: string (unique within partner)
├── type: enum (customer, internal)
├── status: enum (active, suspended, trial, churned)
├── max_devices: int (null = partner limit)
├── settings: jsonb (org-specific settings)
├── sso_config: jsonb (customer's own SSO)
├── contract_start: date
├── contract_end: date
├── billing_contact: jsonb
├── created_at, updated_at
└── deleted_at (soft delete)

Site (Location within Organization)
├── id: uuid (PK)
├── org_id: uuid (FK -> Organization)
├── name: string
├── address: jsonb
├── timezone: string
├── contact: jsonb (site contact info)
├── settings: jsonb (site-specific overrides)
└── created_at, updated_at

DeviceGroup
├── id: uuid (PK)
├── org_id: uuid (FK -> Organization)
├── site_id: uuid (FK, nullable - org-wide groups)
├── name: string
├── type: enum (static, dynamic)
├── rules: jsonb (for dynamic groups: OS=Windows AND RAM>8GB)
├── parent_id: uuid (FK, nullable - nested groups)
└── created_at, updated_at
```

### Access Control Hierarchy

Users can have access at different levels:

```
PartnerUser (MSP technicians)
├── id: uuid (PK)
├── partner_id: uuid (FK -> Partner)
├── user_id: uuid (FK -> User)
├── role_id: uuid (FK -> Role)
├── org_access: enum (all, selected, none)
├── org_ids: uuid[] (if selected, which orgs)
└── created_at

OrganizationUser (Customer users)
├── id: uuid (PK)
├── org_id: uuid (FK -> Organization)
├── user_id: uuid (FK -> User)
├── role_id: uuid (FK -> Role)
├── site_ids: uuid[] (scoped access, null = all sites)
├── device_group_ids: uuid[] (scoped access, null = all)
└── created_at
```

This allows:
- **MSP Admin**: Full access to all customers
- **MSP Technician**: Access to assigned customers only
- **Customer Admin**: Full access within their organization
- **Customer User**: Read-only or limited access to their org

### Users & Roles

```
User (Global user account - can belong to multiple partners/orgs)
├── id: uuid (PK)
├── email: string (unique)
├── name: string
├── password_hash: string (nullable for SSO-only)
├── mfa_secret: string (encrypted)
├── mfa_enabled: boolean
├── status: enum (active, invited, disabled)
├── avatar_url: string
├── last_login_at: timestamp
├── password_changed_at: timestamp
└── created_at, updated_at

Role (Scoped to partner, org, or system-wide)
├── id: uuid (PK)
├── partner_id: uuid (FK, nullable - partner-level roles)
├── org_id: uuid (FK, nullable - org-level roles)
├── scope: enum (system, partner, organization)
├── name: string
├── description: string
├── is_system: boolean (built-in roles like Admin, Technician, Viewer)
└── created_at, updated_at

Built-in System Roles:
- Partner Admin: Full access to partner and all orgs
- Partner Technician: Access to assigned orgs, execute scripts
- Partner Viewer: Read-only access to assigned orgs
- Org Admin: Full access within organization
- Org Technician: Execute scripts, manage devices
- Org Viewer: Read-only access

Permission
├── id: uuid (PK)
├── resource: string (devices, scripts, users, alerts, etc)
├── action: string (read, write, delete, execute, admin)
├── description: string

RolePermission
├── role_id: uuid (FK)
├── permission_id: uuid (FK)
└── constraints: jsonb (additional conditions)

Session
├── id: uuid (PK)
├── user_id: uuid (FK)
├── token_hash: string
├── ip_address: string
├── user_agent: string
├── expires_at: timestamp
└── created_at

ApiKey
├── id: uuid (PK)
├── org_id: uuid (FK)
├── user_id: uuid (FK, creator)
├── name: string
├── key_hash: string
├── permissions: jsonb (scoped permissions)
├── last_used_at: timestamp
├── expires_at: timestamp (nullable)
└── created_at
```

### Devices & Agents

```
Device
├── id: uuid (PK)
├── org_id: uuid (FK)
├── site_id: uuid (FK)
├── agent_id: string (unique, assigned at install)
├── hostname: string
├── display_name: string (user-friendly name)
├── os_type: enum (windows, macos, linux)
├── os_version: string
├── os_build: string
├── architecture: string (amd64, arm64)
├── agent_version: string
├── status: enum (online, offline, maintenance, decommissioned)
├── last_seen_at: timestamp
├── enrolled_at: timestamp
├── enrolled_by: uuid (FK -> User)
├── tags: string[]
└── created_at, updated_at

DeviceHardware
├── device_id: uuid (PK, FK)
├── cpu_model: string
├── cpu_cores: int
├── cpu_threads: int
├── ram_total_mb: int
├── disk_total_gb: int
├── gpu_model: string
├── serial_number: string
├── manufacturer: string
├── model: string
├── bios_version: string
└── updated_at

DeviceNetwork
├── id: uuid (PK)
├── device_id: uuid (FK)
├── interface_name: string
├── mac_address: string
├── ip_address: string
├── ip_type: enum (ipv4, ipv6)
├── is_primary: boolean
├── public_ip: string (detected by server)
└── updated_at

DeviceMetrics (time-series, partitioned)
├── device_id: uuid (FK)
├── timestamp: timestamptz (PK with device_id)
├── cpu_percent: float
├── ram_percent: float
├── ram_used_mb: int
├── disk_percent: float
├── disk_used_gb: float
├── network_in_bytes: bigint
├── network_out_bytes: bigint
├── process_count: int
└── custom_metrics: jsonb

DeviceSoftware
├── id: uuid (PK)
├── device_id: uuid (FK)
├── name: string
├── version: string
├── publisher: string
├── install_date: date
├── install_location: string
├── is_system: boolean
└── updated_at

DeviceGroupMembership
├── device_id: uuid (FK)
├── group_id: uuid (FK)
├── added_at: timestamp
├── added_by: enum (manual, dynamic_rule, policy)
```

### Scripting & Automation

```
Script
├── id: uuid (PK)
├── org_id: uuid (FK, nullable for system scripts)
├── name: string
├── description: string
├── category: string (maintenance, security, deployment, etc)
├── os_types: enum[] (compatible OS)
├── language: enum (powershell, bash, python, cmd)
├── content: text
├── parameters: jsonb (input params schema)
├── timeout_seconds: int
├── run_as: enum (system, user, elevated)
├── is_system: boolean (built-in scripts)
├── version: int
├── created_by: uuid (FK)
└── created_at, updated_at

ScriptExecution
├── id: uuid (PK)
├── script_id: uuid (FK)
├── device_id: uuid (FK)
├── triggered_by: uuid (FK -> User or Automation)
├── trigger_type: enum (manual, scheduled, alert, policy)
├── parameters: jsonb (actual values used)
├── status: enum (pending, queued, running, completed, failed, timeout, cancelled)
├── started_at: timestamp
├── completed_at: timestamp
├── exit_code: int
├── stdout: text (or S3 reference for large output)
├── stderr: text
├── error_message: string
└── created_at

Automation (Workflow)
├── id: uuid (PK)
├── org_id: uuid (FK)
├── name: string
├── description: string
├── enabled: boolean
├── trigger: jsonb (see trigger types below)
├── conditions: jsonb (device filters, time windows)
├── actions: jsonb[] (ordered action steps)
├── on_failure: enum (stop, continue, notify)
├── notification_targets: jsonb
├── last_run_at: timestamp
├── run_count: int
├── created_by: uuid (FK)
└── created_at, updated_at

AutomationRun
├── id: uuid (PK)
├── automation_id: uuid (FK)
├── triggered_by: string (schedule, alert:uuid, manual:user_id)
├── status: enum (running, completed, failed, partial)
├── devices_targeted: int
├── devices_succeeded: int
├── devices_failed: int
├── started_at: timestamp
├── completed_at: timestamp
├── logs: jsonb[]
└── created_at

Policy (Desired State)
├── id: uuid (PK)
├── org_id: uuid (FK)
├── name: string
├── description: string
├── enabled: boolean
├── targets: jsonb (device groups, OS filters)
├── rules: jsonb[] (desired state rules)
├── enforcement: enum (monitor, warn, enforce)
├── check_interval_minutes: int
├── remediation_script_id: uuid (FK, nullable)
├── last_evaluated_at: timestamp
└── created_at, updated_at

PolicyCompliance
├── id: uuid (PK)
├── policy_id: uuid (FK)
├── device_id: uuid (FK)
├── status: enum (compliant, non_compliant, pending, error)
├── details: jsonb (per-rule status)
├── last_checked_at: timestamp
├── remediation_attempts: int
└── updated_at
```

#### Automation Trigger Types
```jsonc
// Schedule-based
{ "type": "schedule", "cron": "0 2 * * *", "timezone": "America/New_York" }

// Event-based
{ "type": "event", "event": "device.enrolled" }
{ "type": "event", "event": "device.offline", "duration_minutes": 15 }
{ "type": "event", "event": "alert.triggered", "alert_rule_id": "uuid" }

// Webhook
{ "type": "webhook", "secret": "..." }

// Manual only
{ "type": "manual" }
```

#### Automation Action Types
```jsonc
// Run script
{ "type": "run_script", "script_id": "uuid", "parameters": {} }

// Send notification
{ "type": "notify", "channels": ["email", "slack"], "template": "..." }

// Update device
{ "type": "update_device", "fields": { "tags": ["patched"] } }

// Run another automation
{ "type": "run_automation", "automation_id": "uuid" }

// Wait
{ "type": "wait", "seconds": 300 }

// Conditional branch
{ "type": "condition", "if": { "last_step.exit_code": 0 }, "then": [...], "else": [...] }
```

### Alerting & Notifications

```
AlertRule
├── id: uuid (PK)
├── org_id: uuid (FK)
├── name: string
├── description: string
├── enabled: boolean
├── severity: enum (critical, high, medium, low, info)
├── targets: jsonb (device groups, all devices, specific)
├── conditions: jsonb (metric thresholds, patterns)
├── cooldown_minutes: int (prevent alert spam)
├── escalation_policy_id: uuid (FK, nullable)
├── notification_channels: jsonb[]
├── auto_resolve: boolean
├── created_by: uuid (FK)
└── created_at, updated_at

Alert (Instance)
├── id: uuid (PK)
├── rule_id: uuid (FK)
├── device_id: uuid (FK)
├── org_id: uuid (FK)
├── status: enum (active, acknowledged, resolved, suppressed)
├── severity: enum
├── title: string
├── message: text
├── context: jsonb (metric values, thresholds)
├── triggered_at: timestamp
├── acknowledged_at: timestamp
├── acknowledged_by: uuid (FK)
├── resolved_at: timestamp
├── resolved_by: uuid (FK, or 'auto')
├── resolution_note: text
└── created_at

AlertCondition Examples:
```jsonc
// CPU > 90% for 5 minutes
{ "metric": "cpu_percent", "operator": "gt", "value": 90, "duration_minutes": 5 }

// Disk < 10% free
{ "metric": "disk_percent", "operator": "gt", "value": 90 }

// Device offline
{ "type": "status", "status": "offline", "duration_minutes": 10 }

// Software installed/removed
{ "type": "software_change", "action": "removed", "name_pattern": "Antivirus*" }

// Custom metric
{ "metric": "custom.app_response_time_ms", "operator": "gt", "value": 5000 }
```

NotificationChannel
├── id: uuid (PK)
├── org_id: uuid (FK)
├── name: string
├── type: enum (email, slack, teams, webhook, pagerduty, sms)
├── config: jsonb (encrypted credentials, URLs)
├── enabled: boolean
└── created_at, updated_at

EscalationPolicy
├── id: uuid (PK)
├── org_id: uuid (FK)
├── name: string
├── steps: jsonb[] (escalation ladder)
└── created_at, updated_at

EscalationStep:
```jsonc
{ "delay_minutes": 0, "channels": ["email"], "targets": ["oncall"] }
{ "delay_minutes": 15, "channels": ["sms", "slack"], "targets": ["team_lead"] }
{ "delay_minutes": 30, "channels": ["phone"], "targets": ["manager"] }
```

### Remote Access

```
RemoteSession
├── id: uuid (PK)
├── device_id: uuid (FK)
├── user_id: uuid (FK)
├── type: enum (terminal, desktop, file_transfer)
├── status: enum (pending, connecting, active, disconnected, failed)
├── webrtc_offer: text (SDP)
├── webrtc_answer: text (SDP)
├── ice_candidates: jsonb[]
├── started_at: timestamp
├── ended_at: timestamp
├── duration_seconds: int
├── bytes_transferred: bigint
├── recording_url: string (if enabled)
└── created_at

FileTransfer
├── id: uuid (PK)
├── session_id: uuid (FK, nullable)
├── device_id: uuid (FK)
├── user_id: uuid (FK)
├── direction: enum (upload, download)
├── remote_path: string
├── local_filename: string
├── size_bytes: bigint
├── status: enum (pending, transferring, completed, failed)
├── progress_percent: int
├── error_message: string
└── created_at, completed_at
```

### Audit & Compliance

```
AuditLog (append-only, partitioned by month)
├── id: uuid (PK)
├── org_id: uuid (FK)
├── timestamp: timestamptz
├── actor_type: enum (user, api_key, agent, system)
├── actor_id: uuid
├── actor_email: string (denormalized for logs)
├── action: string (e.g., 'device.script.execute')
├── resource_type: string
├── resource_id: uuid
├── resource_name: string (denormalized)
├── details: jsonb (full request/response context)
├── ip_address: string
├── user_agent: string
├── result: enum (success, failure, denied)
├── error_message: string
└── checksum: string (for integrity verification)

AuditRetentionPolicy
├── id: uuid (PK)
├── org_id: uuid (FK)
├── retention_days: int
├── archive_to_s3: boolean
├── last_cleanup_at: timestamp
└── created_at, updated_at
```

---

## Agent Architecture (Go)

### Agent Components

```
breeze-agent/
├── cmd/
│   └── breeze-agent/
│       └── main.go
├── internal/
│   ├── config/           # Config management
│   ├── heartbeat/        # Polling & check-in
│   ├── commands/         # Command execution
│   ├── collectors/       # System info collectors
│   │   ├── hardware.go
│   │   ├── software.go
│   │   ├── network.go
│   │   ├── metrics.go
│   │   └── processes.go
│   ├── scripts/          # Script runner
│   ├── remote/           # WebRTC remote access
│   │   ├── terminal.go
│   │   ├── desktop.go
│   │   └── filetransfer.go
│   ├── updates/          # Self-update mechanism
│   └── platform/         # OS-specific code
│       ├── windows/
│       ├── darwin/
│       └── linux/
├── pkg/
│   └── api/              # Server API client
└── scripts/
    └── install/          # Platform installers
```

### Agent Communication Flow

```
1. ENROLLMENT
   Agent → Server: POST /api/v1/agents/enroll
   { enrollment_key: "...", hostname, os_type, hardware_info }
   Server → Agent: { agent_id, auth_token, config }

2. HEARTBEAT (every 60s default, configurable)
   Agent → Server: POST /api/v1/agents/{id}/heartbeat
   Headers: Authorization: Bearer {token}
   Body: {
     metrics: { cpu, ram, disk, network },
     status: "ok" | "warning" | "error",
     agent_version,
     pending_reboot,
     last_user
   }
   Server → Agent: {
     commands: [...],       # Queued commands to execute
     config_update: {...},  # Config changes
     upgrade_to: "v1.2.3"   # Self-update instruction
   }

3. COMMAND EXECUTION
   Agent receives command in heartbeat response
   Agent → Server: POST /api/v1/agents/{id}/commands/{cmd_id}/result
   { status, exit_code, stdout, stderr, duration_ms }

4. REAL-TIME (WebSocket, on-demand)
   Server initiates when user requests remote access
   Server → Agent (via heartbeat): { commands: [{ type: "connect_ws", session_id }] }
   Agent → Server: WebSocket /ws/agents/{id}?session={session_id}
   Bidirectional: terminal I/O, desktop frames, file chunks
```

### Agent Security

- **Mutual TLS**: Agent validates server cert, server validates agent cert
- **Token rotation**: Auth tokens expire & rotate regularly
- **Command signing**: Server signs commands, agent verifies
- **Sandboxed execution**: Scripts run in restricted environment
- **Local encryption**: Credentials encrypted at rest

---

## API Design (Hono)

### Authentication Endpoints

```
POST   /api/v1/auth/login           # Email/password login
POST   /api/v1/auth/logout          # Invalidate session
POST   /api/v1/auth/refresh         # Refresh access token
POST   /api/v1/auth/mfa/setup       # Begin MFA setup
POST   /api/v1/auth/mfa/verify      # Verify MFA code
GET    /api/v1/auth/sso/{provider}  # Initiate SSO
POST   /api/v1/auth/sso/callback    # SSO callback
POST   /api/v1/auth/forgot-password # Password reset request
POST   /api/v1/auth/reset-password  # Complete password reset
```

### Device Management

```
GET    /api/v1/devices              # List devices (paginated, filtered)
GET    /api/v1/devices/:id          # Get device details
PATCH  /api/v1/devices/:id          # Update device (name, tags, site)
DELETE /api/v1/devices/:id          # Decommission device
GET    /api/v1/devices/:id/hardware # Hardware details
GET    /api/v1/devices/:id/software # Installed software
GET    /api/v1/devices/:id/metrics  # Metrics history
GET    /api/v1/devices/:id/alerts   # Device alerts
POST   /api/v1/devices/:id/commands # Queue command
GET    /api/v1/devices/:id/commands # Command history

POST   /api/v1/device-groups        # Create group
GET    /api/v1/device-groups        # List groups
PATCH  /api/v1/device-groups/:id    # Update group
DELETE /api/v1/device-groups/:id    # Delete group
POST   /api/v1/device-groups/:id/members  # Add devices to group
DELETE /api/v1/device-groups/:id/members  # Remove from group
```

### Scripts & Automation

```
GET    /api/v1/scripts              # List scripts
POST   /api/v1/scripts              # Create script
GET    /api/v1/scripts/:id          # Get script
PATCH  /api/v1/scripts/:id          # Update script
DELETE /api/v1/scripts/:id          # Delete script
POST   /api/v1/scripts/:id/execute  # Execute on devices

GET    /api/v1/automations          # List automations
POST   /api/v1/automations          # Create automation
GET    /api/v1/automations/:id      # Get automation
PATCH  /api/v1/automations/:id      # Update automation
DELETE /api/v1/automations/:id      # Delete automation
POST   /api/v1/automations/:id/run  # Manual trigger
GET    /api/v1/automations/:id/runs # Execution history

GET    /api/v1/policies             # List policies
POST   /api/v1/policies             # Create policy
GET    /api/v1/policies/:id         # Get policy
PATCH  /api/v1/policies/:id         # Update policy
DELETE /api/v1/policies/:id         # Delete policy
GET    /api/v1/policies/:id/compliance # Compliance status
```

### Alerts

```
GET    /api/v1/alert-rules          # List rules
POST   /api/v1/alert-rules          # Create rule
PATCH  /api/v1/alert-rules/:id      # Update rule
DELETE /api/v1/alert-rules/:id      # Delete rule

GET    /api/v1/alerts               # List alerts
GET    /api/v1/alerts/:id           # Get alert
POST   /api/v1/alerts/:id/acknowledge  # Acknowledge
POST   /api/v1/alerts/:id/resolve   # Resolve
POST   /api/v1/alerts/:id/suppress  # Suppress
```

### Remote Access

```
POST   /api/v1/remote/sessions      # Start remote session
GET    /api/v1/remote/sessions/:id  # Get session status
DELETE /api/v1/remote/sessions/:id  # End session
POST   /api/v1/remote/sessions/:id/ice  # ICE candidate exchange

WebSocket endpoints:
WS     /ws/remote/:session_id       # WebRTC signaling + data
WS     /ws/agents/:agent_id         # Agent real-time channel
```

### Organization & Users

```
GET    /api/v1/orgs/current         # Current org details
PATCH  /api/v1/orgs/current         # Update org settings
GET    /api/v1/orgs/current/sites   # List sites
POST   /api/v1/orgs/current/sites   # Create site

GET    /api/v1/users                # List org users
POST   /api/v1/users                # Invite user
GET    /api/v1/users/:id            # Get user
PATCH  /api/v1/users/:id            # Update user
DELETE /api/v1/users/:id            # Remove user

GET    /api/v1/roles                # List roles
POST   /api/v1/roles                # Create custom role
PATCH  /api/v1/roles/:id            # Update role
DELETE /api/v1/roles/:id            # Delete role
```

### Audit

```
GET    /api/v1/audit/logs           # Query audit logs
GET    /api/v1/audit/logs/export    # Export logs (CSV/JSON)
GET    /api/v1/audit/summary        # Activity summary
```

---

## Project Structure

```
breeze/
├── apps/
│   ├── web/                        # Astro + React frontend
│   │   ├── src/
│   │   │   ├── components/         # React components
│   │   │   │   ├── ui/            # Base UI components
│   │   │   │   ├── devices/       # Device-related components
│   │   │   │   ├── scripts/       # Script editor, execution
│   │   │   │   ├── alerts/        # Alert management
│   │   │   │   ├── remote/        # Remote access UI
│   │   │   │   └── dashboard/     # Dashboard widgets
│   │   │   ├── layouts/           # Page layouts
│   │   │   ├── pages/             # Astro pages
│   │   │   │   ├── index.astro
│   │   │   │   ├── devices/
│   │   │   │   ├── scripts/
│   │   │   │   ├── automations/
│   │   │   │   ├── alerts/
│   │   │   │   ├── remote/
│   │   │   │   ├── settings/
│   │   │   │   └── auth/
│   │   │   ├── stores/            # State management
│   │   │   └── lib/               # Utilities, API client
│   │   ├── public/
│   │   ├── astro.config.mjs
│   │   └── package.json
│   │
│   └── api/                        # Hono API server
│       ├── src/
│       │   ├── index.ts           # Entry point
│       │   ├── routes/            # Route handlers
│       │   │   ├── auth.ts
│       │   │   ├── agents.ts
│       │   │   ├── devices.ts
│       │   │   ├── scripts.ts
│       │   │   ├── automations.ts
│       │   │   ├── alerts.ts
│       │   │   ├── remote.ts
│       │   │   ├── orgs.ts
│       │   │   ├── users.ts
│       │   │   └── audit.ts
│       │   ├── middleware/        # Auth, logging, rate limiting
│       │   ├── services/          # Business logic
│       │   ├── jobs/              # BullMQ job processors
│       │   │   ├── heartbeat.ts
│       │   │   ├── alerts.ts
│       │   │   ├── automation.ts
│       │   │   └── cleanup.ts
│       │   ├── ws/                # WebSocket handlers
│       │   └── lib/               # Utilities
│       ├── drizzle/
│       │   ├── schema/            # Drizzle schema files
│       │   │   ├── orgs.ts
│       │   │   ├── users.ts
│       │   │   ├── devices.ts
│       │   │   ├── scripts.ts
│       │   │   ├── automations.ts
│       │   │   ├── alerts.ts
│       │   │   └── audit.ts
│       │   └── migrations/
│       └── package.json
│
├── packages/
│   ├── shared/                     # Shared types, utilities
│   │   ├── src/
│   │   │   ├── types/             # TypeScript types
│   │   │   ├── validators/        # Zod schemas
│   │   │   └── constants/
│   │   └── package.json
│   │
│   └── ui/                         # Shared UI components (if needed)
│
├── agent/                          # Go agent
│   ├── cmd/breeze-agent/
│   ├── internal/
│   ├── pkg/
│   ├── scripts/install/
│   ├── go.mod
│   └── Makefile
│
├── docker/
│   ├── docker-compose.yml          # Local dev
│   ├── docker-compose.prod.yml     # Production
│   ├── Dockerfile.api
│   └── Dockerfile.web
│
├── docs/
│   ├── architecture.md
│   ├── api.md
│   └── agent.md
│
├── scripts/
│   └── setup.sh
│
├── turbo.json                      # Turborepo config
├── pnpm-workspace.yaml
├── package.json
└── README.md
```

---

## Implementation Phases

### Phase 1: Foundation
1. Project scaffolding (monorepo, packages)
2. Database schema & migrations
3. Authentication (local + MFA)
4. Basic RBAC
5. Organization/Site/User management UI

### Phase 2: Agent Core
1. Go agent skeleton
2. Enrollment flow
3. Heartbeat/polling
4. Hardware/software collectors
5. Basic metrics reporting

### Phase 3: Device Management
1. Device list/detail views
2. Device groups (static)
3. Inventory views (hardware, software)
4. Real-time metrics dashboard
5. Device search & filtering

### Phase 4: Scripting
1. Script library CRUD
2. Script editor (syntax highlighting)
3. Execute on single device
4. Execute on device groups
5. Execution history & results

### Phase 5: Alerting
1. Alert rule builder
2. Metric threshold alerts
3. Status alerts (offline)
4. Notification channels (email, webhook)
5. Alert dashboard

### Phase 6: Remote Access
1. WebRTC signaling server
2. Agent WebRTC client
3. Web terminal (xterm.js)
4. Basic file transfer
5. Session recording (optional)

### Phase 7: Automation
1. Automation builder UI
2. Schedule triggers
3. Event triggers
4. Multi-step workflows
5. Policy engine (desired state)

### Phase 8: Enterprise
1. SSO (SAML/OIDC)
2. Advanced RBAC (resource scoping)
3. Compliance-ready audit logs
4. API keys
5. Multi-region support

---

## Key Libraries & Dependencies

### Web (TypeScript)
- **Astro** - Static site generation + islands
- **React** - Interactive components
- **Hono** - API framework
- **Drizzle ORM** - Database
- **BullMQ** - Job queues
- **Zod** - Validation
- **@tanstack/react-query** - Data fetching
- **xterm.js** - Web terminal
- **simple-peer** or **peerjs** - WebRTC
- **Tailwind CSS** - Styling
- **shadcn/ui** - UI components
- **Recharts** - Charts

### Agent (Go)
- **gopsutil** - System info
- **gorilla/websocket** - WebSocket client
- **pion/webrtc** - WebRTC
- **creack/pty** - PTY for terminal
- **spf13/cobra** - CLI
- **spf13/viper** - Config

---

## Verification Steps

After scaffolding:
1. `pnpm install` - Dependencies install successfully
2. `pnpm dev` - Web + API start without errors
3. `docker-compose up -d` - Postgres + Redis start
4. `pnpm db:push` - Schema pushes to database
5. API health check: `curl http://localhost:3001/health`
6. Web loads at `http://localhost:4321`
7. `cd agent && go build ./...` - Agent compiles
