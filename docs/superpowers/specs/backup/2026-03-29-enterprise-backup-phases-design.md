# Breeze RMM — Enterprise Backup: Next Phases

## Context

The current backup system provides **file-level backups** with gzip compression, timestamp-based incremental detection, local + S3 storage providers, scheduling via BullMQ, verification/readiness scoring (BE-29, merged), and a React web UI. The DB schema already has enum values for `system_image`, `database`, `application`, and `bare_metal` but **none of these are implemented yet**.

This spec designs **7 phases** to bring the backup system to enterprise-grade, covering VSS, system state + bare metal recovery, MSSQL, Hyper-V, cloud-to-cloud, storage providers, DR orchestration, and SLA monitoring.

---

## Phase 1: VSS Integration (Windows Application-Consistent Backups)

**Goal**: Use Volume Shadow Copy Service before file/image backups so open files and databases get consistent snapshots.

**Why first**: VSS is a prerequisite for MSSQL, Hyper-V, Exchange, and system image backups. Everything downstream depends on it.

### Agent (Go)

**New package**: `agent/internal/backup/vss/`

| File | Purpose |
|------|---------|
| `vss_windows.go` | VSS requestor via COM — `IVssBackupComponents` using pure-Go syscall vtable pattern from `comutil_windows.go`. `CoInitializeEx(COINIT_MULTITHREADED)` + `runtime.LockOSThread()` on dedicated goroutine. |
| `vss_stub.go` (`//go:build !windows`) | No-op stub returning "VSS not supported" |
| `writers_windows.go` | VSS writer enumeration — iterate `GetWriterMetadata` to report writer name, state, failures for SQL Server, Hyper-V, Exchange, filesystem writers |
| `shadow_windows.go` | Shadow copy lifecycle: `AddToSnapshotSet` → `PrepareForBackup` → `DoSnapshotSet` → expose shadow path → `BackupComplete` → `DeleteSnapshots` |
| `types.go` | `VSSSession`, `VSSMetadata` (shadow ID, creation time, writer statuses, exposed path), `WriterStatus` |

**Integration point**: Modify `BackupManager.RunBackup()` in `agent/internal/backup/backup.go` — if Windows + VSS enabled, create shadow copy first, rewrite source paths to shadow device path, then proceed with existing file collection.

**New commands**: `vss_status`, `vss_writer_list`

**Error handling**: Writer failure → log warning, continue with available writers, mark job `partial`. All writers fail → attempt backup without VSS (degraded mode), flag risk factor. VSS timeout (10 min default) → cancel snapshot set, retry once, then fall back.

### API

- `GET /backup/vss/status/:deviceId` — dispatches `vss_writer_list` command
- Add `vss_metadata` JSONB column to `backup_jobs`
- Web UI: show VSS writer status on backup job details

### DB Migration

```sql
ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS vss_metadata jsonb;
```

---

## Phase 2: Storage Providers + Encryption + Advanced Retention

**Goal**: Implement remaining storage backends, client-side encryption, and GFS retention.

### 2A: Storage Providers

**New Go provider files** in `agent/internal/backup/providers/`:

| File | SDK |
|------|-----|
| `azure.go` | `github.com/Azure/azure-sdk-for-go/sdk/storage/azblob` |
| `gcs.go` | `cloud.google.com/go/storage` |
| `b2.go` | `github.com/Backblaze/blazer/b2` |

All implement the existing `BackupProvider` interface (Upload/Download/List/Delete).

**Provider interface extensions** (optional Go interfaces for backward compat):

```go
type StreamUploader interface {
    UploadStream(reader io.Reader, remotePath string, size int64) error
}
type Encryptor interface {
    UploadEncrypted(localPath, remotePath string, key []byte) error
    DownloadDecrypted(remotePath, localPath string, key []byte) error
}
type ImmutableStorage interface {
    SetObjectLock(remotePath string, retainUntil time.Time) error
}
type TierableStorage interface {
    SetStorageTier(remotePath string, tier string) error
}
```

Backup manager type-asserts at runtime: `if enc, ok := provider.(Encryptor); ok { ... }`

### 2B: Client-Side Encryption (BYOK)

