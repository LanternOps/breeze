/**
 * Input schemas for the W10 AI-agent read tools (full-control W10, #6780):
 * `get_device_ai_activity`, `list_operator_tasks`, `get_operator_task`,
 * `list_ai_agent_schedules`, `list_fleet_designs`, `get_fleet_design`.
 *
 * Plain strict `z.object`s (no unions or refinements) so the chat SDK `tool()`
 * declarations can take `.shape` directly. None of these multiplexes an
 * `action`: each is one read. No `z.undefined()` anywhere: it empties the
 * model's tool list.
 *
 * Keys mirror each tool's registry `input_schema` one-for-one;
 * aiToolSchemas.aiReads.test.ts pins that.
 */
import { z } from 'zod';
import { AI_OPERATOR_TASK_STATES } from '@breeze/shared';

const uuid = z.string().guid();

export const AI_ORIGIN_SOURCES = ['execution', 'command'] as const;

export const aiReadToolShapes = {
  get_device_ai_activity: {
    device_id: uuid,
    days: z.number().int().min(1).max(30).optional(),
    source: z.enum(AI_ORIGIN_SOURCES).optional(),
    sourceId: uuid.optional(),
  },
  list_operator_tasks: {
    deviceId: uuid.optional(),
    state: z.enum(AI_OPERATOR_TASK_STATES).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z.string().max(256).optional(),
  },
  get_operator_task: {
    taskId: uuid,
  },
  list_ai_agent_schedules: {
    agentId: uuid.optional(),
    orgId: uuid.optional(),
  },
  list_fleet_designs: {
    orgId: uuid.optional(),
  },
  get_fleet_design: {
    reportRunId: uuid,
  },
} as const;

export const aiReadToolSchemas: Record<string, z.ZodType> = Object.fromEntries(
  Object.entries(aiReadToolShapes).map(([name, shape]) => [name, z.object(shape).strict()]),
);
