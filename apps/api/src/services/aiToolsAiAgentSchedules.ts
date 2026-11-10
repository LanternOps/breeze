/**
 * `manage_ai_agent_schedules` (full-control W16 PR B, #6786): the AI twin of
 * `POST/PATCH/DELETE /ai/agents/schedules` over the same service, so every route
 * gate travels with it. Another door to the same rows and the same resolver
 * (`effectiveSchedule`): no new setting.
 *
 * Classes (aiGuardrails.ts, W16 plan class review):
 *  - `create` and `update` are supervised. Each run a schedule starts uses credits
 *    and may notify people, so neither can be tier 2.
 *  - `delete` is four-eyes with a mandatory effect digest
 *    (actionIntents/scheduleDeleteDigest.ts): a baseline cascades every org's
 *    override, and that tightening cannot be restored. It is static for both owners
 *    because the input names no owner, so a single-org override on an unarmed
 *    baseline is stricter than the class rule requires (recorded in the plan).
 *    A baseline delete's second approver must hold the partner axis
 *    (actionIntents/partnerWideEffect.ts).
 *
 * The tool never arms act mode (Decision 3). `create` takes no `actMode`, `update`
 * takes only `false`, and while a baseline is armed a write may only narrow what it
 * runs unattended: `refuseArmedWidening` checks it under the target row's lock.
 *
 * A baseline write released by the worker needs the requester's partner axis
 * (`PARTNER_AXIS_RELEASE_ACTIONS`, Decision 8). Agent-human-only, and a site- or
 * device-restricted session is refused.
 */
import { createAiAgentScheduleSchema, updateAiAgentScheduleSchema } from '@breeze/shared';
import type { AiAgentScheduleRow } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { AgentAccessDeniedError, AgentSiteCeilingDeniedError } from './aiAgents/access';
import { ScheduleValidationError, createSchedule, deleteSchedule, updateSchedule } from './aiAgents/scheduleService';
import { mfaGatedToolError } from './aiToolMfaGate';
import { AI_AGENT_SCHEDULE_ACTIONS, aiAgentScheduleToolSchemas } from './aiToolSchemasAiAgentSchedules';
import { auditToolWrite, json, jsonError, thrown } from './aiToolsSecurityPolicyShared';
import { agentRefusal, isAgentPrincipal } from './aiToolsTicketOpsShared';
import { orgAdminInputSchema, parseInput, restrictedSessionDenied } from './aiToolsOrgAdminShared';
import { PartnerWideWriteDeniedError, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from './partnerWideAccess';

const TOOL = 'manage_ai_agent_schedules';
const WHAT = 'An AI agent schedule';

/**
 * What the model sees of a row. Not the route's DTO: `lastRunSummary` aggregates
 * every org under the partner, and `createdBy` is no use to it.
 */
function scheduleView(row: AiAgentScheduleRow) {
  return {
    id: row.id,
    ownerScope: row.partnerId ? 'partner' : 'organization',
    orgId: row.orgId,
    agentId: row.agentId,
    baselineScheduleId: row.baselineScheduleId,
    kind: row.kind,
    cron: row.cron,
    timezone: row.timezone,
    sweepKinds: row.sweepKinds,
    enabled: row.enabled,
    actMode: row.actMode,
  };
}

/** `mapScheduleError` (routes/aiAgentSchedules.ts) as `{ error, code }`, with the same codes. */
function refusal(error: unknown): { message: string; code: string } | null {
  if (error instanceof ScheduleValidationError) return { message: error.message, code: error.code };
  if (error instanceof PartnerWideWriteDeniedError) return { message: PARTNER_WIDE_WRITE_DENIED_MESSAGE, code: 'PARTNER_WIDE_WRITE_DENIED' };
  if (error instanceof AgentSiteCeilingDeniedError) return { message: error.message, code: 'ACCESS_DENIED' };
  // A foreign id and a missing one are the same answer, as on REST.
  if (error instanceof AgentAccessDeniedError) return { message: 'Schedule not found or access denied', code: 'NOT_FOUND' };
  return null;
}

/** The action's own fields, without the discriminator. */
function fieldsOf(input: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...fields } = input;
  return fields;
}

function issueText(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  const issue = error.issues[0];
  return `${issue?.path.length ? `${issue.path.join('.')}: ` : ''}${issue?.message ?? 'Invalid input'}`;
}

/** Keeps the audit's org the row's own; a partner baseline lands on the partner axis. */
function auditOwner(auth: AuthContext, row: Pick<AiAgentScheduleRow, 'orgId'>): { orgId: string | null; partnerId: string | null } {
  return row.orgId ? { orgId: row.orgId, partnerId: null } : { orgId: null, partnerId: auth.partnerId ?? null };
}

const CREATED_ACTION = 'ai_agent.schedule.created';
const UPDATED_ACTION = 'ai_agent.schedule.updated';
const DELETED_ACTION = 'ai_agent.schedule.deleted';