- New table `storage_encryption_keys` (orgId, keyType, publicKeyPem, encryptedPrivateKey, keyHash, isActive)
- API endpoints: `POST/GET/DELETE /backup/configs/:id/encryption-key`
- Agent encrypts with AES-256-GCM before upload; key derived via HKDF with per-snapshot salt from org encryption key

### 2C: GFS Retention + Legal Hold

Extend `backup_policies` with:
- `gfsConfig` JSONB — `{ daily: 7, weekly: 4, monthly: 12, yearly: 3 }`
- `legalHold` boolean + `legalHoldReason` text
- `bandwidthLimitMbps` integer
- `backupWindowStart` / `backupWindowEnd` varchar
- `priority` integer (1=highest)

Extend `backup_snapshots` with:
- `storageTier`, `isImmutable`, `immutableUntil`, `legalHold`, `encryptionKeyId`, `checksumSha256`

GFS tagging: on backup completion, tag snapshot as daily; if last-of-week also `weekly`; if last-of-month also `monthly`; if last-of-year also `yearly`. Retention keeps N most recent of each tag.

Agent bandwidth throttling: `golang.org/x/time/rate` token bucket wrapping `io.Reader` before provider upload.

---

## Phase 3: System State Backup + Bare Metal / VM Restore

**Goal**: Extend file-level backups with system state capture (OS config, registry, drivers, boot config, certs). Use these system state + file backups as the source for bare metal recovery and VM restore — no block-level disk imaging.

**Key insight**: MSPs almost always rebuild from a standard OS image. What they need back is the data + configuration, not a sector-by-sector disk clone. System state + files gets ~90% of BMR value at ~15% of the imaging complexity.

### 3A: System State Capture

Extend the existing file-level backup to collect OS-critical state alongside user data.

**New package**: `agent/internal/backup/systemstate/`

| File | Purpose |
|------|---------|
| `systemstate.go` | Orchestrator — collects all system state artifacts into a temp staging dir, adds them to the file backup manifest |
| `state_windows.go` | Windows system state: registry hives (`SYSTEM`, `SOFTWARE`, `SAM`, `SECURITY` via `reg save`), boot config (`bcdedit /export`), driver inventory (`driverquery /v /fo csv` + INF files for critical drivers), certificate stores (`certutil -backupDB`), IIS config (`appcmd list config /xml`), service configs, scheduled tasks, firewall rules, Windows features list |
| `state_darwin.go` | macOS system state: `/Library/Preferences/`, launchd plists (`/Library/LaunchDaemons/`, `/Library/LaunchAgents/`), system keychain backup, network config (`networksetup`), installed packages (`pkgutil --pkgs`), user list + groups |
| `state_linux.go` | Linux system state: `/etc/` (full tree), `/boot/` config files, package list (`dpkg --get-selections` or `rpm -qa`), systemd service configs, firewall rules (`iptables-save`), crontabs, user/group databases |
| `drivers_windows.go` | Export critical driver INF + sys files (storage controllers, NICs, chipset) for injection during BMR. Package as zip in the backup. |
| `hardware_profile.go` | Capture hardware fingerprint: CPU model, motherboard, storage controllers, NIC models, BIOS/UEFI version, disk layout (partition table, volume labels, mount points, filesystem types). Stored in snapshot metadata for recovery planning. |
| `types.go` | `SystemStateManifest` (list of collected artifacts, hardware profile, platform, OS version), `DriverPack` (list of drivers with device IDs) |

**Integration with existing backup**: `BackupManager.RunBackup()` gains a `systemState: boolean` config flag. When enabled:
1. Collect system state artifacts to temp staging dir
2. Add staging dir to the existing file paths list
3. Existing file backup flow handles compression + upload
4. System state manifest stored in `backup_snapshots.metadata`

On Windows, VSS (Phase 1) runs first for consistency — system state files are read from the shadow copy.

**New commands**: `system_state_collect` (standalone collection for on-demand snapshots), `hardware_profile` (lightweight — just captures hardware fingerprint without full backup)

### 3B: Bare Metal Recovery

Recovery approach: fresh OS install → Breeze agent install → agent restores system state + files → post-restore fixup.

