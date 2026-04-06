# Backup Policy Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove standalone `backupPolicies` table and rewire the backup system (scheduler, routes, dashboard, AI tools) to use the configuration policy system's backup feature links.

**Architecture:** Add a `config_policy_backup_settings` normalized table for schedule/retention data. Add `resolveBackupConfigForDevice()` to `featureConfigResolver.ts`. Rewrite `backupWorker.ts` scheduler to query config policy feature links. Update all routes that read `backupPolicies` to use config policies instead. Delete standalone policy routes and frontend components.

**Tech Stack:** PostgreSQL + Drizzle ORM, BullMQ, Hono routes, React frontend.

**Spec:** `docs/superpowers/specs/2026-03-29-backup-policy-migration-design.md`

---

### Task 1: Database migration and Drizzle schema

**Files:**
- Create: `apps/api/migrations/0073-backup-policy-to-config-policy.sql`
- Modify: `apps/api/src/db/schema/configurationPolicies.ts`
- Modify: `apps/api/src/db/schema/backup.ts`
- Modify: `apps/api/src/db/schema/index.ts`

- [ ] **Step 1: Write the migration SQL**

Create `apps/api/migrations/0073-backup-policy-to-config-policy.sql`:

```sql
-- config_policy_backup_settings: normalized schedule/retention for backup feature links
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

CREATE INDEX IF NOT EXISTS idx_config_policy_backup_settings_feature_link
  ON config_policy_backup_settings(feature_link_id);

-- Add feature_link_id column to backup_jobs for config policy tracking
DO $$ BEGIN
  ALTER TABLE backup_jobs ADD COLUMN feature_link_id UUID
    REFERENCES config_policy_feature_links(id);
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_backup_jobs_feature_link_id
  ON backup_jobs(feature_link_id);

-- Drop old FK from backup_jobs.policy_id → backup_policies
DO $$ BEGIN
  ALTER TABLE backup_jobs DROP CONSTRAINT IF EXISTS backup_jobs_policy_id_backup_policies_id_fk;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

-- Mark backup_policies as deprecated
COMMENT ON TABLE backup_policies IS 'DEPRECATED: replaced by config_policy_backup_settings + config_policy_feature_links';
```

- [ ] **Step 2: Add Drizzle schema for config_policy_backup_settings**

In `apps/api/src/db/schema/configurationPolicies.ts`, add after the existing settings tables (after `configPolicyMonitoringWatches`):

```typescript
export const configPolicyBackupSettings = pgTable('config_policy_backup_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  featureLinkId: uuid('feature_link_id').notNull().unique().references(() => configPolicyFeatureLinks.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  schedule: jsonb('schedule').notNull().default({}),
  retention: jsonb('retention').notNull().default({}),
  paths: jsonb('paths').notNull().default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

Add the `organizations` import if not already present.

- [ ] **Step 3: Add featureLinkId to backupJobs in Drizzle**

In `apps/api/src/db/schema/backup.ts`, add to the `backupJobs` table definition, after the `policyId` column:

```typescript
    featureLinkId: uuid('feature_link_id').references(() => configPolicyFeatureLinks.id),
```

Add the import at the top:
```typescript
import { configPolicyFeatureLinks } from './configurationPolicies';
```

- [ ] **Step 4: Export the new table from schema index**

In `apps/api/src/db/schema/index.ts`, verify `configPolicyBackupSettings` is exported (it should be if `configurationPolicies.ts` is re-exported with `export *`).

- [ ] **Step 5: Check drift**

Run: `pnpm db:check-drift`
Expected: No drift (migration matches schema)

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/0073-backup-policy-to-config-policy.sql apps/api/src/db/schema/configurationPolicies.ts apps/api/src/db/schema/backup.ts apps/api/src/db/schema/index.ts
git commit -m "feat(api): add config_policy_backup_settings table and backup_jobs.feature_link_id

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Register backup in configurationPolicy.ts

**Files:**
- Modify: `apps/api/src/services/configurationPolicy.ts`

- [ ] **Step 1: Add backup case to decomposeInlineSettings**

In `configurationPolicy.ts`, find the `decomposeInlineSettings` function's switch statement. Add a `case 'backup':` block following the pattern of `case 'patch':`:

```typescript
    case 'backup': {
      await tx.insert(configPolicyBackupSettings).values({
        featureLinkId: linkId,
        orgId: /* read from context — check how other cases get orgId */,
        schedule: typeof s.schedule === 'object' && s.schedule ? s.schedule as Record<string, unknown> : {},
        retention: typeof s.retention === 'object' && s.retention ? s.retention as Record<string, unknown> : {},
        paths: Array.isArray(s.paths) ? s.paths as string[] : [],
      });
      break;
    }
