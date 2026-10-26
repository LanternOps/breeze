/**
 * `get_device_ai_activity` and `list_ai_agent_schedules` (full-control W10, #6780).
 *
 * Tier 1, read-only, agent-reachable. `get_device_ai_activity` is the AI twin
 * of GET /devices/:id/ai-activity (the de-duplicated count of AI-dispatched
 * mutations in a window) and, when `source` + `sourceId` name one execution or
 * command, GET /devices/:id/ai-origin (the authorized, per-viewer origin
 * summary). The device is resolved with `verifyDeviceAccess` (helper lock,
 * exact-device membership, org, site), so a device-bound agent reads its own
 * device and nothing else; every unreachable device, execution or command is
 * the same "not found".
 *
 * `list_ai_agent_schedules` is GET /ai/agents/schedules via `listSchedules`.
 * It nulls a partner-owned row's `lastRunSummary` unless the caller reaches
 * every org of the partner: that summary aggregates all of them and
 * `listSchedules` only strips it for org callers (plan fact 7, quorum QW3).
 */
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { verifyDeviceAccess } from './aiTools';
import { countDeviceAiActivity } from './deviceAiActivity';
import { AiOriginSourceNotFoundError, resolveAiOriginSummary } from './aiOriginSummary';
import { AgentAccessDeniedError } from './aiAgents/access';
import { listSchedules } from './aiAgents/scheduleService';
import { AI_ORIGIN_SOURCES } from './aiToolSchemasAiReads';
import { bounded, clampInt, jsonError, notFound, str, thrown } from './aiToolsAiReadsShared';

const DEVICE_NOT_FOUND = 'Device';

/** A caller that reaches EVERY org of its partner (or the whole system) may see a partner baseline's fleet-wide run summary. */
export function reachesWholePartner(auth: AuthContext): boolean {
  return auth.scope === 'system' || (auth.scope === 'partner' && auth.partnerOrgAccess === 'all');
}

export function registerAiActivityTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('get_device_ai_activity', {
    tier: 1,
    domain: 'ai',
    searchHint: 'what the AI did on a device; AI-dispatched scripts and commands; who started an action',
    deviceArgs: ['device_id'],
    definition: {
      name: 'get_device_ai_activity',
      description:
        'AI activity on one device: the count of AI-dispatched scripts and commands in the last N days (default 7, max 30). With source (execution|command) and sourceId, also who started that one action (AI assistant, AI agent or flow).',
      input_schema: {
        type: 'object' as const,
        properties: {
          device_id: { type: 'string', description: 'Device UUID' },
          days: { type: 'number', description: 'Window in days (default 7, max 30)' },
          source: { type: 'string', enum: [...AI_ORIGIN_SOURCES], description: 'With sourceId: look up the origin of one execution or command' },
          sourceId: { type: 'string', description: 'With source: the execution or command UUID' },
        },
        required: ['device_id'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const deviceId = str(input.device_id);
      if (!deviceId) return jsonError('device_id is required', 'VALIDATION_ERROR');
      const source = str(input.source) as (typeof AI_ORIGIN_SOURCES)[number] | undefined;
      const sourceId = str(input.sourceId);
      if ((source === undefined) !== (sourceId === undefined)) {
        return jsonError('source and sourceId go together', 'VALIDATION_ERROR');
      }
      if (source !== undefined && !AI_ORIGIN_SOURCES.includes(source)) {
        return jsonError(`Unknown source: ${source}`, 'VALIDATION_ERROR');
      }

      try {
        const access = await verifyDeviceAccess(deviceId, auth);
        if ('error' in access) return notFound(DEVICE_NOT_FOUND);

        const activity = await countDeviceAiActivity(deviceId, clampInt(input.days, 7, 30));
        if (!source || !sourceId) return bounded({ activity });

        try {
          const origin = await resolveAiOriginSummary(auth, { kind: source, id: sourceId, deviceId });
          return bounded({ activity, origin });
        } catch (err) {
          // Same body as an unreachable device: an id on another device must not be distinguishable.
          if (err instanceof AiOriginSourceNotFoundError) return notFound(DEVICE_NOT_FOUND);
          throw err;
        }
      } catch (error) {
        return thrown('get_device_ai_activity', error);
      }
    },
  });

  aiTools.set('list_ai_agent_schedules', {
    tier: 1,
    domain: 'ai',
    searchHint: 'when AI agents run; sweep or report schedules, cron, enabled; baseline and override',
    deviceArgs: [],
    definition: {
      name: 'list_ai_agent_schedules',
      description:
        'List AI agent schedules visible to you: cron, timezone, enabled state, sweep kinds, last enqueue, plus the effective schedule after an organization override of a partner baseline.',
      input_schema: {
        type: 'object' as const,
        properties: {
          agentId: { type: 'string', description: 'Only this AI agent UUID' },
          orgId: { type: 'string', description: 'Organization UUID (partner callers: the org whose overrides to resolve)' },
          limit: { type: 'number', description: 'Max results (default 50, max 200)' },
        },
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      try {
        const rows = await listSchedules(auth, { agentId: str(input.agentId), orgId: str(input.orgId) });
        const full = reachesWholePartner(auth);
        const limit = clampInt(input.limit, 50, 200);
        const schedules = rows
          .slice(0, limit)
          .map((row) => (row.ownerScope === 'partner' && !full ? { ...row, lastRunSummary: null } : row));
        return bounded({ schedules, showing: schedules.length, total: rows.length, hasMore: rows.length > limit });
      } catch (error) {
        // An org the caller cannot reach and a missing org read the same; a caller with no org context of its own is told to name one.
        if (error instanceof AgentAccessDeniedError) {
          if (!str(input.orgId) && /context required/i.test(error.message)) {
            return jsonError('orgId is required for this session', 'VALIDATION_ERROR');
          }
          return notFound('Organization');
        }
        return thrown('list_ai_agent_schedules', error);
      }
    },
  });
}
