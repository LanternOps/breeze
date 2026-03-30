/**
 * AI Local Vault Tools
 *
 * 4 local vault tools for listing vaults, reviewing vault sync health,
 * dispatching sync operations, and creating or updating vault configs.
 * Each tool wraps existing DB schema with org-scoped isolation.
 */

import { db } from '../db';
import { devices, localVaults } from '../db/schema';
import { eq, and, desc, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { CommandTypes, queueCommandForExecution } from './commandQueue';

type VaultHandler = (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;

// ============================================
// Helpers
// ============================================

function orgWhere(auth: AuthContext, orgIdCol: ReturnType<typeof eq> | any): SQL | undefined {
  return auth.orgCondition(orgIdCol) ?? undefined;
}

/** Wrap handler in try-catch so DB/runtime errors return JSON instead of crashing */
function safeHandler(toolName: string, fn: VaultHandler): VaultHandler {
  return async (input, auth) => {
    try {
      return await fn(input, auth);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      console.error(`[vault:${toolName}]`, message, err);
      return JSON.stringify({ error: 'Operation failed. Check server logs for details.' });
    }
  };
}

function clampLimit(value: unknown, fallback = 25, max = 100): number {
  return Math.min(Math.max(1, Number(value) || fallback), max);
}

function getOrgId(auth: AuthContext): string | null {
  return auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
}

// ============================================
// Register all vault tools into the aiTools Map
// ============================================

export function registerVaultTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // 1. query_vaults — List local vaults
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'query_vaults',
      description: 'List local vault configurations and sync status for the accessible organization scope.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Filter to a specific device UUID' },
          isActive: { type: 'boolean', description: 'Filter active or inactive vaults' },
          lastSyncStatus: { type: 'string', description: 'Filter by last sync status' },
          limit: { type: 'number', description: 'Max results (default 25, max 100)' },
        },
        required: [],
      },
    },
    handler: safeHandler('query_vaults', async (input, auth) => {
      const conditions: SQL[] = [];
      const oc = orgWhere(auth, localVaults.orgId);
      if (oc) conditions.push(oc);
      if (typeof input.deviceId === 'string') conditions.push(eq(localVaults.deviceId, input.deviceId));
      if (typeof input.isActive === 'boolean') conditions.push(eq(localVaults.isActive, input.isActive));
      if (typeof input.lastSyncStatus === 'string') conditions.push(eq(localVaults.lastSyncStatus, input.lastSyncStatus));

      const limit = clampLimit(input.limit);
      const rows = await db
        .select({
          id: localVaults.id,
          deviceId: localVaults.deviceId,
          hostname: devices.hostname,
          deviceStatus: devices.status,
          vaultPath: localVaults.vaultPath,
          vaultType: localVaults.vaultType,
          isActive: localVaults.isActive,
          retentionCount: localVaults.retentionCount,
          lastSyncAt: localVaults.lastSyncAt,
          lastSyncStatus: localVaults.lastSyncStatus,
          lastSyncSnapshotId: localVaults.lastSyncSnapshotId,
          syncSizeBytes: localVaults.syncSizeBytes,
          createdAt: localVaults.createdAt,
          updatedAt: localVaults.updatedAt,
        })
        .from(localVaults)
        .leftJoin(devices, eq(localVaults.deviceId, devices.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(localVaults.updatedAt))
        .limit(limit);

      return JSON.stringify({ vaults: rows, showing: rows.length });
    }),
  });

  // ============================================
  // 2. get_vault_status — Detailed health for a device
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_vault_status',
      description: 'Get detailed vault status for a specific device, including all configured vaults and sync summaries.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Device UUID (required)' },
        },
        required: ['deviceId'],
      },
    },
    handler: safeHandler('get_vault_status', async (input, auth) => {
      const deviceId = input.deviceId as string;
      if (!deviceId) return JSON.stringify({ error: 'deviceId is required' });

      const deviceConditions: SQL[] = [eq(devices.id, deviceId)];
      const dc = orgWhere(auth, devices.orgId);
      if (dc) deviceConditions.push(dc);
      const [device] = await db
        .select({
          id: devices.id,
          hostname: devices.hostname,
          status: devices.status,
        })
        .from(devices)
        .where(and(...deviceConditions))
        .limit(1);

      if (!device) return JSON.stringify({ error: 'Device not found or access denied' });

      const vaultConditions: SQL[] = [eq(localVaults.deviceId, deviceId)];
      const vc = orgWhere(auth, localVaults.orgId);
      if (vc) vaultConditions.push(vc);

      const vaults = await db
        .select({
          id: localVaults.id,
          vaultPath: localVaults.vaultPath,
          vaultType: localVaults.vaultType,
          isActive: localVaults.isActive,
          retentionCount: localVaults.retentionCount,
          lastSyncAt: localVaults.lastSyncAt,
          lastSyncStatus: localVaults.lastSyncStatus,
          lastSyncSnapshotId: localVaults.lastSyncSnapshotId,
          syncSizeBytes: localVaults.syncSizeBytes,
          createdAt: localVaults.createdAt,
          updatedAt: localVaults.updatedAt,
        })
        .from(localVaults)
        .where(and(...vaultConditions))
        .orderBy(desc(localVaults.updatedAt));

      const activeVaults = vaults.filter((vault) => vault.isActive).length;
      const failedSyncs = vaults.filter((vault) => vault.lastSyncStatus === 'failed').length;
      const pendingSyncs = vaults.filter((vault) => vault.lastSyncStatus === 'pending').length;
      const totalSyncBytes = vaults.reduce((sum, vault) => sum + Number(vault.syncSizeBytes ?? 0), 0);
      const latestSyncAt = vaults
        .map((vault) => vault.lastSyncAt)
        .filter((value): value is Date => value instanceof Date)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

      return JSON.stringify({
        deviceId: device.id,
        hostname: device.hostname,
        deviceStatus: device.status,
        totalVaults: vaults.length,
        activeVaults,
        pendingSyncs,
        failedSyncs,
        totalSyncBytes,
        latestSyncAt,
        vaults,
      });
    }),
  });

  // ============================================
  // 3. trigger_vault_sync — Queue sync command
  // ============================================

  registerTool({
    tier: 2,
    definition: {
      name: 'trigger_vault_sync',
      description: 'Dispatch a vault sync command for a specific local vault.',
      input_schema: {
        type: 'object' as const,
        properties: {
          vaultId: { type: 'string', description: 'Local vault UUID (required)' },
          snapshotId: { type: 'string', description: 'Optional backup snapshot identifier to sync' },
        },
        required: ['vaultId'],
      },
    },
    handler: safeHandler('trigger_vault_sync', async (input, auth) => {
      const vaultId = input.vaultId as string;
      if (!vaultId) return JSON.stringify({ error: 'vaultId is required' });

      const vaultConditions: SQL[] = [eq(localVaults.id, vaultId)];
      const vc = orgWhere(auth, localVaults.orgId);
      if (vc) vaultConditions.push(vc);
      const [vault] = await db
        .select({
          id: localVaults.id,
          deviceId: localVaults.deviceId,
          isActive: localVaults.isActive,
        })
        .from(localVaults)
        .where(and(...vaultConditions))
        .limit(1);

      if (!vault) return JSON.stringify({ error: 'Vault not found or access denied' });
      if (!vault.isActive) return JSON.stringify({ error: 'Vault is inactive' });

      await db
        .update(localVaults)
        .set({
          lastSyncStatus: 'pending',
          lastSyncSnapshotId: typeof input.snapshotId === 'string' ? input.snapshotId : null,
          updatedAt: new Date(),
        })
        .where(eq(localVaults.id, vault.id));

      const { command, error } = await queueCommandForExecution(
        vault.deviceId,
        CommandTypes.VAULT_SYNC,
        {
          vaultId: vault.id,
          snapshotId: typeof input.snapshotId === 'string' ? input.snapshotId : undefined,
        },
        { userId: auth.user?.id }
      );

      if (error) {
        await db
          .update(localVaults)
          .set({
            lastSyncStatus: 'failed',
            updatedAt: new Date(),
          })
          .where(eq(localVaults.id, vault.id));
        return JSON.stringify({ error });
      }

      return JSON.stringify({
        success: true,
        vaultId: vault.id,
        deviceId: vault.deviceId,
        commandId: command?.id,
        status: command?.status,
      });
    }),
  });

  // ============================================
  // 4. configure_vault — Create or update vault
  // ============================================

  registerTool({
    tier: 2,
    definition: {
      name: 'configure_vault',
      description: 'Create or update a local vault configuration.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'update'],
            description: 'The vault configuration action to perform',
          },
          vaultId: { type: 'string', description: 'Local vault UUID for updates' },
          deviceId: { type: 'string', description: 'Device UUID for new vaults' },
          vaultPath: { type: 'string', description: 'Vault path' },
          vaultType: {
            type: 'string',
            enum: ['local', 'smb', 'usb'],
            description: 'Vault storage type',
          },
          retentionCount: { type: 'number', description: 'Retention count to keep in the vault' },
          isActive: { type: 'boolean', description: 'Whether the vault should be active' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('configure_vault', async (input, auth) => {
      const action = input.action as string;

      if (action === 'create') {
        const deviceId = input.deviceId as string;
        const vaultPath = input.vaultPath as string;
        if (!deviceId || !vaultPath) {
          return JSON.stringify({ error: 'deviceId and vaultPath are required for create' });
        }

        const deviceConditions: SQL[] = [eq(devices.id, deviceId)];
        const dc = orgWhere(auth, devices.orgId);
        if (dc) deviceConditions.push(dc);
        const [device] = await db
          .select({
            id: devices.id,
            orgId: devices.orgId,
          })
          .from(devices)
          .where(and(...deviceConditions))
          .limit(1);

        if (!device) return JSON.stringify({ error: 'Device not found or access denied' });

        const now = new Date();
        const [vault] = await db
          .insert(localVaults)
          .values({
            orgId: device.orgId,
            deviceId,
            vaultPath,
            vaultType: (input.vaultType as string) ?? 'local',
            retentionCount: Number(input.retentionCount) || 3,
            isActive: typeof input.isActive === 'boolean' ? input.isActive : true,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        return JSON.stringify({ success: true, vault });
      }

      if (action === 'update') {
        const vaultId = input.vaultId as string;
        if (!vaultId) return JSON.stringify({ error: 'vaultId is required for update' });

        const vaultConditions: SQL[] = [eq(localVaults.id, vaultId)];
        const vc = orgWhere(auth, localVaults.orgId);
        if (vc) vaultConditions.push(vc);
        const [existing] = await db
          .select({ id: localVaults.id })
          .from(localVaults)
          .where(and(...vaultConditions))
          .limit(1);

        if (!existing) return JSON.stringify({ error: 'Vault not found or access denied' });

        const updateData: Record<string, unknown> = { updatedAt: new Date() };
        if (typeof input.vaultPath === 'string') updateData.vaultPath = input.vaultPath;
        if (typeof input.vaultType === 'string') updateData.vaultType = input.vaultType;
        if (input.retentionCount !== undefined) updateData.retentionCount = Number(input.retentionCount);
        if (typeof input.isActive === 'boolean') updateData.isActive = input.isActive;

        const [vault] = await db
          .update(localVaults)
          .set(updateData)
          .where(eq(localVaults.id, vaultId))
          .returning();

        return JSON.stringify({ success: true, vault });
      }

      const orgId = getOrgId(auth);
      if (!orgId) return JSON.stringify({ error: 'Organization context required' });
      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });
}