```

**Note to implementer:** Read the function signature and surrounding cases carefully. Some cases access `orgId` from a parameter, others derive it. Follow the exact pattern of the nearest case (e.g., `maintenance`).

- [ ] **Step 2: Add backup case to deleteNormalizedRows**

In the same file, find the `deleteNormalizedRows` function's switch statement. Add:

```typescript
    case 'backup':
      await tx.delete(configPolicyBackupSettings).where(eq(configPolicyBackupSettings.featureLinkId, linkId));
      break;
```

- [ ] **Step 3: Add import for configPolicyBackupSettings**

Add to the imports at the top of the file:
```typescript
import { configPolicyBackupSettings } from '../db/schema/configurationPolicies';
```

(Or wherever it's exported from — follow existing import pattern in the file.)

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit --project apps/api/tsconfig.json`
Expected: clean

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/configurationPolicy.ts
git commit -m "feat(api): register backup feature in decomposeInlineSettings and deleteNormalizedRows

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Add resolveBackupConfigForDevice to featureConfigResolver

**Files:**
- Modify: `apps/api/src/services/featureConfigResolver.ts`

- [ ] **Step 1: Add the resolver function**

Follow the exact pattern of `resolvePatchConfigForDevice` (lines 324-371). Add:

```typescript
export async function resolveBackupConfigForDevice(
  deviceId: string
): Promise<{
  settings: typeof configPolicyBackupSettings.$inferSelect;
  featureLinkId: string;
  configId: string | null;
} | null> {
  const hierarchy = await loadDeviceHierarchy(deviceId);
  if (!hierarchy) return null;

  const targetConditions = buildTargetConditions(hierarchy);
  const roleOsConditions = buildRoleOsFilterConditions(hierarchy);

  const rows = await db
    .select({
      backupSettings: configPolicyBackupSettings,
      featureLink: configPolicyFeatureLinks,
      assignmentLevel: configPolicyAssignments.level,
      assignmentPriority: configPolicyAssignments.priority,
      assignmentCreatedAt: configPolicyAssignments.createdAt,
      assignmentId: configPolicyAssignments.id,
    })
    .from(configPolicyAssignments)
    .innerJoin(
      configurationPolicies,
      and(
        eq(configPolicyAssignments.configPolicyId, configurationPolicies.id),
        eq(configurationPolicies.status, 'active')
      )
    )
    .innerJoin(
      configPolicyFeatureLinks,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyFeatureLinks.featureType, 'backup')
      )
    )
    .innerJoin(
      configPolicyBackupSettings,
      eq(configPolicyBackupSettings.featureLinkId, configPolicyFeatureLinks.id)
    )
    .where(and(sql`(${sql.join(targetConditions, sql` OR `)})`, ...roleOsConditions))
    .orderBy(
      configPolicyAssignments.level,
      configPolicyAssignments.priority,
      configPolicyAssignments.createdAt
    );

  if (rows.length === 0) return null;

  const sorted = sortByHierarchy(rows);
  const winner = sorted[0]!;
  return {
    settings: winner.backupSettings,
    featureLinkId: winner.featureLink.id,
    configId: winner.featureLink.featurePolicyId,
  };
}
```

- [ ] **Step 2: Add a function to resolve all devices with backup config**

This is needed by the scheduler and run-all endpoints:

```typescript
export async function resolveAllBackupAssignedDevices(
  orgId: string
): Promise<Array<{ deviceId: string; featureLinkId: string; configId: string | null; settings: typeof configPolicyBackupSettings.$inferSelect }>> {
  // Get all active backup feature links for the org
  const links = await db
    .select({
      featureLink: configPolicyFeatureLinks,
      backupSettings: configPolicyBackupSettings,
      assignment: configPolicyAssignments,
    })
    .from(configPolicyFeatureLinks)
    .innerJoin(
      configurationPolicies,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configurationPolicies.status, 'active'),
        eq(configurationPolicies.orgId, orgId)
      )
    )
    .innerJoin(
      configPolicyBackupSettings,
      eq(configPolicyBackupSettings.featureLinkId, configPolicyFeatureLinks.id)
    )
    .innerJoin(
      configPolicyAssignments,
      eq(configPolicyAssignments.configPolicyId, configurationPolicies.id)
    )
    .where(eq(configPolicyFeatureLinks.featureType, 'backup'));

  // Resolve device IDs from assignments
  const results = new Map<string, { featureLinkId: string; configId: string | null; settings: typeof configPolicyBackupSettings.$inferSelect }>();

  for (const row of links) {
    const assignment = row.assignment;
    let deviceIds: string[] = [];

    if (assignment.level === 'device' && assignment.targetId) {
      deviceIds = [assignment.targetId];
    } else if (assignment.level === 'device_group' && assignment.targetId) {
      const members = await db
        .select({ deviceId: deviceGroupMemberships.deviceId })
        .from(deviceGroupMemberships)
        .where(eq(deviceGroupMemberships.groupId, assignment.targetId));
      deviceIds = members.map((m) => m.deviceId);
    } else if (assignment.level === 'site' && assignment.targetId) {
      const siteDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.siteId, assignment.targetId), eq(devices.orgId, orgId)));
      deviceIds = siteDevices.map((d) => d.id);
    } else if (assignment.level === 'organization') {
      const orgDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.orgId, orgId));
      deviceIds = orgDevices.map((d) => d.id);
    }

    for (const deviceId of deviceIds) {
      if (!results.has(deviceId)) {
        results.set(deviceId, {
          featureLinkId: row.featureLink.id,
          configId: row.featureLink.featurePolicyId,
          settings: row.backupSettings,
        });
      }
    }
  }

  return Array.from(results.entries()).map(([deviceId, data]) => ({
    deviceId,
    ...data,
  }));
}
```

- [ ] **Step 3: Add required imports**

