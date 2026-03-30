# Config Policy Enterprise Backup Scheduling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable automated scheduling of Hyper-V, MSSQL, and system image backups through the configuration policy system, alongside existing file backups.

**Architecture:** Add `backupMode` enum and `targets` JSONB to `configPolicyBackupSettings`. The backup worker reads mode and dispatches the appropriate command type (`backup_run`, `hyperv_backup`, `mssql_backup`). Hyper-V/MSSQL use all-by-default targeting with optional exclude lists, querying `hyperv_vms` and `sql_instances` at dispatch time.

**Tech Stack:** PostgreSQL (migration), Drizzle ORM, Zod validation, BullMQ worker, React (BackupTab component), Vitest

**Spec:** `docs/superpowers/specs/2026-03-29-config-policy-enterprise-backup-design.md`

---

### Task 1: Database Migration + Drizzle Schema

**Files:**
- Create: `apps/api/migrations/0083-backup-mode-targets.sql`
- Modify: `apps/api/src/db/schema/configurationPolicies.ts:229-238`

- [ ] **Step 1: Write the migration SQL**

Create `apps/api/migrations/0083-backup-mode-targets.sql`:

```sql
-- Add backup_mode enum and targets column to config_policy_backup_settings
-- Idempotent: safe to re-run

DO $$ BEGIN
  CREATE TYPE backup_mode_enum AS ENUM ('file', 'hyperv', 'mssql', 'system_image');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE config_policy_backup_settings
  ADD COLUMN IF NOT EXISTS backup_mode backup_mode_enum NOT NULL DEFAULT 'file';

ALTER TABLE config_policy_backup_settings
  ADD COLUMN IF NOT EXISTS targets jsonb NOT NULL DEFAULT '{}';

-- Migrate existing rows: copy paths into targets for file mode
UPDATE config_policy_backup_settings
SET targets = jsonb_build_object('paths', COALESCE(paths, '[]'::jsonb))
WHERE paths IS NOT NULL AND paths != '[]'::jsonb
  AND (targets = '{}'::jsonb);
```

- [ ] **Step 2: Update Drizzle schema**

In `apps/api/src/db/schema/configurationPolicies.ts`, add the enum after the existing enums (after line ~45):

```typescript
export const backupModeEnum = pgEnum('backup_mode_enum', [
  'file',
  'hyperv',
  'mssql',
  'system_image',
]);
```

Then add the two columns to the `configPolicyBackupSettings` table definition (after the `paths` column, around line 236):

```typescript
  backupMode: backupModeEnum('backup_mode').notNull().default('file'),
  targets: jsonb('targets').notNull().default({}),
```

- [ ] **Step 3: Run migration and verify no drift**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
psql "$DATABASE_URL" -f apps/api/migrations/0083-backup-mode-targets.sql
pnpm db:check-drift
```

Expected: Migration applies cleanly, no schema drift.

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/0083-backup-mode-targets.sql apps/api/src/db/schema/configurationPolicies.ts
git commit -m "feat: add backup_mode enum and targets column to config policy backup settings"
```

---

### Task 2: Zod Target Validators (Shared Package)

