# Config Policy Enterprise Backup Scheduling

**Date:** 2026-03-29
**Status:** Approved design, pending implementation

## Problem

The configuration policy system only schedules **file backups**. Three enterprise backup types — Hyper-V VM export, MSSQL database backup, and bare metal recovery (system image) — are manual-only via separate API endpoints. There is no way to configure automated, scheduled backups of VMs or databases through the policy system.

The backup worker (`backupWorker.ts`) reads from `configPolicyBackupSettings` and dispatches `backup_run` commands. Enterprise backup types use the generic command queue (`hyperv_backup`, `mssql_backup`) and have no connection to policy scheduling.

## Architecture Decision

**Extend `configPolicyBackupSettings`** with `backupMode` and `targets` columns. The backup config (`backupConfigs`) stays as a storage destination. The policy settings define what gets backed up, when, and how long to keep it. The worker reads `backupMode` and dispatches the appropriate command type.

This follows the existing separation: config = where, policy = what + when.

### Why not separate tables per backup type?

The config policy system already uses JSONB extensively (`schedule`, `retention`, `paths`, `inlineSettings`, `filters`). Validation happens via Zod schemas on the API routes. Typed Postgres columns wouldn't catch anything Zod doesn't already catch earlier. Four backup modes with simple flat target objects don't warrant the complexity of per-type tables. Revisit if the mode count exceeds 5-6 or target schemas become deeply nested.

## Schema Changes

### Migration

```sql
-- Idempotent: IF NOT EXISTS / DO $$ BEGIN ... EXCEPTION
DO $$ BEGIN
  CREATE TYPE backup_mode_enum AS ENUM ('file', 'hyperv', 'mssql', 'system_image');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE config_policy_backup_settings
  ADD COLUMN IF NOT EXISTS backup_mode backup_mode_enum NOT NULL DEFAULT 'file',
  ADD COLUMN IF NOT EXISTS targets jsonb NOT NULL DEFAULT '{}';

-- Migrate existing rows: move paths into targets
UPDATE config_policy_backup_settings
SET targets = jsonb_build_object('paths', COALESCE(paths, '[]'::jsonb))
WHERE paths IS NOT NULL AND paths != '[]'::jsonb
  AND (targets IS NULL OR targets = '{}'::jsonb);
```

### Drizzle Schema

Add to `configurationPolicies.ts`:

```typescript
export const backupModeEnum = pgEnum('backup_mode_enum', ['file', 'hyperv', 'mssql', 'system_image']);
```

Add columns to `configPolicyBackupSettings`:

```typescript
backupMode: backupModeEnum('backup_mode').notNull().default('file'),
targets: jsonb('targets').notNull().default({}),
```

### Zod Target Schemas

Validated on API routes when creating/updating backup feature links.

```typescript
const fileTargets = z.object({
  paths: z.array(z.string()).min(1),
  excludes: z.array(z.string()).optional(),
});

const hypervTargets = z.object({
  exportPath: z.string().min(1),
  consistencyType: z.enum(['application', 'crash']).default('application'),
  excludeVms: z.array(z.string()).default([]),
});

const mssqlTargets = z.object({
  outputPath: z.string().min(1),
  backupType: z.enum(['full', 'differential', 'log']).default('full'),
  excludeDatabases: z.array(z.string()).default([]),
});

const systemImageTargets = z.object({
  includeSystemState: z.boolean().default(true),
});
```

### Default Targeting

- **Hyper-V**: Backs up ALL discovered VMs on each assigned device. `excludeVms` removes specific VMs by name. New VMs are automatically included on the next scheduled run.
- **MSSQL**: Backs up ALL discovered databases on each assigned device. `excludeDatabases` removes specific databases. New databases are automatically included.
- **File**: Explicit paths (no "all" concept for files).
- **System Image**: All by nature — captures full system state.

## Backup Worker Changes

### File: `apps/api/src/jobs/backupWorker.ts`

**check-schedules job** (runs every 60s): No changes to schedule resolution. After resolving devices and checking schedule, the job creation step reads `backupMode` from `entry.settings`.

**dispatch-backup job**: Replace the single `backup_run` dispatch with mode-based routing:

```
switch (settings.backupMode):
  'file':
    → dispatch backup_run (same as today, paths from targets.paths)

  'hyperv':
    → query hyperv_vms for deviceId
    → subtract excludeVms
    → create one backupJobs row PER VM
    → dispatch hyperv_backup per VM with { vmName, exportPath, consistencyType }

  'mssql':
    → query sql_instances table for deviceId (populated by MSSQL discovery)
    → subtract excludeDatabases
    → create one backupJobs row PER database
    → dispatch mssql_backup per database with { instance, database, backupType, outputPath }

  'system_image':
    → dispatch backup_run with { systemImage: true }
```