async function create(auth: AuthContext, input: Record<string, unknown>): Promise<string> {
  const { actMode: named, ...fields } = fieldsOf(input);
  if (named !== undefined) return jsonError('create takes no actMode; arming is on the AI Agents page', 'VALIDATION_ERROR');
  const parsed = createAiAgentScheduleSchema.safeParse(fields);
  if (!parsed.success) return jsonError(issueText(parsed.error), 'VALIDATION_ERROR');
  const row = await createSchedule(auth, parsed.data, { refuseExistingOverride: true });
  auditToolWrite(auth, {
    ...auditOwner(auth, row),
    action: CREATED_ACTION,
    resourceType: 'ai_agent_schedule',
    resourceId: row.id,
    details: {
      via: 'ai_tool',
      ownerScope: row.partnerId ? 'partner' : 'organization',
      agentId: row.agentId,
      baselineScheduleId: row.baselineScheduleId,
      kind: row.kind,
      sweepKinds: row.sweepKinds,
      actMode: row.actMode,
    },
    result: 'success',
  });
  return json(scheduleView(row));
}

async function update(auth: AuthContext, input: Record<string, unknown>): Promise<string> {
  const { scheduleId, ...fields } = fieldsOf(input);
  if (typeof scheduleId !== 'string') return jsonError('update needs scheduleId', 'VALIDATION_ERROR');
  const parsed = updateAiAgentScheduleSchema.safeParse(fields);
  if (!parsed.success) return jsonError(issueText(parsed.error), 'VALIDATION_ERROR');
  const changed = Object.keys(parsed.data);
  if (changed.length === 0) return jsonError('update must name at least one field', 'VALIDATION_ERROR');
  const row = await updateSchedule(auth, scheduleId, parsed.data, { refuseArmedWidening: true });
  auditToolWrite(auth, {
    ...auditOwner(auth, row),
    action: UPDATED_ACTION,
    resourceType: 'ai_agent_schedule',
    resourceId: row.id,
    details: { via: 'ai_tool', changed, sweepKinds: row.sweepKinds, enabled: row.enabled, actMode: row.actMode },
    result: 'success',
  });
  return json(scheduleView(row));
}

async function remove(auth: AuthContext, input: Record<string, unknown>): Promise<string> {
  const { scheduleId, ...rest } = fieldsOf(input);
  if (typeof scheduleId !== 'string') return jsonError('delete needs scheduleId', 'VALIDATION_ERROR');
  if (Object.keys(rest).length > 0) return jsonError('delete takes only scheduleId', 'VALIDATION_ERROR');
  const row = await deleteSchedule(auth, scheduleId, { refuseArmedWidening: true });
  auditToolWrite(auth, {
    ...auditOwner(auth, row),
    action: DELETED_ACTION,
    resourceType: 'ai_agent_schedule',
    resourceId: scheduleId,
    details: { via: 'ai_tool', ownerScope: row.partnerId ? 'partner' : 'organization', kind: row.kind },
    result: 'success',
  });
  return json({ deleted: true, scheduleId });
}

const ACTION_AUDIT: Record<(typeof AI_AGENT_SCHEDULE_ACTIONS)[number], string> = {
  create: CREATED_ACTION,
  update: UPDATED_ACTION,
  delete: DELETED_ACTION,
};

export function registerAiAgentScheduleTool(aiTools: Map<string, AiTool>): void {
  aiTools.set(TOOL, {
    tier: 1,
    domain: 'ai',
    deviceArgs: [],
    searchHint: 'schedule an AI agent: recurring sweeps, reports, designs or patch runs for all customers or one org',
    definition: {
      name: TOOL,
      description:
        'Schedule AI agent runs. create (a partner baseline, or one organization\'s tighter override), update, delete (two approvers). Needs approval; each run uses AI credits and may notify people. It cannot turn on act mode.',
      input_schema: orgAdminInputSchema(aiAgentScheduleToolSchemas.manage_ai_agent_schedules),
    },
    handler: async (input, auth) => {
      const parsed = parseInput(aiAgentScheduleToolSchemas.manage_ai_agent_schedules, input);
      if (!parsed.ok) return parsed.error;
      const { action } = parsed.value;
      if (isAgentPrincipal(auth)) return agentRefusal(action);
      const denied = restrictedSessionDenied(auth, WHAT) ?? mfaGatedToolError(TOOL, action, auth);
      if (denied) return denied;
      try {
        if (action === 'create') return await create(auth, input);
        if (action === 'update') return await update(auth, input);
        return await remove(auth, input);
      } catch (error) {
        const refused = refusal(error);
        if (!refused) return thrown(TOOL, error);
        auditToolWrite(auth, {
          orgId: auth.orgId ?? null,
          partnerId: auth.partnerId ?? null,
          action: ACTION_AUDIT[action],
          resourceType: 'ai_agent_schedule',
          ...(typeof parsed.value.scheduleId === 'string' ? { resourceId: parsed.value.scheduleId } : {}),
          details: { via: 'ai_tool', refused: refused.code },
          result: 'failure',
        });
        return jsonError(refused.message, refused.code);
      }
    },
  });
}