**Files:**
- Create: `packages/shared/src/validators/backupTargets.ts`
- Modify: `packages/shared/src/validators/index.ts`
- Test: `packages/shared/src/validators/backupTargets.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/src/validators/backupTargets.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  fileTargetsSchema,
  hypervTargetsSchema,
  mssqlTargetsSchema,
  systemImageTargetsSchema,
  backupInlineSettingsSchema,
} from './backupTargets';

describe('fileTargetsSchema', () => {
  it('accepts valid file targets', () => {
    const result = fileTargetsSchema.safeParse({
      paths: ['/Users', '/etc'],
      excludes: ['*.tmp'],
    });
    expect(result.success).toBe(true);
  });

  it('requires at least one path', () => {
    const result = fileTargetsSchema.safeParse({ paths: [] });
    expect(result.success).toBe(false);
  });

  it('excludes is optional', () => {
    const result = fileTargetsSchema.safeParse({ paths: ['/data'] });
    expect(result.success).toBe(true);
    expect(result.data?.excludes).toBeUndefined();
  });
});

describe('hypervTargetsSchema', () => {
  it('accepts valid hyperv targets', () => {
    const result = hypervTargetsSchema.safeParse({
      exportPath: 'D:\\Backups\\VMs',
      consistencyType: 'application',
    });
    expect(result.success).toBe(true);
  });

  it('defaults consistencyType to application', () => {
    const result = hypervTargetsSchema.safeParse({
      exportPath: 'D:\\Backups',
    });
    expect(result.success).toBe(true);
    expect(result.data?.consistencyType).toBe('application');
  });

  it('defaults excludeVms to empty array', () => {
    const result = hypervTargetsSchema.safeParse({
      exportPath: 'D:\\Backups',
    });
    expect(result.success).toBe(true);
    expect(result.data?.excludeVms).toEqual([]);
  });

  it('rejects empty exportPath', () => {
    const result = hypervTargetsSchema.safeParse({ exportPath: '' });
    expect(result.success).toBe(false);
  });

  it('accepts excludeVms list', () => {
    const result = hypervTargetsSchema.safeParse({
      exportPath: 'D:\\Backups',
      excludeVms: ['TestVM', 'DevVM'],
    });
    expect(result.success).toBe(true);
    expect(result.data?.excludeVms).toEqual(['TestVM', 'DevVM']);
  });
});

describe('mssqlTargetsSchema', () => {
  it('accepts valid mssql targets', () => {
    const result = mssqlTargetsSchema.safeParse({
      outputPath: 'D:\\SQLBackups',
      backupType: 'full',
    });
    expect(result.success).toBe(true);
  });

  it('defaults backupType to full', () => {
    const result = mssqlTargetsSchema.safeParse({
      outputPath: 'D:\\SQLBackups',
    });
    expect(result.success).toBe(true);
    expect(result.data?.backupType).toBe('full');
  });

  it('defaults excludeDatabases to empty array', () => {
    const result = mssqlTargetsSchema.safeParse({
      outputPath: 'D:\\SQLBackups',
    });
    expect(result.success).toBe(true);
    expect(result.data?.excludeDatabases).toEqual([]);
  });

  it('accepts differential and log backup types', () => {
    expect(
      mssqlTargetsSchema.safeParse({ outputPath: '/bak', backupType: 'differential' }).success
    ).toBe(true);
    expect(
      mssqlTargetsSchema.safeParse({ outputPath: '/bak', backupType: 'log' }).success
    ).toBe(true);
  });

  it('rejects invalid backupType', () => {
    const result = mssqlTargetsSchema.safeParse({
      outputPath: '/bak',
      backupType: 'incremental',
    });
    expect(result.success).toBe(false);
  });
});

describe('systemImageTargetsSchema', () => {
  it('defaults includeSystemState to true', () => {
    const result = systemImageTargetsSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data?.includeSystemState).toBe(true);
  });

  it('accepts explicit false', () => {
    const result = systemImageTargetsSchema.safeParse({
      includeSystemState: false,
    });
    expect(result.success).toBe(true);
    expect(result.data?.includeSystemState).toBe(false);
  });
});

describe('backupInlineSettingsSchema', () => {
  it('validates file mode with matching targets', () => {
    const result = backupInlineSettingsSchema.safeParse({
      backupMode: 'file',
      targets: { paths: ['/data'] },
      schedule: { frequency: 'daily', time: '02:00' },
      retention: { keepDaily: 7 },
    });
    expect(result.success).toBe(true);
  });

  it('validates hyperv mode with matching targets', () => {
    const result = backupInlineSettingsSchema.safeParse({
      backupMode: 'hyperv',
      targets: { exportPath: 'D:\\Backups' },
      schedule: { frequency: 'daily', time: '02:00' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects hyperv mode with file targets', () => {
    const result = backupInlineSettingsSchema.safeParse({
      backupMode: 'hyperv',
      targets: { paths: ['/data'] },
      schedule: { frequency: 'daily', time: '02:00' },
    });
    expect(result.success).toBe(false);
  });

  it('defaults backupMode to file when omitted', () => {
    const result = backupInlineSettingsSchema.safeParse({
      targets: { paths: ['/data'] },
      schedule: { frequency: 'daily', time: '02:00' },
    });
    expect(result.success).toBe(true);
    expect(result.data?.backupMode).toBe('file');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/shared && npx vitest run src/validators/backupTargets.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the validators**

Create `packages/shared/src/validators/backupTargets.ts`:

```typescript
import { z } from 'zod';

export const fileTargetsSchema = z.object({
  paths: z.array(z.string()).min(1),
  excludes: z.array(z.string()).optional(),
});

export const hypervTargetsSchema = z.object({
  exportPath: z.string().min(1),
  consistencyType: z.enum(['application', 'crash']).default('application'),
  excludeVms: z.array(z.string()).default([]),
});

export const mssqlTargetsSchema = z.object({
  outputPath: z.string().min(1),
  backupType: z.enum(['full', 'differential', 'log']).default('full'),
  excludeDatabases: z.array(z.string()).default([]),
});

export const systemImageTargetsSchema = z.object({
  includeSystemState: z.boolean().default(true),
});

