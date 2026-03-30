/**
 * AI Cloud-to-Cloud Backup Tools
 *
 * 5 C2C tools for querying connections and jobs, searching protected items,
 * and triggering sync / restore operations against the internal C2C API model.
 * Each tool wraps existing DB schema with org-scoped isolation.
 */

import { db } from '../db';
import {
  c2cBackupConfigs,
  c2cBackupItems,
  c2cBackupJobs,
  c2cConnections,
} from '../db/schema';
import {
  eq,
  and,
  desc,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
  SQL,
} from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { getC2cQueue } from '../jobs/c2cBackupWorker';

type C2CHandler = (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;

// ============================================
// Helpers
// ============================================

function orgWhere(auth: AuthContext, orgIdCol: ReturnType<typeof eq> | any): SQL | undefined {
  return auth.orgCondition(orgIdCol) ?? undefined;
}

/** Wrap handler in try-catch so DB/runtime errors return JSON instead of crashing */
function safeHandler(toolName: string, fn: C2CHandler): C2CHandler {
  return async (input, auth) => {
    try {
      return await fn(input, auth);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      console.error(`[c2c:${toolName}] ${err?.constructor?.name ?? 'Error'}:`, message, err);
      return JSON.stringify({ error: 'Operation failed. Check server logs for details.' });
    }
  };
}

function clampLimit(value: unknown, fallback = 25, max = 100): number {
  return Math.min(Math.max(1, Number(value) || fallback), max);
}

// ============================================
// Register all C2C tools into the aiTools Map
// ============================================

export function registerC2CTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // 1. query_c2c_connections — List connections
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'query_c2c_connections',
      description: 'List cloud-to-cloud connections with sensitive credential fields masked.',
      input_schema: {
        type: 'object' as const,
        properties: {
          provider: { type: 'string', description: 'Filter by provider' },
          status: { type: 'string', description: 'Filter by connection status' },
          limit: { type: 'number', description: 'Max results (default 25, max 100)' },
        },
        required: [],
      },
    },
    handler: safeHandler('query_c2c_connections', async (input, auth) => {
      const conditions: SQL[] = [];
      const oc = orgWhere(auth, c2cConnections.orgId);
      if (oc) conditions.push(oc);
      if (typeof input.provider === 'string') conditions.push(eq(c2cConnections.provider, input.provider));
      if (typeof input.status === 'string') conditions.push(eq(c2cConnections.status, input.status));

      const limit = clampLimit(input.limit);
      const rows = await db
        .select({
          id: c2cConnections.id,
          provider: c2cConnections.provider,
          displayName: c2cConnections.displayName,
          tenantId: c2cConnections.tenantId,
          clientId: c2cConnections.clientId,
          hasClientSecret: sql<boolean>`${c2cConnections.clientSecret} IS NOT NULL`.as('has_client_secret'),
          hasRefreshToken: sql<boolean>`${c2cConnections.refreshToken} IS NOT NULL`.as('has_refresh_token'),
          hasAccessToken: sql<boolean>`${c2cConnections.accessToken} IS NOT NULL`.as('has_access_token'),
          tokenExpiresAt: c2cConnections.tokenExpiresAt,
          scopes: c2cConnections.scopes,
          status: c2cConnections.status,
          lastSyncAt: c2cConnections.lastSyncAt,
          createdAt: c2cConnections.createdAt,
          updatedAt: c2cConnections.updatedAt,
        })
        .from(c2cConnections)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(c2cConnections.updatedAt))
        .limit(limit);

      const connections = rows;

      return JSON.stringify({ connections, showing: connections.length });
    }),
  });

  // ============================================
  // 2. query_c2c_jobs — List backup jobs
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'query_c2c_jobs',
      description: 'List C2C backup jobs with config and provider context plus processing statistics.',
      input_schema: {
        type: 'object' as const,
        properties: {
          configId: { type: 'string', description: 'Filter to a specific C2C backup config UUID' },
          status: { type: 'string', description: 'Filter by job status' },
          from: { type: 'string', description: 'Filter jobs created at or after this ISO datetime' },
          to: { type: 'string', description: 'Filter jobs created at or before this ISO datetime' },
          limit: { type: 'number', description: 'Max results (default 25, max 100)' },
        },
        required: [],
      },
    },
    handler: safeHandler('query_c2c_jobs', async (input, auth) => {
      const conditions: SQL[] = [];
      const oc = orgWhere(auth, c2cBackupJobs.orgId);
      if (oc) conditions.push(oc);
      if (typeof input.configId === 'string') conditions.push(eq(c2cBackupJobs.configId, input.configId));
      if (typeof input.status === 'string') conditions.push(eq(c2cBackupJobs.status, input.status));

      if (typeof input.from === 'string') {
        const from = new Date(input.from);
        if (!Number.isNaN(from.getTime())) conditions.push(gte(c2cBackupJobs.createdAt, from));
      }
      if (typeof input.to === 'string') {
        const to = new Date(input.to);
        if (!Number.isNaN(to.getTime())) conditions.push(lte(c2cBackupJobs.createdAt, to));
      }

      const limit = clampLimit(input.limit);
      const jobs = await db
        .select({
          id: c2cBackupJobs.id,
          configId: c2cBackupJobs.configId,
          configName: c2cBackupConfigs.name,
          backupScope: c2cBackupConfigs.backupScope,
          connectionId: c2cBackupConfigs.connectionId,
          connectionName: c2cConnections.displayName,
          provider: c2cConnections.provider,
          status: c2cBackupJobs.status,
          startedAt: c2cBackupJobs.startedAt,
          completedAt: c2cBackupJobs.completedAt,
          itemsProcessed: c2cBackupJobs.itemsProcessed,
          itemsNew: c2cBackupJobs.itemsNew,
          itemsUpdated: c2cBackupJobs.itemsUpdated,
          itemsDeleted: c2cBackupJobs.itemsDeleted,
          bytesTransferred: c2cBackupJobs.bytesTransferred,
          errorLog: c2cBackupJobs.errorLog,
          createdAt: c2cBackupJobs.createdAt,
          updatedAt: c2cBackupJobs.updatedAt,
        })
        .from(c2cBackupJobs)
        .leftJoin(c2cBackupConfigs, eq(c2cBackupJobs.configId, c2cBackupConfigs.id))
        .leftJoin(c2cConnections, eq(c2cBackupConfigs.connectionId, c2cConnections.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(c2cBackupJobs.createdAt))
        .limit(limit);

      return JSON.stringify({ jobs, showing: jobs.length });
    }),
  });

  // ============================================
  // 3. search_c2c_items — Search protected items
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'search_c2c_items',
      description: 'Search cloud-to-cloud backup items by config, user, item type, or keyword.',
      input_schema: {
        type: 'object' as const,
        properties: {
          configId: { type: 'string', description: 'Filter to a specific config UUID' },
          userEmail: { type: 'string', description: 'Filter to a specific user email' },
          itemType: { type: 'string', description: 'Filter by item type' },
          keyword: { type: 'string', description: 'Search across item subject/name, parent path, and external ID' },
          includeDeleted: { type: 'boolean', description: 'Include deleted items in search results' },
          limit: { type: 'number', description: 'Max results (default 25, max 100)' },
          offset: { type: 'number', description: 'Pagination offset (default 0)' },
        },
        required: [],
      },
    },
    handler: safeHandler('search_c2c_items', async (input, auth) => {
      const conditions: SQL[] = [];
      const oc = orgWhere(auth, c2cBackupItems.orgId);
      if (oc) conditions.push(oc);
      if (typeof input.configId === 'string') conditions.push(eq(c2cBackupItems.configId, input.configId));
      if (typeof input.userEmail === 'string') conditions.push(eq(c2cBackupItems.userEmail, input.userEmail));
      if (typeof input.itemType === 'string') conditions.push(eq(c2cBackupItems.itemType, input.itemType));
      if (input.includeDeleted !== true) conditions.push(eq(c2cBackupItems.isDeleted, false));

      if (typeof input.keyword === 'string' && input.keyword.trim().length > 0) {
        const keyword = `%${input.keyword.trim()}%`;
        conditions.push(
          or(
            ilike(c2cBackupItems.subjectOrName, keyword),
            ilike(c2cBackupItems.parentPath, keyword),
            ilike(c2cBackupItems.externalId, keyword)
          ) as SQL
        );
      }

      const limit = clampLimit(input.limit);
      const offset = Math.max(0, Number(input.offset) || 0);
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, countResult] = await Promise.all([
        db
          .select({
            id: c2cBackupItems.id,
            configId: c2cBackupItems.configId,
            configName: c2cBackupConfigs.name,
            jobId: c2cBackupItems.jobId,
            itemType: c2cBackupItems.itemType,
            externalId: c2cBackupItems.externalId,
            userEmail: c2cBackupItems.userEmail,
            subjectOrName: c2cBackupItems.subjectOrName,
            parentPath: c2cBackupItems.parentPath,
            storagePath: c2cBackupItems.storagePath,
            sizeBytes: c2cBackupItems.sizeBytes,
            itemDate: c2cBackupItems.itemDate,
            isDeleted: c2cBackupItems.isDeleted,
            metadata: c2cBackupItems.metadata,
            createdAt: c2cBackupItems.createdAt,
            updatedAt: c2cBackupItems.updatedAt,
          })
          .from(c2cBackupItems)
          .leftJoin(c2cBackupConfigs, eq(c2cBackupItems.configId, c2cBackupConfigs.id))
          .where(whereClause)
          .orderBy(desc(c2cBackupItems.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(c2cBackupItems)
          .where(whereClause)
          .then((result) => result[0]?.count ?? 0),
      ]);

      return JSON.stringify({
        items: rows,
        total: countResult,
        limit,
        offset,
      });
    }),
  });

  // ============================================
  // 4. trigger_c2c_sync — Queue sync job
  // ============================================

  registerTool({
    tier: 2,
    definition: {
      name: 'trigger_c2c_sync',
      description: 'Trigger an immediate cloud-to-cloud sync job for a C2C backup config.',
      input_schema: {
        type: 'object' as const,
        properties: {
          configId: { type: 'string', description: 'C2C backup config UUID (required)' },
        },
        required: ['configId'],
      },
    },
    handler: safeHandler('trigger_c2c_sync', async (input, auth) => {
      const configId = input.configId as string;
      if (!configId) return JSON.stringify({ error: 'configId is required' });

      const configConditions: SQL[] = [eq(c2cBackupConfigs.id, configId)];
      const cc = orgWhere(auth, c2cBackupConfigs.orgId);
      if (cc) configConditions.push(cc);
      const [config] = await db
        .select({
          id: c2cBackupConfigs.id,
          orgId: c2cBackupConfigs.orgId,
          name: c2cBackupConfigs.name,
        })
        .from(c2cBackupConfigs)
        .where(and(...configConditions))
        .limit(1);

      if (!config) return JSON.stringify({ error: 'Config not found or access denied' });

      const now = new Date();
      const [job] = await db
        .insert(c2cBackupJobs)
        .values({
          orgId: config.orgId,
          configId: config.id,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      if (!job) return JSON.stringify({ error: 'Failed to create C2C sync job' });

      const queue = getC2cQueue();
      await queue.add('run-sync', {
        type: 'run-sync' as const,
        jobId: job.id,
        configId: config.id,
        orgId: config.orgId,
      });

      return JSON.stringify({
        success: true,
        jobId: job.id,
        status: job.status,
        configId: config.id,
        configName: config.name,
      });
    }),
  });

  // ============================================
  // 5. restore_c2c_items — Queue restore job
  // ============================================

  registerTool({
    tier: 3,
    definition: {
      name: 'restore_c2c_items',
      description: 'Trigger a cloud-to-cloud item restore job for one or more protected items.',
      input_schema: {
        type: 'object' as const,
        properties: {
          itemIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of C2C item UUIDs to restore (required)',
          },
          targetConnectionId: { type: 'string', description: 'Optional target connection UUID for restore destination' },
        },
        required: ['itemIds'],
      },
    },
    handler: safeHandler('restore_c2c_items', async (input, auth) => {
      const itemIds = Array.isArray(input.itemIds) ? input.itemIds.filter((value): value is string => typeof value === 'string') : [];
      if (itemIds.length === 0) return JSON.stringify({ error: 'itemIds is required' });

      if (typeof input.targetConnectionId === 'string') {
        const connectionConditions: SQL[] = [eq(c2cConnections.id, input.targetConnectionId)];
        const cc = orgWhere(auth, c2cConnections.orgId);
        if (cc) connectionConditions.push(cc);
        const [connection] = await db
          .select({ id: c2cConnections.id })
          .from(c2cConnections)
          .where(and(...connectionConditions))
          .limit(1);
        if (!connection) return JSON.stringify({ error: 'Target connection not found or access denied' });
      }

      const itemConditions: SQL[] = [inArray(c2cBackupItems.id, itemIds)];
      const ic = orgWhere(auth, c2cBackupItems.orgId);
      if (ic) itemConditions.push(ic);
      const items = await db
        .select({
          id: c2cBackupItems.id,
          orgId: c2cBackupItems.orgId,
          configId: c2cBackupItems.configId,
        })
        .from(c2cBackupItems)
        .where(and(...itemConditions));

      if (items.length === 0) return JSON.stringify({ error: 'No matching items found' });
      if (items.length !== itemIds.length) return JSON.stringify({ error: 'One or more items were not found or access was denied' });

      const configIds = new Set(items.map((item) => item.configId));
      if (configIds.size > 1) {
        return JSON.stringify({ error: 'All items must belong to the same C2C backup configuration' });
      }

      const now = new Date();
      const [restoreJob] = await db
        .insert(c2cBackupJobs)
        .values({
          orgId: items[0]!.orgId,
          configId: items[0]!.configId,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      if (!restoreJob) return JSON.stringify({ error: 'Failed to create C2C restore job' });

      const queue = getC2cQueue();
      await queue.add('process-restore', {
        type: 'process-restore' as const,
        restoreJobId: restoreJob.id,
        orgId: items[0]!.orgId,
        itemIds,
        targetConnectionId: typeof input.targetConnectionId === 'string' ? input.targetConnectionId : null,
      });

      return JSON.stringify({
        success: true,
        restoreJobId: restoreJob.id,
        status: restoreJob.status,
        itemCount: itemIds.length,
      });
    }),
  });
}
