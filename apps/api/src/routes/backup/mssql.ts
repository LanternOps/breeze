import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { backupJobs, backupSnapshots, devices } from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { sqlInstances, backupChains } from '../../db/schema/applicationBackup';
import {
  executeCommand,
  CommandTypes,
} from '../../services/commandQueue';
import { PERMISSIONS } from '../../services/permissions';
import { resolveScopedOrgId } from './helpers';
import { resolveAllBackupAssignedDevices, resolveBackupConfigForDevice } from '../../services/featureConfigResolver';
import { backupCommandResultSchema } from './resultSchemas';
import {
  applyBackupCommandResultToJob,
  markBackupJobFailedIfInFlight,
} from '../../services/backupResultPersistence';

export const mssqlRoutes = new Hono();

// ── Validation schemas ────────────────────────────────────────────

// Database and instance names: alphanumeric, underscore, hyphen, dot, space only.
// Prevents T-SQL injection via crafted identifiers.
const sqlIdentifierRegex = /^[a-zA-Z0-9_\-. ]+$/;

const deviceIdParamSchema = z.object({
  deviceId: z.string().uuid(),
});

const snapshotIdParamSchema = z.object({
  snapshotId: z.string().uuid(),
});

const mssqlBackupSchema = z.object({
  deviceId: z.string().uuid(),
  instance: z.string().min(1).regex(sqlIdentifierRegex, 'Invalid instance name characters'),
  database: z.string().min(1).regex(sqlIdentifierRegex, 'Invalid database name characters'),
  backupType: z.enum(['full', 'differential', 'log']).default('full'),
});

const mssqlRestoreSchema = z.object({
  deviceId: z.string().uuid(),
  snapshotId: z.string().uuid(),
  instance: z.string().min(1).regex(sqlIdentifierRegex, 'Invalid instance name characters').optional(),
  targetDatabase: z.string().min(1).regex(sqlIdentifierRegex, 'Invalid database name characters'),
  noRecovery: z.boolean().default(false),
});

// ── GET /mssql/instances — list all discovered instances (org-wide) ──

mssqlRoutes.get('/mssql/instances', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const instances = await db
    .select()
    .from(sqlInstances)
    .where(eq(sqlInstances.orgId, orgId));

  return c.json({ data: instances });
});

// ── GET /mssql/instances/:deviceId — instances on a specific device ──

mssqlRoutes.get(
  '/mssql/instances/:deviceId',
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { deviceId } = c.req.valid('param');

    const [device] = await db
      .select({ id: devices.id, orgId: devices.orgId })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);

    if (!device || device.orgId !== orgId) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const instances = await db
      .select()
      .from(sqlInstances)
      .where(
        and(
          eq(sqlInstances.orgId, orgId),
          eq(sqlInstances.deviceId, deviceId)
        )
      );

    return c.json({ data: instances });
  }
);

// ── GET /mssql/discovery-targets — MSSQL-protected Windows devices ──

mssqlRoutes.get(
  '/mssql/discovery-targets',
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const assignedDevices = await resolveAllBackupAssignedDevices(orgId);
    const targetDeviceIds = assignedDevices
      .filter((entry) => entry.configId && entry.settings?.backupMode === 'mssql')
      .map((entry) => entry.deviceId);

    if (targetDeviceIds.length === 0) {
      return c.json({ data: [] });
    }

    const rows = await db
      .select({
        id: devices.id,
        displayName: devices.displayName,
        hostname: devices.hostname,
        osType: devices.osType,
        status: devices.status,
      })
      .from(devices)
      .where(and(
        eq(devices.orgId, orgId),
        eq(devices.osType, 'windows'),
        inArray(devices.id, targetDeviceIds),
      ));

    const data = rows
      .sort((a, b) => {
        const left = (a.displayName ?? a.hostname ?? a.id).toLowerCase();
        const right = (b.displayName ?? b.hostname ?? b.id).toLowerCase();
        return left.localeCompare(right);
      })
      .map((row) => ({
        ...row,
        eligible: row.status === 'online',
      }));

    return c.json({ data });
  }
);

// ── POST /mssql/discover/:deviceId — trigger discovery on device ──