**New package**: `agent/internal/backup/bmr/`

| File | Purpose |
|------|---------|
| `bmr.go` | Recovery orchestrator — sequences: download system state → apply OS config → restore files → apply drivers → fixup → re-enroll |
| `restore_windows.go` | Apply Windows system state: import registry hives (`reg restore`), restore boot config, import certificates (`certutil -restoreDB`), restore IIS config, re-register services, restore scheduled tasks, apply firewall rules |
| `restore_darwin.go` | Apply macOS state: restore preferences, launchd plists, keychain, network config |
| `restore_linux.go` | Apply Linux state: restore `/etc/`, reinstall packages from saved list, restore systemd configs, apply firewall rules, restore crontabs |
| `drivers_windows.go` | Inject drivers from the backup's driver pack into the fresh OS (`pnputil /add-driver *.inf /install /subdirs`) — handles dissimilar hardware by matching PnP device IDs |
| `validate.go` | Post-restore validation: verify services started, network connectivity, critical files present, boot config intact |
| `reenroll.go` | Re-enrollment: agent maps back to original device record in Breeze API, preserving history |

**Recovery media**: Rather than building custom WinPE ISOs (massive complexity), provide:
1. **Recovery guide generator** — API generates a device-specific PDF/HTML recovery runbook with: hardware profile, OS version, required drivers download link, step-by-step instructions, Breeze agent installer URL with pre-configured recovery token
2. **PXE/network boot** (optional) — iPXE script that chain-loads a standard OS installer + injects Breeze agent auto-install script
3. **Recovery token** — one-time auth token that lets a freshly installed agent identify itself as a recovery target and pull the right backup

**New table**:

```sql
CREATE TABLE recovery_tokens (
  id uuid PK, org_id, device_id FK, snapshot_id FK -> backup_snapshots,
  token_hash varchar(64) NOT NULL,  -- SHA-256 of the token
  restore_type varchar(30) NOT NULL, -- 'bare_metal', 'vm_restore', 'system_state'
  target_config jsonb,               -- VM specs, target hardware profile, etc.
  status varchar(20) DEFAULT 'active', -- active, used, expired, revoked
  created_by FK -> users,
  created_at, expires_at, used_at
);
```

**New API endpoints**:
- `POST /backup/bmr/prepare/:deviceId` — collects system state + creates recovery package (runbook + driver pack + token)
- `POST /backup/bmr/token` — generate recovery token for a snapshot (body: snapshotId, restoreType, targetConfig)
- `GET /backup/bmr/token/:tokenId/runbook` — download recovery runbook PDF/HTML
- `POST /backup/bmr/recover/authenticate` — recovery agent authenticates with token, receives snapshot manifest + download URLs
- `POST /backup/bmr/recover/complete` — agent reports recovery complete, triggers re-enrollment
- `GET /backup/bmr/drivers/:snapshotId` — download driver pack from backup

**Bare metal recovery flow**:
1. Admin generates recovery token from web UI for a device's latest backup
2. Admin installs fresh OS on replacement hardware (standard process, or PXE)
3. Admin installs Breeze agent with recovery token: `breeze-agent install --recovery-token=<token>`
4. Agent authenticates with API, downloads system state + file backup
5. Agent applies system state (registry, drivers, certs, services, configs)
6. Agent restores all backed-up files to original paths
7. Agent validates (services running, network up, critical files present)
8. Agent re-enrolls with original device record, reboot recommended
9. Device shows up in Breeze dashboard with restored history

### 3C: VM Restore (from System State + File Backups)

Restore a backed-up machine as a new VM — useful for P2V migration or spinning up a copy for testing.

**New file**: `agent/internal/backup/bmr/vm_restore.go`

| Function | Purpose |
|----------|---------|
| `CreateHyperVFromBackup()` | Create new Hyper-V VM matching the hardware profile (memory, CPU, disk size from backup metadata), create blank VHDX, mount it, restore files + system state into it, inject Hyper-V drivers, fix boot config for VM hardware, detach |
| `CreateVMwareFromBackup()` | Similar flow for VMware Workstation/ESXi — create VMDK, restore into it |
| `EstimateVMRequirements()` | Read hardware profile + total backup size to recommend VM specs |

