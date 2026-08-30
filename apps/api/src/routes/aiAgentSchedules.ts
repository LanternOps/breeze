/**
 * Phase 2 wave P2-2 (#4187 / #4189) — `/ai/agents/schedules`.
 *
 * Mounted BEFORE `/ai/agents` in index.ts: `aiAgentsRoutes` owns `/:id`, which
 * would otherwise swallow `/schedules` as an agent id.
 *
 * Same middleware set as `routes/aiAgents.ts`: dedicated `ai_agents:read` /
 * `ai_agents:write` capabilities (NOT organizations:*) plus `requireMfa()` on
 * every mutation — a sweep schedule is partner-wide policy that decides what
 * runs against customer machines.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  createAiAgentScheduleSchema,
  updateAiAgentScheduleSchema,
  type AiAgentScheduleDto,
} from '@breeze/shared';
import { zValidator } from '../lib/validation';
import type { AiAgentScheduleRow } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE, PartnerWideWriteDeniedError } from '../services/partnerWideAccess';
import { AgentAccessDeniedError } from '../services/aiAgents/access';
import {
  ScheduleValidationError,
  createSchedule,
  deleteSchedule,
  listSchedules,
  updateSchedule,
} from '../services/aiAgents/scheduleService';
import { writeRouteAudit } from '../services/auditEvents';
import { isPgUniqueViolation } from '../utils/pgErrors';
import { PERMISSIONS } from '../services/permissions';

export const aiAgentSchedulesRoutes = new Hono();
aiAgentSchedulesRoutes.use('*', authMiddleware);

const requireAiRead = requirePermission(PERMISSIONS.AI_AGENTS_READ.resource, PERMISSIONS.AI_AGENTS_READ.action);
const requireAiWrite = requirePermission(PERMISSIONS.AI_AGENTS_WRITE.resource, PERMISSIONS.AI_AGENTS_WRITE.action);
const scopes = requireScope('organization', 'partner', 'system');

const UUID = z.string().guid();

/** A non-uuid path id must never reach a query: 22P02 poisons the request transaction. */
function uuidParam(c: Context, name: string): string | null {
  const parsed = UUID.safeParse(c.req.param(name));
  return parsed.success ? parsed.data : null;
}

/**
 * Field by field, deliberately not `{ ...row }`: spreading would publish
 * `createdBy` and would make every column added to ai_agent_schedules in a
 * later wave part of the table's public API.
 */