Add imports for `configPolicyBackupSettings`, `configPolicyFeatureLinks`, `configPolicyAssignments`, `configurationPolicies`, `deviceGroupMemberships`, `devices`, and SQL operators as needed. Follow the existing import pattern in the file.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit --project apps/api/tsconfig.json`
Expected: clean

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/featureConfigResolver.ts
git commit -m "feat(api): add resolveBackupConfigForDevice and resolveAllBackupAssignedDevices

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Rewrite backup worker scheduler

**Files:**
- Modify: `apps/api/src/jobs/backupWorker.ts`

- [ ] **Step 1: Replace processCheckSchedules**

Replace the `processCheckSchedules` function. The new version:
1. Calls `resolveAllBackupAssignedDevices(orgId)` for each org
2. Evaluates each device's backup settings schedule against current time
3. Deduplicates by checking for existing jobs in the current minute window
4. Creates jobs with `featureLinkId` instead of `policyId`

```typescript
async function processCheckSchedules(): Promise<{ enqueued: number }> {
  const now = new Date();
  const currentHour = now.getUTCHours();
  const currentMin = now.getUTCMinutes();

  // Get all orgs that have active backup config policies
  const orgs = await db
    .selectDistinct({ orgId: configurationPolicies.orgId })
    .from(configurationPolicies)
    .innerJoin(
      configPolicyFeatureLinks,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyFeatureLinks.featureType, 'backup')
      )
    )
    .where(eq(configurationPolicies.status, 'active'));

  let enqueued = 0;

  for (const { orgId } of orgs) {
    const assigned = await resolveAllBackupAssignedDevices(orgId);

    for (const entry of assigned) {
      const schedule = entry.settings.schedule as PolicySchedule | null;
      if (!schedule?.frequency || !schedule.time) continue;

      const [schedHour, schedMin] = (schedule.time ?? '02:00').split(':').map(Number);
      if (currentHour !== schedHour || currentMin !== schedMin) continue;

      if (schedule.frequency === 'weekly' && typeof schedule.dayOfWeek === 'number' && now.getUTCDay() !== schedule.dayOfWeek) continue;
      if (schedule.frequency === 'monthly' && typeof schedule.dayOfMonth === 'number' && now.getUTCDate() !== schedule.dayOfMonth) continue;

      // Deduplicate: check if already created a job this minute
      const minuteStart = new Date(now);
      minuteStart.setSeconds(0, 0);
      const minuteEnd = new Date(minuteStart.getTime() + 60_000);

      const [existing] = await db
        .select({ id: backupJobs.id })
        .from(backupJobs)
        .where(
          and(
            eq(backupJobs.featureLinkId, entry.featureLinkId),
            eq(backupJobs.deviceId, entry.deviceId),
            sql`${backupJobs.createdAt} >= ${minuteStart.toISOString()}::timestamptz`,
            sql`${backupJobs.createdAt} < ${minuteEnd.toISOString()}::timestamptz`
          )
        )
        .limit(1);

      if (existing) continue;

      if (!entry.configId) continue;

      const [job] = await db
        .insert(backupJobs)
        .values({
          orgId,
          configId: entry.configId,
          featureLinkId: entry.featureLinkId,
          deviceId: entry.deviceId,
          status: 'pending',
          type: 'scheduled',
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      if (job) {
        await enqueueBackupDispatch(job.id, job.configId, orgId, entry.deviceId);
        enqueued++;
      }
    }
  }

  if (enqueued > 0) {
    console.log(`[BackupWorker] Scheduled ${enqueued} backup job(s) from config policies`);
  }

  return { enqueued };
}
```

- [ ] **Step 2: Update imports**

Replace the `backupPolicies` import with:
```typescript
import { resolveAllBackupAssignedDevices } from '../services/featureConfigResolver';
import { configurationPolicies, configPolicyFeatureLinks } from '../db/schema/configurationPolicies';
```

Remove the `backupPolicies` import if no other function in the file uses it.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit --project apps/api/tsconfig.json`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/jobs/backupWorker.ts
git commit -m "feat(api): rewrite backup scheduler to use config policy assignments

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Update backup routes (jobs, dashboard, status)

**Files:**
- Modify: `apps/api/src/routes/backup/jobs.ts`
- Modify: `apps/api/src/routes/backup/dashboard.ts`

- [ ] **Step 1: Update POST /jobs/run/:deviceId**

Replace the policy lookup with config policy resolution:

```typescript
jobsRoutes.post('/jobs/run/:deviceId', async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const deviceId = c.req.param('deviceId');

  // Resolve backup config from configuration policy hierarchy
  const resolved = await resolveBackupConfigForDevice(deviceId);

  let configId = resolved?.configId ?? null;
  let featureLinkId = resolved?.featureLinkId ?? null;

  // Fallback: first available backup config in org
  if (!configId) {
    const [fallbackConfig] = await db
      .select({ id: backupConfigs.id })
      .from(backupConfigs)
      .where(eq(backupConfigs.orgId, orgId))
      .limit(1);
    configId = fallbackConfig?.id ?? null;
  }

  if (!configId) {
    return c.json({ error: 'No backup config available' }, 400);
  }

  const now = new Date();
  const [row] = await db
    .insert(backupJobs)
    .values({
      orgId,
      configId,
      featureLinkId,
      deviceId,
      status: 'pending',
      type: 'manual',
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  // ... rest unchanged (enqueue, audit, return)
```

Add import: `import { resolveBackupConfigForDevice } from '../../services/featureConfigResolver';`

- [ ] **Step 2: Update POST /jobs/run-all and GET /jobs/run-all/preview**

Replace the `backupPolicies` query with `resolveAllBackupAssignedDevices`:

```typescript
// In run-all/preview:
const assigned = await resolveAllBackupAssignedDevices(orgId);
const deviceIds = new Set(assigned.filter((a) => a.configId).map((a) => a.deviceId));

// In run-all:
const assigned = await resolveAllBackupAssignedDevices(orgId);
const deviceConfigMap = new Map(
  assigned.filter((a) => a.configId).map((a) => [a.deviceId, { configId: a.configId!, featureLinkId: a.featureLinkId }])
);
```

Add import: `import { resolveAllBackupAssignedDevices } from '../../services/featureConfigResolver';`

Remove import: `import { backupPolicies } from '../../db/schema';` (if no longer used)

- [ ] **Step 3: Update GET /backup/dashboard — protectedDevices**

In `dashboard.ts`, replace the `protectedDevices` computation (currently flattens `backupPolicies.targets`):

```typescript
// Replace the policies query and protectedDevices computation with:
const assignedDevices = await resolveAllBackupAssignedDevices(orgId);
const protectedDevices = new Set(assignedDevices.map((a) => a.deviceId));
```

Remove the `backupPolicies` query from the `Promise.all` array and adjust the destructuring.

Add import: `import { resolveAllBackupAssignedDevices } from '../../services/featureConfigResolver';`

- [ ] **Step 4: Update GET /backup/status/:deviceId**

Replace the policy lookup:

```typescript
const resolved = await resolveBackupConfigForDevice(deviceId);
const policySchedule = resolved?.settings.schedule as BackupPolicySchedule | null;

return c.json({
  data: {
    deviceId,
    protected: Boolean(resolved),
    featureLinkId: resolved?.featureLinkId ?? null,
    configId: resolved?.configId ?? null,
    lastJob: lastJob ? { ... } : null,
    lastSuccessAt: lastSuccess?.completedAt?.toISOString() ?? null,
    lastFailureAt: lastFailure?.completedAt?.toISOString() ?? null,
    nextScheduledAt: policySchedule ? getNextRun(policySchedule) : null,
  },
});
```

Add import: `import { resolveBackupConfigForDevice } from '../../services/featureConfigResolver';`

- [ ] **Step 5: Remove backupPolicies imports from both files**

Remove `backupPolicies` from all imports in `jobs.ts` and `dashboard.ts`. Remove the `BackupPolicyTargets` type import if unused.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit --project apps/api/tsconfig.json`
Expected: clean

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/backup/jobs.ts apps/api/src/routes/backup/dashboard.ts
git commit -m "feat(api): rewire backup routes to use config policy system

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Delete standalone policy routes and frontend

**Files:**
- Delete: `apps/api/src/routes/backup/policies.ts`
- Delete: `apps/web/src/components/backup/BackupPolicyList.tsx`
- Delete: `apps/web/src/components/backup/BackupPolicyAssignment.tsx`
- Modify: `apps/api/src/routes/backup/index.ts`
- Modify: `apps/api/src/routes/backup/store.ts`
- Modify: `apps/api/src/routes/backup/storeSeedData.ts`

- [ ] **Step 1: Remove policy routes from backup index**

In `apps/api/src/routes/backup/index.ts`, remove the `policiesRoutes` import and `.route('/', policiesRoutes)` line.

- [ ] **Step 2: Delete the policies route file**

```bash
rm apps/api/src/routes/backup/policies.ts
```

- [ ] **Step 3: Remove backupPolicies from seed data**

In `apps/api/src/routes/backup/storeSeedData.ts`, remove all `backupPolicies` entries.

In `apps/api/src/routes/backup/store.ts`, remove the `backupPolicies` export and any references to it.

- [ ] **Step 4: Delete frontend components**

```bash
rm apps/web/src/components/backup/BackupPolicyList.tsx
rm apps/web/src/components/backup/BackupPolicyAssignment.tsx
```

- [ ] **Step 5: Verify no dangling imports**

Run: `grep -rn "BackupPolicyList\|BackupPolicyAssignment\|policiesRoutes" apps/web/src/ apps/api/src/ --include="*.ts" --include="*.tsx"`
Expected: no results (or only in deleted files)

- [ ] **Step 6: Type-check both projects**

Run: `npx tsc --noEmit --project apps/api/tsconfig.json && npx tsc --noEmit --project apps/web/tsconfig.json`
Expected: clean

- [ ] **Step 7: Commit**

```bash
git add -A apps/api/src/routes/backup/ apps/web/src/components/backup/
git commit -m "chore(api,web): remove standalone backup policy routes and components

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Update verification services and AI tools

**Files:**
- Modify: `apps/api/src/routes/backup/verificationService.ts`
- Modify: `apps/api/src/routes/backup/verificationScheduled.ts`
- Modify: `apps/api/src/routes/backup/readinessCalculator.ts`
- Modify: `apps/api/src/services/aiToolsBackup.ts`

- [ ] **Step 1: Update isCriticalDevice in all three verification files**

Replace the `isCriticalDevice` function in each of `verificationService.ts`, `verificationScheduled.ts`, and `readinessCalculator.ts`. The old version checks `backupPolicies` seed data. The new version checks config policy assignments:

```typescript
function isCriticalDevice(deviceId: string, orgId: string): boolean {
  // A device is critical if it has a backup policy assigned at the device level
  // This is a sync check using the in-memory data; for production use,
  // this should be an async DB query or cached result
  return false; // Simplified: treat all devices equally for now
}
```

**Note to implementer:** The `isCriticalDevice` function is used to prioritize verification scheduling. For now, return `false` (treat all devices equally). A future enhancement can add device-level criticality based on config policy assignment level or tags. The old implementation was reading from in-memory seed data that doesn't reflect reality.

- [ ] **Step 2: Update readinessCalculator protected device logic**

In `readinessCalculator.ts`, find where `backupPolicies` seed data is used to compute protected devices. Replace with a call to `resolveAllBackupAssignedDevices` or import the device list from the config policy system.

Read the file to find the exact usage — the seed data is used to determine which devices to compute readiness scores for. Replace with:

```typescript
const assigned = await resolveAllBackupAssignedDevices(orgId);
const protectedDeviceIds = assigned.map((a) => a.deviceId);
```

- [ ] **Step 3: Update AI tools**

In `apps/api/src/services/aiToolsBackup.ts`, find the `list_policies` action handler. Replace the `backupPolicies` query with:

```typescript
// Query backup feature links with their settings and parent policy names
const links = await db
  .select({
    featureLink: configPolicyFeatureLinks,
    settings: configPolicyBackupSettings,
    policyName: configurationPolicies.name,
  })
  .from(configPolicyFeatureLinks)
  .innerJoin(configurationPolicies, eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id))
  .leftJoin(configPolicyBackupSettings, eq(configPolicyBackupSettings.featureLinkId, configPolicyFeatureLinks.id))
  .where(
    and(
      eq(configPolicyFeatureLinks.featureType, 'backup'),
      eq(configurationPolicies.orgId, orgId),
      eq(configurationPolicies.status, 'active')
    )
  );
```

Map the result to a shape similar to what the AI tool previously returned.

- [ ] **Step 4: Remove all backupPolicies imports from these files**

Remove any remaining references to `backupPolicies` from imports and in-memory seed data usage.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit --project apps/api/tsconfig.json`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/backup/verificationService.ts apps/api/src/routes/backup/verificationScheduled.ts apps/api/src/routes/backup/readinessCalculator.ts apps/api/src/services/aiToolsBackup.ts
git commit -m "feat(api): update verification services and AI tools to use config policies

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Update tests and final verification

**Files:**
- Modify: `apps/api/src/routes/backup.test.ts`

- [ ] **Step 1: Remove backupPolicies from test mocks**

In `backup.test.ts`, remove `backupPolicies` from the `vi.mock('../db/schema')` block.

- [ ] **Step 2: Run all tests**

```bash
pnpm test --filter=@breeze/api
pnpm test --filter=@breeze/web
```

Fix any failures related to removed imports or changed types.

- [ ] **Step 3: Verify zero references to backupPolicies in active code**

```bash
grep -rn "backupPolicies" apps/api/src/ apps/web/src/ --include="*.ts" --include="*.tsx" | grep -v "node_modules" | grep -v ".test." | grep -v "schema/backup.ts"
```

Expected: no results (the table definition in schema stays, everything else is removed)

- [ ] **Step 4: Run the migration against local DB**

```bash
docker exec -i breeze-postgres psql -U breeze -d breeze < apps/api/migrations/0073-backup-policy-to-config-policy.sql
```

Verify: `docker exec -i breeze-postgres psql -U breeze -d breeze -c "SELECT count(*) FROM config_policy_backup_settings;"`

- [ ] **Step 5: Verify Kit shows as protected**

Hit the status endpoint:
```bash
curl -s localhost:3000/backup/status/e65460f3-413c-4599-a9a6-90ee71bbc4ff -H "Authorization: Bearer <token>" | jq '.data.protected'
```
Expected: `true`

- [ ] **Step 6: Check drift**

Run: `pnpm db:check-drift`
Expected: no drift

- [ ] **Step 7: Commit any test fixes**

```bash
git add -A
git commit -m "test(api): update backup tests for config policy migration

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```