**VM restore flow**:
1. Admin selects backup snapshot → "Restore as VM"
2. Chooses hypervisor (Hyper-V on a target host device, or download OVA/VHDX)
3. For Hyper-V on a managed host: API dispatches `vm_restore_from_backup` command to the host agent
4. Host agent creates VM, mounts blank disk, restores system state + files, injects VM-appropriate drivers, fixes boot config
5. VM boots with restored OS + data, Breeze agent inside re-enrolls

**New commands**: `vm_restore_from_backup` (on the target Hyper-V host), `vm_restore_estimate` (returns estimated disk/memory/CPU needs)

**API endpoints**:
- `POST /backup/restore/as-vm` — trigger VM restore (body: snapshotId, targetDeviceId, hypervisor, vmName, vmSpecs?)
- `GET /backup/restore/as-vm/estimate/:snapshotId` — estimate VM requirements from backup metadata

### DB Migration

```sql
ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS backup_type backup_type DEFAULT 'file';
ALTER TABLE backup_snapshots ADD COLUMN IF NOT EXISTS backup_type backup_type DEFAULT 'file';
ALTER TABLE backup_snapshots ADD COLUMN IF NOT EXISTS hardware_profile jsonb;
ALTER TABLE backup_snapshots ADD COLUMN IF NOT EXISTS system_state_manifest jsonb;
ALTER TABLE restore_jobs ADD COLUMN IF NOT EXISTS restore_type restore_type DEFAULT 'selective';
ALTER TABLE restore_jobs ADD COLUMN IF NOT EXISTS target_config jsonb;  -- VM specs, target hardware, etc.
ALTER TABLE restore_jobs ADD COLUMN IF NOT EXISTS recovery_token_id uuid REFERENCES recovery_tokens(id);
```

---

## Phase 4: MSSQL Backup & Restore

**Goal**: Full/differential/log backup of SQL Server databases with point-in-time recovery.

### Agent (Go)

**New package**: `agent/internal/backup/mssql/`

| File | Purpose |
|------|---------|
| `discovery.go` | 3-prong discovery: (1) Registry `HKLM\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL`, (2) Windows services matching `MSSQL$*`, (3) SQL Browser UDP 1434. Probe each for version, edition, database list, TDE status. |
| `connection.go` | SQL connection pool using `github.com/microsoft/go-mssqldb`. Support Windows Integrated auth (SYSTEM account) + SQL auth. |
| `backup.go` | Execute `BACKUP DATABASE ... TO DISK`, `BACKUP DATABASE ... WITH DIFFERENTIAL`, `BACKUP LOG ... TO DISK`. Write to local temp → upload to provider → delete local. Native SQL compression enabled. |
| `restore.go` | Sequential `RESTORE DATABASE ... WITH NORECOVERY` for chain replay. `RESTORE LOG ... WITH STOPAT` for point-in-time. `RESTORE VERIFYONLY` for verification. |
| `chain.go` | LSN chain management. Local state file (`$DATA_DIR/mssql_chains/<instance>_<db>.json`) tracking last full LSN, diff LSN, log sequence. |
| `types.go` | `SQLInstance`, `SQLDatabase`, `BackupChainState`, `MSSQLBackupResult` |

**New dependency**: `github.com/microsoft/go-mssqldb` in `go.mod`

**New commands** (all `//go:build windows`): `mssql_discover`, `mssql_backup`, `mssql_restore`, `mssql_verify`, `mssql_list_chains`

**Handler files**: `handlers_mssql.go` + `handlers_mssql_other.go` (stub for non-Windows)

### Backup Chain Management

**New table**: `backup_chains`

```sql
CREATE TABLE backup_chains (
  id uuid PK, org_id, device_id, config_id FK,
  chain_type ('mssql'|'hyperv'), target_name varchar(256),
  target_id varchar(256), is_active boolean,
  full_snapshot_id FK -> backup_snapshots,
  chain_metadata jsonb, created_at, updated_at
);
```

Chain lifecycle: Full backup creates/resets chain → diff references chain's full LSN → log appends to log sequence → new full marks previous chain inactive.