export const backupModeSchema = z.enum([
  'file',
  'hyperv',
  'mssql',
  'system_image',
]);

export type BackupMode = z.infer<typeof backupModeSchema>;

const targetsMap = {
  file: fileTargetsSchema,
  hyperv: hypervTargetsSchema,
  mssql: mssqlTargetsSchema,
  system_image: systemImageTargetsSchema,
} as const;

export const backupInlineSettingsSchema = z
  .object({
    backupMode: backupModeSchema.default('file'),
    targets: z.record(z.unknown()).default({}),
    schedule: z.record(z.unknown()).optional(),
    retention: z.record(z.unknown()).optional(),
    paths: z.array(z.string()).optional(), // backwards compat
  })
  .superRefine((data, ctx) => {
    const schema = targetsMap[data.backupMode];
    const result = schema.safeParse(data.targets);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          ...issue,
          path: ['targets', ...issue.path],
        });
      }
    }
  });

export type BackupInlineSettings = z.infer<typeof backupInlineSettingsSchema>;
```

- [ ] **Step 4: Export from index**

Add to `packages/shared/src/validators/index.ts`:

```typescript
export {
  fileTargetsSchema,
  hypervTargetsSchema,
  mssqlTargetsSchema,
  systemImageTargetsSchema,
  backupModeSchema,
  backupInlineSettingsSchema,
  type BackupMode,
  type BackupInlineSettings,
} from './backupTargets';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/shared && npx vitest run src/validators/backupTargets.test.ts`
Expected: All 14 tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/validators/backupTargets.ts packages/shared/src/validators/backupTargets.test.ts packages/shared/src/validators/index.ts
git commit -m "feat: add Zod validators for backup mode targets (file, hyperv, mssql, system_image)"
```

---

### Task 3: API — Decompose/Assemble Inline Settings

**Files:**
- Modify: `apps/api/src/services/configurationPolicy.ts:434-450` (decompose)
- Modify: `apps/api/src/services/configurationPolicy.ts:~746` (assemble)

- [ ] **Step 1: Update decomposeInlineSettings backup case**

In `apps/api/src/services/configurationPolicy.ts`, find the `case 'backup':` block inside `decomposeInlineSettings` (around line 434). Replace it with:

```typescript
case 'backup': {
  const [policyRow] = await tx
    .select({ orgId: configurationPolicies.orgId })
    .from(configPolicyFeatureLinks)
    .innerJoin(configurationPolicies, eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id))
    .where(eq(configPolicyFeatureLinks.id, linkId))
    .limit(1);
  if (!policyRow) throw new Error(`Cannot resolve orgId for feature link ${linkId}`);
  await tx.insert(configPolicyBackupSettings).values({
    featureLinkId: linkId,
    orgId: policyRow.orgId,
    schedule: (s.schedule ?? {}) as Record<string, unknown>,
    retention: (s.retention ?? {}) as Record<string, unknown>,
    paths: (Array.isArray(s.paths) ? s.paths : []) as unknown[],
    backupMode: s.backupMode ?? 'file',
    targets: (s.targets ?? {}) as Record<string, unknown>,
  });
  break;
}
```

- [ ] **Step 2: Add assembleInlineSettings backup case**

Find `assembleInlineSettings` in the same file (around line 746). Add a `case 'backup':` that reads from the normalized table:

```typescript
case 'backup': {
  const [row] = await tx
    .select()
    .from(configPolicyBackupSettings)
    .where(eq(configPolicyBackupSettings.featureLinkId, linkId))
    .limit(1);
  if (!row) return null;
  return {
    schedule: row.schedule,
    retention: row.retention,
    paths: row.paths,
    backupMode: row.backupMode,
    targets: row.targets,
  };
}
```

- [ ] **Step 3: Verify type check passes**

Run: `cd apps/api && npx tsc --noEmit 2>&1 | grep -i backup`
Expected: No new errors related to backup (pre-existing errors in test files are expected)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/configurationPolicy.ts
git commit -m "feat: decompose/assemble backupMode and targets in config policy backup settings"
```

---

### Task 4: API — Feature Link Validation

**Files:**
- Modify: `apps/api/src/routes/configurationPolicies/featureLinks.ts`

- [ ] **Step 1: Add backup validation to POST handler**

In `apps/api/src/routes/configurationPolicies/featureLinks.ts`, add an import at the top:

```typescript
import { backupInlineSettingsSchema } from '@breeze/shared/validators';
```

In the POST `/:id/features` handler (around line 45), after the existing validation and before calling `addFeatureLink`, add:

```typescript
    // Validate backup-specific inline settings
    if (data.featureType === 'backup' && data.inlineSettings) {
      const parsed = backupInlineSettingsSchema.safeParse(data.inlineSettings);
      if (!parsed.success) {
        return c.json({ error: 'Invalid backup settings', details: parsed.error.flatten() }, 400);
      }
      data.inlineSettings = parsed.data;
    }