mssqlRoutes.post(
  '/mssql/discover/:deviceId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { deviceId } = c.req.valid('param');

    const [device] = await db
      .select({ id: devices.id, orgId: devices.orgId })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);

    if (!device || device.orgId !== orgId) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const result = await executeCommand(
      deviceId,
      CommandTypes.MSSQL_DISCOVER,
      {},
      { userId: auth?.user?.id, timeoutMs: 60000 }
    );

    if (result.status === 'failed') {
      return c.json(
        { error: result.error || 'MSSQL discovery failed' },
        500
      );
    }

    // Parse discovery result and upsert instances
    try {
      const data = result.stdout ? JSON.parse(result.stdout) : null;
      if (data?.instances && Array.isArray(data.instances)) {
        for (const inst of data.instances) {
          await db
            .insert(sqlInstances)
            .values({
              orgId,
              deviceId,
              instanceName: inst.name,
              version: inst.version || null,
              edition: inst.edition || null,
              port: inst.port || null,
              authType: inst.authType || 'windows',
              databases: inst.databases || [],
              status: inst.status || 'unknown',
              lastDiscoveredAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [sqlInstances.deviceId, sqlInstances.instanceName],
              set: {
                version: inst.version || null,
                edition: inst.edition || null,
                port: inst.port || null,
                authType: inst.authType || 'windows',
                databases: inst.databases || [],
                status: inst.status || 'unknown',
                lastDiscoveredAt: new Date(),
                updatedAt: new Date(),
              },
            });
        }
      }
      return c.json({ data });
    } catch {
      return c.json({ data: result.stdout });
    }
  }
);

// ── POST /mssql/backup — trigger MSSQL backup ──

mssqlRoutes.post(
  '/mssql/backup',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', mssqlBackupSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const payload = c.req.valid('json');

    const [device] = await db
      .select({ id: devices.id, orgId: devices.orgId })
      .from(devices)
      .where(eq(devices.id, payload.deviceId))
      .limit(1);

    if (!device || device.orgId !== orgId) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const resolvedConfig = await resolveBackupConfigForDevice(payload.deviceId);
    if (!resolvedConfig?.configId) {
      return c.json({ error: 'A provider-backed backup configuration is required on this device' }, 400);
    }

    const [backupJob] = await db
      .insert(backupJobs)
      .values({
        orgId,
        configId: resolvedConfig.configId,
        featureLinkId: resolvedConfig.featureLinkId,
        deviceId: payload.deviceId,
        status: 'pending',
        type: 'manual',
        backupType: 'database',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    if (!backupJob) {
      return c.json({ error: 'Failed to create backup job' }, 500);
    }

    const result = await executeCommand(
      payload.deviceId,
      CommandTypes.MSSQL_BACKUP,
      {
        instance: payload.instance,
        database: payload.database,
        backupType: payload.backupType,
      },
      { userId: auth?.user?.id, timeoutMs: 600000 }
    );

    let parsedData: unknown = null;
    let snapshotDbId: string | null = null;
    let providerSnapshotId: string | null = null;
    try {
      parsedData = result.stdout ? JSON.parse(result.stdout) : {};
      const parsedBackup = backupCommandResultSchema.safeParse(parsedData);
      if (!parsedBackup.success) {
        throw new Error(parsedBackup.error.issues.map((issue) => issue.message).join(', '));
      }

      const persisted = await applyBackupCommandResultToJob({
        jobId: backupJob.id,
        orgId,
        deviceId: payload.deviceId,
        resultStatus: result.status,
        result: {
          ...parsedBackup.data,
          error: result.error,
        },
      });
      snapshotDbId = persisted.snapshotDbId;
      providerSnapshotId = persisted.providerSnapshotId;
    } catch (error) {
      await markBackupJobFailedIfInFlight(
        backupJob.id,
        error instanceof Error ? error.message : 'Failed to persist MSSQL backup result',
      );
      if (result.status === 'completed') {
        return c.json(
          { error: error instanceof Error ? error.message : 'Failed to persist MSSQL backup result' },
          500
        );
      }
    }

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'MSSQL backup failed' }, 500);
    }

    return c.json({
      data: {
        ...(parsedData && typeof parsedData === 'object' ? parsedData : { raw: result.stdout ?? null }),
        backupJobId: backupJob.id,
        snapshotDbId,
        snapshotId: providerSnapshotId,
      },
    });
  }
);

// ── GET /mssql/chains — list backup chains (org-wide) ──

mssqlRoutes.get('/mssql/chains', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const chains = await db
    .select()
    .from(backupChains)
    .where(eq(backupChains.orgId, orgId));

  return c.json({ data: chains });
});

// ── POST /mssql/restore — trigger MSSQL restore ──