MSSQL snapshot metadata (in `backup_snapshots.metadata` JSONB):
```json
{
  "backupSubType": "full|differential|log",
  "instanceName": "MSSQLSERVER",
  "databaseName": "MyDatabase",
  "firstLsn": "...", "lastLsn": "...", "databaseBackupLsn": "...",
  "compressed": true, "recoveryModel": "FULL", "chainId": "uuid"
}
```

### Scheduling

Extend `backup_policies.schedule` JSONB with `subSchedules` array:
```json
[
  {"subType": "full", "frequency": "weekly", "dayOfWeek": 0, "time": "02:00"},
  {"subType": "differential", "frequency": "daily", "time": "12:00"},
  {"subType": "log", "frequency": "interval", "intervalMinutes": 30}
]
```

### Discovery Table

```sql
CREATE TABLE sql_instances (
  id uuid PK, org_id, device_id,
  instance_name varchar(256), version, edition, port,
  auth_type ('windows'|'sql'|'mixed'),
  databases jsonb, status ('online'|'offline'|'unknown'),
  last_discovered_at, created_at, updated_at,
  UNIQUE(device_id, instance_name)
);
```

### API Endpoints

- `GET /backup/mssql/instances` — list discovered instances (org-wide)
- `GET /backup/mssql/instances/:deviceId` — instances on a device
- `POST /backup/mssql/discover/:deviceId` — trigger discovery
- `POST /backup/mssql/backup` — trigger backup (body: deviceId, instanceName, databaseName, subType, configId)
- `GET /backup/mssql/chains` — list backup chains
- `POST /backup/mssql/restore` — trigger restore (body: snapshotId, deviceId, targetDatabase?, pointInTime?)
- `POST /backup/mssql/verify/:snapshotId` — RESTORE VERIFYONLY

### Point-in-Time Restore Flow

1. API looks up chain → identifies needed snapshots: full + latest diff before timestamp + all logs covering the gap
2. Builds ordered restore plan in `restore_jobs.metadata`
3. Agent downloads each backup file from provider to local temp
4. Agent executes RESTORE commands in sequence: full (NORECOVERY) → diff (NORECOVERY) → logs (NORECOVERY) → final log (STOPAT + RECOVERY)

### Security

- SQL auth passwords stored encrypted in `backup_configs.providerConfig` JSONB
- API never returns raw passwords in GET responses (mask as `********`)
- Prefer Windows Integrated Auth where possible (SYSTEM account → `DOMAIN\HOSTNAME$`)

---

## Phase 5: Hyper-V VM Backup & Restore

**Goal**: Full and incremental VM backup via Hyper-V VSS writer, with cross-host restore.

### Agent (Go)

**New package**: `agent/internal/backup/hyperv/`

| File | Purpose |
|------|---------|
| `discovery.go` | WMI query `Msvm_ComputerSystem` in `root\virtualization\v2` + PowerShell `Get-VM` fallback. Per-VM: VHD paths, generation, state, memory, CPU, RCT capability, pass-through disk detection. |
| `backup.go` | VM export via `Export-VM` PowerShell cmdlet (application-consistent via Hyper-V VSS writer). Saved-state fallback for VMs that don't support live backup. Stream VHD/VHDX files to provider with progress. |
| `rct.go` | Resilient Change Tracking — `Get-VMChangedDiskRegions` for incremental backup. Export only changed blocks since reference point. |
| `restore.go` | `Import-VM -Path <export> -Copy -GenerateNewId` for same-host. Download + import for cross-host. Incremental restore: apply full then overlay changed blocks. |
| `checkpoint.go` | Create/delete/apply checkpoints via `Checkpoint-VM`, `Remove-VMSnapshot`, `Restore-VMSnapshot` |
| `types.go` | `HyperVVM`, `VMDisk`, `VMCheckpoint`, `HyperVBackupResult` |

**New commands** (`//go:build windows`): `hyperv_discover`, `hyperv_backup`, `hyperv_restore`, `hyperv_checkpoint`, `hyperv_vm_state`

### Discovery Table

