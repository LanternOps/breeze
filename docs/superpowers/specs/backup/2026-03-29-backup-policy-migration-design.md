# Backup Policy Migration: Standalone → Configuration Policy System

## Overview

Remove the standalone `backupPolicies` table and rewire everything to use the configuration policy system's backup feature links. The config policy system already handles backup assignment for devices like Kit — the standalone system is an orphaned predecessor with no production data.

## Decisions

- **Schedule/retention storage:** New `config_policy_backup_settings` normalized table (option B — follows patch/maintenance pattern)
- **backupJobs.policyId FK:** Repoint to `config_policy_feature_links.id` (option A — the feature link IS the backup policy)
- **Existing data:** Clean slate (option B — no production data in `backupPolicies`, only E2E leftovers already cleaned)
- **Old routes/components:** Remove immediately (option A — internal product, no external API consumers)

## Part 1: Schema Changes

### New table: `config_policy_backup_settings`

Follows the pattern of `config_policy_patch_settings`, `config_policy_maintenance_settings`, etc.

```sql
CREATE TABLE IF NOT EXISTS config_policy_backup_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_link_id UUID NOT NULL REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  schedule JSONB NOT NULL DEFAULT '{}',
  retention JSONB NOT NULL DEFAULT '{}',
  paths JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (feature_link_id)
);
```

- `schedule`: `{ frequency: 'daily'|'weekly'|'monthly', time: 'HH:MM', timezone: string, dayOfWeek?: number, dayOfMonth?: number }`
- `retention`: `{ keepDaily: number, keepWeekly: number, keepMonthly: number }`
- `paths`: `string[]` — include/exclude paths for the backup
- `feature_link_id` references the backup feature link, which in turn has `feature_policy_id` pointing to a `backupConfigs` row (the storage provider config)

### Modify `backup_jobs`