```

- [ ] **Step 2: Add same validation to PATCH handler**

In the PATCH `/:id/features/:linkId` handler (around line 94), add the same validation:

```typescript
    if (data.inlineSettings) {
      // Check if this is a backup feature link
      const links = await listFeatureLinks(id);
      const link = links.find((l) => l.id === linkId);
      if (link?.featureType === 'backup') {
        const parsed = backupInlineSettingsSchema.safeParse(data.inlineSettings);
        if (!parsed.success) {
          return c.json({ error: 'Invalid backup settings', details: parsed.error.flatten() }, 400);
        }
        data.inlineSettings = parsed.data;
      }
    }
```

- [ ] **Step 3: Verify type check passes**

Run: `cd apps/api && npx tsc --noEmit 2>&1 | grep featureLinks`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/configurationPolicies/featureLinks.ts
git commit -m "feat: validate backup mode and targets on feature link create/update"
```

---

### Task 5: Backup Worker — Mode-Based Dispatch

**Files:**
- Modify: `apps/api/src/jobs/backupWorker.ts:236-297`
- Test: `apps/api/src/jobs/backupWorker.test.ts`

- [ ] **Step 1: Write failing tests for dispatch routing**

Create `apps/api/src/jobs/backupWorker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveBackupTargets } from './backupWorker';

// Mock drizzle
vi.mock('../db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  },
}));

describe('resolveBackupTargets', () => {
  it('returns file targets unchanged', async () => {
    const result = await resolveBackupTargets('file', {
      paths: ['/data', '/etc'],
    }, 'device-id');
    expect(result).toEqual([
      { commandType: 'backup_run', payload: { paths: ['/data', '/etc'] } },
    ]);
  });

  it('returns system_image target', async () => {
    const result = await resolveBackupTargets('system_image', {
      includeSystemState: true,
    }, 'device-id');
    expect(result).toEqual([
      { commandType: 'backup_run', payload: { systemImage: true } },
    ]);
  });

  it('returns one entry per discovered VM for hyperv', async () => {
    // Mock hyperv_vms query to return 3 VMs
    const { db } = await import('../db');
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { vmName: 'DC-01' },
          { vmName: 'SQL-01' },
          { vmName: 'DevVM' },
        ]),
      }),
    } as any);

    const result = await resolveBackupTargets('hyperv', {
      exportPath: 'D:\\Backups',
      consistencyType: 'application',
      excludeVms: ['DevVM'],
    }, 'device-id');

    expect(result).toEqual([
      { commandType: 'hyperv_backup', payload: { vmName: 'DC-01', exportPath: 'D:\\Backups', consistencyType: 'application' } },
      { commandType: 'hyperv_backup', payload: { vmName: 'SQL-01', exportPath: 'D:\\Backups', consistencyType: 'application' } },
    ]);
  });

  it('returns empty array when all VMs excluded', async () => {
    const { db } = await import('../db');
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { vmName: 'DevVM' },
        ]),
      }),
    } as any);

    const result = await resolveBackupTargets('hyperv', {
      exportPath: 'D:\\Backups',
      excludeVms: ['DevVM'],
    }, 'device-id');

    expect(result).toEqual([]);
  });

  it('returns one entry per database for mssql', async () => {
    const { db } = await import('../db');
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { instanceName: 'SQLEXPRESS', databases: ['AppDB', 'AuthDB', 'tempdb'] },
        ]),
      }),
    } as any);

    const result = await resolveBackupTargets('mssql', {
      outputPath: 'D:\\SQLBackups',
      backupType: 'full',
      excludeDatabases: ['tempdb'],
    }, 'device-id');

    expect(result).toEqual([
      { commandType: 'mssql_backup', payload: { instance: 'SQLEXPRESS', database: 'AppDB', backupType: 'full', outputPath: 'D:\\SQLBackups' } },
      { commandType: 'mssql_backup', payload: { instance: 'SQLEXPRESS', database: 'AuthDB', backupType: 'full', outputPath: 'D:\\SQLBackups' } },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run src/jobs/backupWorker.test.ts`
Expected: FAIL — `resolveBackupTargets` not exported

- [ ] **Step 3: Implement resolveBackupTargets**

In `apps/api/src/jobs/backupWorker.ts`, add the following imports and function. Add the import for the schema tables:

