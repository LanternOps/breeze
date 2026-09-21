/**
 * AI Agent Log Tools
 *
 * Tools for searching agent diagnostic logs and controlling log levels.
 * - search_agent_logs (Tier 1): Query logs across fleet with filters
 * - set_agent_log_level (Tier 2): Temporarily adjust agent log verbosity
 * - capture_agent_pprof (Tier 2): On-demand Go runtime profiles from the agent
 */

import { db } from '../db';
import { agentLogs, devices } from '../db/schema';
import { and, eq, gte, lte, ilike, inArray, desc, type SQL } from 'drizzle-orm';
import { escapeLike } from '../utils/sql';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { redactAgentLogRow } from './logRedaction';
import { deviceScopeCondition, deviceSiteDenied, resolveSiteAllowedDeviceIds } from './aiToolsSiteScope';
import { sanitizeThrownToolError } from './aiToolErrors';
import { aiExecuteCommand, aiQueueCommandForExecution } from './aiDispatch';

type AiToolTier = 1 | 2 | 3 | 4;

function getOrgId(auth: AuthContext): string | null {
  return auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
}

export interface AgentLogQueryFilters {
  deviceIds?: string[];
  level?: string;
  component?: string;
  startTime?: string;
  endTime?: string;
  message?: string;
}

/**
 * The one predicate list for `agent_logs`, shared by `search_agent_logs` and
 * `export_dataset`. Extracted rather than duplicated: the site-axis narrowing
 * below is app-layer authz that RLS does NOT enforce, so a second copy would be
 * a second place to forget it.
 *
 * Returns `null` when a site-restricted caller has zero in-scope devices —
 * distinct from `[]` (an unrestricted caller with no filters).
 */
