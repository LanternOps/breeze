/**
 * AI Agent Log Tools
 *
 * Tools for searching agent diagnostic logs and controlling log levels.
 * - search_agent_logs (Tier 1): Query logs across fleet with filters
 * - set_agent_log_level (Tier 2): Temporarily adjust agent log verbosity
 */

import { db } from '../db';
import { agentLogs, devices } from '../db/schema';
import { and, eq, gte, lte, ilike, inArray, desc } from 'drizzle-orm';
import { escapeLike } from '../utils/sql';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

type AiToolTier = 1 | 2 | 3 | 4;

function getOrgId(auth: AuthContext): string | null {
  return auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
}

export function registerAgentLogTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // 1. search_agent_logs — Query agent diagnostic logs
  // ============================================

  registerTool({
    tier: 1 as AiToolTier,
    definition: {
      name: 'search_agent_logs',
      description:
        'Search agent diagnostic logs across the fleet. Filter by device, log level, component, time range, or message text. Returns matching log entries ordered by timestamp (newest first).',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filter by specific device UUIDs',
          },
          level: {
            type: 'string',
            enum: ['debug', 'info', 'warn', 'error'],
            description: 'Filter by log level',
          },
          component: {
            type: 'string',
            description: 'Filter by component name (e.g., "heartbeat", "websocket", "main")',
          },
          startTime: {
            type: 'string',
            description: 'ISO datetime - only return logs after this time',
          },
          endTime: {
            type: 'string',
            description: 'ISO datetime - only return logs before this time',
          },
          message: {
            type: 'string',
            description: 'Text search within log messages (case-insensitive partial match)',
          },
          limit: {
            type: 'number',
            description: 'Maximum results to return (default: 100, max: 500)',
          },
        },
        required: [],
      },
    },
    handler: async (input: Record<string, unknown>, auth: AuthContext) => {
      try {
        const orgId = getOrgId(auth);
        if (!orgId) {
          return JSON.stringify({ error: 'No organization context available' });
        }

        const filters = [eq(agentLogs.orgId, orgId)];

        if (input.deviceIds && Array.isArray(input.deviceIds) && input.deviceIds.length > 0) {
          filters.push(inArray(agentLogs.deviceId, input.deviceIds as string[]));
        }
        if (input.level && typeof input.level === 'string') {
          filters.push(eq(agentLogs.level, input.level as any));
        }
        if (input.component && typeof input.component === 'string') {
          filters.push(eq(agentLogs.component, input.component as string));
        }
        if (input.startTime && typeof input.startTime === 'string') {
          filters.push(gte(agentLogs.timestamp, new Date(input.startTime as string)));
        }
        if (input.endTime && typeof input.endTime === 'string') {
          filters.push(lte(agentLogs.timestamp, new Date(input.endTime as string)));
        }
        if (input.message && typeof input.message === 'string') {
          filters.push(ilike(agentLogs.message, `%${escapeLike(input.message)}%`));
        }

        const maxLimit = Math.min(Number(input.limit) || 100, 500);

        const results = await db
          .select()
          .from(agentLogs)
          .where(and(...filters))
          .orderBy(desc(agentLogs.timestamp))
          .limit(maxLimit);

        return JSON.stringify({
          logs: results.map((r) => ({
            id: r.id,
            deviceId: r.deviceId,
            timestamp: r.timestamp.toISOString(),
            level: r.level,
            component: r.component,
            message: r.message,
            fields: r.fields,
            agentVersion: r.agentVersion,
          })),
          count: results.length,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error';
        console.error('[ai:search_agent_logs]', message, err);
        return JSON.stringify({ error: `Search failed: ${message}` });
      }
    },
  });

  // ============================================
  // 2. set_agent_log_level — Adjust log shipping verbosity
  // ============================================

  registerTool({
    tier: 2 as AiToolTier,
    definition: {
      name: 'set_agent_log_level',
      description:
        "Temporarily increase an agent's log shipping verbosity for debugging. The level will auto-revert after the specified duration. Requires approval.",
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: {
            type: 'string',
            description: 'The device UUID to adjust',
          },
          level: {
            type: 'string',
            enum: ['debug', 'info', 'warn', 'error'],
            description: 'The new minimum log level to ship',
          },
          durationMinutes: {
            type: 'number',
            description: 'Auto-revert after this many minutes (default: 60)',
          },
        },
        required: ['deviceId', 'level'],
      },
    },
    handler: async (input: Record<string, unknown>, auth: AuthContext) => {
      try {
        const orgId = getOrgId(auth);
        if (!orgId) {
          return JSON.stringify({ error: 'No organization context available' });
        }

        const deviceId = input.deviceId as string;
        const level = input.level as string;
        const durationMinutes = Number(input.durationMinutes) || 60;

        if (!deviceId || !level) {
          return JSON.stringify({ error: 'deviceId and level are required' });
        }

        // Verify device belongs to the caller's organization
        const [device] = await db
          .select({ id: devices.id })
          .from(devices)
          .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
          .limit(1);

        if (!device) {
          return JSON.stringify({ error: 'Device not found or access denied' });
        }

        const { queueCommandForExecution } = await import('./commandQueue');

        const result = await queueCommandForExecution(deviceId, 'set_log_level', {
          level,
          durationMinutes,
        }, {
          userId: auth.user.id,
        });

        if (result.error) {
          return JSON.stringify({ error: result.error });
        }

        return JSON.stringify({
          commandId: result.command?.id ?? null,
          status: 'queued',
          message: `Log level will be set to ${level} for ${durationMinutes} minutes`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error';
        console.error('[ai:set_agent_log_level]', message, err);
        return JSON.stringify({ error: `Failed to set log level: ${message}` });
      }
    },
  });
}
