/**
 * Input schema for `manage_ai_agent_schedules` (full-control W16 PR B, #6786).
 *
 * Flat, because the SDK registers `.shape`, which a discriminated union does not
 * have. The handler validates each action against the route's own shared schema
 * (`createAiAgentScheduleSchema`, `updateAiAgentScheduleSchema`), so the two cannot
 * drift, and those strict schemas are what refuse another action's fields.
 *
 * `actMode` is the literal `false`: the tool can disarm and can never arm
 * (Decision 3). Arming stays on the AI Agents page. No `z.undefined()` anywhere:
 * it empties the model's tool list.
 */
import { z } from 'zod';
import {
  AI_AGENT_SCHEDULE_KINDS, AI_SWEEP_KINDS, createAiAgentScheduleSchema, updateAiAgentScheduleSchema,
} from '@breeze/shared';

const uuid = z.string().guid();

export const AI_AGENT_SCHEDULE_ACTIONS = ['create', 'update', 'delete'] as const;

export const aiAgentScheduleToolSchemas = {
  manage_ai_agent_schedules: z.object({
    action: z.enum(AI_AGENT_SCHEDULE_ACTIONS),
    scheduleId: uuid.optional().describe('update, delete: the schedule (from list_ai_agent_schedules)'),
    ownerScope: z.enum(['partner', 'organization']).optional()
      .describe('create: partner = a baseline for every organization; organization = one org\'s override of a baseline'),
    kind: z.enum(AI_AGENT_SCHEDULE_KINDS).optional().describe('create, partner: sweep (default), narrative, design or patch'),
    agentId: uuid.optional().describe('create, partner: the partner-wide agent that runs'),
    orgId: uuid.optional().describe('create, organization: the organization the override is for'),
    baselineScheduleId: uuid.optional().describe('create, organization: the baseline this override tightens'),
    cron: z.string().optional().describe('create, update (partner only): 5-field cron; at most hourly, tighter for some kinds'),
    timezone: z.string().optional().describe('create, update (partner only): IANA timezone'),
    sweepKinds: z.array(z.enum(AI_SWEEP_KINDS)).max(AI_SWEEP_KINDS.length).optional()
      .describe('create, update: sweep kinds. An override may only keep kinds its baseline has; [] turns them all off'),
    enabled: z.boolean().optional().describe('create, update: false stops future runs'),
    actMode: z.literal(false).optional()
      .describe('update only: false stops unattended actions, including ones already waiting. Arming is not available here'),
  }).strict().superRefine((value, ctx) => {
    // #11287: validateToolInput runs this before MCP or chat files an approval
    // card. Check a create or update against the route schema the handler
    // applies, so a call it would refuse after a person approved it (e.g. a
    // create without `enabled`) is refused here instead. The handler keeps its
    // own check. Refinements do not appear in the generated JSON schema.
    // The same field split as the handler's create() and update().
    const { action, ...rest } = value;
    if (action === 'delete') return;
    let parsed;
    if (action === 'create') {
      const { actMode, ...fields } = rest;
      if (actMode !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['actMode'], message: 'create takes no actMode; arming is on the AI Agents page' });
        return;
      }
      parsed = createAiAgentScheduleSchema.safeParse(fields);
    } else {
      const { scheduleId: _scheduleId, ...fields } = rest;
      parsed = updateAiAgentScheduleSchema.safeParse(fields);
    }
    if (parsed.success) return;
    for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  }),
} as const;