```typescript
import { hypervVms } from '../db/schema/backup';
import { sqlInstances } from '../db/schema/applicationBackup';
```

Add the exported function (before `processDispatchBackup`):

```typescript
export interface BackupTarget {
  commandType: string;
  payload: Record<string, unknown>;
}

export async function resolveBackupTargets(
  backupMode: string,
  targets: Record<string, unknown>,
  deviceId: string
): Promise<BackupTarget[]> {
  switch (backupMode) {
    case 'file': {
      const t = targets as { paths: string[] };
      return [{ commandType: 'backup_run', payload: { paths: t.paths } }];
    }

    case 'hyperv': {
      const t = targets as {
        exportPath: string;
        consistencyType?: string;
        excludeVms?: string[];
      };
      const vms = await db
        .select({ vmName: hypervVms.vmName })
        .from(hypervVms)
        .where(eq(hypervVms.deviceId, deviceId));

      const excludeSet = new Set(t.excludeVms ?? []);
      return vms
        .filter((vm) => !excludeSet.has(vm.vmName))
        .map((vm) => ({
          commandType: 'hyperv_backup',
          payload: {
            vmName: vm.vmName,
            exportPath: t.exportPath,
            consistencyType: t.consistencyType ?? 'application',
          },
        }));
    }

    case 'mssql': {
      const t = targets as {
        outputPath: string;
        backupType?: string;
        excludeDatabases?: string[];
      };
      const instances = await db
        .select({
          instanceName: sqlInstances.instanceName,
          databases: sqlInstances.databases,
        })
        .from(sqlInstances)
        .where(eq(sqlInstances.deviceId, deviceId));

      const excludeSet = new Set(t.excludeDatabases ?? []);
      const results: BackupTarget[] = [];
      for (const inst of instances) {
        const dbs = (inst.databases as string[]) ?? [];
        for (const database of dbs) {
          if (!excludeSet.has(database)) {
            results.push({
              commandType: 'mssql_backup',
              payload: {
                instance: inst.instanceName,
                database,
                backupType: t.backupType ?? 'full',
                outputPath: t.outputPath,
              },
            });
          }
        }
      }
      return results;
    }

    case 'system_image': {
      return [{ commandType: 'backup_run', payload: { systemImage: true } }];
    }

    default:
      return [{ commandType: 'backup_run', payload: {} }];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/jobs/backupWorker.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Wire resolveBackupTargets into processDispatchBackup**

In `processDispatchBackup` (around line 236), replace the existing command construction (lines 264-276) with mode-based dispatch. Replace the block from the config load through to command sending:

```typescript
  // Read backup mode from the feature link's settings
  const [settingsRow] = data.featureLinkId
    ? await db
        .select({
          backupMode: configPolicyBackupSettings.backupMode,
          targets: configPolicyBackupSettings.targets,
        })
        .from(configPolicyBackupSettings)
        .where(eq(configPolicyBackupSettings.featureLinkId, data.featureLinkId))
        .limit(1)
    : [null];

  const backupMode = (settingsRow?.backupMode as string) ?? 'file';
  const targets = (settingsRow?.targets as Record<string, unknown>) ?? {};

  const resolvedTargets = await resolveBackupTargets(backupMode, targets, data.deviceId);

  if (resolvedTargets.length === 0) {
    logger.warn({ deviceId: data.deviceId, backupMode }, 'No backup targets resolved, skipping');
    await db
      .update(backupJobs)
      .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(backupJobs.id, data.jobId));
    return;
  }

  // For the first target, use the existing job. For additional targets, create new jobs.
  for (let i = 0; i < resolvedTargets.length; i++) {
    const target = resolvedTargets[i];
    let jobId = data.jobId;

    if (i > 0) {
      const [newJob] = await db
        .insert(backupJobs)
        .values({
          orgId: data.orgId,
          configId: data.configId,
          featureLinkId: data.featureLinkId,
          deviceId: data.deviceId,
          status: 'pending',
          type: 'scheduled',
          backupType: backupMode === 'mssql' ? 'database' : backupMode === 'system_image' ? 'system_image' : 'file',
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();
      jobId = newJob.id;
    }

    const command: AgentCommand = {
      id: jobId,
      type: target.commandType,
      payload: {
        jobId,
        configId: data.configId,
        provider: config.provider,
        providerConfig,
        ...target.payload,
      },
    };

    const sent = sendCommandToAgent(agentId, command);
    if (sent) {
      await db
        .update(backupJobs)
        .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
        .where(eq(backupJobs.id, jobId));
    }
  }
```

Note: `data.featureLinkId` needs to be added to `DispatchBackupJobData`. Update the interface (around line 53):

```typescript
interface DispatchBackupJobData {
  type: 'dispatch-backup';
  jobId: string;
  configId: string;
  orgId: string;
  deviceId: string;
  featureLinkId?: string;
}
```

And update `enqueueBackupDispatch` calls in check-schedules to pass `featureLinkId`:

```typescript
await backupEnqueue.enqueueBackupDispatch(job.id, entry.configId!, data.orgId, entry.deviceId, entry.featureLinkId);
```

- [ ] **Step 6: Verify type check**

Run: `cd apps/api && npx tsc --noEmit 2>&1 | head -20`
Expected: No new type errors

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs/backupWorker.ts apps/api/src/jobs/backupWorker.test.ts
git commit -m "feat: mode-based backup dispatch — route to hyperv_backup/mssql_backup by backupMode"
```

---

### Task 6: GFS Retention Fix

**Files:**
- Modify: `apps/api/src/jobs/backupRetention.ts:71-89`
- Test: `apps/api/src/jobs/backupRetention.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/api/src/jobs/backupRetention.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  },
}));

describe('resolveGfsConfigForJob', () => {
  it('reads GFS from configPolicyBackupSettings via featureLinkId', async () => {
    const { db } = await import('../db');

    // First call: get featureLinkId from backupJobs
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ featureLinkId: 'link-123' }]),
        }),
      }),
    } as any);

    // Second call: get retention from configPolicyBackupSettings
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 },
          }]),
        }),
      }),
    } as any);

    const { resolveGfsConfigForJob } = await import('./backupRetention');
    const result = await resolveGfsConfigForJob('job-456');

    expect(result).toEqual({
      daily: 7,
      weekly: 4,
      monthly: 12,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/jobs/backupRetention.test.ts`
Expected: FAIL — current implementation reads from backupPolicies, not configPolicyBackupSettings

- [ ] **Step 3: Update resolveGfsConfigForJob**

In `apps/api/src/jobs/backupRetention.ts`, add import:

```typescript
import { configPolicyBackupSettings } from '../db/schema';
```

Replace `resolveGfsConfigForJob` (lines 71-89) with:

```typescript
export async function resolveGfsConfigForJob(
  jobId: string
): Promise<GfsConfig | null> {
  // Try config policy backup settings first (new system)
  const [job] = await db
    .select({
      featureLinkId: backupJobs.featureLinkId,
      policyId: backupJobs.policyId,
    })
    .from(backupJobs)
    .where(eq(backupJobs.id, jobId))
    .limit(1);

  if (!job) return null;

  // New path: read from config policy backup settings
  if (job.featureLinkId) {
    const [settings] = await db
      .select({ retention: configPolicyBackupSettings.retention })
      .from(configPolicyBackupSettings)
      .where(eq(configPolicyBackupSettings.featureLinkId, job.featureLinkId))
      .limit(1);

    if (settings?.retention) {
      const r = settings.retention as Record<string, number>;
      return {
        daily: r.keepDaily,
        weekly: r.keepWeekly,
        monthly: r.keepMonthly,
        yearly: r.keepYearly,
      };
    }
  }

  // Legacy fallback: read from deprecated backupPolicies
  if (job.policyId) {
    const [policy] = await db
      .select({ gfsConfig: backupPolicies.gfsConfig })
      .from(backupPolicies)
      .where(eq(backupPolicies.id, job.policyId))
      .limit(1);

    return (policy?.gfsConfig as GfsConfig) ?? null;
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/jobs/backupRetention.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/backupRetention.ts apps/api/src/jobs/backupRetention.test.ts
git commit -m "fix: read GFS config from config policy backup settings, fall back to legacy backupPolicies"
```

---

### Task 7: Web UI — BackupTab Mode Selector

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/BackupTab.tsx`

- [ ] **Step 1: Add backup mode state and selector UI**

At the top of the component (after existing state declarations), add:

```typescript
const [backupMode, setBackupMode] = useState<string>(
  (settings?.backupMode as string) ?? 'file'
);
const [targets, setTargets] = useState<Record<string, unknown>>(
  (settings?.targets as Record<string, unknown>) ?? {}
);
```

Add a mode selector section at the top of the form (before the schedule section):

```tsx
<div className="space-y-3">
  <label className="text-sm font-medium text-zinc-300">Backup Type</label>
  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
    {[
      { value: 'file', label: 'File Backup' },
      { value: 'hyperv', label: 'Hyper-V VMs' },
      { value: 'mssql', label: 'SQL Server' },
      { value: 'system_image', label: 'System Image' },
    ].map((opt) => (
      <button
        key={opt.value}
        type="button"
        onClick={() => {
          setBackupMode(opt.value);
          setTargets({});
        }}
        className={`rounded-md border px-3 py-2 text-sm ${
          backupMode === opt.value
            ? 'border-blue-500 bg-blue-500/10 text-blue-400'
            : 'border-zinc-700 text-zinc-400 hover:border-zinc-600'
        }`}
      >
        {opt.label}
      </button>
    ))}
  </div>
</div>
```

- [ ] **Step 2: Add mode-specific target fields**

Below the mode selector, add conditional target inputs:

```tsx
{backupMode === 'file' && (
  <div className="space-y-3">
    {/* Existing paths UI stays here — keep the current paths input as-is */}
  </div>
)}

{backupMode === 'hyperv' && (
  <div className="space-y-3">
    <div>
      <label className="text-sm font-medium text-zinc-300">Export Path</label>
      <input
        type="text"
        placeholder="D:\Backups\VMs"
        value={(targets.exportPath as string) ?? ''}
        onChange={(e) => setTargets({ ...targets, exportPath: e.target.value })}
        className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200"
      />
    </div>
    <div>
      <label className="text-sm font-medium text-zinc-300">Consistency Type</label>
      <select
        value={(targets.consistencyType as string) ?? 'application'}
        onChange={(e) => setTargets({ ...targets, consistencyType: e.target.value })}
        className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200"
      >
        <option value="application">Application-consistent (recommended)</option>
        <option value="crash">Crash-consistent</option>
      </select>
      <p className="mt-1 text-xs text-zinc-500">All discovered VMs are backed up automatically. Exclude specific VMs below.</p>
    </div>
    <div>
      <label className="text-sm font-medium text-zinc-300">Exclude VMs (optional)</label>
      <input
        type="text"
        placeholder="TestVM, DevVM"
        value={((targets.excludeVms as string[]) ?? []).join(', ')}
        onChange={(e) =>
          setTargets({
            ...targets,
            excludeVms: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
          })
        }
        className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200"
      />
    </div>
  </div>
)}

{backupMode === 'mssql' && (
  <div className="space-y-3">
    <div>
      <label className="text-sm font-medium text-zinc-300">Output Path</label>
      <input
        type="text"
        placeholder="D:\SQLBackups"
        value={(targets.outputPath as string) ?? ''}
        onChange={(e) => setTargets({ ...targets, outputPath: e.target.value })}
        className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200"
      />
    </div>
    <div>
      <label className="text-sm font-medium text-zinc-300">Backup Type</label>
      <select
        value={(targets.backupType as string) ?? 'full'}
        onChange={(e) => setTargets({ ...targets, backupType: e.target.value })}
        className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200"
      >
        <option value="full">Full</option>
        <option value="differential">Differential</option>
        <option value="log">Transaction Log</option>
      </select>
      <p className="mt-1 text-xs text-zinc-500">All discovered databases are backed up automatically. Exclude specific databases below.</p>
    </div>
    <div>
      <label className="text-sm font-medium text-zinc-300">Exclude Databases (optional)</label>
      <input
        type="text"
        placeholder="tempdb, test_db"
        value={((targets.excludeDatabases as string[]) ?? []).join(', ')}
        onChange={(e) =>
          setTargets({
            ...targets,
            excludeDatabases: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
          })
        }
        className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200"
      />
    </div>
  </div>
)}

{backupMode === 'system_image' && (
  <div className="space-y-3">
    <label className="flex items-center gap-2 text-sm text-zinc-300">
      <input
        type="checkbox"
        checked={(targets.includeSystemState as boolean) ?? true}
        onChange={(e) => setTargets({ ...targets, includeSystemState: e.target.checked })}
        className="rounded border-zinc-600"
      />
      Include system state (OS config, drivers, registry)
    </label>
    <p className="text-xs text-zinc-500">Captures a full system image for bare metal recovery.</p>
  </div>
)}
```

- [ ] **Step 3: Include backupMode and targets in save payload**

Find where the component saves settings (the `handleSave` or `onSave` function) and ensure `backupMode` and `targets` are included in the `inlineSettings` payload sent to the API:

```typescript
const inlineSettings = {
  ...existingSettings,
  backupMode,
  targets,
};
```

- [ ] **Step 4: Verify the web app builds**

Run: `cd apps/web && npx astro build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs/BackupTab.tsx
git commit -m "feat: add backup mode selector and type-specific target fields to BackupTab"
```

---

### Task 8: Integration Test — End-to-End Policy Dispatch

**Files:**
- Create: `apps/api/src/jobs/backupWorkerDispatch.test.ts`

- [ ] **Step 1: Write integration test**

Create `apps/api/src/jobs/backupWorkerDispatch.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveBackupTargets, type BackupTarget } from './backupWorker';

// Test the resolveBackupTargets function with realistic data shapes

vi.mock('../db', () => {
  const mockSelect = vi.fn();
  return {
    db: {
      select: mockSelect,
    },
  };
});

describe('resolveBackupTargets integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('file mode passes through paths unchanged', async () => {
    const targets = await resolveBackupTargets(
      'file',
      { paths: ['/home', '/var/log'] },
      'device-1'
    );
    expect(targets).toHaveLength(1);
    expect(targets[0].commandType).toBe('backup_run');
    expect(targets[0].payload).toEqual({ paths: ['/home', '/var/log'] });
  });

  it('system_image mode returns single backup_run with systemImage flag', async () => {
    const targets = await resolveBackupTargets(
      'system_image',
      { includeSystemState: true },
      'device-1'
    );
    expect(targets).toHaveLength(1);
    expect(targets[0].commandType).toBe('backup_run');
    expect(targets[0].payload).toEqual({ systemImage: true });
  });

  it('hyperv mode creates one target per VM minus excludes', async () => {
    const { db } = await import('../db');
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { vmName: 'DC-01' },
          { vmName: 'SQL-01' },
          { vmName: 'Test-VM' },
        ]),
      }),
    } as any);

    const targets = await resolveBackupTargets(
      'hyperv',
      { exportPath: 'E:\\Exports', consistencyType: 'crash', excludeVms: ['Test-VM'] },
      'device-1'
    );

    expect(targets).toHaveLength(2);
    expect(targets[0]).toEqual({
      commandType: 'hyperv_backup',
      payload: { vmName: 'DC-01', exportPath: 'E:\\Exports', consistencyType: 'crash' },
    });
    expect(targets[1]).toEqual({
      commandType: 'hyperv_backup',
      payload: { vmName: 'SQL-01', exportPath: 'E:\\Exports', consistencyType: 'crash' },
    });
  });

  it('mssql mode expands instances x databases minus excludes', async () => {
    const { db } = await import('../db');
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { instanceName: 'MSSQLSERVER', databases: ['AppDB', 'master', 'tempdb'] },
          { instanceName: 'SQLEXPRESS', databases: ['ReportDB'] },
        ]),
      }),
    } as any);

    const targets = await resolveBackupTargets(
      'mssql',
      { outputPath: 'D:\\Bak', backupType: 'full', excludeDatabases: ['master', 'tempdb'] },
      'device-1'
    );

    expect(targets).toHaveLength(2);
    expect(targets[0].payload).toEqual({
      instance: 'MSSQLSERVER', database: 'AppDB', backupType: 'full', outputPath: 'D:\\Bak',
    });
    expect(targets[1].payload).toEqual({
      instance: 'SQLEXPRESS', database: 'ReportDB', backupType: 'full', outputPath: 'D:\\Bak',
    });
  });

  it('hyperv with no discovered VMs returns empty array', async () => {
    const { db } = await import('../db');
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const targets = await resolveBackupTargets(
      'hyperv',
      { exportPath: 'D:\\Backups' },
      'device-1'
    );
    expect(targets).toEqual([]);
  });

  it('unknown mode falls back to backup_run', async () => {
    const targets = await resolveBackupTargets(
      'unknown_mode' as any,
      {},
      'device-1'
    );
    expect(targets).toEqual([{ commandType: 'backup_run', payload: {} }]);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd apps/api && npx vitest run src/jobs/backupWorkerDispatch.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/jobs/backupWorkerDispatch.test.ts
git commit -m "test: integration tests for backup worker mode-based dispatch"
```

---

### Task 9: Verify Everything Together

- [ ] **Step 1: Run all backup-related tests**

```bash
cd apps/api && npx vitest run --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|backupWorker|backupRetention|backupTargets)"
```

Expected: All new tests pass. No regressions.

- [ ] **Step 2: Run shared package tests**

```bash
cd packages/shared && npx vitest run --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|backupTargets)"
```

Expected: All validator tests pass.

- [ ] **Step 3: Type check the full API**

```bash
cd apps/api && npx tsc --noEmit 2>&1 | wc -l
```

Expected: No new errors (compare count to pre-existing baseline).

- [ ] **Step 4: Type check the web app**

```bash
cd apps/web && npx astro check 2>&1 | tail -10
```

Expected: No new errors.

- [ ] **Step 5: Run schema drift check**

```bash
pnpm db:check-drift
```

Expected: No drift detected.

- [ ] **Step 6: Final commit if any loose changes**

```bash
git status
```

If clean, done. If any missed files, stage and commit.
