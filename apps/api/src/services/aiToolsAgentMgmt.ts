/**
 * AI Agent Management Tools
 *
 * Tools for managing agent versions and upgrades.
 * - query_agent_versions (Tier 1): List available agent versions and check upgrades
 * - trigger_agent_upgrade (Tier 3): Queue an agent upgrade for devices
 */

import { db } from '../db';
import { devices, agentVersions } from '../db/schema';
import { eq, ne, and, desc, sql, inArray, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

type AiToolTier = 1 | 2 | 3 | 4;

async function verifyDeviceAccess(
  deviceId: string,
  auth: AuthContext,
  requireOnline = false
): Promise<{ device: typeof devices.$inferSelect } | { error: string }> {
  const conditions: SQL[] = [eq(devices.id, deviceId)];
  const orgCond = auth.orgCondition(devices.orgId);
  if (orgCond) conditions.push(orgCond);
  const [device] = await db.select().from(devices).where(and(...conditions)).limit(1);
  if (!device) return { error: 'Device not found or access denied' };
  if (requireOnline && device.status !== 'online') return { error: `Device ${device.hostname} is not online (status: ${device.status})` };
  return { device };
}

let _commandQueue: typeof import('./commandQueue') | null = null;
async function getCommandQueue() {
  if (!_commandQueue) _commandQueue = await import('./commandQueue');
  return _commandQueue;
}

export function registerAgentMgmtTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // query_agent_versions - Tier 1 (auto-execute)
  // ============================================

  registerTool({
    tier: 1 as AiToolTier,
    definition: {
      name: 'query_agent_versions',
      description: 'List available agent versions and check which devices need upgrades.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['list_versions', 'check_upgrades'],
            description: 'Action to perform',
          },
          platform: {
            type: 'string',
            description: 'Filter by platform (windows, macos, linux) — only for list_versions',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 25, max 50)',
          },
        },
        required: ['action'],
      },
    },
    handler: async (input, auth) => {
      const action = input.action as string;
      const limit = Math.min((input.limit as number) || 25, 50);

      if (action === 'list_versions') {
        const conditions: SQL[] = [];
        if (input.platform) {
          conditions.push(eq(agentVersions.platform, input.platform as string));
        }

        const versions = await db
          .select({
            version: agentVersions.version,
            platform: agentVersions.platform,
            architecture: agentVersions.architecture,
            isLatest: agentVersions.isLatest,
            fileSize: agentVersions.fileSize,
            releaseNotes: agentVersions.releaseNotes,
            createdAt: agentVersions.createdAt,
          })
          .from(agentVersions)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(agentVersions.createdAt))
          .limit(limit);

        return JSON.stringify({ versions, total: versions.length });
      }

      if (action === 'check_upgrades') {
        // Get the latest agent version
        const [latest] = await db
          .select({ version: agentVersions.version })
          .from(agentVersions)
          .where(eq(agentVersions.isLatest, true))
          .limit(1);

        if (!latest) {
          return JSON.stringify({ error: 'No latest agent version found' });
        }

        // Find devices in org with a different agent version
        const conditions: SQL[] = [ne(devices.agentVersion, latest.version)];
        const orgCond = auth.orgCondition(devices.orgId);
        if (orgCond) conditions.push(orgCond);

        const outdated = await db
          .select({
            currentVersion: devices.agentVersion,
            count: sql<number>`count(*)::int`,
          })
          .from(devices)
          .where(and(...conditions))
          .groupBy(devices.agentVersion)
          .orderBy(desc(sql<number>`count(*)`));

        const totalOutdated = outdated.reduce((sum, row) => sum + row.count, 0);

        return JSON.stringify({
          latestVersion: latest.version,
          totalOutdated,
          byVersion: outdated,
        });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    },
  });

  // ============================================
  // trigger_agent_upgrade - Tier 3 (requires approval)
  // ============================================

  registerTool({
    tier: 3 as AiToolTier,
    definition: {
      name: 'trigger_agent_upgrade',
      description: 'Queue an agent upgrade for a device or group of devices.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Device UUIDs to upgrade (max 50)',
          },
          targetVersion: {
            type: 'string',
            description: 'Target agent version (defaults to latest if not specified)',
          },
        },
        required: ['deviceIds'],
      },
    },
    handler: async (input, auth) => {
      const deviceIds = (input.deviceIds as string[]).slice(0, 50);
      if (deviceIds.length === 0) {
        return JSON.stringify({ error: 'deviceIds array is required and must not be empty' });
      }

      // Verify access to the first device
      const firstAccess = await verifyDeviceAccess(deviceIds[0]!, auth);
      if ('error' in firstAccess) return JSON.stringify({ error: firstAccess.error });

      // Verify all deviceIds belong to the org
      const orgCond = auth.orgCondition(devices.orgId);
      const accessConditions: SQL[] = [inArray(devices.id, deviceIds)];
      if (orgCond) accessConditions.push(orgCond);

      const accessibleDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(...accessConditions));

      const accessibleIds = new Set(accessibleDevices.map(d => d.id));
      const deniedIds = deviceIds.filter(id => !accessibleIds.has(id));
      if (deniedIds.length > 0) {
        return JSON.stringify({ error: `Access denied for devices: ${deniedIds.join(', ')}` });
      }

      // Resolve target version
      let targetVersion = input.targetVersion as string | undefined;
      if (!targetVersion) {
        const [latest] = await db
          .select({ version: agentVersions.version })
          .from(agentVersions)
          .where(eq(agentVersions.isLatest, true))
          .limit(1);

        if (!latest) {
          return JSON.stringify({ error: 'No latest agent version found' });
        }
        targetVersion = latest.version;
      } else {
        // Verify the specified version exists
        const [versionRow] = await db
          .select({ version: agentVersions.version })
          .from(agentVersions)
          .where(eq(agentVersions.version, targetVersion))
          .limit(1);

        if (!versionRow) {
          return JSON.stringify({ error: `Agent version "${targetVersion}" not found` });
        }
      }

      // Dispatch upgrade commands
      const { executeCommand } = await getCommandQueue();
      let queued = 0;
      const errors: Record<string, string> = {};

      for (const deviceId of deviceIds) {
        try {
          await executeCommand(deviceId, 'agent_upgrade', {
            targetVersion,
          }, { userId: auth.user.id, timeoutMs: 60000 });
          queued++;
        } catch (err) {
          errors[deviceId] = err instanceof Error ? err.message : 'Failed to queue upgrade';
        }
      }

      return JSON.stringify({
        queued,
        targetVersion,
        ...(Object.keys(errors).length > 0 ? { errors } : {}),
      });
    },
  });
}