export async function buildAgentLogConditions(
  orgId: string,
  auth: AuthContext,
  filters: AgentLogQueryFilters,
): Promise<SQL[] | null> {
  const conditions: SQL[] = [eq(agentLogs.orgId, orgId)];

  if (filters.deviceIds && filters.deviceIds.length > 0) {
    conditions.push(inArray(agentLogs.deviceId, filters.deviceIds));
  }

  // Exact-device axis: independent of the site axis. A device-LESS analysis run
  // carries only `allowedDeviceIds`, so the site block below never fires for it
  // and the search would read org-wide (#6096 RC3). No-op when unrestricted.
  const deviceCond = deviceScopeCondition(auth, agentLogs.deviceId);
  if (deviceCond) conditions.push(deviceCond);

  if (auth.allowedSiteIds) {
    const allowed = await resolveSiteAllowedDeviceIds(orgId, auth);
    if (!allowed || allowed.length === 0) return null;
    conditions.push(inArray(agentLogs.deviceId, allowed));
  }

  if (filters.level) conditions.push(eq(agentLogs.level, filters.level as any));
  if (filters.component) conditions.push(eq(agentLogs.component, filters.component));
  if (filters.startTime) conditions.push(gte(agentLogs.timestamp, new Date(filters.startTime)));
  if (filters.endTime) conditions.push(lte(agentLogs.timestamp, new Date(filters.endTime)));
  if (filters.message) conditions.push(ilike(agentLogs.message, `%${escapeLike(filters.message)}%`));

  return conditions;
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
    domain: 'admin',
    searchHint: 'agent diagnostic logs by device, level, component, time range or message text',
    deviceArgs: ['deviceIds'],
    definition: {
      name: 'search_agent_logs',
      description:
        'Search agent diagnostic logs across the fleet. Filter by device, log level, component, event-time range, or message text. Returns matching log entries ordered by server receipt time (newest received first).',
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

        const conditions = await buildAgentLogConditions(orgId, auth, {
          deviceIds: Array.isArray(input.deviceIds) ? input.deviceIds as string[] : undefined,
          level: typeof input.level === 'string' ? input.level : undefined,
          component: typeof input.component === 'string' ? input.component : undefined,
          startTime: typeof input.startTime === 'string' ? input.startTime : undefined,
          endTime: typeof input.endTime === 'string' ? input.endTime : undefined,
          message: typeof input.message === 'string' ? input.message : undefined,
        });
        if (conditions === null) {
          return JSON.stringify({ logs: [], count: 0 });
        }

        const maxLimit = Math.min(Number(input.limit) || 100, 500);

        const results = await db
          .select()
          .from(agentLogs)
          .where(and(...conditions))
          // Receipt time dominates. Ingest writes up to 100 rows in one INSERT,
          // so a whole batch shares created_at to the microsecond and the random
          // uuid id would shuffle it; agent event time only breaks ties WITHIN a
          // single receipt instant, which cannot reorder rows across receipts.
          .orderBy(desc(agentLogs.createdAt), desc(agentLogs.timestamp), desc(agentLogs.id))
          .limit(maxLimit);

        return JSON.stringify({
          logs: results.map((r) => {
            const redacted = redactAgentLogRow(r);
            return {
              id: r.id,
              deviceId: r.deviceId,
              timestamp: r.timestamp.toISOString(),
              receivedAt: r.createdAt.toISOString(),
              level: r.level,
              component: r.component,
              message: redacted.message,
              fields: redacted.fields,
              agentVersion: r.agentVersion,
            };
          }),
          count: results.length,
        });
      } catch (err) {
        const message = sanitizeThrownToolError('agent-logs', err);
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
    domain: 'admin',
    searchHint: 'agent log shipping verbosity: temporarily change the logging level for debugging',
    deviceArgs: ['deviceId'],
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
          .select({ id: devices.id, siteId: devices.siteId })
          .from(devices)
          .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
          .limit(1);

        if (!device) {
          return JSON.stringify({ error: 'Device not found or access denied' });
        }
        // Site axis (app-layer only; RLS does NOT enforce it).
        if (deviceSiteDenied(auth, device.siteId, device.id)) {
          return JSON.stringify({ error: 'Device not found or access denied' });
        }

        const result = await aiQueueCommandForExecution(auth, 'set_agent_log_level', deviceId, 'set_log_level', {
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
        const message = sanitizeThrownToolError('agent-logs', err);
        console.error('[ai:set_agent_log_level]', message, err);
        return JSON.stringify({ error: `Failed to set log level: ${message}` });
      }
    },
  });

  // ============================================
  // 3. capture_agent_pprof — On-demand runtime profiles (#2401)
  // ============================================

  registerTool({
    tier: 2 as AiToolTier,
    domain: 'admin',
    searchHint: 'agent Go runtime pprof profiles, heap memory growth and goroutine leaks',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'capture_agent_pprof',
      description:
        "Capture agent heap/goroutine pprof profiles to diagnose memory growth or leaks; return sizes, capture time and runtime gauges. Raw profiles remain in the command result for download. Requires approval.",
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: {
            type: 'string',
            description: 'The device UUID whose agent to profile',
          },
          profile: {
            type: 'string',
            enum: ['heap', 'goroutine', 'all'],
            description: 'Which profile(s) to capture (default: all)',
          },
        },
        required: ['deviceId'],
      },
    },
    handler: async (input: Record<string, unknown>, auth: AuthContext) => {
      try {
        const orgId = getOrgId(auth);
        if (!orgId) {
          return JSON.stringify({ error: 'No organization context available' });
        }

        const deviceId = input.deviceId as string;
        if (!deviceId) {
          return JSON.stringify({ error: 'deviceId is required' });
        }

        const profile = (input.profile as string | undefined) ?? 'all';
        if (!['heap', 'goroutine', 'all'].includes(profile)) {
          return JSON.stringify({
            error: `Invalid profile "${profile}": must be heap, goroutine, or all`,
          });
        }

        // Verify device belongs to the caller's organization
        const [device] = await db
          .select({ id: devices.id, siteId: devices.siteId })
          .from(devices)
          .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
          .limit(1);

        if (!device) {
          return JSON.stringify({ error: 'Device not found or access denied' });
        }
        // Site axis (app-layer only; RLS does NOT enforce it).
        if (deviceSiteDenied(auth, device.siteId, device.id)) {
          return JSON.stringify({ error: 'Device not found or access denied' });
        }

        const result = await aiExecuteCommand(auth, 'capture_agent_pprof', deviceId, 'capture_pprof', { profile }, {
          userId: auth.user.id,
          timeoutMs: 30000,
        });

        if (result.status !== 'completed') {
          return JSON.stringify({
            error: result.error || 'Profile capture failed',
            // Present when the command row was created before failing —
            // lets the operator inspect the stored result/stderr.
            commandId: result.commandId ?? null,
          });
        }

        // The agent returns the profiles base64-encoded in stdout (up to
        // ~2.7 MB for "all"). NEVER inline them into the AI transcript —
        // return metadata and point at the persisted command result instead.
        let captured: Record<string, unknown>;
        try {
          captured = JSON.parse(result.stdout ?? '{}');
        } catch (parseErr) {
          console.error(
            `[ai:capture_agent_pprof] Failed to parse capture result (deviceId=${deviceId}, commandId=${result.commandId ?? 'unknown'})`,
            parseErr,
          );
          return JSON.stringify({
            error: 'Failed to parse profile capture response',
            commandId: result.commandId ?? null,
          });
        }

        const profiles: Record<string, { sizeBytes: number }> = {};
        if (typeof captured.heapProfileBytes === 'number') {
          profiles.heap = { sizeBytes: captured.heapProfileBytes };
        }
        if (typeof captured.goroutineProfileBytes === 'number') {
          profiles.goroutine = { sizeBytes: captured.goroutineProfileBytes };
        }

        // A completed command whose stdout carries no profile fields means
        // the agent/API contract drifted (or stdout was lost in transit).
        // Don't dress that up as success.
        if (Object.keys(profiles).length === 0) {
          console.error(
            `[ai:capture_agent_pprof] Completed capture returned no profile data (deviceId=${deviceId}, commandId=${result.commandId ?? 'unknown'})`,
          );
          return JSON.stringify({
            error: 'Profile capture completed but returned no profile data (agent/API version mismatch?)',
            commandId: result.commandId ?? null,
          });
        }

        return JSON.stringify({
          status: 'completed',
          commandId: result.commandId ?? null,
          capturedAt: captured.capturedAt ?? null,
          // Runtime gauges at capture time (heapAllocBytes, heapInuseBytes,
          // sysBytes, numGc, goroutines) for correlating with the profiles.
          runtime: captured.runtime ?? null,
          profiles,
          retrieval: result.commandId
            ? `Raw profiles are base64-encoded gzip protobuf (the format \`go tool pprof\` consumes), stored on the command result. Fetch GET /devices/${deviceId}/commands/${result.commandId} and decode the heapProfileBase64 / goroutineProfileBase64 fields from the result stdout JSON. Do NOT re-fetch them into this conversation.`
            : 'Profiles captured but the command id was unavailable; look up the latest capture_pprof command for this device in the command history.',
        });
      } catch (err) {
        const message = sanitizeThrownToolError('agent-logs', err);
        console.error('[ai:capture_agent_pprof]', message, err);
        return JSON.stringify({ error: `Profile capture failed: ${message}` });
      }
    },
  });
}