**Granularity**: One job per VM or database, not one job per policy. A Hyper-V policy targeting a host with 5 VMs creates 5 jobs. Each job tracks success/failure independently.

**process-results job**: Minor update to parse result format from `hyperv_backup` and `mssql_backup` commands (export metadata vs file backup metadata). Snapshot creation logic unchanged.

### Device skip logic

- Device offline: job stays pending, stale command reaper fails it after 2 hours
- No discovered VMs/databases: skip device, log warning, no job created
- All VMs/databases excluded: skip device, no error
- Device is wrong platform (e.g., Linux in a Hyper-V policy): no VMs in discovery table, skipped automatically

## Feature Config Resolver Changes

### File: `apps/api/src/services/featureConfigResolver.ts`

No structural changes. `resolveAllBackupAssignedDevices()` already returns `settings` which will now include `backupMode` and `targets`. The resolver doesn't interpret these fields — the worker does.

## API Route Changes

### File: `apps/api/src/routes/configurationPolicies/featureLinks.ts`

When creating/updating a backup feature link with `inlineSettings`:
- Validate `backupMode` against the enum
- Validate `targets` against the mode-specific Zod schema
- Decompose into `configPolicyBackupSettings` row (existing pattern)

### Existing backup routes unchanged

`POST /backup/hyperv/backup`, `POST /backup/mssql/backup` etc. remain available for manual/on-demand backups. The policy scheduler uses the same underlying agent commands.

## GFS Retention Fix

### File: `apps/api/src/jobs/backupRetention.ts`

`resolveGfsConfigForJob()` currently reads from the deprecated `backupPolicies` table. Update to read GFS config from `configPolicyBackupSettings.retention` via the job's `featureLinkId`. This completes the migration started in PR #306.

## Web UI Changes

### File: `apps/web/src/components/configurationPolicies/featureTabs/BackupTab.tsx`

1. Add **Backup Mode** selector at top (radio group): File, Hyper-V, MSSQL, System Image
2. Mode-specific target fields below:
   - **File**: paths input (same as today)
   - **Hyper-V**: export path input + optional excludeVms text area
   - **MSSQL**: output path input + backup type selector + optional excludeDatabases text area
   - **System Image**: "Include system state" checkbox (default on)
3. Schedule and retention sections unchanged — apply to all modes
4. No VM/database picker needed (all-by-default with excludes is simpler)

## Testing

### Unit Tests (Vitest)

- Zod schema validation for each target type (valid inputs, invalid inputs, defaults, exclude lists)
- Worker dispatch logic: mock command queue, verify correct command type and payload per mode
- Worker VM/database resolution: mock `hyperv_vms` query, verify exclude list filtering, verify one job per VM
- GFS retention resolver reads from `configPolicyBackupSettings.retention` instead of deprecated table

### Integration Tests

- Create config policy with `backupMode: 'hyperv'`, assign to device with discovered VMs, verify worker creates N jobs with `hyperv_backup` command type
- Device with no discovered VMs gets skipped (no job, no error)
- Exclude list: 3 VMs, 1 excluded = 2 jobs
- MSSQL: same patterns with instances/databases
- File mode: backwards compatible, existing behavior unchanged

### No E2E tests

Actual Hyper-V/MSSQL commands require Windows hosts. Integration tests mock the agent side.

## Files Changed

| File | Change |
|------|--------|
| `apps/api/migrations/0076-backup-mode-targets.sql` | Add backup_mode enum + columns, migrate paths |
| `apps/api/src/db/schema/configurationPolicies.ts` | Add backupModeEnum, backupMode + targets columns |
| `apps/api/src/jobs/backupWorker.ts` | Mode-based dispatch routing, per-VM/database job creation |
| `apps/api/src/jobs/backupRetention.ts` | Read GFS from configPolicyBackupSettings instead of deprecated backupPolicies |
| `apps/api/src/routes/configurationPolicies/featureLinks.ts` | Validate backupMode + targets on create/update |
| `apps/web/src/components/configurationPolicies/featureTabs/BackupTab.tsx` | Mode selector + mode-specific target fields |
| `packages/shared/src/validators/` | Zod schemas for backup target types |
| Test files alongside each changed file | Unit + integration tests |

## Out of Scope

- Incremental Hyper-V backups via RCT (future enhancement, requires tracking last backup per VM)
- MSSQL differential/log chain scheduling (e.g., full weekly + log hourly — requires multi-schedule support)
- Dropping the deprecated `backupPolicies` table (separate cleanup task)
- VM/database discovery scheduling (currently manual — could be added to heartbeat later)