```sql
CREATE TABLE hyperv_vms (
  id uuid PK, org_id, device_id,
  vm_id varchar(64), vm_name varchar(256),
  generation integer, state varchar(30),
  vhd_paths jsonb, memory_mb bigint, processor_count integer,
  rct_enabled boolean, has_passthrough_disks boolean,
  checkpoints jsonb, notes text,
  last_discovered_at, created_at, updated_at,
  UNIQUE(device_id, vm_id)
);
```

### Large File Transfer

VHD/VHDX files can be 50GB-2TB. Key strategies:
- Stream `Export-VM` output directly to S3 multipart via `io.Pipe()` (avoid 2x local disk)
- `UploadWithProgress` on provider interface for WebSocket progress
- Resume: persist S3 upload ID + completed parts to disk
- Bandwidth throttling (from Phase 2)

### Hyper-V Snapshot Metadata

```json
{
  "backupSubType": "full|incremental",
  "vmId": "GUID", "vmName": "WebServer01", "vmGeneration": 2,
  "consistencyType": "application|crash",
  "rctId": "tracking-id", "vhdCount": 2, "totalVhdSizeBytes": 107374182400,
  "exportPaths": ["vm-config.xml", "disk0.vhdx", "disk1.vhdx"],
  "chainId": "uuid"
}
```

### API Endpoints

- `GET /backup/hyperv/vms` — list VMs (org-wide)
- `GET /backup/hyperv/vms/:deviceId` — VMs on a host
- `POST /backup/hyperv/discover/:deviceId` — trigger discovery
- `POST /backup/hyperv/backup` — trigger backup (body: deviceId, vmId, subType, configId, consistencyType?)
- `GET /backup/hyperv/chains` — list VM backup chains
- `POST /backup/hyperv/restore` — trigger restore (body: snapshotId, deviceId?, targetHost?, vmName?)
- `POST /backup/hyperv/checkpoints/:deviceId/:vmId` — manage checkpoints (create/delete/apply)

### Safety

- Skip VMs in live migration state
- Warn/skip pass-through disks (flag `has_passthrough_disks`)
- Agent runs as SYSTEM — full Hyper-V management access by default

---

## Phase 6: Cloud-to-Cloud Backup (M365 + Google Workspace)

**Goal**: Server-side SaaS data protection — no agent involved.

### Architecture

C2C runs entirely on the API server via a new BullMQ worker. The agent is not involved.

```
Web UI (OAuth consent) → API stores tokens in c2c_connections
                       → c2cBackupWorker polls on schedule
                       → Worker calls MS Graph / Google APIs
                       → Worker uploads to configured storage provider
                       → Worker updates c2c_backup_items catalog
                       → Restore: download from storage, push back via API
```

### New Tables

```sql
-- OAuth connections
CREATE TABLE c2c_connections (
  id uuid PK, org_id, provider ('microsoft_365'|'google_workspace'),
  display_name, tenant_id, client_id,
  client_secret encrypted, refresh_token encrypted,
  access_token encrypted, token_expires_at,
  scopes, status ('active'|'expired'|'revoked'),
  last_sync_at, created_at, updated_at
);

-- What to back up
CREATE TABLE c2c_backup_configs (
  id uuid PK, org_id, connection_id FK,
  name, backup_scope ('mailbox'|'onedrive'|'sharepoint'|'teams'|'gmail'|'drive'|'calendar'),
  target_users jsonb, storage_config_id FK -> backup_configs,
  schedule jsonb, retention jsonb, is_active,
  created_at, updated_at
);

-- Sync run history
CREATE TABLE c2c_backup_jobs (
  id uuid PK, org_id, config_id FK,
  status, started_at, completed_at,
  items_processed, items_new, items_updated, items_deleted,
  bytes_transferred, delta_token, error_log,
  created_at, updated_at
);

-- Granular item catalog for individual restore
CREATE TABLE c2c_backup_items (
  id uuid PK, org_id, config_id FK, job_id FK,
  item_type ('email'|'file'|'calendar_event'|'contact'|'chat_message'),
  external_id, user_email, subject_or_name, parent_path,
  storage_path, size_bytes, item_date,
  is_deleted, deleted_at, metadata jsonb,
  created_at, updated_at
);
```

### API Endpoints

