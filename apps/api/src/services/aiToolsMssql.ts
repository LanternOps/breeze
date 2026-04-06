/**
 * AI MSSQL Backup Tools
 *
 * 5 MSSQL-focused tools for listing discovered instances, reviewing backup
 * chain health, and dispatching backup / restore / verify operations.
 * Each tool wraps existing DB schema with org-scoped isolation.
 */

import { db } from '../db';
import {
  backupChains,
  backupConfigs,
  backupJobs,
  backupSnapshots,
  devices,
  sqlInstances,
} from '../db/schema';
import { eq, and, desc, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { CommandTypes, queueCommandForExecution } from './commandQueue';
import { resolveBackupConfigForDevice } from './featureConfigResolver';

type MssqlHandler = (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;

const sqlIdentifierPattern = /^[a-zA-Z0-9_\-. ]+$/;

// ============================================
// Helpers
// ============================================

function orgWhere(auth: AuthContext, orgIdCol: ReturnType<typeof eq> | any): SQL | undefined {
  return auth.orgCondition(orgIdCol) ?? undefined;
}

/** Wrap handler in try-catch so DB/runtime errors return JSON instead of crashing */
function safeHandler(toolName: string, fn: MssqlHandler): MssqlHandler {
  return async (input, auth) => {
    try {
      return await fn(input, auth);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      console.error(`[mssql:${toolName}] ${err?.constructor?.name ?? 'Error'}:`, message, err);
      return JSON.stringify({ error: 'Operation failed. Check server logs for details.' });
    }
  };
}

function clampLimit(value: unknown, fallback = 25, max = 100): number {
  return Math.min(Math.max(1, Number(value) || fallback), max);
}

function isValidSqlIdentifier(value: unknown): value is string {
  return typeof value === 'string' && sqlIdentifierPattern.test(value) && value.trim().length > 0;
}

// ============================================
// Register all MSSQL tools into the aiTools Map
// ============================================

export function registerMssqlTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // 1. query_mssql_instances — List discovered SQL instances
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'query_mssql_instances',
      description: 'List discovered SQL Server instances and their databases for the accessible organization scope.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Filter to a specific device UUID' },
          status: { type: 'string', description: 'Filter by instance discovery status' },
          limit: { type: 'number', description: 'Max results (default 25, max 100)' },
        },
        required: [],
      },
    },
    handler: safeHandler('query_mssql_instances', async (input, auth) => {
      const conditions: SQL[] = [];
      const oc = orgWhere(auth, sqlInstances.orgId);
      if (oc) conditions.push(oc);
      if (typeof input.deviceId === 'string') conditions.push(eq(sqlInstances.deviceId, input.deviceId));
      if (typeof input.status === 'string') conditions.push(eq(sqlInstances.status, input.status));

      const limit = clampLimit(input.limit);
      const rows = await db
        .select({
          id: sqlInstances.id,
          deviceId: sqlInstances.deviceId,
          hostname: devices.hostname,
          instanceName: sqlInstances.instanceName,
          version: sqlInstances.version,
          edition: sqlInstances.edition,
          port: sqlInstances.port,
          authType: sqlInstances.authType,
          status: sqlInstances.status,
          databases: sqlInstances.databases,
          lastDiscoveredAt: sqlInstances.lastDiscoveredAt,
          createdAt: sqlInstances.createdAt,
          updatedAt: sqlInstances.updatedAt,
        })
        .from(sqlInstances)
        .leftJoin(devices, eq(sqlInstances.deviceId, devices.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(sqlInstances.updatedAt))
        .limit(limit);

      const instances = rows.map((row) => ({
        ...row,
        databases: Array.isArray(row.databases) ? row.databases : [],
        databaseCount: Array.isArray(row.databases) ? row.databases.length : 0,
      }));

      return JSON.stringify({ instances, showing: instances.length });
    }),
  });

  // ============================================
  // 2. get_mssql_backup_status — Chain health per database
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_mssql_backup_status',
      description: 'Get MSSQL backup chain status by database, including active chain metadata and latest full snapshot context.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Filter to a specific device UUID' },
          database: { type: 'string', description: 'Filter to a specific target database name' },
          limit: { type: 'number', description: 'Max results (default 25, max 100)' },
        },
        required: [],
      },
    },
    handler: safeHandler('get_mssql_backup_status', async (input, auth) => {
      const conditions: SQL[] = [eq(backupChains.chainType, 'mssql')];
      const oc = orgWhere(auth, backupChains.orgId);
      if (oc) conditions.push(oc);
      if (typeof input.deviceId === 'string') conditions.push(eq(backupChains.deviceId, input.deviceId));
      if (typeof input.database === 'string') conditions.push(eq(backupChains.targetName, input.database));

      const limit = clampLimit(input.limit);
      const rows = await db
        .select({
          id: backupChains.id,
          deviceId: backupChains.deviceId,
          hostname: devices.hostname,
          configId: backupChains.configId,
          configName: backupConfigs.name,
          targetName: backupChains.targetName,
          targetId: backupChains.targetId,
          isActive: backupChains.isActive,
          fullSnapshotId: backupChains.fullSnapshotId,
          fullSnapshotLabel: backupSnapshots.label,
          fullSnapshotTimestamp: backupSnapshots.timestamp,
          chainMetadata: backupChains.chainMetadata,
          createdAt: backupChains.createdAt,
          updatedAt: backupChains.updatedAt,
        })
        .from(backupChains)
        .leftJoin(devices, eq(backupChains.deviceId, devices.id))
        .leftJoin(backupConfigs, eq(backupChains.configId, backupConfigs.id))
        .leftJoin(backupSnapshots, eq(backupChains.fullSnapshotId, backupSnapshots.id))
        .where(and(...conditions))
        .orderBy(desc(backupChains.updatedAt))
        .limit(limit);

      const chains = rows.map((row) => {
        const metadata = (row.chainMetadata ?? {}) as Record<string, unknown>;
        return {
          id: row.id,
          deviceId: row.deviceId,
          hostname: row.hostname,
          configId: row.configId,
          configName: row.configName,
          database: row.targetName,
          targetId: row.targetId,
          isActive: row.isActive,
          chainHealth:
            typeof metadata.health === 'string'
              ? metadata.health
              : row.isActive
                ? 'active'
                : 'inactive',
          lastBackupAt:
            typeof metadata.lastBackupAt === 'string'
              ? metadata.lastBackupAt
              : row.fullSnapshotTimestamp,
          fullSnapshot: row.fullSnapshotId
            ? {
                id: row.fullSnapshotId,
                label: row.fullSnapshotLabel,
                timestamp: row.fullSnapshotTimestamp,
              }
            : null,
          metadata,
          updatedAt: row.updatedAt,
        };
      });

      return JSON.stringify({ chains, showing: chains.length });
    }),
  });

  // ============================================
  // 3. trigger_mssql_backup — Queue MSSQL backup command
  // ============================================

  registerTool({
    tier: 3,
    definition: {
      name: 'trigger_mssql_backup',
      description: 'Dispatch an MSSQL backup command to a device for a specific instance and database.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Device UUID (required)' },
          instance: { type: 'string', description: 'SQL instance name (required)' },
          database: { type: 'string', description: 'Database name (required)' },
          backupType: {
            type: 'string',
            enum: ['full', 'differential', 'log'],
            description: 'Backup type to run',
          },
        },
        required: ['deviceId', 'instance', 'database'],
      },
    },
    handler: safeHandler('trigger_mssql_backup', async (input, auth) => {
      const deviceId = input.deviceId as string;
      const instance = input.instance as string;
      const database = input.database as string;
      const backupType = (input.backupType as string) ?? 'full';

      if (!deviceId || !instance || !database) {
        return JSON.stringify({ error: 'deviceId, instance, and database are required' });
      }
      if (!isValidSqlIdentifier(instance) || !isValidSqlIdentifier(database)) {
        return JSON.stringify({ error: 'instance and database contain invalid characters' });
      }

      const deviceConditions: SQL[] = [eq(devices.id, deviceId)];
      const dc = orgWhere(auth, devices.orgId);
      if (dc) deviceConditions.push(dc);
      const [device] = await db
        .select({ id: devices.id, orgId: devices.orgId })
        .from(devices)
        .where(and(...deviceConditions))
        .limit(1);
      if (!device) return JSON.stringify({ error: 'Device not found or access denied' });

      const resolvedConfig = await resolveBackupConfigForDevice(deviceId);
      if (!resolvedConfig?.configId) {
        return JSON.stringify({ error: 'A provider-backed backup configuration is required on this device' });
      }

      const [backupJob] = await db
        .insert(backupJobs)
        .values({
          orgId: device.orgId,
          configId: resolvedConfig.configId,
          featureLinkId: resolvedConfig.featureLinkId,
          deviceId,
          status: 'pending',
          type: 'manual',
          backupType: 'database',
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning({ id: backupJobs.id });

      const { command, error } = await queueCommandForExecution(
        deviceId,
        CommandTypes.MSSQL_BACKUP,
        {
          backupJobId: backupJob?.id,
          instance,
          database,
          backupType,
        },
        { userId: auth.user?.id }
      );

      if (error) {
        if (backupJob?.id) {
          await db
            .update(backupJobs)
            .set({
              status: 'failed',
              completedAt: new Date(),
              updatedAt: new Date(),
              errorLog: error,
            })
            .where(eq(backupJobs.id, backupJob.id));
        }
        return JSON.stringify({ error });
      }

      return JSON.stringify({
        success: true,
        commandId: command?.id,
        backupJobId: backupJob?.id,
        status: command?.status,
        deviceId,
        instance,
        database,
        backupType,
      });
    }),
  });

  // ============================================
  // 4. restore_mssql_database — Queue MSSQL restore command
  // ============================================

  registerTool({
    tier: 3,
    definition: {
      name: 'restore_mssql_database',
      description: 'Dispatch an MSSQL restore command to a device.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Device UUID (required)' },
          snapshotId: { type: 'string', description: 'Backup snapshot UUID (required)' },
          instance: { type: 'string', description: 'Optional SQL instance name override' },
          targetDatabase: { type: 'string', description: 'Target database name (required)' },
          noRecovery: { type: 'boolean', description: 'Leave database in restoring state after restore' },
        },
        required: ['deviceId', 'snapshotId', 'targetDatabase'],
      },
    },
    handler: safeHandler('restore_mssql_database', async (input, auth) => {
      const deviceId = input.deviceId as string;
      const snapshotId = input.snapshotId as string;
      const targetDatabase = input.targetDatabase as string;

      if (!deviceId || !snapshotId || !targetDatabase) {
        return JSON.stringify({ error: 'deviceId, snapshotId, and targetDatabase are required' });
      }
      const instanceOverride =
        typeof input.instance === 'string' ? input.instance : '';
      if (
        (instanceOverride && !isValidSqlIdentifier(instanceOverride))
        || !isValidSqlIdentifier(targetDatabase)
      ) {
        return JSON.stringify({ error: 'instance and targetDatabase contain invalid characters' });
      }

      const deviceConditions: SQL[] = [eq(devices.id, deviceId)];
      const dc = orgWhere(auth, devices.orgId);
      if (dc) deviceConditions.push(dc);
      const [device] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(...deviceConditions))
        .limit(1);
      if (!device) return JSON.stringify({ error: 'Device not found or access denied' });

      const snapshotConditions: SQL[] = [eq(backupSnapshots.id, snapshotId)];
      const sc = orgWhere(auth, backupSnapshots.orgId);
      if (sc) snapshotConditions.push(sc);
      const [snapshot] = await db
        .select({
          id: backupSnapshots.id,
          providerSnapshotId: backupSnapshots.snapshotId,
          metadata: backupSnapshots.metadata,
        })
        .from(backupSnapshots)
        .where(and(...snapshotConditions))
        .limit(1);
      if (!snapshot) return JSON.stringify({ error: 'Snapshot not found or access denied' });

      const metadata =
        snapshot.metadata && typeof snapshot.metadata === 'object' && !Array.isArray(snapshot.metadata)
          ? snapshot.metadata as Record<string, unknown>
          : {};
      if (metadata.backupKind !== 'mssql_database' && metadata.backupKind !== 'mssql_backup') {
        return JSON.stringify({ error: 'Snapshot is not an MSSQL backup artifact' });
      }
      const backupFileName =
        typeof metadata.backupFileName === 'string'
          ? metadata.backupFileName
          : typeof metadata.backupFile === 'string'
            ? String(metadata.backupFile).split('/').pop() ?? ''
          : '';
      if (!backupFileName) {
        return JSON.stringify({ error: 'Snapshot is missing MSSQL backup file metadata' });
      }

      const { command, error } = await queueCommandForExecution(
        deviceId,
        CommandTypes.MSSQL_RESTORE,
        {
          instance:
            instanceOverride
            || (
              typeof metadata.instance === 'string'
                ? metadata.instance
                : typeof metadata.instanceName === 'string'
                  ? metadata.instanceName
                  : 'MSSQLSERVER'
            ),
          snapshotId: snapshot.providerSnapshotId,
          backupFileName,
          targetDatabase,
          noRecovery: Boolean(input.noRecovery),
        },
        { userId: auth.user?.id }
      );

      if (error) return JSON.stringify({ error });

      return JSON.stringify({
        success: true,
        commandId: command?.id,
        status: command?.status,
        deviceId,
        snapshotId: snapshot.id,
        providerSnapshotId: snapshot.providerSnapshotId,
        targetDatabase,
      });
    }),
  });

  // ============================================
  // 5. verify_mssql_backup — Queue verify command
  // ============================================

  registerTool({
    tier: 2,
    definition: {
      name: 'verify_mssql_backup',
      description: 'Dispatch an MSSQL backup verification command for a provider-backed MSSQL snapshot.',
      input_schema: {
        type: 'object' as const,
        properties: {
          snapshotId: { type: 'string', description: 'Backup snapshot UUID to verify (required)' },
          instance: { type: 'string', description: 'Optional SQL instance name override' },
        },
        required: ['snapshotId'],
      },
    },
    handler: safeHandler('verify_mssql_backup', async (input, auth) => {
      const snapshotId = input.snapshotId as string;
      if (!snapshotId) return JSON.stringify({ error: 'snapshotId is required' });
      const instanceOverride =
        typeof input.instance === 'string' ? input.instance : '';
      if (instanceOverride && !isValidSqlIdentifier(instanceOverride)) {
        return JSON.stringify({ error: 'instance contains invalid characters' });
      }

      const snapshotConditions: SQL[] = [eq(backupSnapshots.id, snapshotId)];
      const sc = orgWhere(auth, backupSnapshots.orgId);
      if (sc) snapshotConditions.push(sc);
      const [snapshot] = await db
        .select({
          id: backupSnapshots.id,
          deviceId: backupSnapshots.deviceId,
          providerSnapshotId: backupSnapshots.snapshotId,
          metadata: backupSnapshots.metadata,
        })
        .from(backupSnapshots)
        .where(and(...snapshotConditions))
        .limit(1);
      if (!snapshot) return JSON.stringify({ error: 'Snapshot not found or access denied' });

      const metadata =
        snapshot.metadata && typeof snapshot.metadata === 'object' && !Array.isArray(snapshot.metadata)
          ? snapshot.metadata as Record<string, unknown>
          : {};
      if (metadata.backupKind !== 'mssql_database' && metadata.backupKind !== 'mssql_backup') {
        return JSON.stringify({ error: 'Snapshot is not an MSSQL backup artifact' });
      }
      const backupFileName =
        typeof metadata.backupFileName === 'string'
          ? metadata.backupFileName
          : typeof metadata.backupFile === 'string'
            ? String(metadata.backupFile).split('/').pop() ?? ''
          : '';
      if (!backupFileName) {
        return JSON.stringify({ error: 'Snapshot is missing MSSQL backup file metadata' });
      }

      const { command, error } = await queueCommandForExecution(
        snapshot.deviceId,
        CommandTypes.MSSQL_VERIFY,
        {
          instance:
            instanceOverride
            || (
              typeof metadata.instance === 'string'
                ? metadata.instance
                : typeof metadata.instanceName === 'string'
                  ? metadata.instanceName
                  : 'MSSQLSERVER'
            ),
          snapshotId: snapshot.providerSnapshotId,
          backupFileName,
        },
        { userId: auth.user?.id }
      );

      if (error) return JSON.stringify({ error });

      return JSON.stringify({
        success: true,
        commandId: command?.id,
        status: command?.status,
        deviceId: snapshot.deviceId,
        snapshotId: snapshot.id,
        providerSnapshotId: snapshot.providerSnapshotId,
      });
    }),
  });
}
