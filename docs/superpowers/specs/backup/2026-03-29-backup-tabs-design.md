# Backup Tabs Design

## Overview

Add two things:
1. A unified "Backup" tab on device details (replacing the standalone "Backup Verification" tab)
2. A tabbed layout on the `/backup` page with an org-wide "Verification" tab

## Part 1: Per-Device Backup Tab

### Location
Device Details page (`DeviceDetails.tsx`). Replaces the existing `backup-verification` tab with a broader `backup` tab.

### Tab Visibility
Always show the tab. If the device has no backup policy and no job history, show an empty state: "No backup configured — assign a policy to protect this device."

Determine state via `GET /backup/status/:deviceId` — if `protected: false` and `lastJob: null`, show empty state.

### Sections (top to bottom)

**1. Status Header**
Quick-read summary bar:
- Last backup time + pass/fail status
- Next scheduled backup
- Storage used + restore point count
- Protection tier (policy name)

Data source: `GET /backup/status/:deviceId`

Reuse display logic from `DeviceBackupStatus.tsx` but render inline as tab header, not a standalone card.

**2. Job History**
Table of recent backup jobs for this device:
- Columns: type, status, started, duration, size, errors
- No filters needed (single device)
- Show last 20 jobs, "Load more" if needed

Data source: `GET /backup/jobs?deviceId=X`

Reuse formatting helpers from `BackupJobList.tsx` (formatBytes, formatDuration, formatTime, status badges).

**3. Snapshots**
List of available restore points:
- Columns: label/name, timestamp, size, incremental flag
- Row actions: "Restore", "Verify Integrity"

Data source: `GET /backup/snapshots?deviceId=X`

**4. Verification & Readiness**
The existing `BackupVerificationTab` content becomes a section:
- Recovery readiness score card (score, RTO, RPO, risk factors)
- Action buttons: Integrity Check, Test Restore, Refresh
- Verification history table with status badges and auto-polling

Move the existing component's internals into the unified tab component, or render `BackupVerificationTab` as a child section.

### Component Structure
One new component: `DeviceBackupTab.tsx`
- Accepts `{ deviceId: string; timezone?: string }`
- Fetches all data in parallel on mount
- Sections are collapsible or always-visible (always-visible preferred for scannability)

### Changes to DeviceDetails.tsx
- Replace `'backup-verification'` tab ID with `'backup'`
- Update Tab type, VALID_TABS, tab definition (label: "Backup", icon: Database)
- Replace `<BackupVerificationTab>` render with `<DeviceBackupTab>`

## Part 2: Tabbed Backup Page with Verification Tab

### Location
`/backup` page. Currently renders `<BackupDashboard />` as a single scrollable view.

### Tab Layout
Add tabs to the backup page:
- **Overview** — the existing `BackupDashboard` content (stats, jobs, storage, attention items)
- **Verification** — new org-wide verification status

Tab state managed via URL hash (same pattern as device details). Default tab: Overview.

### Tab implementation
Add tab bar inside `BackupDashboard.tsx` at the top, before the existing content. The existing content becomes the "Overview" tab. New "Verification" tab renders a new `BackupVerificationOverview` component.

### Verification Tab Content

**Fleet Readiness Summary**
Top-level stats cards:
- Average readiness score across all protected devices
- Count by band: green (85+), yellow (70-84), red (<70)
- Devices never verified count
- Last fleet-wide verification time

Data source: `GET /backup/recovery-readiness` (returns all devices) + `GET /backup/health`

**Recent Failures**
Table of failed verifications across all devices, sorted most recent first:
- Columns: device name, verification type, status, started, duration, error summary
- Links to device backup tab for details
- Show last 20, "Load more" if needed

Data source: `GET /backup/verifications` (no deviceId filter = org-wide)

**Low Readiness Devices**
Table sorted by readiness score ascending (worst first):
- Columns: device name, score, estimated RTO, estimated RPO, risk factor count, last verified
- Links to device backup tab
- Only show devices below threshold (< 85)

Data source: `GET /backup/recovery-readiness`

**Bulk Actions**
- "Verify All" button — triggers integrity check for all devices with backup policies
- Confirmation dialog showing device count before proceeding

### Component Structure
New component: `BackupVerificationOverview.tsx`
- Accepts `{ orgId?: string }`
- Fetches health + readiness + recent verifications in parallel

## Design Tokens

All new components use design system tokens (`text-success`, `text-destructive`, `text-warning`, `bg-muted`, etc.). No hardcoded Tailwind color classes. Also normalize the existing `BackupVerificationTab` colors during this work.

## API Changes

None. All required endpoints already exist:
- `GET /backup/status/:deviceId`
- `GET /backup/jobs?deviceId=X`
- `GET /backup/snapshots?deviceId=X`
- `GET /backup/verifications` (org-wide) and `?deviceId=X` (per-device)
- `GET /backup/recovery-readiness` (org-wide) and `?deviceId=X` (per-device)
- `GET /backup/health`
- `POST /backup/verify`

## Files to Create
- `apps/web/src/components/backup/DeviceBackupTab.tsx` — unified per-device backup tab
- `apps/web/src/components/backup/BackupVerificationOverview.tsx` — org-wide verification tab

## Files to Modify
- `apps/web/src/components/devices/DeviceDetails.tsx` — replace backup-verification tab with backup tab
- `apps/web/src/components/backup/BackupDashboard.tsx` — add tab bar, wrap existing content as "Overview" tab
- `apps/web/src/components/backup/BackupVerificationTab.tsx` — normalize hardcoded colors to design tokens

## Files to Delete
None. `BackupVerificationTab.tsx` is kept — its content is either embedded in `DeviceBackupTab` or rendered as a child component.

## Testing
- Verify tab shows empty state for devices without backup policies
- Verify tab shows full content for devices with backup data
- Verify org-wide verification tab loads health/readiness data
- Verify "Verify All" bulk action works with confirmation
- Verify design token normalization (no hardcoded colors remain)