- `POST/GET/DELETE /c2c/connections` — OAuth connection management
- `POST /c2c/connections/:id/test` — test connection
- `POST/GET/PATCH/DELETE /c2c/configs` — backup config CRUD
- `GET /c2c/jobs`, `POST /c2c/configs/:id/run` — job management
- `GET /c2c/items` — search/browse backed-up items
- `POST /c2c/restore`, `GET /c2c/restore/:id` — granular restore
- `GET /c2c/dashboard` — C2C stats

### Incremental Sync

- Microsoft Graph: delta queries (`/users/{id}/messages/delta`) — track `lastDeltaToken` per mailbox/drive
- Google: push notifications + incremental change tokens
- Worker respects `Retry-After` headers and API rate limits with exponential backoff

---

## Phase 7: SLA Monitoring, DR Orchestration, Reporting

**Goal**: Enterprise compliance, disaster recovery planning, and executive reporting.

### 7A: SLA Monitoring

```sql
CREATE TABLE backup_sla_configs (
  id uuid PK, org_id, name,
  rpo_target_minutes, rto_target_minutes,
  target_devices jsonb, target_groups jsonb,
  alert_on_breach boolean, created_at, updated_at
);

CREATE TABLE backup_sla_events (
  id uuid PK, org_id, sla_config_id FK,
  device_id, event_type ('rpo_breach'|'rto_breach'|'missed_backup'),
  detected_at, resolved_at, details jsonb
);
```

New BullMQ worker: `backupSlaWorker` — checks compliance every 5 min, emits events on breach.

API: `POST/GET/PATCH/DELETE /backup/sla-configs`, `GET /backup/sla-events`, `GET /backup/sla-dashboard`

### 7B: DR Orchestration

```sql
CREATE TABLE dr_plans (
  id uuid PK, org_id, name, description,
  status ('draft'|'active'|'archived'),
  rpo_target_minutes, rto_target_minutes,
  created_by FK -> users, created_at, updated_at
);

CREATE TABLE dr_plan_groups (
  id uuid PK, plan_id FK, org_id, name,
  sequence integer, depends_on_group_id FK (self-ref),
  devices jsonb, restore_config jsonb,
  estimated_duration_minutes
);

CREATE TABLE dr_executions (
  id uuid PK, plan_id FK, org_id,
  execution_type ('rehearsal'|'failover'|'failback'),
  status, started_at, completed_at,
  initiated_by FK -> users, results jsonb, created_at
);
```

API: Full CRUD for plans + groups, `POST /dr/plans/:id/execute`, `GET /dr/executions`

Execution engine: process groups in sequence order, resolve dependencies, dispatch restore commands per device. Rehearsal mode restores to isolated targets, validates, cleans up.

### 7C: Reporting

Extend existing `reports` system with `backup_summary` report type:
- Storage consumption forecasting (linear regression on snapshot sizes)
- Backup success rate trending
- RPO/RTO compliance across fleet
- Executive PDF/email summaries

---

## Phase Dependencies

```
Phase 1 (VSS)
  ├──→ Phase 3 (System State + BMR) — VSS for consistent state capture on Windows
  ├──→ Phase 4 (MSSQL) — VSS for application-consistent SQL backup
  └──→ Phase 5 (Hyper-V) — Hyper-V VSS writer

Phase 2 (Storage + Encryption + Retention)
  ├──→ Phase 6 (C2C needs storage providers as destination)
  └──→ Phase 7 (SLA needs GFS retention for compliance)

Phase 3 (System State + BMR)
  └──→ Phase 3C (VM Restore) uses system state + file backup as source
  └──→ Phase 5 (Hyper-V host needed for VM Restore target)

Phase 4 (MSSQL) + Phase 5 (Hyper-V) — can run in parallel

Phase 6 (C2C) — independent of agent work, can run in parallel with 3-5

Phase 7 (DR Orchestration) — depends on all backup types being restorable
```

**Parallelization opportunities**:
- Phases 4 + 5 can be developed in parallel (separate teams)
- Phase 6 is fully independent of agent work (server-side only)
- Phase 2 can start alongside Phase 1
- Phase 3A (system state capture) can start alongside Phase 1 for macOS/Linux; Windows needs VSS first