- Drop FK constraint on `policy_id` → `backup_policies(id)`
- Add new nullable column `feature_link_id UUID REFERENCES config_policy_feature_links(id)`
- Keep `policy_id` nullable for historical rows (don't drop column yet)

### Deprecate `backup_policies`

- Do NOT drop the table in this migration (safety)
- Add a comment: `-- DEPRECATED: replaced by config_policy_backup_settings + config_policy_feature_links`
- A future migration will drop it after confirming zero references

### Add Drizzle schema definition

Add `configPolicyBackupSettings` table to `apps/api/src/db/schema/configurationPolicies.ts` following the existing pattern of `configPolicyPatchSettings`.

### Register in `decomposeInlineSettings` and `deleteNormalizedRows`

In `apps/api/src/services/configurationPolicy.ts`:
- Add `case 'backup':` to `decomposeInlineSettings()` — extract schedule/retention/paths from `inlineSettings` into the new table
- Add `case 'backup':` to `deleteNormalizedRows()` — delete settings when feature link is removed

## Part 2: API Rewiring

### Backup worker scheduler (`backupWorker.ts`)

Rewrite `processCheckSchedules()`:

**Current flow:** Query `backupPolicies` → iterate `targets.deviceIds` → create jobs.

**New flow:**
1. Query `config_policy_feature_links` where `feature_type = 'backup'` and join to `configuration_policies` where `status = 'active'`
2. For each feature link, join to `config_policy_backup_settings` to get schedule
3. Evaluate schedule against current time (same logic as today)
4. For each due feature link, resolve assigned devices:
   - Join `config_policy_assignments` for the parent `configuration_policies.id`
   - Resolve device IDs from assignments (device-level is direct, group-level joins `device_group_memberships`, site-level joins `devices.site_id`, org-level gets all org devices)
   - Filter by `os_filter` and `role_filter` if set on the assignment
5. Deduplicate: skip devices that already have a job in the current minute window
6. Create `backup_jobs` rows with `config_id` from `feature_link.feature_policy_id` and `feature_link_id` from the feature link

Add a helper: `resolveDeviceIdsForBackupFeatureLink(featureLinkId, orgId)` in `featureConfigResolver.ts` — follows the pattern of `resolveDevicesForPatchPolicy`.

### Manual trigger (`jobs.ts`)

**`POST /backup/jobs/run/:deviceId`:**
- Replace: scan `backupPolicies` for matching `targets.deviceIds`
- With: call `resolveEffectiveConfig(deviceId)`, extract `features.backup`, get `featurePolicyId` (= configId) and `featureLinkId`
- Fallback to first `backupConfigs` row if no config policy assignment exists

**`POST /backup/jobs/run-all`:**
- Replace: build device→policy map from `backupPolicies`
- With: query all active backup feature links, resolve their assigned devices via hierarchy, build device→{configId, featureLinkId} map

**`GET /backup/jobs/run-all/preview`:**
- Same change as run-all but read-only

### Dashboard (`dashboard.ts`)

**`GET /backup/dashboard` — protected device count:**
- Replace: flatten `backupPolicies.targets.deviceIds`
- With: query backup feature links → resolve assigned devices via `resolveDeviceIdsForBackupFeatureLink`

**`GET /backup/status/:deviceId`:**
- Replace: scan `backupPolicies` for `targets.deviceIds.includes(deviceId)`
- With: call `resolveEffectiveConfig(deviceId)`, check `features.backup` exists
- Return `protected: true` if backup feature link exists, with schedule from `config_policy_backup_settings`
- Compute `nextScheduledAt` from the settings schedule (same `getNextRun` logic)

### Verification services

**`verificationService.ts`, `verificationScheduled.ts`, `readinessCalculator.ts`:**
- These currently use in-memory seed data for `isCriticalDevice` which checks `backupPolicies` targets
- Replace with: query config policy assignments to determine if a device has a backup feature assigned, and check if the policy name contains "server" or "critical"
- Or simplify: a device is "critical" if it has a backup policy assigned at the device level (not inherited from org/site) — this is a stronger signal

### AI tools (`aiToolsBackup.ts`)

- The `list_policies` action queries `backupPolicies` — replace with querying backup feature links + their settings
- Return shape should be similar: name, schedule, retention, target devices (resolved from assignments)

## Part 3: Frontend Cleanup

### Remove standalone policy components
- Delete `apps/web/src/components/backup/BackupPolicyList.tsx`
- Delete `apps/web/src/components/backup/BackupPolicyAssignment.tsx`

### Remove policy routes from backup page
- The backup page's Overview tab currently doesn't render these directly (they were standalone). Verify no imports reference them.

### Update DeviceBackupTab
- The tab currently reads from `GET /backup/status/:deviceId` — after the API is updated, this will automatically show the config policy data. No frontend change needed beyond verifying it works.

### Remove seed data
- Delete `backupPolicies` entries from `apps/api/src/routes/backup/storeSeedData.ts`
- Remove `backupPolicies` from `apps/api/src/routes/backup/store.ts` exports

## Part 4: Route Cleanup

### Remove `/backup/policies` CRUD routes
- Delete `apps/api/src/routes/backup/policies.ts`
- Remove from `apps/api/src/routes/backup/index.ts` route mounting
- Remove `backupPolicies` from test mocks in `backup.test.ts`

Backup configuration is now managed entirely through the configuration policy UI at `/settings/policies`.

## Migration SQL

Single idempotent migration file: `apps/api/migrations/0073-backup-policy-to-config-policy.sql`

```sql
-- Create normalized backup settings table for config policies
CREATE TABLE IF NOT EXISTS config_policy_backup_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_link_id UUID NOT NULL REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  schedule JSONB NOT NULL DEFAULT '{}',
  retention JSONB NOT NULL DEFAULT '{}',
  paths JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT config_policy_backup_settings_feature_link_id_unique UNIQUE (feature_link_id)
);

CREATE INDEX IF NOT EXISTS idx_config_policy_backup_settings_org
  ON config_policy_backup_settings(org_id);

-- Add feature_link_id to backup_jobs for config policy tracking
DO $$ BEGIN
  ALTER TABLE backup_jobs ADD COLUMN feature_link_id UUID
    REFERENCES config_policy_feature_links(id);
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Drop old FK constraint from backup_jobs.policy_id → backup_policies
-- (keep the column for historical data, just remove the constraint)
DO $$ BEGIN
  ALTER TABLE backup_jobs DROP CONSTRAINT IF EXISTS backup_jobs_policy_id_backup_policies_id_fk;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

-- Mark backup_policies as deprecated (do not drop yet)
COMMENT ON TABLE backup_policies IS 'DEPRECATED: replaced by config_policy_backup_settings + config_policy_feature_links. Will be dropped in a future migration.';
```

## Files to Create
- `apps/api/migrations/0073-backup-policy-to-config-policy.sql`
- `apps/api/src/db/schema/configPolicyBackupSettings.ts` (or add to `configurationPolicies.ts`)

## Files to Modify
- `apps/api/src/db/schema/configurationPolicies.ts` — add Drizzle schema for new table
- `apps/api/src/db/schema/backup.ts` — add `featureLinkId` column to `backupJobs`
- `apps/api/src/db/schema/index.ts` — export new table
- `apps/api/src/services/configurationPolicy.ts` — add `case 'backup'` to `decomposeInlineSettings` and `deleteNormalizedRows`
- `apps/api/src/services/featureConfigResolver.ts` — add `resolveDeviceIdsForBackupFeatureLink`
- `apps/api/src/jobs/backupWorker.ts` — rewrite `processCheckSchedules` to use config policies
- `apps/api/src/routes/backup/jobs.ts` — update `run/:deviceId`, `run-all`, `run-all/preview`
- `apps/api/src/routes/backup/dashboard.ts` — update protected device count and status endpoint
- `apps/api/src/routes/backup/index.ts` — remove policy routes
- `apps/api/src/routes/backup/store.ts` — remove backupPolicies from seed data
- `apps/api/src/routes/backup/storeSeedData.ts` — remove backupPolicies entries
- `apps/api/src/routes/backup/verificationService.ts` — update `isCriticalDevice`
- `apps/api/src/routes/backup/verificationScheduled.ts` — update `isCriticalDevice`
- `apps/api/src/routes/backup/readinessCalculator.ts` — update `isCriticalDevice` and protected device logic
- `apps/api/src/services/aiToolsBackup.ts` — update `list_policies` action
- `apps/api/src/routes/backup.test.ts` — remove backupPolicies mock, update tests

## Files to Delete
- `apps/api/src/routes/backup/policies.ts`
- `apps/web/src/components/backup/BackupPolicyList.tsx`
- `apps/web/src/components/backup/BackupPolicyAssignment.tsx`

## Testing
- Verify scheduled backups dispatch correctly from config policy assignments
- Verify `GET /backup/status/:deviceId` returns `protected: true` for devices with config policy backup feature
- Verify manual trigger resolves config from effective configuration
- Verify `run-all` resolves devices from config policy hierarchy (not flat deviceIds array)
- Verify backup jobs table tracks `feature_link_id`
- Verify removing a config policy backup feature link stops scheduling for those devices
- Verify `pnpm db:check-drift` passes (schema matches migration)

## Success Criteria
- Zero references to `backupPolicies` table in any route, worker, or service (except the deprecated schema definition)
- Kit's Backup tab shows "Policy assigned" with schedule from the "Workstation Backups" config policy
- Scheduled backups resolve devices through the config policy hierarchy (org/site/group/device)
- `siteIds` and `groupIds` assignments actually work (the old system's TODO is resolved for free)