mssqlRoutes.post(
  '/mssql/restore',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', mssqlRestoreSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const payload = c.req.valid('json');

    const [device] = await db
      .select({ id: devices.id, orgId: devices.orgId })
      .from(devices)
      .where(eq(devices.id, payload.deviceId))
      .limit(1);

    if (!device || device.orgId !== orgId) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const [snapshot] = await db
      .select({
        id: backupSnapshots.id,
        providerSnapshotId: backupSnapshots.snapshotId,
        metadata: backupSnapshots.metadata,
      })
      .from(backupSnapshots)
      .where(
        and(
          eq(backupSnapshots.id, payload.snapshotId),
          eq(backupSnapshots.orgId, orgId)
        )
      )
      .limit(1);

    if (!snapshot) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }

    const metadata =
      snapshot.metadata && typeof snapshot.metadata === 'object' && !Array.isArray(snapshot.metadata)
        ? snapshot.metadata as Record<string, unknown>
        : {};
    if (metadata.backupKind !== 'mssql_database' && metadata.backupKind !== 'mssql_backup') {
      return c.json({ error: 'Snapshot is not an MSSQL backup artifact' }, 400);
    }

    const backupFileName =
      typeof metadata.backupFileName === 'string'
        ? metadata.backupFileName
        : typeof metadata.backupFile === 'string'
          ? String(metadata.backupFile).split('/').pop() ?? null
          : null;
    if (!backupFileName) {
      return c.json({ error: 'Snapshot is missing MSSQL backup file metadata' }, 400);
    }

    const result = await executeCommand(
      payload.deviceId,
      CommandTypes.MSSQL_RESTORE,
      {
        instance:
          payload.instance
          ?? (
            typeof metadata.instance === 'string'
              ? metadata.instance
              : typeof metadata.instanceName === 'string'
                ? metadata.instanceName
                : 'MSSQLSERVER'
          ),
        snapshotId: snapshot.providerSnapshotId,
        backupFileName,
        targetDatabase: payload.targetDatabase,
        noRecovery: payload.noRecovery,
      },
      { userId: auth?.user?.id, timeoutMs: 600000 }
    );

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'MSSQL restore failed' }, 500);
    }

    try {
      const data = result.stdout ? JSON.parse(result.stdout) : null;
      return c.json({ data });
    } catch {
      return c.json({ data: result.stdout });
    }
  }
);

// ── POST /mssql/verify/:snapshotId — RESTORE VERIFYONLY ──

mssqlRoutes.post(
  '/mssql/verify/:snapshotId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('param', snapshotIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { snapshotId } = c.req.valid('param');

    const [snapshot] = await db
      .select({
        id: backupSnapshots.id,
        deviceId: backupSnapshots.deviceId,
        providerSnapshotId: backupSnapshots.snapshotId,
        metadata: backupSnapshots.metadata,
      })
      .from(backupSnapshots)
      .where(
        and(
          eq(backupSnapshots.id, snapshotId),
          eq(backupSnapshots.orgId, orgId)
        )
      )
      .limit(1);

    if (!snapshot) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }

    const metadata = (snapshot.metadata ?? {}) as Record<string, unknown>;
    if (metadata.backupKind !== 'mssql_database' && metadata.backupKind !== 'mssql_backup') {
      return c.json({ error: 'Snapshot is not an MSSQL backup artifact' }, 400);
    }
    const instance =
      (metadata.instance as string)
      || (metadata.instanceName as string)
      || 'MSSQLSERVER';
    const backupFileName =
      typeof metadata.backupFileName === 'string'
        ? metadata.backupFileName
        : typeof metadata.backupFile === 'string'
          ? String(metadata.backupFile).split('/').pop() ?? null
        : null;

    if (!backupFileName) {
      return c.json(
        { error: 'Snapshot is missing MSSQL backup file metadata' },
        400
      );
    }

    const result = await executeCommand(
      snapshot.deviceId,
      CommandTypes.MSSQL_VERIFY,
      {
        instance,
        snapshotId: snapshot.providerSnapshotId,
        backupFileName,
      },
      { userId: auth?.user?.id, timeoutMs: 120000 }
    );

    if (result.status === 'failed') {
      return c.json(
        { error: result.error || 'MSSQL verify failed' },
        500
      );
    }

    try {
      const data = result.stdout ? JSON.parse(result.stdout) : null;
      return c.json({ data });
    } catch {
      return c.json({ data: result.stdout });
    }
  }
);