---

## Application-Aware Backup (fits within Phases 1 + 4-5)

These use VSS writers and existing infrastructure:

| Application | Approach | Phase |
|-------------|----------|-------|
| Exchange Server | VSS writer `Microsoft Exchange Writer` | Phase 5 (post Hyper-V, same Windows COM patterns) |
| Active Directory | `wbadmin start systemstatebackup` | Phase 3 (system state = system image variant) |
| IIS | `appcmd list config /xml > backup.xml` | Phase 4 (lightweight, add alongside MSSQL) |
| Certificate Stores | `certutil -backupDB` + `certutil -exportPFX` | Phase 4 (lightweight) |
| SharePoint | SQL DB backup of content databases | Phase 4 (reuses MSSQL infrastructure) |

---

## Immutable Storage / Ransomware Protection (Phase 2 add-on)

- S3 Object Lock → `SetObjectLock(remotePath, retainUntil)` on `ImmutableStorage` interface
- Azure Blob immutability policies
- WORM flag on `backup_snapshots` (`isImmutable`, `immutableUntil`)
- Legal hold prevents deletion regardless of retention policy
- Storage tiering worker moves snapshots: hot → cool → archive based on age

---

## Key Files to Modify/Create (across all phases)

| File | Change |
|------|--------|
| `agent/internal/backup/backup.go` | Add `systemState` flag, VSS integration point |
| `agent/internal/backup/systemstate/` | **New pkg**: system state collection per platform + hardware profiling |
| `agent/internal/backup/bmr/` | **New pkg**: BMR orchestration, system state restore, VM restore, driver injection |
| `agent/internal/backup/vss/` | **New pkg**: VSS requestor, writer enumeration, shadow copy management |
| `agent/internal/backup/mssql/` | **New pkg**: SQL discovery, backup/restore, chain management |
| `agent/internal/backup/hyperv/` | **New pkg**: VM discovery, export/import, RCT incremental, checkpoints |
| `agent/internal/backup/providers/` | New: `azure.go`, `gcs.go`, `b2.go`. Extend interface with optional interfaces. |
| `agent/internal/remote/tools/types.go` | Add ~20 new command constants |
| `agent/internal/heartbeat/` | New handler files: `handlers_vss.go`, `handlers_systemstate.go`, `handlers_bmr.go`, `handlers_mssql.go`, `handlers_hyperv.go` |
| `agent/internal/config/config.go` | Add SystemStateEnabled, VSSEnabled fields |
| `apps/api/src/db/schema/backup.ts` | Add columns to existing tables |
| `apps/api/src/db/schema/` | New: `applicationBackup.ts`, `recoveryTokens.ts`, `c2c.ts`, `drPlans.ts` |
| `apps/api/src/routes/backup/` | New: `mssql.ts`, `hyperv.ts`, `bmr.ts`, `systemstate.ts` |
| `apps/api/src/routes/` | New: `c2c.ts`, `dr.ts` |
| `apps/api/src/jobs/` | New: `c2cBackupWorker.ts`, `backupSlaWorker.ts`. Extend `backupWorker.ts`. |
| `apps/web/src/components/backup/` | New pages/tabs for MSSQL, Hyper-V, C2C, DR, SLA, BMR |

---

## Verification

Each phase should be verified with:
1. **Unit tests**: Go tests with `-race` for agent packages, Vitest for API
2. **Integration tests**: Real SQL Server instance for MSSQL, Hyper-V host for VM backup, actual S3/Azure for providers
3. **E2E tests**: YAML-driven E2E runner for end-to-end flows
4. **Manual verification**: VSS on Windows VM with SQL Server, image capture + BMR on physical/nested VM
5. **Multi-tenant isolation**: All new tables and queries filter by `org_id`
6. **Security review**: Credential encryption, one-time tokens, path traversal protection, audit trail

---

## Execution Approach

**Worktree**: All enterprise backup work should be done in a new git worktree branched from `main`. Each phase gets its own feature branch off the worktree.

**BE-29 Backup Verification**: Already merged to main. The verification infrastructure (agent commands, API wiring, readiness scoring, web UI) is available as a foundation.