function mapScheduleRow(row: AiAgentScheduleRow): AiAgentScheduleDto {
  return {
    id: row.id,
    ownerScope: row.partnerId ? 'partner' : 'organization',
    orgId: row.orgId,
    partnerId: row.partnerId,
    agentId: row.agentId,
    baselineScheduleId: row.baselineScheduleId,
    kind: row.kind,
    cron: row.cron,
    timezone: row.timezone,
    sweepKinds: row.sweepKinds,
    enabled: row.enabled,
    lastEnqueuedAt: row.lastEnqueuedAt?.toISOString() ?? null,
    lastOccurrenceKey: row.lastOccurrenceKey,
    // Safe on a write response: the caller just wrote this exact row on its own
    // ownership axis. The org-facing STRIPPING of a partner baseline's summary
    // happens in listSchedules, which is the only place an org sees one.
    lastRunSummary: row.lastRunSummary,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 403 for every access denial, including "not found" — a schedule id that
 * resolves to another tenant's row and one that does not exist must be
 * indistinguishable, so there is deliberately no 404 branch here.
 */
function mapScheduleError(c: Context, err: unknown) {
  if (err instanceof ScheduleValidationError) {
    return c.json({ error: err.code, message: err.message }, 422);
  }
  if (err instanceof PartnerWideWriteDeniedError) {
    return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
  }
  if (err instanceof AgentAccessDeniedError) {
    return c.json({ error: err.message }, 403);
  }
  // `ai_agent_schedules_org_baseline_uq` is a partial unique index on
  // `(org_id, baseline_schedule_id) WHERE org_id IS NOT NULL`: an org may hold
  // at most ONE override per baseline. The service does not pre-check it (a
  // pre-check cannot win the race anyway), so the violation is answered here
  // rather than becoming an unactionable 500. Deliberately NOT a
  // `ScheduleValidationError` code: this is a conflict with an existing row,
  // not a statement about the submitted values, so 409 rather than 422.
  //
  // `isPgUniqueViolation`, NOT a hand-rolled `err.code === '23505'`: drizzle
  // wraps every driver error in a DrizzleQueryError whose own `.code` is
  // undefined — the real PostgresError is on `.cause` — so a top-level check
  // matches NOTHING a drizzle insert can throw and the conflict would 500.
  // Naming the constraint keeps any other 23505 propagating instead of being
  // mislabelled as a duplicate override.
  if (isPgUniqueViolation(err, 'ai_agent_schedules_org_baseline_uq')) {
    return c.json({ error: 'override_exists' }, 409);
  }
  throw err;
}

aiAgentSchedulesRoutes.get(
  '/',
  scopes,
  requireAiRead,
  zValidator('query', z.object({
    agentId: UUID.optional(),
    orgId: UUID.optional(),
  })),
  async (c) => {
    const auth = c.get('auth');
    const { agentId, orgId } = c.req.valid('query');
    try {
      const data = await listSchedules(auth, { agentId, orgId });
      return c.json({ data });
    } catch (err) {
      return mapScheduleError(c, err);
    }
  },
);

aiAgentSchedulesRoutes.post(
  '/',
  scopes,
  requireAiWrite,
  requireMfa(),
  zValidator('json', createAiAgentScheduleSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    try {
      const row = await createSchedule(auth, body);
      writeRouteAudit(c, {
        orgId: row.orgId,
        action: 'ai_agent.schedule.created',
        resourceType: 'ai_agent_schedule',
        resourceId: row.id,
        result: 'success',
        details: {
          ownerScope: row.partnerId ? 'partner' : 'organization',
          agentId: row.agentId,
          baselineScheduleId: row.baselineScheduleId,
          // P2-3: what the schedule PRODUCES (sweep findings vs. a weekly org
          // narrative). Audited on create because it is immutable afterwards
          // — there is no later event that could record it.
          kind: row.kind,
          sweepKinds: row.sweepKinds,
        },
      });
      return c.json({ data: mapScheduleRow(row) }, 201);
    } catch (err) {
      return mapScheduleError(c, err);
    }
  },
);

aiAgentSchedulesRoutes.patch(
  '/:id',
  scopes,
  requireAiWrite,
  requireMfa(),
  zValidator('json', updateAiAgentScheduleSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const id = uuidParam(c, 'id');
    if (!id) return c.json({ error: 'Schedule not found' }, 404);
    try {
      const row = await updateSchedule(auth, id, body);
      writeRouteAudit(c, {
        orgId: row.orgId,
        action: 'ai_agent.schedule.updated',
        resourceType: 'ai_agent_schedule',
        resourceId: row.id,
        result: 'success',
        details: { changed: Object.keys(body), sweepKinds: row.sweepKinds, enabled: row.enabled },
      });
      return c.json({ data: mapScheduleRow(row) });
    } catch (err) {
      return mapScheduleError(c, err);
    }
  },
);

aiAgentSchedulesRoutes.delete('/:id', scopes, requireAiWrite, requireMfa(), async (c) => {
  const auth = c.get('auth');
  const id = uuidParam(c, 'id');
  if (!id) return c.json({ error: 'Schedule not found' }, 404);
  try {
    await deleteSchedule(auth, id);
    writeRouteAudit(c, {
      orgId: null,
      action: 'ai_agent.schedule.deleted',
      resourceType: 'ai_agent_schedule',
      resourceId: id,
      result: 'success',
    });
    return c.body(null, 204);
  } catch (err) {
    return mapScheduleError(c, err);
  }
});
